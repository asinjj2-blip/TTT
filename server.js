const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const rateBuckets = new Map();

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function cleanUsername(value) { return String(value || '').trim().replace(/^@/, ''); }
function isValidUsername(username) { return /^[A-Za-z0-9._]{2,24}$/.test(username); }
function rateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > 60000) bucket = { startedAt: now, count: 0 };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > 30) return res.status(429).json({ error: 'Too many searches. Please wait a minute and try again.' });
  next();
}
function getAt(obj, parts) { let current = obj; for (const part of parts) { if (!current || typeof current !== 'object') return undefined; current = current[part]; } return current; }
function firstValue(obj, paths) { for (const parts of paths) { const value = getAt(obj, parts); if (value !== undefined && value !== null && value !== '') return value; } return null; }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function asBoolean(value) { return typeof value === 'boolean' ? value : null; }
function toIsoTime(value) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return null; const d = new Date(n > 10000000000 ? n : n * 1000); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function normalizeRegionCode(value) { if (typeof value !== 'string') return null; const clean = value.trim().toUpperCase(); return /^[A-Z]{2}$/.test(clean) ? clean : null; }
function findRegionInObject(obj, depth = 0, basePath = '') {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const key of ['accountRegion', 'regionCode', 'region', 'countryCode']) {
    const code = normalizeRegionCode(obj[key]);
    if (code) return { code, source: basePath ? `${basePath}.${key}` : key };
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') {
      const found = findRegionInObject(value, depth + 1, basePath ? `${basePath}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}
async function timedFetch(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function baseProfile(username) { return { profileUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}` }; }

async function getTikwmPostRegion(username) {
  try {
    const url = `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(username)}&count=8&cursor=0`;
    const response = await timedFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }, 10000);
    if (!response.ok) return null;
    const payload = await response.json();
    if (Number(payload.code) !== 0 || !Array.isArray(payload?.data?.videos)) return null;
    const counts = new Map();
    for (const video of payload.data.videos) {
      const code = findRegionInObject(video)?.code;
      if (code) counts.set(code, (counts.get(code) || 0) + 1);
    }
    let best = null, max = 0;
    for (const [code, count] of counts) if (count > max) { best = code; max = count; }
    return best;
  } catch { return null; }
}

function normalizeTikwm(username, payload, postRegion) {
  const data = payload?.data || {};
  const user = data.user || {};
  const stats = data.stats || {};
  const explicit = findRegionInObject(user, 0, 'profile') || findRegionInObject(data, 0, 'profileData');
  const regionCode = explicit?.code || postRegion || null;
  const regionSource = explicit
    ? `Explicit public profile region field: ${explicit.source}`
    : postRegion ? 'Recent public post metadata via TikWM; this is a content-region signal, not an account-registration or live-location field.' : null;
  const language = firstValue(user, [['language'], ['languageCode'], ['lang']]);
  return {
    username: String(firstValue(user, [['uniqueId'], ['unique_id']]) || username),
    displayName: firstValue(user, [['nickname']]),
    bio: firstValue(user, [['signature']]),
    avatarUrl: firstValue(user, [['avatarLarger'], ['avatarMedium'], ['avatarThumb'], ['avatar']]),
    verified: asBoolean(firstValue(user, [['verified'], ['isVerified']])),
    privateAccount: asBoolean(firstValue(user, [['privateAccount'], ['secret']])),
    userId: firstValue(user, [['id'], ['uid']]) ? String(firstValue(user, [['id'], ['uid']])) : null,
    language: typeof language === 'string' ? language : null,
    regionCode,
    regionSource,
    followerCount: asNumber(firstValue(stats, [['followerCount'], ['follower_count']])),
    followingCount: asNumber(firstValue(stats, [['followingCount'], ['following_count']])),
    likesCount: asNumber(firstValue(stats, [['heartCount'], ['heart'], ['total_favorited']])),
    videoCount: asNumber(firstValue(stats, [['videoCount'], ['aweme_count']])),
    friendCount: asNumber(firstValue(stats, [['friendCount']])),
    diggCount: asNumber(firstValue(stats, [['diggCount'], ['favoriting_count']])),
    createTime: toIsoTime(firstValue(user, [['createTime'], ['create_time']])),
    nicknameModifiedAt: toIsoTime(firstValue(user, [['nickNameModifyTime'], ['nicknameModifyTime']])),
    usernameModifiedAt: toIsoTime(firstValue(user, [['uniqueIdModifyTime'], ['usernameModifyTime']])),
    ...baseProfile(username),
    sourceStatus: 'TikWM public TikTok profile data',
    notice: explicit
      ? 'Region is an explicit public profile/account field returned by the public data source. It is not live GPS, IP address, or current physical location.'
      : postRegion
        ? 'Region is derived from recent public TikTok post metadata. It can indicate a content/market region, but it is not proof of where the account was created and is not the person’s current location.'
        : 'No public region signal was available. TTT does not guess a location from bio, language, flags, or other indirect clues.'
  };
}
async function fetchViaTikwm(username) {
  const url = `https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(username)}`;
  const response = await timedFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } }, 12000);
  if (!response.ok) throw new Error(`TikWM HTTP ${response.status}`);
  const payload = await response.json();
  if (Number(payload.code) !== 0 || !payload?.data?.user) throw new Error(payload?.msg || 'TikWM profile unavailable');
  const explicit = findRegionInObject(payload.data.user) || findRegionInObject(payload.data);
  const postRegion = explicit ? null : await getTikwmPostRegion(username);
  return normalizeTikwm(username, payload, postRegion);
}

function parseJsonScripts(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) { try { results.push(JSON.parse(match[1].trim())); } catch {} }
  return results;
}
function findUserDetail(root, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 9) return null;
  const direct = root?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  if (direct?.userInfo?.user) return direct;
  if (root?.userInfo?.user && (root.userInfo.user.uniqueId || root.userInfo.user.id)) return root;
  for (const value of Array.isArray(root) ? root : Object.values(root)) {
    if (value && typeof value === 'object') { const found = findUserDetail(value, depth + 1); if (found) return found; }
  }
  return null;
}
function normalizeTikTok(username, userDetail) {
  const user = userDetail?.userInfo?.user || {};
  const stats = userDetail?.userInfo?.stats || {};
  const region = findRegionInObject(user, 0, 'profile') || findRegionInObject(userDetail, 0, 'userDetail');
  const language = firstValue(user, [['language'], ['languageCode'], ['lang']]);
  return {
    username: String(firstValue(user, [['uniqueId']]) || username), displayName: firstValue(user, [['nickname']]), bio: firstValue(user, [['signature']]), avatarUrl: firstValue(user, [['avatarLarger'], ['avatarMedium'], ['avatarThumb']]), verified: asBoolean(firstValue(user, [['verified']])), privateAccount: asBoolean(firstValue(user, [['privateAccount']])), userId: firstValue(user, [['id']]) ? String(firstValue(user, [['id']])) : null, language: typeof language === 'string' ? language : null, regionCode: region?.code || null, regionSource: region ? `Explicit public profile region field: ${region.source}` : null, followerCount: asNumber(firstValue(stats, [['followerCount']])), followingCount: asNumber(firstValue(stats, [['followingCount']])), likesCount: asNumber(firstValue(stats, [['heartCount'], ['heart']])), videoCount: asNumber(firstValue(stats, [['videoCount']])), friendCount: asNumber(firstValue(stats, [['friendCount']])), diggCount: asNumber(firstValue(stats, [['diggCount']])), createTime: toIsoTime(firstValue(user, [['createTime']])), nicknameModifiedAt: toIsoTime(firstValue(user, [['nickNameModifyTime'], ['nicknameModifyTime']])), usernameModifiedAt: toIsoTime(firstValue(user, [['uniqueIdModifyTime'], ['usernameModifyTime']])), ...baseProfile(username), sourceStatus: 'TikTok public profile page', notice: region ? 'Region is an explicit public profile/account field. It is not live GPS, IP address, or current physical location.' : 'No public region signal was available. TTT does not guess a location.'
  };
}
async function fetchViaTikTok(username) {
  const url = `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en`;
  const response = await timedFetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' } }, 9000);
  const html = await response.text();
  if (!response.ok || html.length < 1000) throw new Error('TikTok page unavailable');
  let detail = null;
  for (const script of parseJsonScripts(html)) { detail = findUserDetail(script); if (detail) break; }
  if (!detail?.userInfo?.user) throw new Error('TikTok embedded profile data unavailable');
  return normalizeTikTok(username, detail);
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'TTT', time: new Date().toISOString() }));
app.get('/api/lookup/:username', rateLimit, async (req, res) => {
  const username = cleanUsername(req.params.username);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Enter a valid TikTok username.' });
  const key = username.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return res.json({ success: true, profile: cached.data });
  const failures = [];
  for (const provider of [fetchViaTikwm, fetchViaTikTok]) {
    try {
      const profile = await provider(username);
      cache.set(key, { savedAt: Date.now(), data: profile });
      return res.json({ success: true, profile });
    } catch (error) { failures.push(error?.message || 'provider failed'); }
  }
  console.warn('Lookup providers failed:', username, failures.join(' | '));
  return res.status(502).json({ error: 'Public TikTok data providers could not retrieve this profile right now. Try again shortly.' });
});
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`TTT running on http://localhost:${PORT}`));
