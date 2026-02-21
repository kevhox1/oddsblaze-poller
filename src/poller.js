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

// ─── Market Filter ─────────────────────────────────────────────────
// Only keep markets that our bots actually use.
// Playbook First Bets: first basket + method markets
// Long Shot Scanner: player props + first basket
const KEEP_MARKETS = new Set([
  // First basket (Playbook + Scanner)
  'First Basket',
  'First Field Goal',             // BetMGM
  'Away Team First Basket',
  'Home Team First Basket',
  'Away Team First Field Goal',
  'Home Team First Field Goal',
  'First Basket Method 5-Way',
  'First Basket Method 3-Way',
  // Player props (Scanner)
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

// ─── State ─────────────────────────────────────────────────────────
let pollCount = 0;
let lastPollMs = 0;
let errorCount = 0;
let polling = false; // guard against overlapping polls

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

// ─── Filter ────────────────────────────────────────────────────────

function filterEvents(bookEvents) {
  const now = Date.now();
  const filtered = {};
  for (const [book, events] of Object.entries(bookEvents)) {
    filtered[book] = events.map(event => {
      // Keep event metadata, filter odds to only relevant markets
      const filteredOdds = (event.odds || []).filter(odd => {
        const market = odd.market || '';
        return KEEP_MARKETS.has(market);
      });
      return {
        id: event.id,
        teams: event.teams,
        date: event.date,
        live: event.live,
        odds: filteredOdds,
      };
    }).filter(event => {
      // Drop live events
      if (event.live) return false;
      // Drop events that have already started (game time has passed)
      if (event.date) {
        const gameTime = new Date(event.date).getTime();
        if (gameTime <= now) return false;
      }
      return true;
    });
  }
  return filtered;
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
  if (polling) return; // skip if previous poll still running
  polling = true;
  const start = Date.now();
  try {
    const rawEvents = await fetchAllSportsbooks();
    const filtered = filterEvents(rawEvents);

    const bookCount = Object.keys(filtered).length;
    const oddsCount = Object.values(filtered).reduce(
      (sum, events) => sum + events.reduce((s, e) => s + e.odds.length, 0), 0
    );

    writeCache(filtered);

    pollCount++;
    lastPollMs = Date.now() - start;

    if (pollCount % 15 === 1) {
      const fileSize = (fs.statSync(CACHE_PATH).size / 1024).toFixed(0);
      console.log(`[${new Date().toISOString()}] Poll #${pollCount} | ${bookCount} books | ${oddsCount} odds | ${lastPollMs}ms | ${fileSize}KB`);
    }
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
