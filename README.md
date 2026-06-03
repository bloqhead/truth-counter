# Truth Counter

A static dashboard tracking Trump's Truth Social post count. No backend, no scraping — just a well-sourced JSON file and a Vue 3 frontend served via GitHub Pages.

**Live site:** https://bloqhead.github.io/truth-counter

## How to update the data

Edit `public/data.json`. That's it. Push to `main` and GitHub Actions redeploys in ~30 seconds.

```json
{
  "updatedAt": "2026-06-03",
  "yearData": [
    { "year": 2026, "posts": 2700, "estimated": true, "note": "Source note here" }
  ]
}
```

Set `"estimated": false` for a year when you have a confirmed full-year count.

## Sources to check periodically

- Roll Call, Washington Post, AFP, NPR — all publish periodic Trump posting analyses
- Financial Times — published a detailed 2026 breakdown in May 2026
- WCVB/Get the Facts — published confirmed 2025 full-year count (6,168 posts)

## Stack

- Vue 3 (CDN, no build step)
- GitHub Pages (free)
- `public/data.json` — manually updated source of truth
