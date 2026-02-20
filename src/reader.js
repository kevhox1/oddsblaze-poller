/**
 * OddsBlaze Cache Reader
 * 
 * Import this in your bots to read from the shared cache.
 * 
 * Usage:
 *   import { getLatestOdds, getCacheAge, isCacheHealthy } from '../oddsblaze-poller/src/reader.js';
 */

import fs from 'fs';

const DEFAULT_CACHE_PATH = '/tmp/oddsblaze-cache.json';

/**
 * Read the full cache object
 * @returns {Object|null} - { meta, latest } or null
 */
export function readCache(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Get latest odds: { [bookKey]: events[] }
 */
export function getLatestOdds(cachePath = DEFAULT_CACHE_PATH) {
  return readCache(cachePath)?.latest || null;
}

/**
 * Cache age in ms (Infinity if missing)
 */
export function getCacheAge(cachePath = DEFAULT_CACHE_PATH) {
  const cache = readCache(cachePath);
  if (!cache?.meta?.lastUpdatedMs) return Infinity;
  return Date.now() - cache.meta.lastUpdatedMs;
}

/**
 * True if cache exists and is < maxAgeMs old
 */
export function isCacheHealthy(maxAgeMs = 10000, cachePath = DEFAULT_CACHE_PATH) {
  return getCacheAge(cachePath) < maxAgeMs;
}

export default { readCache, getLatestOdds, getCacheAge, isCacheHealthy };
