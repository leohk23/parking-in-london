import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoneOptions } from '../src/sources/zones.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';
import * as curated from '../data/zones.js';

// Geometry is a stand-in: only the street name and a point inside Wandsworth matter here.
const streets = [{ name: 'Wimbledon Park Road', line: [[51.44, -0.205], [51.445, -0.203]] }];

function wimbledonParkRoad(isoTime, stay) {
  const [option] = zoneOptions(streets);
  return evaluateOption(option, londonClock(new Date(isoTime)), stay);
}

test('Wimbledon Park Road on Sunday afternoon: every zone is free until Monday', () => {
  const o = wimbledonParkRoad('2026-10-18T14:41:00Z', 120);
  assert.equal(o.status, 'free');
  assert.deepEqual(
    o.results.map((r) => [r.label, r.status, r.summary]),
    [
      ['Zone A6', 'free', 'Free until Mon 09:30, then pay or permit (check the bay sign)'],
      ['Zone S1', 'free', 'Free until Mon 09:30, then pay or permit (check the bay sign)'],
      ['Zone S5', 'free', 'Free until Mon 14:00, then pay or permit (check the bay sign)'],
    ],
  );
});

test('Wimbledon Park Road on a weekday morning: only the S5 stretch is free', () => {
  const o = wimbledonParkRoad('2026-10-19T09:00:00Z', 120); // Mon 10:00 BST
  assert.equal(o.status, 'free');
  assert.deepEqual(
    o.results.map((r) => [r.label, r.status]),
    [
      ['Zone A6', 'paid'],
      ['Zone S1', 'paid'],
      ['Zone S5', 'free'],
    ],
  );
  assert.equal(o.results[1].summary, 'Pay or permit (check the bay sign) until 16:30, then free');
});

test('a stay that runs into control hours is flagged', () => {
  const o = wimbledonParkRoad('2026-10-19T12:30:00Z', 120); // Mon 13:30 BST, until 15:30
  const s5 = o.results.find((r) => r.label === 'Zone S5');
  assert.equal(s5.now.status, 'free');
  assert.equal(s5.status, 'paid');
  assert.equal(s5.changesDuringStay, true);
  assert.equal(s5.summary, 'Free until 14:00, then pay or permit (check the bay sign)');
});

test('street names only match inside the borough', () => {
  assert.equal(zoneOptions([{ name: 'Wimbledon Park Road', line: [[51.6, -0.1]] }]).length, 0);
  assert.equal(zoneOptions([{ name: 'wimbledon park road', line: streets[0].line }]).length, 1);
});

test('curated data is internally consistent', () => {
  for (const street of curated.STREETS) {
    assert.ok(curated.BOROUGHS[street.borough], street.name);
    for (const id of street.zones) {
      assert.ok(curated.ZONES.some((z) => z.borough === street.borough && z.id === id), `${street.name}: ${id}`);
    }
  }
  for (const [option] of [zoneOptions(streets)]) {
    for (const part of option.parts) assert.notEqual(part.otherwise.effect, 'unknown', part.label);
  }
});
