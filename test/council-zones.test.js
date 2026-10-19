import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZones, fetchCouncilZones, outsideZones, ZONE_LAYERS } from '../src/sources/council-zones.js';
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

  const far = await fetchCouncilZones(bboxAround([51.5724, -0.1941], 500), { fetchImpl }); // Golders Green
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

const layer = (id) => ZONE_LAYERS.find((l) => l.id === id);
const feature = (properties, lat = 51.5, lon = -0.1) => ({ properties, geometry: { type: 'Polygon', coordinates: square(lat, lon, 0.001) } });
const monday = londonClock(new Date('2026-10-19T13:00:00Z')); // Mon 14:00 BST

test('Lambeth zones with two sets of hours go by the longer ones', () => {
  const [l, c] = parseZones(
    {
      features: [
        feature({ NAME: 'Clapham (L)', HOURS: '8:30am - 6:30pm Monday - Friday & 10:00am - 12:00pm Monday - Friday', CODE_1: 'L' }),
        feature({ NAME: 'Clapham (C)', HOURS: '8:30am - 6:30pm Monday - Friday (Check individual bays)', CODE_1: 'C' }),
      ],
    },
    layer('lambeth'),
  );
  assert.equal(l.subtitle, 'Clapham · Lambeth controlled parking zone');
  assert.equal(evaluateOption(l, monday, 60).results[0].summary, 'Pay or permit until 18:30, then free');
  assert.match(l.notes[0], /controlled 10:00am - 12:00pm Monday - Friday instead/);
  assert.equal(c.parts[0].detail, '8:30am - 6:30pm Monday - Friday');
  assert.match(c.notes[0], /their own hours/);
});

test('Kensington & Chelsea: zone hours, restricted zones and residents’ bays', () => {
  const [zone, restricted] = parseZones(
    {
      features: [
        feature({ Name: 'Zone 1', Type: 'Monday to Friday, 8:30am - 6:30pm, Saturday, 8:30am - 1.30pm', Zone: '1' }),
        feature({ Name: 'Restricted Zone - Exhibition Road', Type: 'Restricted Zone', Zone: 'Restricted' }),
      ],
    },
    layer('rbkc'),
  );
  assert.equal(zone.title, 'Zone 1');
  assert.match(zone.notes[0], /single yellow lines and pay bays/);
  assert.equal(restricted.title, 'Restricted zone: Exhibition Road');
  assert.equal(restricted.parts[0].otherwise.effect, 'unknown');

  const [bays, earls] = parseZones(
    {
      features: [
        feature({ Control: 'Control 2', Control_1: '8:30am - 10:00pm Monday to Friday', Control_2: '8:30am - 6:30pm Saturday', Control_3: ' ', Area_Name: ' ' }),
        feature({ Control: 'Control 8', Control_1: '8:30am - 10:00pm Monday to Friday', Control_2: '8:30am - 6:30pm Saturday', Control_3: '8.30am - 5pm Saturday to Sunday (on event days)', Area_Name: 'Earls Court Exhibition Centre' }),
      ],
    },
    layer('rbkc-bays'),
  );
  assert.equal(bays.id, 'zone-rbkc-bays-Control-2');
  assert.equal(bays.title, "Residents' bays");
  assert.equal(bays.subtitle, "Control 2 · Kensington & Chelsea residents' bay hours");
  assert.equal(bays.parts[0].detail, '8:30am - 10:00pm Monday to Friday; 8:30am - 6:30pm Saturday');
  assert.equal(evaluateOption(bays, monday, 60).results[0].summary, 'Permit holders only until 22:00, then free');
  assert.equal(earls.notes[0], 'Also 8.30am - 5pm Saturday to Sunday (on event days).');
});

test('Hackney: hours split over lines, event days noted, pieces of a zone merged', () => {
  const options = parseZones(
    {
      features: [
        feature({ zone: 'Zone M', controlled_hours: 'Mon-Fri 8.30am-6.30pm<br>Sat 8.30am-1.30pm<br>Emirates Stadium events' }),
        feature({ zone: 'Zone M', controlled_hours: 'Mon-Fri 8.30am-6.30pm<br>Sat 8.30am-1.30pm<br>Emirates Stadium events' }, 51.51),
        feature({ zone: 'Zone M', controlled_hours: 'Mon-Fri 8.30am-6.30pm<br>Sat 8.30am-1.30pm' }, 51.52),
      ],
    },
    layer('hackney'),
  );
  assert.equal(options.length, 2);
  const [m, m2] = options;
  assert.equal(m.title, 'Zone M');
  assert.equal(m.polygons.length, 2);
  assert.equal(m.parts[0].detail, 'Mon-Fri 8.30am-6.30pm; Sat 8.30am-1.30pm');
  assert.equal(m.notes[0], 'Extra controls on Emirates Stadium event days: check the signs.');
  assert.equal(m2.id, 'zone-hackney-M-2');
});

test("Newham's map can't say a street has no zone", () => {
  const [s] = parseZones({ features: [feature({ NAME: 'Stratford Central', PREFIX: 'S', TIMES: '8am - 6:30pm (Mon-Sat)', CPZ_Status: 'Event Day Parking Zone' })] }, layer('newham'));
  assert.equal(s.subtitle, 'Stratford Central · Newham controlled parking zone');
  assert.match(s.notes[0], /event days/);
  assert.equal(outsideZones({ options: [s], layers: [layer('newham')] }, 'Newham', [51.6, 0]).length, 0);
  assert.equal(outsideZones({ options: [], layers: [layer('hackney')] }, 'Hackney', [51.6, 0]).length, 1);
});
