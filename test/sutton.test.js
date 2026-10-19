import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseZones, outsideZones, fetchCouncilZones, ZONE_LAYERS, wfsQuery } from '../src/sources/council-zones.js';
import { parseKerbside, kerbPart, fetchKerbside, KERB_LAYERS } from '../src/sources/kerbside.js';
import { evaluateOption, evaluatePart } from '../src/evaluate.js';
import { londonClock, parseSchedule } from '../src/schedule.js';
import { bboxAround } from '../src/geo.js';
import { councilAt } from '../src/geocode.js';

const SUTTON = ZONE_LAYERS.find((l) => l.id === 'sutton');
const KERB = KERB_LAYERS.find((l) => l.id === 'sutton');
const KT4_8RW = [51.371715, -0.228827];
const MONDAY_10AM = londonClock(new Date('2026-10-19T09:00:00Z'));
const SUNDAY_NOON = londonClock(new Date('2026-10-18T11:00:00Z'));

// Shaped like Sutton's WFS GeoJSON; the geometry is a stand-in around KT4 8RW.
const square = ([lat, lon], d) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
const zoneA = {
  type: 'Feature',
  properties: { name: 'Wellington Road and Lingfield Road Zone (A) Mon to Sat 8am to 6.30pm', link: 'https://www.sutton.gov.uk/x', type: 'CPZ', status: 'E' },
  geometry: { type: 'MultiPolygon', coordinates: [square([51.3716, -0.2308], 0.001)] },
};

test('Sutton zone names carry the zone letter, area and hours', () => {
  const [a] = parseZones({ features: [zoneA] }, SUTTON);
  assert.equal(a.title, 'Zone A');
  assert.equal(a.subtitle, 'Wellington Road and Lingfield Road · Sutton controlled parking zone');
  assert.equal(a.parts[0].detail, 'Mon to Sat 8am to 6.30pm');
  assert.equal(a.link, 'https://www.sutton.gov.uk/x');
  assert.equal(evaluateOption(a, MONDAY_10AM, 120).results[0].summary, 'Pay or permit until 18:30, then free');
  assert.equal(evaluateOption(a, SUNDAY_NOON, 120).results[0].summary, 'Free until Mon 08:00, then pay or permit');
});

test('outside every zone in the council area: say parking is uncontrolled', () => {
  const zones = parseZones({ features: [zoneA] }, SUTTON);
  const result = { options: zones, layers: [SUTTON] };
  const [none] = outsideZones(result, 'Sutton', KT4_8RW); // KT4 8RW is ~140 m east of the stand-in square
  assert.equal(none.title, 'No parking zone here');
  assert.equal(none.kind, 'area');
  assert.equal(evaluateOption(none, MONDAY_10AM, 120).results[0].summary, 'Free on streets without yellow lines or bays');
  // Inside a zone, or in another borough, there's nothing to add.
  assert.deepEqual(outsideZones(result, 'Sutton', [51.3716, -0.2308]), []);
  assert.deepEqual(outsideZones(result, 'Kingston upon Thames', KT4_8RW), []);
  assert.deepEqual(outsideZones(result, null, KT4_8RW), []);
});

test('Sutton is queried by WFS, in lon/lat, only near Sutton', async () => {
  const url = wfsQuery('https://example.org/wfs', 'statmap:x', [51.36, -0.24, 51.38, -0.22]);
  assert.match(url, /version=1\.1\.0&request=GetFeature&typeName=statmap%3Ax&outputFormat=application%2Fjson&srsName=EPSG%3A4326&bbox=-0\.24%2C51\.36%2C-0\.22%2C51\.38%2CEPSG%3A4326/);
  const urls = [];
  const fetchImpl = async (u) => {
    urls.push(u);
    return { ok: true, json: async () => ({ type: 'FeatureCollection', features: [] }) };
  };
  await fetchCouncilZones(bboxAround(KT4_8RW, 500), { fetchImpl });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /sutton\.statmap\.co\.uk.*controlled_parking_zones/);
  const kerb = await fetchKerbside(bboxAround([51.4957, -0.2437], 500), { fetchImpl });
  assert.equal(kerb.skipped, true);
});

test('kerbside wording becomes rules', () => {
  const at = (part, clock = MONDAY_10AM) => evaluatePart(part, clock, 120).summary;
  assert.equal(at(kerbPart('No waiting Mon-Sat 8am-6.30pm', 'No Waiting')), 'No parking until 18:30, then free');
  assert.equal(at(kerbPart('No waiting Mon-Sat 8am-6.30pm', 'No Waiting'), SUNDAY_NOON), 'Free until Mon 08:00, then no parking');
  assert.equal(at(kerbPart('No waiting Mon-Fri 10am-11am and 2pm-3pm', 'No Waiting')), 'No parking until 11:00, then free');
  assert.equal(at(kerbPart('No Waiting At Any Time', 'No Waiting At Any Time')), 'No parking');
  assert.equal(at(kerbPart('Bus Stop', 'Bus Stop and Stands')), 'No stopping');
  assert.equal(at(kerbPart('Advisory Zig-Zag Marking', 'No Stopping on School Entrance Marking')), 'No stopping (school or crossing markings)');
  assert.equal(at(kerbPart('Zebra Crossing', 'Crossing')), 'No stopping (school or crossing markings)');
  assert.equal(at(kerbPart('Free Parking Place', 'Parking Bay')), 'Free');
  assert.equal(
    at(kerbPart('Limited Waiting Mon-Sat 8am-6.30pm Max stay 1 hour no return within 2 hours', 'Limited Waiting Bays')),
    'Free for up to 1 hour until 18:30, then free',
  );
  assert.equal(at(kerbPart('Permit holders only Mon-Sat 8am-6.30pm Zone A', 'Permit Parking Bay')), 'Permit holders only until 18:30, then free');
  assert.equal(at(kerbPart('Something new', 'Unusual')), 'Something new');
});

test('kerbside stretches with the same rule are shown once', async () => {
  const line = (rule, type, lon) => ({
    type: 'Feature',
    properties: { Type: type, Restriction: rule },
    geometry: { type: 'LineString', coordinates: [[lon, 51.3714], [lon + 0.0002, 51.3715]] },
  });
  const fetchImpl = async (u) => ({
    ok: true,
    json: async () => ({
      features: u.includes('lines')
        ? [line('No Waiting At Any Time', 'No Waiting At Any Time', -0.2286), line('No Waiting At Any Time', 'No Waiting At Any Time', -0.229), line('Bus Stop', 'Bus Stop and Stands', -0.2295)]
        : [],
    }),
  });
  const { options } = await fetchKerbside(bboxAround(KT4_8RW, 500), { fetchImpl });
  assert.deepEqual(options.map((o) => [o.title, o.lines.length]), [['No Waiting At Any Time', 2], ['Bus Stop', 1]]);
  assert.equal(options[1].subtitle, 'Bus Stop and Stands · Sutton');
  assert.deepEqual(parseKerbside({ features: [{ properties: {}, geometry: null }] }, KERB), []);
});

test('durations in restriction text are not read as times', () => {
  assert.deepEqual(parseSchedule('Limited waiting 2 hours Mon-Sat 8am-6.30pm').byDay[1], [[480, 1110]]);
});

test('the council for a point comes from postcodes.io', async () => {
  const fetchImpl = async (u) => {
    assert.match(u, /postcodes\?lon=-0\.228827&lat=51\.371715&radius=300&limit=1/);
    return { ok: true, json: async () => ({ result: [{ admin_district: 'Sutton' }] }) };
  };
  assert.equal(await councilAt(KT4_8RW, { fetchImpl }), 'Sutton');
  assert.equal(await councilAt(KT4_8RW, { fetchImpl: async () => ({ ok: true, json: async () => ({ result: null }) }) }), null);
});
