# OddsBlaze Poller

Centralized odds fetcher for all betting bots. Polls OddsBlaze every 4 seconds and writes to a shared JSON cache file that other bots read from.

## Why

One API key, one poller, multiple bots. Instead of each bot calling OddsBlaze independently (burning 3x the API calls), this single process fetches once and all bots read locally.

## Setup

```bash
cp .env.example .env
# Edit .env with your API key
npm install
npm start
```

## How It Works

1. Poller hits OddsBlaze API every 4 seconds (15 calls/min × 15 books = 15 API calls per poll)
2. Writes all data to `/tmp/oddsblaze-cache.json` (atomic write)
3. Keeps historical snapshots for the last 60 minutes (configurable)
4. Auto-prunes old data to prevent disk bloat

## Reading the Cache (from your bots)

```javascript
import { getLatestOdds, getCacheAge, isCacheHealthy } from '../oddsblaze-poller/src/reader.js';

// Get latest odds
const odds = getLatestOdds();
// odds = { draftkings: [...events], fanduel: [...events], ... }

// Check freshness
const ageMs = getCacheAge();
const healthy = isCacheHealthy(10000); // true if < 10s old

// Get history for line movement
import { getHistory } from '../oddsblaze-poller/src/reader.js';
const snapshots = getHistory(); // [{ timestamp, events }, ...]
```

## Cache Structure

```json
{
  "meta": {
    "lastUpdated": "2026-02-20T03:45:00.000Z",
    "lastUpdatedMs": 1740024300000,
    "pollCount": 150,
    "pollIntervalMs": 4000,
    "league": "nba",
    "sportsbooks": ["draftkings", "fanduel", ...],
    "errorCount": 2
  },
  "latest": {
    "draftkings": [/* raw OddsBlaze events */],
    "fanduel": [/* raw OddsBlaze events */],
    ...
  }
}
```

## PM2 (Production)

```bash
pm2 start src/poller.js --name oddsblaze-poller
pm2 save
```

## Consumers

- **NBA Playbook First Bet Bot** — first basket odds
- **Long Shot Scanner Bot** — long shot props
- **Bet With Moose** — social betting odds
