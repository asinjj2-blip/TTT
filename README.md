# TTT — TikTok Account Lookup

TTT now includes its own standalone **TikTok public read client**. It does not depend on Omar or TikWM.

The client is intentionally limited to TikTok data that a logged-out/public web session can access. It does not include CAPTCHA bypasses, stolen session cookies, or code intended to defeat TikTok access controls.

## Architecture

```text
Browser / mobile UI
      |
      v
TTT Express API
      |
      v
lib/tiktok-public-client.js
      |
      +-- TikTok public profile page JSON
      |
      +-- TikTok public user-detail route when available
```

The client tries the normal public profile page first and parses TikTok's embedded `webapp.user-detail` JSON. If that data is unavailable, it makes a best-effort request to TikTok's logged-out public user-detail route.

## What it shows

- Avatar, display name, username and bio
- Verified / public-private status
- Followers, following, likes, videos, friends and diggs when TikTok exposes them
- TikTok user ID and secUid when present
- Language when explicitly present
- Account/profile region code when explicitly present
- Account-created / nickname-change / username-change timestamps when explicitly present

## Region rule

TTT only returns a region when TikTok explicitly supplies a two-letter field such as `region`, `accountRegion`, `regionCode`, or `countryCode` in the public profile response.

It does **not** infer location from the bio, language, flags, videos, or other indirect clues. A returned region is not GPS, an IP address, a street address, or proof of a person's current physical location.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run check
npm test
npm start
```

Open `http://localhost:3000`.

## API

```http
GET /api/lookup/:username
GET /api/health
```

Example:

```bash
curl http://localhost:3000/api/lookup/tiktok
```

## Client module

The reusable client lives in:

```text
lib/tiktok-public-client.js
```

It exports `TikTokPublicClient`, `TikTokPublicAccessError`, validation helpers, JSON parsing helpers, and profile normalization helpers. The server imports this module instead of embedding provider logic directly.

## Reliability

TikTok changes its public web routes and sometimes restricts automated requests from hosting-provider IP ranges. When TikTok does not expose a usable logged-out response, TTT returns an explicit error rather than fabricating data.

That means the client can work from one network and fail from another. Improving network reachability should be handled separately from the profile parser/client itself.
