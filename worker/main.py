import asyncio
import os
import time
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request
from TikTokApi import TikTokApi

app = FastAPI(title='TTT TikTok Worker', version='1.0.0')

CACHE_TTL = 300
RATE_WINDOW = 60
RATE_LIMIT = 30
cache: dict[str, tuple[float, dict[str, Any]]] = {}
rate_buckets: dict[str, tuple[float, int]] = {}
api_instance: TikTokApi | None = None
api_lock = asyncio.Lock()


def clean_username(value: str) -> str:
    return str(value or '').strip().lstrip('@')


def valid_username(value: str) -> bool:
    if not 2 <= len(value) <= 24:
        return False
    return all(ch.isalnum() or ch in '._' for ch in value)


def number(value: Any) -> int | float | None:
    try:
        n = float(value)
        return int(n) if n.is_integer() else n
    except (TypeError, ValueError):
        return None


def boolean(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def iso_time(value: Any) -> str | None:
    try:
        n = float(value)
        if n <= 0:
            return None
        if n > 10_000_000_000:
            n /= 1000
        from datetime import datetime, timezone
        return datetime.fromtimestamp(n, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def normalize_region(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip().upper()
    return value if len(value) == 2 and value.isalpha() else None


def direct_region(obj: dict[str, Any]) -> tuple[str | None, str | None]:
    for key in ('accountRegion', 'regionCode', 'region', 'countryCode'):
        code = normalize_region(obj.get(key))
        if code:
            return code, key
    return None, None


def first(obj: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = obj.get(key)
        if value is not None and value != '':
            return value
    return None


def profile_from_payload(username: str, raw: dict[str, Any]) -> dict[str, Any]:
    info = raw.get('userInfo') if isinstance(raw.get('userInfo'), dict) else raw
    user = info.get('user') if isinstance(info, dict) and isinstance(info.get('user'), dict) else {}
    stats = info.get('stats') if isinstance(info, dict) and isinstance(info.get('stats'), dict) else {}

    region, region_source = direct_region(user)
    if not region and isinstance(info, dict):
        region, info_key = direct_region(info)
        if region:
            region_source = f'userInfo.{info_key}'
    elif region_source:
        region_source = f'user.{region_source}'

    language = first(user, 'language', 'languageCode', 'lang')
    returned_username = first(user, 'uniqueId', 'unique_id') or username
    user_id = first(user, 'id', 'uid')

    return {
        'username': str(returned_username),
        'displayName': text(first(user, 'nickname')),
        'bio': text(first(user, 'signature')),
        'avatarUrl': text(first(user, 'avatarLarger', 'avatarMedium', 'avatarThumb', 'avatar')),
        'verified': boolean(first(user, 'verified', 'isVerified')),
        'privateAccount': boolean(first(user, 'privateAccount', 'secret')),
        'userId': str(user_id) if user_id is not None else None,
        'secUid': text(first(user, 'secUid')),
        'language': text(language),
        'regionCode': region,
        'regionSource': f'Explicit TikTok profile field: {region_source}' if region_source else None,
        'followerCount': number(first(stats, 'followerCount', 'follower_count')),
        'followingCount': number(first(stats, 'followingCount', 'following_count')),
        'likesCount': number(first(stats, 'heartCount', 'heart', 'total_favorited')),
        'videoCount': number(first(stats, 'videoCount', 'aweme_count')),
        'friendCount': number(first(stats, 'friendCount')),
        'diggCount': number(first(stats, 'diggCount', 'favoriting_count')),
        'createTime': iso_time(first(user, 'createTime', 'create_time')),
        'nicknameModifiedAt': iso_time(first(user, 'nickNameModifyTime', 'nicknameModifyTime')),
        'usernameModifiedAt': iso_time(first(user, 'uniqueIdModifyTime', 'usernameModifyTime')),
        'profileUrl': f'https://www.tiktok.com/@{username}',
        'sourceStatus': 'TTT Python worker using davidteather/TikTok-Api',
        'notice': (
            'Region is an explicit public TikTok account/profile field. It is not live GPS, IP location, or proof of current physical location.'
            if region
            else 'No explicit public region field was returned. TTT does not infer a country from browser IP, language, bio, flags, videos, or content.'
        ),
    }


def proxy_settings() -> list[dict[str, str]] | None:
    raw = os.getenv('TTT_PROXY_SERVER', '').strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.hostname:
        return None
    server = f'{parsed.scheme}://{parsed.hostname}'
    if parsed.port:
        server += f':{parsed.port}'
    result: dict[str, str] = {'server': server}
    if parsed.username:
        result['username'] = parsed.username
    if parsed.password:
        result['password'] = parsed.password
    return [result]


async def close_api() -> None:
    global api_instance
    if api_instance is not None:
        try:
            await api_instance.close_sessions()
        except Exception:
            pass
        try:
            await api_instance.stop_playwright()
        except Exception:
            pass
    api_instance = None


async def get_api(force_new: bool = False) -> TikTokApi:
    global api_instance
    async with api_lock:
        if force_new:
            await close_api()
        if api_instance is not None:
            return api_instance

        api = TikTokApi()
        ms_token = os.getenv('TTT_MS_TOKEN', '').strip() or None
        kwargs: dict[str, Any] = {
            'num_sessions': 1,
            'headless': True,
            'sleep_after': 2,
            'browser': 'chromium',
            'timeout': 30000,
            'allow_partial_sessions': False,
            'suppress_resource_load_types': ['image', 'media', 'font'],
        }
        if ms_token:
            kwargs['ms_tokens'] = [ms_token]
        proxies = proxy_settings()
        if proxies:
            kwargs['proxies'] = proxies

        try:
            await api.create_sessions(**kwargs)
        except Exception:
            try:
                await api.stop_playwright()
            except Exception:
                pass
            raise
        api_instance = api
        return api


async def lookup_profile(username: str) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            api = await get_api(force_new=attempt > 0)
            user = api.user(username=username)
            raw = await asyncio.wait_for(user.info(), timeout=35)
            if not isinstance(raw, dict):
                raise RuntimeError('TikTokApi returned a non-object response.')
            profile = profile_from_payload(username, raw)
            if not profile.get('userId') and not profile.get('displayName'):
                raise RuntimeError('TikTokApi response did not contain public profile data.')
            return profile
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error) if last_error else 'TikTok lookup failed.')


def check_auth(authorization: str | None) -> None:
    expected = os.getenv('TTT_WORKER_TOKEN', '').strip()
    if not expected:
        return
    if authorization != f'Bearer {expected}':
        raise HTTPException(status_code=401, detail='Unauthorized')


def check_rate(request: Request) -> None:
    host = request.client.host if request.client else 'unknown'
    now = time.time()
    started, count = rate_buckets.get(host, (now, 0))
    if now - started > RATE_WINDOW:
        started, count = now, 0
    count += 1
    rate_buckets[host] = (started, count)
    if count > RATE_LIMIT:
        raise HTTPException(status_code=429, detail='Too many searches. Try again in a minute.')


@app.get('/health')
async def health() -> dict[str, Any]:
    return {
        'ok': True,
        'service': 'TTT TikTok Worker',
        'engine': 'davidteather/TikTok-Api + Playwright',
        'sessionReady': api_instance is not None,
        'proxyConfigured': bool(os.getenv('TTT_PROXY_SERVER', '').strip()),
        'msTokenConfigured': bool(os.getenv('TTT_MS_TOKEN', '').strip()),
    }


@app.get('/lookup/{username}')
async def lookup(username: str, request: Request, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    check_auth(authorization)
    check_rate(request)
    username = clean_username(username)
    if not valid_username(username):
        raise HTTPException(status_code=400, detail='Enter a valid TikTok username.')

    key = username.lower()
    cached = cache.get(key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return {'success': True, 'profile': cached[1], 'cached': True}

    try:
        profile = await lookup_profile(username)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f'TikTokApi could not retrieve this public profile from the current network: {str(exc)[:220]}',
        ) from exc

    cache[key] = (time.time(), profile)
    return {'success': True, 'profile': profile, 'cached': False}


@app.on_event('shutdown')
async def shutdown_event() -> None:
    await close_api()
