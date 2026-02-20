/**
 * Quick test — reads the cache and prints a summary.
 * Run: npm test (or node src/test-read.js)
 */

import { readCache, getCacheAge, isCacheHealthy } from './reader.js';

const cache = readCache();

if (!cache) {
  console.log('❌ No cache found. Is the poller running?');
  process.exit(1);
}

const ageMs = getCacheAge();
const ageSec = (ageMs / 1000).toFixed(1);
const healthy = isCacheHealthy(10000);

console.log(`✅ Cache found`);
console.log(`  Last updated: ${cache.meta.lastUpdated}`);
console.log(`  Age: ${ageSec}s ${healthy ? '(healthy)' : '(STALE)'}`);
console.log(`  Poll count: ${cache.meta.pollCount}`);
console.log(`  History snapshots: ${cache.meta.historySnapshots}`);
console.log(`  Errors: ${cache.meta.errorCount}`);
console.log('');

console.log('Books in latest snapshot:');
for (const [book, events] of Object.entries(cache.latest)) {
  console.log(`  ${book}: ${events.length} events`);
}
