# TTT TikTok Worker

This worker is the open-source transport for TTT. It uses `davidteather/TikTok-Api` with Playwright/Chromium to retrieve public TikTok profile data from a logged-out session.

It does not depend on Omar or TikWM. It does not include CAPTCHA bypasses, stolen cookies, private-account scraping, or login-required routes.

## Easiest Windows setup

1. Download or clone the TTT repository onto a Windows PC.
2. Open the `worker` folder.
3. Double-click `START-TTT-WORKER.bat`.
4. The first run installs the Python packages, Playwright Chromium, and Cloudflare Tunnel.
5. Keep the window open. It prints a public `https://...trycloudflare.com` URL and saves it to `worker-url.txt`.
6. Configure that URL in the live TTT AppDeploy app as the `TTT_WORKER_URL` backend secret.

The quick-tunnel URL can change when the worker is restarted, so update `TTT_WORKER_URL` after a new tunnel URL is created.

## Endpoints

- `GET /health`
- `GET /lookup/{username}`

The lookup response uses the same profile shape as the TTT web application.

## Optional environment variables

- `TTT_MS_TOKEN` — an optional TikTok `msToken` supplied by the operator. The worker can attempt a logged-out session without it.
- `TTT_PROXY_SERVER` — optional HTTP/SOCKS proxy URL if the current network is blocked by TikTok.
- `TTT_WORKER_TOKEN` — optional bearer token protecting the `/lookup` endpoint.

Do not commit any token, cookie, password, proxy credential, or API secret to GitHub.

## Docker

The included Dockerfile installs Python, the worker dependencies, and Playwright Chromium. Build it from the repository root so the Docker build can copy `worker/requirements.txt` and `worker/main.py`.

## Region behavior

TTT returns a region only when the TikTok profile response explicitly includes a two-letter field such as `region`, `accountRegion`, `regionCode`, or `countryCode`. It does not infer a location from the worker IP, proxy country, browser language, bio, flags, videos, or content.
