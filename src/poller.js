import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';

// ─── Config ────────────────────────────────────────────────────────
const API_KEY = process.env.ODDSBLAZE_API_KEY;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '4000', 10);
const CACHE_PATH = process.env.CACHE_FILE_PATH || '/tmp/oddsblaze-cache.json';
const LEAGUE = process.env.LEAGUE || 'nba';
const API_BASE = 'https://odds.oddsblaze.com/';

if (!API_KEY) {
  console.error('ODDSBLAZE_API_KEY is required');
  process.exit(1);
}

const SPORTSBOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'betrivers',
  'fanatics', 'betparx', 'fliff', 'thescore', 'pinnacle',
  'circa', 'bet365', 'bally-bet', 'hard-rock', 'prophetx'
];

// ─── State ─────────────────────────────────────────────────────────
let pollCount = 0;
let lastPollMs = 0;
let errorCount = 0;

// ─── Fetching ──────────────────────────────────────────────────────

async function fetchAllSportsbooks() {
  const results = {};
  const promises = SPORTSBOOKS.map(async (book) => {
    try {
      const url = `${API_BASE}?key=${API_KEY}&sportsbook=${book}&league=${LEAGUE}`;
      const resp = await axios.get(url, { timeout: 15000 });
      if (resp.data && resp.data.events) {
        results[book] = resp.data.events;
      }
    } catch (err) {
      errorCount++;
    }
  });
  await Promise.all(promises);
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
    // Latest snapshot — the only thing bots need
    latest: latestEvents,
  };

  // Atomic write: write to tmp then rename
  const tmpPath = CACHE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(cache), 'utf8');
  fs.renameSync(tmpPath, CACHE_PATH);
}

// ─── Poll Loop ─────────────────────────────────────────────────────

async function poll() {
  const start = Date.now();
  try {
    const events = await fetchAllSportsbooks();
    const bookCount = Object.keys(events).length;
    const eventCount = Object.values(events).reduce((sum, e) => sum + e.length, 0);

    writeCache(events);

    pollCount++;
    lastPollMs = Date.now() - start;

    if (pollCount % 15 === 1) {
      console.log(`[${new Date().toISOString()}] Poll #${pollCount} | ${bookCount} books | ${eventCount} events | ${lastPollMs}ms`);
    }
  } catch (err) {
    errorCount++;
    console.error(`[${new Date().toISOString()}] Poll error: ${err.message}`);
  }
}

// ─── Start ─────────────────────────────────────────────────────────

console.log(`OddsBlaze Poller starting`);
console.log(`  League: ${LEAGUE}`);
console.log(`  Interval: ${POLL_INTERVAL}ms`);
console.log(`  Cache: ${CACHE_PATH}`);
console.log(`  Sportsbooks: ${SPORTSBOOKS.length}`);
console.log('');

// Initial poll immediately
poll();
setInterval(poll, POLL_INTERVAL);
