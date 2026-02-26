# Sharpness Analyzer Framework

## Goal
Determine which sportsbooks are sharpest for which markets by analyzing historical line movement data from the 5-minute snapshots.

## Architecture

```
/tmp/oddsblaze-history/          ← gzipped snapshots (every 5 min)
        ↓
  snapshot-analyzer/
    ├── src/
    │   ├── reader.js            ← reads & decompresses snapshots for a date range
    │   ├── timeline.js          ← builds per-market line timelines across books
    │   ├── sharpness.js         ← leader/follower detection + scoring
    │   ├── clv.js               ← closing line value calculator
    │   └── report.js            ← outputs reports (console, JSON, CSV)
    └── reports/                 ← generated reports
```

## Core Concepts

### 1. Line Timeline
For each unique `(eventId, market, player, line)` tuple, build a timeline:
```
{ book: "fanduel", prices: [{ts, price}, {ts, price}, ...] }
{ book: "draftkings", prices: [{ts, price}, {ts, price}, ...] }
...
```
This shows how each book's price evolves over time for the same bet.

### 2. Move Detection
A "move" = when a book's price changes between snapshots by ≥ 2 cents (filters noise).

For each move, record:
- Which book moved
- Direction (shorter or longer)
- Timestamp
- New price

### 3. Leader-Follower Analysis
For each detected move:
1. Which book moved **first**?
2. Which books followed within 5 / 15 / 30 / 60 minutes?
3. Which books **never** followed (stale/independent)?

**Sharpness Score** = weighted metric:
- Points for leading moves that others follow
- Points deducted for following (being slow)
- Weighted by how many books eventually converge to the new price

### 4. Market-Level Sharpness
Aggregate leader-follower stats per market:
```
Market: "Player Points"
  #1 FanDuel     — led 42% of moves, avg lead time 12 min
  #2 Pinnacle    — led 28% of moves, avg lead time 8 min
  #3 DraftKings  — led 15% of moves, avg lead time 22 min
  ...
  
Market: "First Basket"
  #1 DraftKings  — led 38% of moves
  #2 BetMGM      — led 22% of moves
  ...
```

### 5. Closing Line Value (CLV)
The gold standard for measuring edge. Requires:
- **Opening line**: first snapshot where a market appears
- **Closing line**: last snapshot before game starts (event goes live)
- **CLV of a bet**: `(closing_price / bet_price) - 1`

Positive CLV = you got a better price than the market settled on = edge.

#### Book-Level CLV
Compare each book's opening price to FanDuel's closing price:
- Books whose openers consistently differ from FD close = soft/exploitable
- Books whose openers match FD close = sharp

### 6. Stale Line Detection
Flag lines that haven't moved in >2 hours while 3+ other books have moved:
- These are the juiciest spots for +EV bets
- Track which books are stalest for which markets

## Reports

### Daily Sharpness Report
```
=== Sharpness Report: 2026-02-25 ===

PLAYER POINTS
  Leader: FanDuel (42% of moves initiated)
  Stalest: Fliff (avg 45 min behind), BetParx (avg 38 min behind)
  
FIRST BASKET  
  Leader: DraftKings (38% of moves initiated)
  Stalest: Circa (no movement detected), Bet365 (avg 60 min behind)

STALE LINE ALERTS (live):
  BetParx Player Points: LeBron James O24.5 @ 1.91 — FD/DK/MGM all at 1.85
  Fliff Player Rebounds: Giannis O12.5 @ 2.05 — market consensus 1.95
```

### Weekly Trend Report
- Is a book getting sharper or softer over time?
- Which markets have the most cross-book disagreement (= most opportunity)?
- Average number of exploitable stale lines per day

## Implementation Phases

### Phase 1: Reader + Timeline Builder
- Read snapshots for a date range
- Build line timelines per (event, market, player, line, book)
- Output: JSON timeline files

### Phase 2: Move Detection + Leader-Follower
- Detect price moves ≥ 2 cents
- For each move, find who led and who followed
- Compute per-book, per-market sharpness scores

### Phase 3: CLV Calculator
- Identify opening and closing lines per event
- Calculate CLV using FanDuel close as benchmark
- Track book-level CLV distributions

### Phase 4: Stale Line Detector (Real-Time)
- Run against latest cache (not just historical)
- Alert when a book's line is significantly off consensus
- Could feed directly into bot alerts

### Phase 5: Dashboard / Reporting
- Daily/weekly automated reports
- CSV exports for deeper analysis
- Telegram alerts for high-confidence stale lines

## Data Requirements
- **Minimum 1 week** of snapshots before sharpness scores are meaningful
- **~2-4 weeks** for market-level confidence
- Games with heavy action (primetime, playoffs) produce cleaner signals

## Storage Estimates
- 288 snapshots/day × ~1.5MB = ~430MB/day
- 7-day window = ~3GB
- 30-day window (if extended) = ~13GB — would need disk upgrade on VPS

## Integration with Bots
Once sharpness data is available:
1. **Playbook Bot**: Weight alerts by book sharpness — FD move = high signal, Fliff move = low signal
2. **Long Shot Scanner**: Prioritize scanning soft books for stale lines
3. **Future +EV Bot**: Auto-detect stale lines and calculate expected value using sharp book as fair value
