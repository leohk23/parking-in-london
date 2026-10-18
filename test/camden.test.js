import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCamden, fetchCamden } from '../src/sources/camden.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';

// Rows shaped like the Socrata API output for the documented columns.
const rows = [
  {
    road_name: 'ADELAIDE ROAD',
    restriction_type: 'Paid-for / Permit holders',
    times_of_operation: 'Mon-Fri 8.30am-6.30pm',
    maximum_stay: '4 hours',
    tariff: '£4.50 per hour',
    parking_spaces: '6',
    controlled_parking_zone: 'CA-B',
    latitude: '51.5432',
    longitude: '-0.1689',
  },
  {
    road_name: 'ADELAIDE ROAD',
    restriction_type: 'Disabled',
    times_of_operation: 'At any time',
    parking_spaces: '1',
    latitude: '51.5433',
    longitude: '-0.1690',
  },
  { road_name: 'NOWHERE', restriction_type: 'Paid-for', latitude: '', longitude: '' },
];

test('parses bays and their rules', () => {
  const bays = parseCamden(rows);
  assert.equal(bays.length, 2);
  assert.equal(bays[0].title, 'Adelaide Road');
  assert.match(bays[0].subtitle, /Paid-for \/ Permit holders · 6 spaces · zone CA-B/);

  const sunday = londonClock(new Date('2026-10-18T14:41:00Z'));
  const [paid, disabled] = bays.map((b) => evaluateOption(b, sunday, 120));
  assert.equal(paid.status, 'free');
  assert.equal(paid.results[0].summary, 'Free until Mon 08:30, then pay to park (or permit)');
  assert.equal(disabled.status, 'no');
  assert.equal(disabled.results[0].summary, 'Blue Badge holders only');

  const monday = londonClock(new Date('2026-10-19T09:00:00Z'));
  assert.equal(evaluateOption(bays[0], monday, 120).status, 'paid');
});

test('uses the bay outline when given as lon/lat', () => {
  const [bay] = parseCamden([
    { ...rows[0], the_geom: { type: 'LineString', coordinates: [[-0.1689, 51.5432], [-0.1687, 51.5433]] } },
  ]);
  assert.deepEqual(bay.lines, [[[51.5432, -0.1689], [51.5433, -0.1687]]]);
  const [wkt] = parseCamden([{ ...rows[0], geometry_4326: 'LINESTRING (-0.1689 51.5432, -0.1687 51.5433)' }]);
  assert.deepEqual(wkt.lines, [[[51.5432, -0.1689], [51.5433, -0.1687]]]);
});

test('skips the download outside Camden', async () => {
  let called = false;
  const result = await fetchCamden([51.44, -0.21, 51.45, -0.2], { fetchImpl: () => { called = true; } });
  assert.equal(called, false);
  assert.deepEqual(result.options, []);
});
