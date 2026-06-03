# Truth Counter

A live dashboard tracking Trump's Truth Social post count, powered by Node/Express + Vue 3.

## How It Works

Truth Social is built on Mastodon, which exposes a standard public REST API. The server hits the `/api/v1/accounts/lookup` endpoint to get Trump's account data, which includes `statuses_count` — the total number of posts. No scraping, no auth needed.

**Refresh schedule:** Every 6 hours via node-cron (00:00, 06:00, 12:00, 18:00). Results are cached to `cache.json` so the server never hits Truth Social on every page load.

## Setup

```bash
npm install
npm start
# → http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Vue frontend |
| `GET /api/stats` | Cached stats (auto-refreshes if >6h old) |
| `GET /api/stats?refresh=true` | Force a fresh fetch |
| `GET /api/refresh` | Trigger a background refresh |

## Deployment (DigitalOcean / your existing setup)

Since you're already running Node on DO, just:

```bash
# Clone/copy project to your server
npm install --production

# Run with PM2 (recommended)
npm install -g pm2
pm2 start server.js --name truth-counter
pm2 save
pm2 startup
```

Then proxy via Caddy (you're already using it for guillotine.club):

```
truth.yourdomain.com {
  reverse_proxy localhost:3000
}
```

## Data Notes

- **Live total**: pulled directly from Truth Social's Mastodon API (`statuses_count`)
- **Per-year breakdown**: 2022–2024 are estimated from cross-referenced reporting (Roll Call, Washington Post, AFP, WCVB). The current year is derived as `live total − historical sum`.
- **Historical baselines used**: 2022 ≈ 2,800 | 2023 ≈ 7,400 | 2024 ≈ 8,760

## Project Structure

```
truth-counter/
├── server.js        # Express server, API, cron, cache
├── cache.json       # Auto-generated on first run
├── package.json
├── public/
│   └── index.html   # Vue 3 frontend (CDN, no build step)
└── README.md
```
