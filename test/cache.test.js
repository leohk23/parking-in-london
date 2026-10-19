import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';
import { fetchOsm } from '../src/sources/osm.js';
import { addRecent, loadRecent, clearRecent } from '../src/recent.js';

function memoryStorage({ failWrites = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (failWrites) throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
}

test('cache returns fresh entries and drops expired ones', () => {
  const storage = memoryStorage();
  const cache = createCache('t', { maxAgeMs: 1000, storage });
  cache.set('query A', { n: 1 });
  assert.deepEqual(cache.get('query A'), { n: 1 });
  assert.equal(cache.get('query B'), null);
  const [id] = JSON.parse(storage.getItem('park-nearby:t:index'));
  const entry = JSON.parse(storage.getItem(id));
  storage.setItem(id, JSON.stringify({ ...entry, savedAt: Date.now() - 2000 }));
  assert.equal(cache.get('query A'), null);
});

test('cache keeps only the newest entries', () => {
  const storage = memoryStorage();
  const cache = createCache('t', { maxAgeMs: 60000, maxEntries: 2, storage });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
  assert.equal([...storage.data.keys()].filter((k) => !k.endsWith(':index')).length, 2);
});

test('cache copes with full or missing storage', () => {
  const full = createCache('t', { maxAgeMs: 60000, storage: memoryStorage({ failWrites: true }) });
  full.set('a', 1);
  assert.equal(full.get('a'), null);
  const none = createCache('t', { maxAgeMs: 60000, storage: null });
  none.set('a', 1);
  assert.equal(none.get('a'), null);
});

test('a repeat OpenStreetMap search comes from the cache', async () => {
  const cache = createCache('osm', { maxAgeMs: 60000, storage: memoryStorage() });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ elements: [{ type: 'node', id: 1, lat: 51.4, lon: -0.2, tags: { amenity: 'parking', fee: 'no' } }] }) };
  };
  const bbox = [51.39, -0.21, 51.41, -0.19];
  const first = await fetchOsm(bbox, { cache, fetchImpl, endpoints: ['https://x.example/api'] });
  const second = await fetchOsm(bbox, { cache, fetchImpl, endpoints: ['https://x.example/api'] });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.deepEqual(second.options, first.options);
});

test('recent searches: newest first, no duplicates, at most six', () => {
  const storage = memoryStorage();
  for (const label of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) addRecent({ label, point: [51, 0] }, storage);
  addRecent({ label: 'c', point: [51.1, 0] }, storage);
  assert.deepEqual(loadRecent(storage).map((p) => p.label), ['c', 'G', 'F', 'E', 'D', 'B']);
  clearRecent(storage);
  assert.deepEqual(loadRecent(storage), []);
});

test('recent searches survive bad or blocked storage', () => {
  const storage = memoryStorage();
  storage.setItem('park-nearby:recent', '{not json');
  assert.deepEqual(loadRecent(storage), []);
  addRecent({ label: 'A', point: [51, 0] }, memoryStorage({ failWrites: true }));
  assert.deepEqual(loadRecent(null), []);
});
