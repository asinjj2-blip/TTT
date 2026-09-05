class TikTokPublicAccessError extends Error {
  constructor(message, code = 'TIKTOK_PUBLIC_ACCESS_FAILED', details = []) {
    super(message);
    this.name = 'TikTokPublicAccessError';
    this.code = code;
    this.details = details;
  }
}

function cleanUsername(value) {
  return String(value || '').trim().replace(/^@/, '');
}

function isValidUsername(username) {
  return /^[A-Za-z0-9._]{2,24}$/.test(username);
}

function getAt(obj, parts) {
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function firstValue(obj, paths) {
  for (const path of paths) {
    const value = getAt(obj, path);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function toIsoTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n > 10000000000 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeRegionCode(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(clean) ? clean : null;
}

function findExplicitRegion(obj, depth = 0, basePath = '') {
  if (!obj || typeof obj !== 'object' || depth > 7) return null;
  const keys = ['accountRegion', 'regionCode', 'region', 'countryCode'];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const code = normalizeRegionCode(obj[key]);
      if (code) return { code, source: basePath ? `${basePath}.${key}` : key };
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      const found = findExplicitRegion(value, depth + 1, basePath ? `${basePath}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

function parseJsonScripts(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try { results.push(JSON.parse(raw)); } catch {}
  }
  return results;
}

function findUserDetail(root, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 10) return null;
  const direct = root?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  if (direct?.userInfo?.user) return direct;
  if (root?.userInfo?.user && (root.userInfo.user.uniqueId || root.userInfo.user.id)) return root;
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const found = findUserDetail(value, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeProfile(username, userDetail, provider) {
  const user = userDetail?.userInfo?.user || {};
  const stats = userDetail?.userInfo?.stats || {};
  const region = findExplicitRegion(user, 0, 'user') || findExplicitRegion(userDetail, 0, 'userDetail');
  const language = firstValue(user, [['language'], ['languageCode'], ['lang']]);
  return {
    username: String(firstValue(user, [['uniqueId']]) || username),
    displayName: firstValue(user, [['nickname']]),
    bio: firstValue(user, [['signature']]),
    avatarUrl: firstValue(user, [['avatarLarger'], ['avatarMedium'], ['avatarThumb']]),
    verified: asBoolean(firstValue(user, [['verified']])),
    privateAccount: asBoolean(firstValue(user, [['privateAccount'], ['secret']])),
    userId: firstValue(user, [['id']]) ? String(firstValue(user, [['id']])) : null,
    secUid: firstValue(user, [['secUid']]),
    language: typeof language === 'string' ? language : null,
    regionCode: region?.code || null,
    regionSource: region?.source || null,
    followerCount: asNumber(firstValue(stats, [['followerCount']])),
    followingCount: asNumber(firstValue(stats, [['followingCount']])),
    likesCount: asNumber(firstValue(stats, [['heartCount'], ['heart']])),
    videoCount: asNumber(firstValue(stats, [['videoCount']])),
    friendCount: asNumber(firstValue(stats, [['friendCount']])),
    diggCount: asNumber(firstValue(stats, [['diggCount']])),
    createTime: toIsoTime(firstValue(user, [['createTime']])),
    nicknameModifiedAt: toIsoTime(firstValue(user, [['nickNameModifyTime'], ['nicknameModifyTime']])),
    usernameModifiedAt: toIsoTime(firstValue(user, [['uniqueIdModifyTime'], ['usernameModifyTime']])),
    profileUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
    sourceStatus: provider,
    notice: region
      ? 'Region is an explicit field returned in public TikTok profile data. It is not live GPS, IP location, or proof of current physical location.'
      : 'No explicit public region field was returned. TTT does not infer a country from the bio, language, flags, content, or other indirect clues.'
  };
}

class TikTokPublicClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
    this.timeoutMs = Number(options.timeoutMs || 12000);
    this.language = options.language || 'en-US';
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  }

  async _fetch(url, init = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  _headers(extra = {}) {
    return {
      'User-Agent': this.userAgent,
      'Accept-Language': `${this.language},en;q=0.8`,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      ...extra
    };
  }

  async fromProfilePage(username) {
    const url = `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en`;
    const response = await this._fetch(url, { redirect: 'follow', headers: this._headers() });
    const html = await response.text();
    if (!response.ok) throw new TikTokPublicAccessError(`TikTok profile page returned HTTP ${response.status}.`, 'PROFILE_PAGE_HTTP');
    if (!html || html.length < 1000) throw new TikTokPublicAccessError('TikTok returned an incomplete public profile page.', 'PROFILE_PAGE_EMPTY');
    for (const script of parseJsonScripts(html)) {
      const detail = findUserDetail(script);
      if (detail?.userInfo?.user) return normalizeProfile(username, detail, 'TikTok public profile page');
    }
    throw new TikTokPublicAccessError('TikTok public profile JSON was not present in the page.', 'PROFILE_PAGE_JSON_MISSING');
  }

  async fromPublicUserDetail(username) {
    const params = new URLSearchParams({
      aid: '1988',
      app_name: 'tiktok_web',
      device_platform: 'web_pc',
      uniqueId: username
    });
    const url = `https://www.tiktok.com/api/user/detail/?${params.toString()}`;
    const response = await this._fetch(url, { headers: this._headers({ Accept: 'application/json,text/plain,*/*', Referer: `https://www.tiktok.com/@${encodeURIComponent(username)}` }) });
    if (!response.ok) throw new TikTokPublicAccessError(`TikTok public user-detail endpoint returned HTTP ${response.status}.`, 'USER_DETAIL_HTTP');
    const text = await response.text();
    if (!text.trim()) throw new TikTokPublicAccessError('TikTok public user-detail endpoint returned an empty response.', 'USER_DETAIL_EMPTY');
    let payload;
    try { payload = JSON.parse(text); } catch { throw new TikTokPublicAccessError('TikTok public user-detail endpoint did not return JSON.', 'USER_DETAIL_NON_JSON'); }
    const detail = payload?.userInfo?.user ? payload : findUserDetail(payload);
    if (!detail?.userInfo?.user) throw new TikTokPublicAccessError('TikTok public user-detail response did not contain profile data.', 'USER_DETAIL_NO_PROFILE');
    return normalizeProfile(username, detail, 'TikTok public user-detail endpoint');
  }

  async lookup(value) {
    const username = cleanUsername(value);
    if (!isValidUsername(username)) throw new TikTokPublicAccessError('Enter a valid TikTok username.', 'INVALID_USERNAME');
    const failures = [];
    for (const provider of [this.fromProfilePage.bind(this), this.fromPublicUserDetail.bind(this)]) {
      try {
        return await provider(username);
      } catch (error) {
        failures.push({ code: error?.code || 'PROVIDER_FAILED', message: error?.message || 'Provider failed.' });
      }
    }
    throw new TikTokPublicAccessError('TikTok did not expose the public profile through the currently available logged-out web routes.', 'ALL_PUBLIC_ROUTES_FAILED', failures);
  }
}

module.exports = {
  TikTokPublicClient,
  TikTokPublicAccessError,
  cleanUsername,
  isValidUsername,
  parseJsonScripts,
  findUserDetail,
  findExplicitRegion,
  normalizeProfile
};
