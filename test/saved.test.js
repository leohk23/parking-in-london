import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSaved, isSaved, savePlace, removeSaved } from '../src/saved.js';

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
};
const home = { label: '12 Wimbledon Park Road, SW19 6NL', point: [51.444, -0.204], street: 'Wimbledon Park Road' };
const office = { label: 'Stamford Court, W6 0LF', point: [51.4957, -0.2437] };

test('saved places: newest first, kept once, removed by name', () => {
  const storage = memory();
  assert.deepEqual(loadSaved(storage), []);
  assert.equal(savePlace(home, storage), true);
  savePlace(office, storage);
  savePlace({ ...home, label: '12 wimbledon park road, sw19 6nl' }, storage);
  assert.deepEqual(loadSaved(storage).map((p) => p.label), ['12 wimbledon park road, sw19 6nl', 'Stamford Court, W6 0LF']);
  assert.equal(isSaved(home, storage), true);
  removeSaved('STAMFORD COURT, W6 0LF', storage);
  assert.equal(isSaved(office, storage), false);
  assert.equal(loadSaved(storage).length, 1);
});

test('saved places: no storage, or broken data, is no saved places', () => {
  assert.equal(savePlace(home, null), false); // blocked storage: says it couldn't save
  assert.deepEqual(loadSaved(null), []);
  const broken = memory();
  broken.setItem('park-nearby:saved', '{not json');
  assert.deepEqual(loadSaved(broken), []);
  const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } };
  assert.equal(savePlace(home, full), false);
});
