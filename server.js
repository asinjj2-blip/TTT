const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
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
  const windowMs = 60000;
  const max = 30;
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > windowMs) { bucket = { startedAt: now, count: 0 }; rateBuckets.set(key, bucket); }
  bucket.count += 1;
  if (bucket.count > max) return res.status(429).json({ error: 'Too many searches. Please wait a minute and try again.' });
  next();
}
function getAt(obj, parts) { let current = obj; for (const part of parts) { if (!current || typeof current !== 'object') return undefined; current = current[part]; } return current; }
function firstValue(obj, paths) { for (const parts of paths) { const value = getAt(obj, parts); if (value !== undefined && value !== null && value !== '') return value; } return null; }
function asNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function asBoolean(value) { return typeof value === 'boolean' ? value : null; }
function toIsoTime(value) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return null; const ms = n > 10000000000 ? n : n * 1000; const d = new Date(ms); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function parseJsonScripts(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) { const raw = match[1].trim(); if (!raw) continue; try { results.push(JSON.parse(raw)); } catch {} }
  return results;
}
function findUserDetail(root, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 9) return null;
  const direct = root?.__DEFAULT_SCOPE__?.['webapp.user-detail'];
  if (direct?.userInfo?.user) return direct;
  if (root?.userInfo?.user && (root.userInfo.user.uniqueId || root.userInfo.user.id)) return root;
  const values = Array.isArray(root) ? root : Object.values(root);
  for (const value of values) { if (value && typeof value === 'object') { const found = findUserDetail(value, depth + 1); if (found) return found; } }
  return null;
}
function normalizeRegionCode(value) { if (typeof value !== 'string') return null; const clean = value.trim().toUpperCase(); return /^[A-Z]{2}$/.test(clean) ? clean : null; }
function findRegionInObject(obj, depth = 0, basePath = '') {
  if (!obj || typeof obj !== 'object' || depth > 7) return null;
  for (const key of ['accountRegion', 'regionCode', 'region', 'countryCode']) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) { const code = normalizeRegionCode(obj[key]); if (code) return { code, source: basePath ? `${basePath}.${key}` : key }; }
  }
  for (const [key, value] of Object.entries(obj)) { if (value && typeof value === 'object') { const found = findRegionInObject(value, depth + 1, basePath ? `${basePath}.${key}` : key); if (found) return found; } }
  return null;
}
function extractRegion(user, userDetail, scripts, html) {
  const direct = findRegionInObject(user, 0, 'user'); if (direct) return direct;
  const detail = findRegionInObject(userDetail, 0, 'userDetail'); if (detail) return detail;
  for (let i = 0; i < scripts.length; i += 1) { const found = findRegionInObject(scripts[i], 0, `script${i}`); if (found) return found; }
  const raw = html.match(/"(?:accountRegion|regionCode|region|countryCode)"\s*:\s*"([A-Za-z]{2})"/);
  return raw ? { code: raw[1].toUpperCase(), source: 'html-explicit-field' } : { code: null, source: null };
}
function normalizeProfile(username, userDetail, scripts, html) {
  const user = userDetail?.userInfo?.user || {};
  const stats = userDetail?.userInfo?.stats || {};
  const region = extractRegion(user, userDetail, scripts, html);
  const language = firstValue(user, [['language'], ['languageCode'], ['lang']]);
  return {
    username: String(firstValue(user, [['uniqueId']]) || username),
    displayName: firstValue(user, [['nickname']]),
    bio: firstValue(user, [['signature']]),
    avatarUrl: firstValue(user, [['avatarLarger'], ['avatarMedium'], ['avatarThumb']]),
    verified: asBoolean(firstValue(user, [['verified']])),
    privateAccount: asBoolean(firstValue(user, [['privateAccount']])),
    userId: firstValue(user, [['id']]) ? String(firstValue(user, [['id']])) : null,
    secUid: firstValue(user, [['secUid']]),
    language: typeof language === 'string' ? language : null,
    regionCode: region.code,
    regionSource: region.source,
    followerCount: asNumber(firstValue(stats, [['followerCount']])),
    followingCount: asNumber(firstValue(stats, [['followingCount']])),
    likesCount: asNumber(firstValue(stats, [['heartCount'], ['heart']])),
    videoCount: asNumber(firstValue(stats, [['videoCount']])),
    friendCount: asNumber(firstValue(stats, [['friendCount']])),
    diggCount: asNumber(firstValue(stats, [['diggCount']])),
    createTime: toIsoTime(firstValue(user, [['createTime']])),
    nicknameModifiedAt: toIsoTime(firstValue(user, [['nickNameModifyTime'], ['nicknameModifyTime']])),
    usernameModifiedAt: toIsoTime(firstValue(user, [['uniqueIdModifyTime'], ['usernameModifyTime']])),
    storyStatus: firstValue(user, [['storyStatus']]),
    profileUrl: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
    sourceStatus: 'TikTok public profile page',
    fetchedAt: new Date().toISOString(),
    notice: 'Region is an explicit public account/profile region signal when present. It is not live GPS, IP location, or a current physical location.'
  };
}
async function fetchTikTokProfile(username) {
  const cacheKey = username.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}?lang=en`;
  try {
    const response = await fetch(profileUrl, { redirect: 'follow', signal: controller.signal, headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache'
    }});
    const html = await response.text();
    if (!response.ok) { const err = new Error(response.status === 404 ? 'TikTok profile not found.' : `TikTok returned HTTP ${response.status}.`); err.status = response.status === 404 ? 404 : 502; throw err; }
    if (!html || html.length < 1000) { const err = new Error('TikTok returned an incomplete profile page.'); err.status = 502; throw err; }
    const scripts = parseJsonScripts(html);
    let userDetail = null;
    for (const script of scripts) { userDetail = findUserDetail(script); if (userDetail) break; }
    if (!userDetail?.userInfo?.user) { const err = new Error('TikTok profile data was not available in the public page. TikTok may be limiting automated requests.'); err.status = 502; throw err; }
    const profile = normalizeProfile(username, userDetail, scripts, html);
    cache.set(cacheKey, { savedAt: Date.now(), data: profile });
    return profile;
  } finally { clearTimeout(timeout); }
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'TTT', time: new Date().toISOString() }));
app.get('/api/lookup/:username', rateLimit, async (req, res) => {
  const username = cleanUsername(req.params.username);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Enter a valid TikTok username.' });
  try { return res.json({ success: true, profile: await fetchTikTokProfile(username) }); }
  catch (error) {
    const status = Number(error?.status) || (error?.name === 'AbortError' ? 504 : 500);
    const message = error?.name === 'AbortError' ? 'TikTok lookup timed out. Try again.' : (error?.message || 'Lookup failed.');
    console.warn('Lookup failed:', username, message);
    return res.status(status).json({ error: message });
  }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`TTT running on http://localhost:${PORT}`));
