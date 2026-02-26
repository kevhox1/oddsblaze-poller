import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';

// ─── Config ────────────────────────────────────────────────────────
const API_KEY = process.env.ODDSBLAZE_API_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);
const CACHE_PATH = process.env.CACHE_FILE_PATH || '/tmp/oddsblaze-cache.json';
const LEAGUE = process.env.LEAGUE || 'nba';
const API_HOST = 'odds.oddsblaze.com';

const SNAPSHOT_INTERVAL = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '300000', 10); // 5 min
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || '/tmp/oddsblaze-history';
const SNAPSHOT_RETENTION_DAYS = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '7', 10);

if (!API_KEY) {
  console.error('ODDSBLAZE_API_KEY is required');
  process.exit(1);
}

const SPORTSBOOKS = [
  'draftkings', 'fanduel', 'fanduel-yourway', 'betmgm', 'caesars', 'betrivers',
  'fanatics', 'betparx', 'fliff', 'thescore', 'pinnacle',
  'circa', 'bet365', 'bally-bet', 'hard-rock', 'prophetx'
];

// ─── Market Filter ─────────────────────────────────────────────────
const KEEP_MARKETS = new Set([
  'First Basket',
  'First Field Goal',
  'Away Team First Basket',
  'Home Team First Basket',
  'Away Team First Field Goal',
  'Home Team First Field Goal',
  'First Basket Method 5-Way',
  'First Basket Method 3-Way',
  'Player Points',
  'Player Rebounds',
  'Player Assists',
  'Player Threes Made',
  'Player Blocks',
  'Player Steals',
  'Player Blocks + Steals',
  'Player Points + Rebounds + Assists',
  'Player Points + Rebounds',
  'Player Points + Assists',
  'Player Rebounds + Assists',
  'Player Double Double',
  'Player Triple Double',
]);

// ─── Reusable HTTPS agent (connection pooling) ─────────────────────
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 5,        // limit concurrent connections
  maxFreeSockets: 5,
  timeout: 15000,
});

// ─── State ─────────────────────────────────────────────────────────
let pollCount = 0;
let lastPollMs = 0;
let errorCount = 0;
let polling = false;

// ─── Fetch single book (native https, no axios) ───────────────────

function fetchBook(book) {
  return new Promise((resolve) => {
    const path = `/?key=${API_KEY}&sportsbook=${book}&league=${LEAGUE}`;
    const req = https.get({ hostname: API_HOST, path, agent, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          chunks.length = 0; // release refs
          const data = JSON.parse(raw);
          if (data && data.events) {
            // Filter immediately — don't hold the full response
            const filtered = filterBookEvents(data.events);
            resolve({ book, events: filtered });
          } else {
            resolve({ book, events: [] });
          }
        } catch {
          errorCount++;
          resolve({ book, events: [] });
        }
      });
    });
    req.on('error', () => { errorCount++; resolve({ book, events: [] }); });
    req.on('timeout', () => { req.destroy(); errorCount++; resolve({ book, events: [] }); });
  });
}

// ─── Filter (per-book, applied immediately after parse) ────────────

function filterBookEvents(events) {
  const out = [];
  for (const event of events) {
    if (event.live) continue; // drop live events
    const odds = [];
    for (const odd of (event.odds || [])) {
      if (KEEP_MARKETS.has(odd.market || '')) {
        odds.push(odd);
      }
    }
    out.push({
      id: event.id,
      teams: event.teams,
      date: event.date,
      live: event.live,
      odds,
    });
  }
  return out;
}

// ─── Fetch all books (batched, 5 at a time) ────────────────────────

async function fetchAllSportsbooks() {
  const results = {};
  const BATCH_SIZE = 5;
  for (let i = 0; i < SPORTSBOOKS.length; i += BATCH_SIZE) {
    const batch = SPORTSBOOKS.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(fetchBook));
    for (const { book, events } of batchResults) {
      results[book] = events;
    }
  }
  return results;
}

// ─── Write Cache ───────────────────────────────────────────────────

function writeCache(latestEvents) {
  const cache = {
    meta: {
      lastUpdated: new Date().toISOString(),
      lastUpdatedMs: Date.now(),
      pollCount,
      pollIntervalMs: POLL_INTERVAL,
      league: LEAGUE,
      sportsbooks: SPORTSBOOKS,
      errorCount,
    },
    latest: latestEvents,
  };

  const tmpPath = CACHE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf8');
  fs.renameSync(tmpPath, CACHE_PATH);
}

// ─── Poll Loop ─────────────────────────────────────────────────────

async function poll() {
  if (polling) return;
  polling = true;
  const start = Date.now();
  try {
    const filtered = await fetchAllSportsbooks();

    const bookCount = Object.keys(filtered).length;
    const oddsCount = Object.values(filtered).reduce(
      (sum, events) => sum + events.reduce((s, e) => s + e.odds.length, 0), 0
    );

    writeCache(filtered);
    latestCache = filtered;

    pollCount++;
    lastPollMs = Date.now() - start;

    // Log every 15th poll + memory usage
    if (pollCount % 15 === 1) {
      const fileSize = (fs.statSync(CACHE_PATH).size / 1024).toFixed(0);
      const memMB = (process.memoryUsage.rss() / 1024 / 1024).toFixed(0);
      console.log(`[${new Date().toISOString()}] Poll #${pollCount} | ${bookCount} books | ${oddsCount} odds | ${lastPollMs}ms | ${fileSize}KB | ${memMB}MB RSS`);
    }

    // Hint GC if available (run with --expose-gc)
    if (global.gc) global.gc();

  } catch (err) {
    errorCount++;
    console.error(`[${new Date().toISOString()}] Poll error: ${err.message}`);
  } finally {
    polling = false;
  }
}

// ─── Snapshots (historical line movement) ──────────────────────────

let snapshotCount = 0;

function slimCache(latestEvents) {
  const slim = {};
  for (const [book, events] of Object.entries(latestEvents)) {
    const rows = [];
    for (const ev of events) {
      for (const odd of ev.odds) {
        rows.push({
          e: ev.id,                          // event id
          m: odd.market,                     // market name
          s: odd.selection?.name || '',      // selection (player name)
          l: odd.selection?.line ?? null,     // line
          p: odd.price,                      // decimal price
          mn: odd.main ?? null,              // main line flag
        });
      }
    }
    if (rows.length) slim[book] = rows;
  }
  return slim;
}

function writeSnapshot(latestEvents) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snap = {
      ts: new Date().toISOString(),
      tsMs: Date.now(),
      data: slimCache(latestEvents),
    };
    const json = JSON.stringify(snap);
    const gz = gzipSync(json, { level: 6 });
    const filePath = path.join(SNAPSHOT_DIR, `${ts}.json.gz`);
    fs.writeFileSync(filePath, gz);
    snapshotCount++;
    const sizeMB = (gz.length / 1024 / 1024).toFixed(2);
    console.log(`[${new Date().toISOString()}] Snapshot #${snapshotCount} | ${sizeMB}MB gz | ${filePath}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Snapshot error: ${err.message}`);
  }
}

function purgeOldSnapshots() {
  try {
    const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 86400000;
    const files = fs.readdirSync(SNAPSHOT_DIR);
    let removed = 0;
    for (const f of files) {
      const fp = path.join(SNAPSHOT_DIR, f);
      const stat = fs.statSync(fp);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        removed++;
      }
    }
    if (removed) console.log(`[${new Date().toISOString()}] Purged ${removed} old snapshots`);
  } catch { /* dir may not exist yet */ }
}

// Track latest data for snapshot timer
let latestCache = null;

// ─── Start ─────────────────────────────────────────────────────────

console.log(`OddsBlaze Poller starting`);
console.log(`  League: ${LEAGUE}`);
console.log(`  Interval: ${POLL_INTERVAL}ms`);
console.log(`  Cache: ${CACHE_PATH}`);
console.log(`  Sportsbooks: ${SPORTSBOOKS.length}`);
console.log(`  Tracked markets: ${KEEP_MARKETS.size}`);
console.log('');

console.log(`  Snapshots: every ${SNAPSHOT_INTERVAL / 1000}s → ${SNAPSHOT_DIR}`);
console.log(`  Retention: ${SNAPSHOT_RETENTION_DAYS} days`);
console.log('');

poll();
setInterval(poll, POLL_INTERVAL);

// Snapshot timer — independent of poll loop
setInterval(() => {
  if (latestCache) writeSnapshot(latestCache);
}, SNAPSHOT_INTERVAL);

// Purge old snapshots once on start, then daily
purgeOldSnapshots();
setInterval(purgeOldSnapshots, 86400000);
