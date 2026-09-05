const express = require('express');
const path = require('path');
const {
  TikTokPublicClient,
  TikTokPublicAccessError,
  cleanUsername,
  isValidUsername
} = require('./lib/tiktok-public-client');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const rateBuckets = new Map();
const tiktok = new TikTokPublicClient({
  timeoutMs: Number(process.env.TTT_TIKTOK_TIMEOUT_MS || 12000),
  language: process.env.TTT_LANGUAGE || 'en-US'
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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

app.get('/api/health', (req, res) => res.json({
  ok: true,
  service: 'TTT',
  client: 'tiktok-public-client',
  time: new Date().toISOString()
}));

app.get('/api/lookup/:username', rateLimit, async (req, res) => {
  const username = cleanUsername(req.params.username);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Enter a valid TikTok username.' });

  const key = username.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return res.json({ success: true, profile: cached.data, cached: true });
  }

  try {
    const profile = await tiktok.lookup(username);
    cache.set(key, { savedAt: Date.now(), data: profile });
    return res.json({ success: true, profile, cached: false });
  } catch (error) {
    const isPublicAccessError = error instanceof TikTokPublicAccessError;
    const status = error?.code === 'INVALID_USERNAME' ? 400 : 502;
    console.warn('TTT TikTok client lookup failed:', username, error?.code || error?.message, error?.details || []);
    return res.status(status).json({
      error: isPublicAccessError
        ? error.message
        : 'TikTok public profile lookup failed.',
      code: error?.code || 'LOOKUP_FAILED'
    });
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`TTT running on http://localhost:${PORT}`);
});
