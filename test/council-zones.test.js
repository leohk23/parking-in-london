import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZones, fetchCouncilZones, ZONE_LAYERS } from '../src/sources/council-zones.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';
import { distanceToOption, inPolygon, bboxAround } from '../src/geo.js';

const LBHF = ZONE_LAYERS.find((l) => l.id === 'lbhf');
const STAMFORD_COURT = [51.4956983, -0.243712];

// Properties as Hammersmith & Fulham's zone map returns them; the polygons are simple stand-ins.
const square = (lat, lon, d) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      properties: { ZONE_: 'M', ZONE: 'M', DAYS: 'Monday to Friday', TIME_: '9.00am to 5.00pm', COST: '£1.25 per 1/2 hour' },
      geometry: { type: 'Polygon', coordinates: square(51.4957, -0.2437, 0.004) },
    },
    {
      properties: { ZONE_: 'A', ZONE: 'A', DAYS: 'Monday to Sunday', TIME_: '8.30am to 11.00pm', COST: '£1.10 per 1/2 hour' },
      geometry: { type: 'MultiPolygon', coordinates: [square(51.4957, -0.2300, 0.003)] },
    },
    {
      properties: { ZONE_: 'QQ', ZONE: 'QQ', DAYS: 'Monday to Saturday', TIME_: '9.00am to 5.00pm', COST: 'Permit Holders Only' },
      geometry: { type: 'Polygon', coordinates: square(51.5, -0.2, 0.001) },
    },
  ],
};

test('zones carry their hours and cost', () => {
  const [m, a, qq] = parseZones(geojson, LBHF);
  assert.equal(m.title, 'Zone M');
  assert.equal(m.subtitle, 'Hammersmith & Fulham controlled parking zone');
  assert.equal(m.parts[0].detail, 'Monday to Friday 9.00am to 5.00pm · £1.25 per 1/2 hour');
  assert.deepEqual(m.polygons[0][0], [51.4917, -0.2477]);
  assert.equal(a.parts[0].rules[0].effect, 'controlled');
  assert.equal(qq.parts[0].rules[0].effect, 'permit');
});

test('Stamford Court on Sunday evening: inside Zone M, free until Monday 9am', () => {
  const [m, a] = parseZones(geojson, LBHF);
  assert.equal(distanceToOption(STAMFORD_COURT, m), 0);
  assert.ok(distanceToOption(STAMFORD_COURT, a) > 0);

  const sunday = londonClock(new Date('2026-10-18T19:35:00Z'));
  assert.equal(evaluateOption(m, sunday, 120).results[0].summary, 'Free until Mon 09:00, then pay or permit');
  // A seven-day zone is still controlled on a Sunday evening.
  assert.equal(evaluateOption(a, sunday, 120).results[0].summary, 'Pay or permit until 23:00, then free');
});

test('point in polygon handles holes', () => {
  const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]];
  const hole = [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]];
  assert.equal(inPolygon([2, 2], [outer, hole]), true);
  assert.equal(inPolygon([5, 5], [outer, hole]), false);
  assert.equal(inPolygon([11, 5], [outer]), false);
});

test('only boroughs near the search are queried', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => geojson };
  };
  const near = await fetchCouncilZones(bboxAround(STAMFORD_COURT, 500), { fetchImpl });
  assert.equal(near.options.length, 3);
  assert.match(urls[0], /LBHF\/INSPIRE\/MapServer\/10\/query\?geometry=-0\.25/);
  assert.match(urls[0], /outSR=4326.*f=geojson/);

  const far = await fetchCouncilZones(bboxAround([51.539, -0.1426], 500), { fetchImpl }); // Camden Town
  assert.equal(far.skipped, true);
  assert.equal(urls.length, 1);
});

test('service errors are reported', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'Invalid query' } }) });
  await assert.rejects(fetchCouncilZones(bboxAround(STAMFORD_COURT, 500), { fetchImpl }), /Invalid query/);
});

const MERTON = ZONE_LAYERS.find((l) => l.id === 'merton');
// Attributes as Merton's zone map returns them.
const merton = {
  type: 'FeatureCollection',
  features: [
    {
      properties: { Zone_ID: 'W3', Zone_Area: 'Wimbledon Town Centre', Zone_Type: 'Charges Apply', Operation_Summary: 'Mon-Sat 8:30am - 11:00pm; Sun & Bank Holidays 2:00pm - 6:00pm' },
      geometry: { type: 'Polygon', coordinates: square(51.4214, -0.2064, 0.002) },
    },
    {
      properties: { Zone_ID: 'SW1', Zone_Area: 'South Wimbledon', Zone_Type: 'Permit Holders', Operation_Summary: 'Mon-Sat 8:30am - 6:30pm' },
      geometry: { type: 'Polygon', coordinates: square(51.415, -0.19, 0.002) },
    },
    {
      properties: { Zone_ID: null, Zone_Area: null, Zone_Type: 'Pay and Display Only Zone', Operation_Summary: 'Pay and Display Only' },
      geometry: { type: 'Polygon', coordinates: square(51.402, -0.195, 0.002) },
    },
  ],
};

test('Merton zones: Sunday hours, permit-only zones and the pay and display area', () => {
  const [w3, sw1, pd] = parseZones(merton, MERTON);
  assert.equal(w3.title, 'Zone W3');
  assert.equal(w3.subtitle, 'Wimbledon Town Centre · Merton controlled parking zone');
  const sunday = londonClock(new Date('2026-10-18T11:00:00Z')); // Sun 12:00 BST
  assert.equal(evaluateOption(w3, sunday, 60).results[0].summary, 'Free until 14:00, then pay or permit');
  assert.equal(sw1.parts[0].rules[0].effect, 'permit');
  assert.equal(pd.title, 'Pay and display area');
  assert.equal(pd.parts[0].otherwise.effect, 'unknown');
});
