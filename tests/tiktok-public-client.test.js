const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TikTokPublicClient,
  findExplicitRegion,
  normalizeProfile
} = require('../lib/tiktok-public-client');

test('extracts only explicit two-letter region fields', () => {
  assert.deepEqual(findExplicitRegion({ profile: { region: 'US' } }), { code: 'US', source: 'profile.region' });
  assert.equal(findExplicitRegion({ bio: 'I live in US', language: 'en' }), null);
});

test('normalizes public TikTok user detail without guessing location', () => {
  const profile = normalizeProfile('sample', {
    userInfo: {
      user: {
        id: '12345',
        uniqueId: 'sample',
        nickname: 'Sample User',
        signature: 'hello',
        verified: false,
        privateAccount: false,
        region: 'US'
      },
      stats: {
        followerCount: 100,
        followingCount: 20,
        heartCount: 500,
        videoCount: 10
      }
    }
  }, 'fixture');
  assert.equal(profile.username, 'sample');
  assert.equal(profile.regionCode, 'US');
  assert.equal(profile.followerCount, 100);
  assert.match(profile.notice, /explicit field/i);
});

test('parses profile JSON from a public profile page response', async () => {
  const payload = {
    __DEFAULT_SCOPE__: {
      'webapp.user-detail': {
        userInfo: {
          user: { id: '99', uniqueId: 'demo', nickname: 'Demo', region: 'DE' },
          stats: { followerCount: 5 }
        }
      }
    }
  };
  const html = `<html><body>${'x'.repeat(1100)}<script type="application/json">${JSON.stringify(payload)}</script></body></html>`;
  const client = new TikTokPublicClient({ fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }) });
  const profile = await client.lookup('demo');
  assert.equal(profile.displayName, 'Demo');
  assert.equal(profile.regionCode, 'DE');
  assert.equal(profile.sourceStatus, 'TikTok public profile page');
});

test('falls back to public user-detail JSON when profile page has no profile data', async () => {
  let calls = 0;
  const client = new TikTokPublicClient({
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('/api/user/detail/')) {
        return new Response(JSON.stringify({ userInfo: { user: { id: '7', uniqueId: 'fallback', nickname: 'Fallback' }, stats: { followerCount: 12 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(`<html>${'x'.repeat(1200)}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    }
  });
  const profile = await client.lookup('fallback');
  assert.equal(profile.username, 'fallback');
  assert.equal(profile.followerCount, 12);
  assert.equal(profile.sourceStatus, 'TikTok public user-detail endpoint');
  assert.equal(calls, 2);
});
