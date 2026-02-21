import 'dotenv/config';
import https from 'https';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────
const API_KEY = process.env.ODDSBLAZE_API_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);
const CACHE_PATH = process.env.CACHE_FILE_PATH || '/tmp/oddsblaze-cache.json';
const LEAGUE = process.env.LEAGUE || 'nba';
const API_HOST = 'odds.oddsblaze.com';

if (!API_KEY) {
  console.error('ODDSBLAZE_API_KEY is required');
  process.exit(1);
}

const SPORTSBOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers',
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

// ─── Start ─────────────────────────────────────────────────────────

console.log(`OddsBlaze Poller starting`);
console.log(`  League: ${LEAGUE}`);
console.log(`  Interval: ${POLL_INTERVAL}ms`);
console.log(`  Cache: ${CACHE_PATH}`);
console.log(`  Sportsbooks: ${SPORTSBOOKS.length}`);
console.log(`  Tracked markets: ${KEEP_MARKETS.size}`);
console.log('');

poll();
setInterval(poll, POLL_INTERVAL);
