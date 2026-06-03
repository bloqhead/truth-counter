/**
 * backfill.js
 *
 * Pulls the full CNN Truth Social archive (updated every 5 min) and
 * builds accurate per-year post counts from real timestamps.
 *
 * The CNN archive is a JSON array of every Trump Truth Social post —
 * originally maintained by LA Times data journalist Derek Stiles,
 * now hosted by CNN at ix.cnn.io. No Truth Social involvement.
 *
 * Usage:
 *   node backfill.js           # full pull and count
 *   node backfill.js --dry-run # fetch but don't write output
 *
 * Output: backfill.json (or $DATA_DIR/backfill.json on Render)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Respect DATA_DIR env var so output lands on Render's persistent disk
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const BACKFILL_FILE = path.join(DATA_DIR, 'backfill.json');

const CNN_ARCHIVE_URL = 'https://ix.cnn.io/data/truth-social/truth_archive.json';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function run() {
  log('=== Truth Social Backfill (via CNN archive) ===');
  if (DRY_RUN) log('DRY RUN — will not write output');

  log(`Fetching archive from ${CNN_ARCHIVE_URL} ...`);
  log('(This may take a moment — it\'s the full post history)');

  const response = await axios.get(CNN_ARCHIVE_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TruthCounter/1.0)',
      'Accept': 'application/json',
    },
    timeout: 60000,
    maxContentLength: 200 * 1024 * 1024,
  });

  const posts = response.data;

  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error('Unexpected archive format');
  }

  log(`Fetched ${posts.length.toLocaleString()} posts. Counting by year...`);

  // Count by year using created_at timestamp
  const yearCounts = {};
  let skipped = 0;

  for (const post of posts) {
    const dateStr = post.created_at || post.date || post.timestamp;
    if (!dateStr) { skipped++; continue; }
    const year = new Date(dateStr).getFullYear();
    if (isNaN(year)) { skipped++; continue; }
    yearCounts[year] = (yearCounts[year] ?? 0) + 1;
  }

  if (skipped > 0) log(`  Skipped ${skipped} posts with missing/invalid dates`);

  const yearData = Object.entries(yearCounts)
    .map(([year, posts]) => ({ year: parseInt(year), posts, estimated: false }))
    .sort((a, b) => a.year - b.year);

  log('\n=== Results ===');
  for (const yr of yearData) {
    log(`  ${yr.year}: ${yr.posts.toLocaleString()} posts`);
  }
  log(`  Total: ${posts.length.toLocaleString()} posts`);

  const output = {
    yearData,
    totalCounted: posts.length,
    crawledAt: new Date().toISOString(),
    complete: true,
    source: 'CNN Truth Social archive (ix.cnn.io) — updated every 5 minutes',
  };

  if (!DRY_RUN) {
    fs.writeFileSync(BACKFILL_FILE, JSON.stringify(output, null, 2));
    log(`\n✅  Written to ${BACKFILL_FILE}`);
  } else {
    log('\n(Dry run — no files written)');
    log(JSON.stringify(output, null, 2));
  }
}

run().catch(err => {
  log(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
});
