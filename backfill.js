/**
 * backfill.js
 *
 * One-time (or periodic) script that paginates through Trump's full
 * Truth Social post history and builds accurate per-year counts.
 *
 * Writes results to backfill.json, which server.js reads at startup
 * to populate the year-by-year bar chart with real numbers instead
 * of estimates.
 *
 * Usage:
 *   node backfill.js              # full crawl from scratch
 *   node backfill.js --resume     # resume from last saved cursor
 *   node backfill.js --dry-run    # fetch first page only, don't write
 *
 * Rate limiting: Truth Social doesn't publish limits, so we use a
 * conservative 1 req/sec with exponential backoff on 429s.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Respect DATA_DIR env var so output lands on Render's persistent disk
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const BACKFILL_FILE = path.join(DATA_DIR, 'backfill.json');
const CURSOR_FILE   = path.join(DATA_DIR, '.backfill-cursor');

const TS_BASE       = 'https://truthsocial.com/api/v1';
const ACCOUNT_HANDLE = 'realDonaldTrump';
const PAGE_SIZE     = 40;      // Truth Social max per page
const DELAY_MS      = 1100;    // ~1 req/sec
const MAX_RETRIES   = 5;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESUME  = args.includes('--resume');

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function fetchWithBackoff(url, retries = 0) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TruthCounter/1.0)',
        'Accept': 'application/json',
      },
      timeout: 15000,
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || status === 503) && retries < MAX_RETRIES) {
      const wait = Math.pow(2, retries + 2) * 1000; // 4s, 8s, 16s, 32s, 64s
      log(`  Rate limited (${status}). Waiting ${wait / 1000}s before retry ${retries + 1}/${MAX_RETRIES}...`);
      await sleep(wait);
      return fetchWithBackoff(url, retries + 1);
    }
    throw err;
  }
}

// ── Resolve account ID ────────────────────────────────────────────────────────

async function resolveAccountId() {
  log(`Resolving account ID for @${ACCOUNT_HANDLE}...`);
  const data = await fetchWithBackoff(`${TS_BASE}/accounts/lookup?acct=${ACCOUNT_HANDLE}`);
  if (!data?.id) throw new Error('Could not resolve account ID');
  log(`  Account ID: ${data.id} (${data.statuses_count?.toLocaleString()} total posts)`);
  return { id: data.id, totalPosts: data.statuses_count };
}

// ── Main crawl ────────────────────────────────────────────────────────────────

async function crawl() {
  log('=== Truth Social Backfill ===');
  if (DRY_RUN) log('DRY RUN — will not write output');
  if (RESUME)  log('RESUME mode — loading cursor from disk');

  const { id: accountId, totalPosts } = await resolveAccountId();

  // Per-year counts we'll build up
  const yearCounts = {};

  // Pagination cursor (oldest post ID seen — we paginate backwards in time)
  let maxId = null;
  let pageNum = 0;
  let totalSeen = 0;
  let done = false;

  // Resume: load saved cursor and partial counts
  if (RESUME && fs.existsSync(CURSOR_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8'));
      maxId = saved.maxId;
      Object.assign(yearCounts, saved.yearCounts);
      totalSeen = saved.totalSeen;
      log(`  Resuming from cursor ${maxId} (${totalSeen.toLocaleString()} posts already counted)`);
    } catch (e) {
      log(`  Warning: could not load cursor — starting fresh (${e.message})`);
    }
  }

  while (!done) {
    pageNum++;
    let url = `${TS_BASE}/accounts/${accountId}/statuses?limit=${PAGE_SIZE}&exclude_replies=false&exclude_reblogs=false`;
    if (maxId) url += `&max_id=${maxId}`;

    log(`Page ${pageNum} — fetching... (seen: ${totalSeen.toLocaleString()}/${totalPosts?.toLocaleString() ?? '?'})`);

    const posts = await fetchWithBackoff(url);

    if (!Array.isArray(posts) || posts.length === 0) {
      log('  Empty page — crawl complete.');
      done = true;
      break;
    }

    for (const post of posts) {
      const year = new Date(post.created_at).getFullYear();
      yearCounts[year] = (yearCounts[year] ?? 0) + 1;
      maxId = post.id; // keep updating — last in page is the oldest
    }

    totalSeen += posts.length;

    // Save cursor after every page so we can resume
    if (!DRY_RUN) {
      fs.writeFileSync(CURSOR_FILE, JSON.stringify({ maxId, yearCounts, totalSeen, updatedAt: new Date().toISOString() }, null, 2));
    }

    // Progress
    const pct = totalPosts ? ((totalSeen / totalPosts) * 100).toFixed(1) : '?';
    log(`  +${posts.length} posts | year spread: ${JSON.stringify(yearCounts)} | ${pct}%`);

    if (DRY_RUN) {
      log('Dry run — stopping after first page.');
      break;
    }

    if (posts.length < PAGE_SIZE) {
      log('  Short page — reached beginning of history.');
      done = true;
      break;
    }

    await sleep(DELAY_MS);
  }

  // ── Write output ────────────────────────────────────────────────────────────

  const yearData = Object.entries(yearCounts)
    .map(([year, posts]) => ({ year: parseInt(year), posts, estimated: false }))
    .sort((a, b) => a.year - b.year);

  const output = {
    yearData,
    totalCounted: totalSeen,
    crawledAt: new Date().toISOString(),
    complete: done,
    source: 'Truth Social Mastodon API (paginated statuses)',
  };

  log('\n=== Results ===');
  for (const yr of yearData) {
    log(`  ${yr.year}: ${yr.posts.toLocaleString()} posts`);
  }
  log(`  Total counted: ${totalSeen.toLocaleString()}`);

  if (!DRY_RUN) {
    fs.writeFileSync(BACKFILL_FILE, JSON.stringify(output, null, 2));
    log(`\n✅  Written to ${BACKFILL_FILE}`);

    // Clean up cursor on successful complete crawl
    if (done && fs.existsSync(CURSOR_FILE)) {
      fs.unlinkSync(CURSOR_FILE);
      log('   Cursor file removed (crawl complete).');
    }
  } else {
    log('\n(Dry run — no files written)');
    log(JSON.stringify(output, null, 2));
  }
}

crawl().catch(err => {
  log(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
