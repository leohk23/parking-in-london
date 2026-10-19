import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, parseTraffweb, traffwebElement, simplify, tileFile, buildKerbTiles } from '../scripts/build-kerb-tiles.mjs';
import { STEP } from '../scripts/build-osm-tiles.mjs';
import { decodeTile, fetchKerbside, kerbPart, KERB_LAYERS } from '../src/sources/kerbside.js';
import { parseZones, ZONE_LAYERS } from '../src/sources/council-zones.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';

// Monday 14:00 BST.
const monday = londonClock(new Date('2026-10-19T13:00:00Z'));
const summary = (text, type) => evaluateOption({ kind: 'kerb', parts: [kerbPart(text, type)], notes: [] }, monday, 120).results[0].summary;

// As TraffWeb's map service returns them: GML in British National Grid.
const gml = `<wfs:FeatureCollection>
  <gml:featureMember><ms:ordersl>
    <ms:msGeometry><gml:LineString srsName="EPSG:27700"><gml:posList srsDimension="2">544400.0 186600.0 544420.0 186600.0 </gml:posList></gml:LineString></ms:msGeometry>
    <ms:order_type>Residents&amp;#039; Parking</ms:order_type>
    <ms:restriction>Residents&amp;#039; Permit Holders Only Mon-Sat 8am-6.30pm</ms:restriction>
    <ms:order_id>51</ms:order_id>
  </ms:ordersl></gml:featureMember>
  <gml:featureMember><ms:ordersl>
    <ms:msGeometry><gml:LineString srsName="EPSG:27700"><gml:posList srsDimension="2">544400.0 186610.0 544420.0 186610.0 </gml:posList></gml:LineString></ms:msGeometry>
    <ms:order_type>Cycle Hangar</ms:order_type>
    <ms:restriction>Cycle Hanger</ms:restriction>
  </ms:ordersl></gml:featureMember>
</wfs:FeatureCollection>`;

test('TraffWeb restrictions: decoded, converted to GPS and filtered', () => {
  assert.equal(decode('Residents&amp;#039;  Parking'), "Residents' Parking");
  const [bay, hangar] = parseTraffweb(gml, 'ordersl');
  assert.equal(bay.props.restriction, "Residents' Permit Holders Only Mon-Sat 8am-6.30pm");
  // In Ilford.
  const [[lat, lon]] = bay.lines[0];
  assert.ok(Math.abs(lat - 51.5598) < 0.0001 && Math.abs(lon - 0.0817) < 0.0001, `${lat},${lon}`);
  assert.equal(traffwebElement('redbridge', hangar), null);
  assert.deepEqual(Object.keys(traffwebElement('redbridge', bay)), ['t', 'y', 'r', 'g']);
});

test('tiles: shapes simplified, wordings kept once, and decoded back', () => {
  // A straight kerb traced with extra points, and a bay.
  const line = [[51.5, -0.1], [51.50001, -0.1], [51.50002, -0.1], [51.5003, -0.1]];
  assert.deepEqual(simplify(line), [[51.5, -0.1], [51.5003, -0.1]]);
  const elements = [
    { t: 'enfield', y: 'No Waiting', r: 'No Waiting At Any Time', g: [line] },
    { t: 'enfield', y: 'No Waiting', r: 'No Waiting At Any Time', g: [[[51.501, -0.1], [51.5012, -0.1]]] },
    { t: 'enfield', y: 'Disabled Parking', r: 'Disabled Badge Holders Only', p: [[[51.5, -0.1], [51.5, -0.0999], [51.5001, -0.0999], [51.5, -0.1]]] },
  ];
  const tiles = buildKerbTiles(elements);
  assert.equal(tiles.size, 1);
  const file = tileFile([...tiles.values()][0]);
  assert.equal(file.w.length, 2);
  const back = decodeTile(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(back[0], { t: 'enfield', i: 0, y: 'No Waiting', r: 'No Waiting At Any Time', g: [[[51.5, -0.1], [51.5003, -0.1]]] });
  assert.equal(back[2].p[0].length, 4);
});

test('kerbside tiles are read for councils near the search only', async () => {
  const tiles = buildKerbTiles([{ t: 'enfield', y: 'No Waiting', r: 'No Waiting Mon-Fri 11am-12pm', g: [[[51.6135, -0.1065], [51.614, -0.1065]]] }]);
  const files = new Map([
    ['index.json', { updated: '2026-10-19', step: STEP, bbox: [51.5, -0.5, 51.7, 0.3], tiles: [...tiles.keys()] }],
    ...[...tiles].map(([key, els]) => [`${key}.json`, tileFile(els)]),
  ]);
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const file = files.get(url.split('/').pop().split('?')[0]);
    return file ? { ok: true, json: async () => file } : { ok: false, status: 404 };
  };
  const layers = KERB_LAYERS.filter((l) => l.tiled);
  const palmersGreen = [51.611, -0.11, 51.617, -0.102];
  const { options } = await fetchKerbside(palmersGreen, { fetchImpl, layers, tilesBase: 'https://site/kerb/' });
  assert.equal(options.length, 1);
  assert.equal(options[0].subtitle, 'No Waiting · Enfield');
  assert.deepEqual(options[0].lines, [[[51.6135, -0.1065], [51.614, -0.1065]]]);

  const sutton = await fetchKerbside([51.36, -0.2, 51.37, -0.19], { fetchImpl, layers });
  assert.equal(sutton.skipped, true);
  assert.equal(asked.length, 2);
});

test('kerbside wordings from the TraffWeb councils', () => {
  assert.equal(summary("Residents' Permit Holders Only Event Day Only 12pm-9pm", "Residents' Parking"), 'Free except on event days: check the signs');
  assert.equal(summary('Unrestricted Bay', 'Unrestricted Bay'), 'Free');
  assert.equal(summary('Resident Permit Holders Only Zone CH1 Mon-Fri 8.30am-5.30pm', 'Resident Permit Holders'), 'Permit holders only until 17:30, then free');
  assert.equal(summary('CPZ Parking Places M-Sat excl Bank Hols 8am-6.30pm', 'CPZ Permit Parking Places'), 'Permit holders only until 18:30, then free');
  assert.equal(summary('Off-Street Disabled Blue Badge Holders Only', ''), 'Blue Badge holders only');
  assert.equal(summary('Red Route Exemption Area For Taxis 6pm-6am', ''), 'No stopping (red route)');
  assert.equal(summary('Taxi Rank 4pm-11.59pm and midnight-6am', 'PROHIBITION of STOPPING'), 'Free until 16:00, then taxis only');
  assert.equal(summary('Limited Waiting Mon-Sat 8am-7pm 20mins No return within 40mins', 'Limited Waiting'), 'Free for up to 20mins until 19:00, then free');
  assert.equal(
    summary('Payment Parking (TC2) Mon-Fri 8.30am-5.30pm Max stay 4hrs No return within 2hrs/Permit Holders Only Zone WB Mon-Fri 8.30am-5.30pm', 'Pay and Display/ Permit Holder Bay'),
    'Pay to park until 17:30, then free',
  );
});

const feature = (properties) => ({ properties, geometry: { type: 'Polygon', coordinates: [[[-0.1, 51.6], [-0.09, 51.6], [-0.09, 51.61], [-0.1, 51.6]]] } });

test('Harrow and Enfield zones, copied from the councils', () => {
  const [d] = parseZones({ features: [feature({ zone: 'D', area: 'Harrow Town Centre', hours: '8:30am - 6:30pm Mon - Sat' })] }, ZONE_LAYERS.find((l) => l.id === 'harrow'));
  assert.equal(d.subtitle, 'Harrow Town Centre · Harrow controlled parking zone');
  const enfield = ZONE_LAYERS.find((l) => l.id === 'enfield');
  const [grange, spurs] = parseZones(
    { features: [feature({ area: 'GRANGE PARK CPZ', hours: 'Mon - Fri 10 - 11 am' }), feature({ zone: 'SE', area: 'Spurs Event Day C.P.Z.', hours: '' })] },
    enfield,
  );
  assert.equal(grange.title, 'Grange Park');
  assert.equal(evaluateOption(grange, monday, 60).results[0].summary, 'Free until Tue 10:00, then pay or permit');
  assert.equal(spurs.title, 'Zone SE');
  assert.equal(spurs.subtitle, 'Spurs Event Day · Enfield controlled parking zone');
  assert.equal(spurs.parts[0].otherwise.label, 'Free except on event days: check the signs');
});

test("Westminster bays get their sub-zone's hours from the transcribed PDF", async () => {
  const { westminsterRule } = await import('../scripts/build-kerb-tiles.mjs');
  const rule = (...args) => summary(...westminsterRule(...args).reverse());
  assert.equal(rule('RESIDENT BAY', 'A2', 'ECCLESTON SQUARE'), 'Permit holders only until 22:00, then free');
  assert.equal(rule('RESIDENT BAY', 'F1', 'GLOUCESTER PLACE'), 'Permit holders only');
  assert.equal(rule('RESIDENT BAY', 'D4', 'MAUNSEL STREET'), 'Permit holders only until 22:30, then free');
  assert.equal(rule('PBP BAY', 'E1', 'MOUNT STREET'), 'Pay to park until 18:30, then free');
  assert.equal(rule('SHARED USE BAY', 'B6', 'PORCHESTER TERRACE'), 'Pay to park until 18:30, then free');
  assert.equal(rule('MOTORCYCLE BAY', 'G1', 'DEAN STREET'), 'Motorcycles only');
  assert.equal(rule('HOSPITAL BAY', 'F2', 'PRAED STREET'), 'Hospital only');
});

test('Islington zones from its MapThat map', async () => {
  const { islingtonZone } = await import('../scripts/build-kerb-tiles.mjs');
  const columns = 'CPZ,AREA_NAME,MON_TO_FRI,SAT,ADDITIONAL_MATCH_DAY_CONTROLS,AREA_SQ_KM,AREA,';
  const wkt = 'POLYGON ((-0.12 51.55, -0.11 51.55, -0.11 51.56, -0.12 51.55))';
  const zone = (values) => parseZones({ features: [islingtonZone(columns, values, wkt)] }, ZONE_LAYERS.find((l) => l.id === 'islington'))[0];
  const y = zone('Zone Y,Holloway East,8.30am - 6.30pm,8.30am - 1.30pm,Monday - Friday 6.30pm - 8.30pm~ Saturday 1:30pm 4:30pm~ Sunday and public holidays 12 noon - 4.30pm,,,');
  assert.equal(y.title, 'Zone Y');
  assert.equal(y.subtitle, 'Holloway East · Islington controlled parking zone');
  assert.equal(y.parts[0].detail, 'Mon-Fri 8.30am - 6.30pm; Sat 8.30am - 1.30pm');
  assert.match(y.notes[0], /^Also on Emirates match days: Monday - Friday 6.30pm - 8.30pm, Saturday/);
  const c = zone('Zone C,Zone C,Restrictions operate 24 hours a day,Restrictions operate 24 hours Saturday. Sunday: Midnight - 6:00am,None,,,');
  assert.equal(c.subtitle, 'Islington controlled parking zone');
  assert.equal(evaluateOption(c, monday, 60).results[0].summary, 'Pay or permit until Sun 06:00, then free');
  assert.equal(zone('Zone E Matchday,Zone E,8.30am - 6.30pm,8.30am - 1.30pm,None,,,').subtitle, 'Match day area · Islington controlled parking zone');
});

test("Haringey's hours, with event days kept apart", async () => {
  const { haringeyHours } = await import('../scripts/build-kerb-tiles.mjs');
  assert.deepEqual(haringeyHours('Monday to Friday: 10am to 12 noon, and in Priory Gardens - Monday to Saturday: 8am to 6.30pm'), {
    hours: 'Monday to Friday: 10am to 12 noon',
    notes: ['In Priory Gardens: Monday to Saturday: 8am to 6.30pm.'],
  });
  assert.equal(haringeyHours('Monday to Sunday: 8am - 6.30pm, and on event days (Tottenham Hotspur Stadium): Monday to Friday 8am - 8.30pm').hours, 'Monday to Sunday: 8am - 6.30pm');
  const event = haringeyHours('Monday to Friday: 5pm to 8.30pm, and Saturday, Sunday and Public Holidays: 12 noon to 8pm', 'Tottenham Event Day');
  assert.equal(event.eventOnly, true);
  const [zone] = parseZones(
    { features: [{ properties: { area: 'Tottenham Event Day', ...event }, geometry: { type: 'Polygon', coordinates: [[[-0.07, 51.59], [-0.06, 51.59], [-0.06, 51.6], [-0.07, 51.59]]] } }] },
    ZONE_LAYERS.find((l) => l.id === 'haringey'),
  );
  assert.equal(evaluateOption(zone, monday, 60).results[0].summary, 'Free except on event days: check the signs');
});

test("Brent's zones: the council's table wins, and zones yet to start are left out", async () => {
  const { brentZone, brentTable } = await import('../scripts/build-kerb-tiles.mjs');
  const table = brentTable(`<table><tr><td>Zone</td><td>Hours</td></tr>
    <tr><td>KH</td><td>&nbsp;8.30am - 6.30pm Monday - Friday</td></tr>
    <tr><td>KG</td><td>8.30am - 6.30pm Monday - Friday (see notes below)</td></tr>
    <tr><td>KR</td><td>8.30am - 6.30pm Monday - Friday</td></tr><tr><td>KR</td><td>8.30am - 9.00pm Monday - Sunday (Victor Road and Napier Road only)</td></tr></table>`);
  assert.deepEqual(table, { KH: '8.30am - 6.30pm Monday - Friday', KG: '8.30am - 6.30pm Monday - Friday' });
  const geometry = { type: 'Polygon', coordinates: [[[-0.25, 51.55], [-0.24, 51.55], [-0.24, 51.56], [-0.25, 51.55]]] };
  const zone = (properties) => brentZone({ properties, geometry }, table, new Date('2026-10-19'))?.properties;
  assert.equal(zone({ CPZ: 'KH', Operational: '12.00 am - 3.00 pm Mon. - Fri', operational_days: 'Monday - Friday', operational_times: '12am - 3pm' }).hours, '8.30am - 6.30pm Monday - Friday');
  const kr = zone({ CPZ: 'KR_2', Operational: '8.30 am - 9.00pm Mon. - Sun.', 'August ban': 'Monday. 8.30 am - 10.30 pm' });
  assert.equal(kr.hours, '8.30 am - 9.00pm Mon. - Sun');
  assert.deepEqual(kr.notes, ['Also over the August bank holiday weekend: Monday 8.30 am - 10.30 pm.']);
  const school = zone({ CPZ: 'SZ2 (Annesley Close)', Operational: '8.15 am - 9.15 am & 2.30 pm - 4.00 pm Mon. - Fri (School Street Zone)', operational_days: 'Monday - Friday', operational_times: '8.15am - 9.15am & 2.30pm - 4pm' });
  assert.deepEqual([school.zone, school.area, school.hours], ['SZ2', 'Annesley Close', 'Monday - Friday 8.15am - 9.15am & 2.30pm - 4pm']);
  assert.deepEqual(zone({ CPZ: 'NC2', Operational: '8.00 am - 6.30 pm Mon. - Sat. On event days 8am -' }).notes, ['Extra controls on Wembley event days: check the signs.']);
  assert.equal(zone({ CPZ: 'AB', status: 'To start on 21st Nov 26', Operational: '8.30am-6.30pm, Mon-Fri' }), undefined);
});

test("Lewisham's two-part hours and Greenwich's labels", async () => {
  const { lewishamZone, greenwichZone, greenwichRecord } = await import('../scripts/build-kerb-tiles.mjs');
  const wkt = 'MULTIPOLYGON (((-0.02 51.46, -0.01 51.46, -0.01 51.47, -0.02 51.46)))';
  const s = lewishamZone({ zone_id: 'S', zone_name: 'Deptford Central', operatingd: 'Mon-Fri/Sat', operatingt: '9am-6pm/9am-1.30pm' }, wkt);
  assert.deepEqual(s.properties, { zone: 'S', area: 'Deptford Central', hours: 'Mon-Fri 9am-6pm; Sat 9am-1.30pm' });
  assert.deepEqual(s.geometry.coordinates[0][0][0], [-0.02, 51.46]);

  const record = greenwichRecord('<dl><dt>Zone name</dt><dd>Greenwich Town Centre</dd><dt>Zone code</dt><dd>G</dd><dt>Days of operation</dt><dd>Monday to Sunday</dd><dt>Times of operation</dt><dd>Monday to Saturday 9am to 5pm, Sunday 9am to 6pm</dd></dl>');
  assert.deepEqual(record, { code: 'G', name: 'Greenwich Town Centre', hours: 'Monday to Saturday 9am to 5pm, Sunday 9am to 6pm' });
  const geometry = { type: 'MultiPolygon', coordinates: [[[[0.0, 51.48], [0.01, 51.48], [0.01, 51.49], [0.0, 51.48]]]] };
  const feature = (CPZ, code, optim, text) => ({ properties: { CPZ, 'CPZ_eligbility_namelist_zoneinfo_CPZ code': code, CPZ_eligbility_namelist_zoneinfo_CPZ_optim: optim, CPZ_eligbility_namelist_zoneinfo_Text: text }, geometry });
  assert.deepEqual(greenwichZone(feature('EX-HATCH-PERMIT-ELIGIBLE-CPZ-GREENWICH TOWN CENTRE-G', 'G', 'MON-SAT 9am-5pm_SUN 9am-6pm'), { G: record }).properties, {
    zone: 'G', area: 'Greenwich Town Centre', hours: 'Monday to Saturday 9am to 5pm, Sunday 9am to 6pm',
  });
  // The label has Abbey Wood's two zones swapped; the code field goes with the hours.
  assert.deepEqual(greenwichZone(feature('EX-HATCH-PERMIT-ELIGIBLE-CPZ-ABBEY WOOD-AW', 'AO', 'MON-FRI_9am-11am', 'Abbey Wood Outer')).properties, {
    zone: 'AO', area: 'Abbey Wood Outer', hours: 'MON-FRI 9am-11am',
  });
  assert.equal(greenwichZone(feature('EX-HATCH-PERMIT-ELIGIBLE-CPZ-LB BEXLEY-ABBEY WOOD-AW', 'AW*', 'MON-FRI_11am-1pm')), null);
  assert.equal(greenwichZone(feature('Exempt')), null);
});
