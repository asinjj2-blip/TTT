# TTT — TikTok Account Lookup

TTT is a small web app that accepts a TikTok username and reads **public profile information** from TikTok's public profile page.

## What it shows

- Avatar, display name, username and bio
- Verified / public-private status
- Followers, following, likes, videos, friends and diggs when TikTok exposes them
- TikTok user ID
- Language when explicitly present
- Account/profile region code when explicitly present
- Account-created / nickname-change / username-change timestamps when explicitly present

### Important region note

TTT does **not** claim to reveal a person's current location. The region result is only an explicit public TikTok account/profile region field found in the public page. It is not GPS, an IP address, a street address, or a live physical location.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

For development:

```bash
npm run dev
```

## API

```http
GET /api/lookup/:username
GET /api/health
```

Example:

```bash
curl http://localhost:3000/api/lookup/tiktok
```

## Deployment

This is a normal Node/Express app. Deploy it to any host that supports Node.js 20+ and provides a `PORT` environment variable.

## Reliability

TikTok can change its public page format or limit automated server requests. If that happens, the app returns an error instead of fabricating missing fields. The parser is intentionally conservative about region and location data.
