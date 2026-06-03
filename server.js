import express from 'express';
import axios from 'axios';
import cron from 'node-cron';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// On Render, use the persistent disk mount path so cache/backfill survive deploys.
// Locally, files sit next to server.js.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CACHE_FILE    = path.join(DATA_DIR, 'cache.json');
const BACKFILL_FILE = path.join(DATA_DIR, 'backfill.json');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Truth Social API ────────────────────────────────────────────────────────
// Truth Social is Mastodon-based and exposes a standard Mastodon REST API.
// The statuses_count field on the account object is the total post count.

const TS_API = 'https://truthsocial.com/api/v1/accounts/lookup?acct=realDonaldTrump';

// Fallback estimates used only when backfill.json doesn't exist yet
const ESTIMATED_BASELINES = { 2022: 2800, 2023: 7400, 2024: 8760 };
const ESTIMATED_TOTAL_THRU_2024 = Object.values(ESTIMATED_BASELINES).reduce((a, b) => a + b, 0);

function readBackfill() {
  try {
    if (fs.existsSync(BACKFILL_FILE)) {
      return JSON.parse(fs.readFileSync(BACKFILL_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[backfill] Could not read backfill.json:', e.message);
  }
  return null;
}

function buildYearData(liveTotal) {
  const currentYear = new Date().getFullYear();
  const backfill = readBackfill();

  if (backfill?.yearData?.length) {
    // Use real crawled counts for historical years
    const historical = backfill.yearData.filter(y => y.year < currentYear);
    const historicalTotal = historical.reduce((s, y) => s + y.posts, 0);
    const currentYearPosts = Math.max(0, liveTotal - historicalTotal);
    return [
      ...historical,
      { year: currentYear, posts: currentYearPosts, estimated: false },
    ];
  }

  // Fall back to estimates until backfill is run
  const years = Object.entries(ESTIMATED_BASELINES).map(([yr, posts]) => ({
    year: parseInt(yr), posts, estimated: true,
  }));
  const currentYearPosts = Math.max(0, liveTotal - ESTIMATED_TOTAL_THRU_2024);
  years.push({ year: currentYear, posts: currentYearPosts, estimated: false });
  return years;
}

function computeStats(liveTotal, yearData) {
  // Days since Truth Social launch (Feb 21, 2022)
  const launch = new Date('2022-02-21');
  const now = new Date();
  const daysSinceLaunch = Math.floor((now - launch) / (1000 * 60 * 60 * 24));

  const avgPerDay = (liveTotal / daysSinceLaunch).toFixed(1);
  const avgPerHour = (liveTotal / (daysSinceLaunch * 24)).toFixed(2);
  const avgPerWeek = (liveTotal / (daysSinceLaunch / 7)).toFixed(0);
  const minutesPerPost = ((daysSinceLaunch * 24 * 60) / liveTotal).toFixed(0);

  return {
    total: liveTotal,
    daysSinceLaunch,
    avgPerDay: parseFloat(avgPerDay),
    avgPerHour: parseFloat(avgPerHour),
    avgPerWeek: parseInt(avgPerWeek),
    minutesPerPost: parseInt(minutesPerPost),
    yearData,
  };
}

// ─── Fetch from Truth Social API ─────────────────────────────────────────────

async function fetchLiveCount() {
  console.log('[scraper] Fetching from Truth Social API...');

  const response = await axios.get(TS_API, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TruthCounter/1.0)',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });

  const account = response.data;

  if (!account || typeof account.statuses_count !== 'number') {
    throw new Error('Unexpected API response shape');
  }

  return account.statuses_count;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[cache] Read error:', e.message);
  }
  return null;
}

function writeCache(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[cache] Write error:', e.message);
  }
}

// ─── Refresh Logic ────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const liveTotal = await fetchLiveCount();
    const yearData = buildYearData(liveTotal);
    const stats = computeStats(liveTotal, yearData);

    const backfill = readBackfill();
    const payload = {
      ...stats,
      fetchedAt: new Date().toISOString(),
      source: 'truthsocial.com Mastodon API',
      backfillAvailable: !!backfill,
      backfillComplete: backfill?.complete ?? false,
      backfillCrawledAt: backfill?.crawledAt ?? null,
      error: null,
    };

    writeCache(payload);
    console.log(`[scraper] Done — ${liveTotal.toLocaleString()} total posts`);
    return payload;
  } catch (err) {
    console.error('[scraper] Error:', err.message);

    // Preserve last good cache, just flag the error
    const stale = readCache();
    if (stale) {
      stale.fetchError = err.message;
      stale.fetchErrorAt = new Date().toISOString();
      writeCache(stale);
      return stale;
    }
    throw err;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  const cached = readCache();

  const cacheAge = cached
    ? (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000 / 60 / 60
    : Infinity;

  if (!cached || req.query.refresh === 'true' || cacheAge > 6) {
    try {
      const fresh = await refresh();
      return res.json(fresh);
    } catch (err) {
      return res.status(503).json({ error: 'Fetch failed and no cache available', detail: err.message });
    }
  }

  res.json(cached);
});

app.get('/api/refresh', async (req, res) => {
  try {
    const data = await refresh();
    res.json({ ok: true, fetchedAt: data.fetchedAt, total: data.total });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/backfill-status', (req, res) => {
  const backfill = readBackfill();
  if (!backfill) return res.json({ available: false });
  res.json({
    available: true,
    complete: backfill.complete,
    totalCounted: backfill.totalCounted,
    crawledAt: backfill.crawledAt,
    yearData: backfill.yearData,
  });
});

// ─── Cron: refresh every 6 hours ─────────────────────────────────────────────
cron.schedule('0 0,6,12,18 * * *', () => {
  console.log('[cron] Scheduled refresh...');
  refresh();
});

// ─── Startup ──────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n✅  Truth Counter running on http://localhost:${PORT}`);

  const backfill = readBackfill();
  if (backfill) {
    console.log(`   Backfill: ${backfill.complete ? 'complete' : 'partial'} (${backfill.totalCounted?.toLocaleString()} posts crawled, ${backfill.crawledAt})`);
  } else {
    console.log('   Backfill: not yet run — using estimated year data. Run: node backfill.js');
  }

  const cached = readCache();
  if (!cached) {
    console.log('   No cache — fetching now...');
    try { await refresh(); } catch (e) { console.warn('   Initial fetch failed:', e.message); }
  } else {
    const age = ((Date.now() - new Date(cached.fetchedAt).getTime()) / 1000 / 60).toFixed(0);
    console.log(`   Cache: ${age} min old (${cached.total?.toLocaleString()} posts)`);
  }
});
