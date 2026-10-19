// Copies councils' kerbside restrictions (yellow lines, bays, crossings, with
// their times) into small tiles the app loads, for councils whose map servers
// browsers can't read. The deploy workflow runs it weekly:
//
//   node scripts/build-kerb-tiles.mjs data
//
// writes data/kerb/ (tiles, like data/osm/) and refreshes the zone maps in
// data/zones/. A council whose server is down is left out of the tiles for the
// week, and keeps its committed zone map.
//
// Sources: four councils' TraffWeb traffic order maps (GML in British National
// Grid), Harrow's ArcGIS map server, and Westminster's bays with hours from its PDF.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { osgbToWgs84 } from './osgb.mjs';
import { STEP, tileKey } from './build-osm-tiles.mjs';
import { parseSchedule } from '../src/schedule.js';

const TRAFFWEB = 'https://mapserver.traffweb.app/cgi-bin';
const HARROW = 'https://mapping.harrow.gov.uk/server/rest/services/Public/Transport_and_Streets_2/MapServer';

export const TRAFFWEB_SOURCES = [
  { id: 'enfield', tenant: 'enfield', zones: true },
  { id: 'redbridge', tenant: 'redbridge' },
  { id: 'barking-dagenham', tenant: 'barking-dagenham' },
  { id: 'waltham-forest', tenant: 'walthamforest' },
  { id: 'lewisham', tenant: 'lewisham' },
  { id: 'greenwich', tenant: 'greenwich' },
  { id: 'bexley', tenant: 'bexley', zones: true, hours: bexleyHours },
];

// Bexley's map has some zones without hours or codes; its permits page has the
// current hours of each zone, which win.
const BEXLEY_PERMITS = 'https://www.bexley.gov.uk/services/parking-transport-and-streets/parking-permits/residents-parking-permits';
const BEXLEY_NAMES = { WHeath: 'WH', 'Erith Town Centre': 'ER' };
// The page's footnote: "some roads in zones A and ER have different times".
const BEXLEY_NOTES = { A: ['Some roads have different times: check the signs.'], ER: ['Some roads have different times: check the signs.'] };

/** Zone code → { hours, notes } from Bexley's table (Area | Zone Code | Days | Times | …). */
async function bexleyHours() {
  const page = await get(BEXLEY_PERMITS);
  const cells = (row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, c]) => decode(c.replace(/<[^>]+>/g, ' ')));
  const table = {};
  for (const [row] of page.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const [area, code, days, times] = cells(row);
    if (code && /^[A-Z]{1,3}\d?$/.test(code) && times) table[code] = { area: area.replace(/\*+$/, ''), hours: `${days} ${times}`, notes: BEXLEY_NOTES[code] ?? [] };
  }
  if (Object.keys(table).length < 10) throw new Error('the permits page has no hours table');
  return table;
}

// Harrow publishes each kind of restriction as its own layer: layer id →
// properties → [type, restriction] in words the app understands (see kerbPart).
const time = (a) => (a.TIME ?? a.TIME_OF_OPERATION ?? '').trim();
const join = (...parts) => parts.map((p) => (p ?? '').toString().trim()).filter(Boolean).join(' ');
export const HARROW_LAYERS = {
  3: (a) => ['Single yellow line', join('No waiting', time(a))],
  4: () => ['Double yellow line', 'No waiting at any time'],
  5: (a) => ['Permit bay', join('Permit holders only, zone', a.ZONE_LETTER, time(a))],
  10: (a) => ['Ambulance bay', join('Ambulances only', time(a) || 'at any time')],
  11: (a) => ['Business permit bay', join('Business permit holders only', time(a))],
  12: (a) => ['Coach bay', join('Coaches only', time(a) || 'at any time')],
  13: (a) => ["Doctor's bay", join('Doctors only', time(a) || 'at any time')],
  14: (a) => ['Free bay', join('Free parking', time(a))],
  15: (a) => ['Loading bay', join('Loading only', time(a) || 'at any time')],
  16: (a) => ['Motorcycle bay', join('Motorcycles only', time(a) || 'at any time')],
  17: (a) => ['Pay and display bay', join('Pay and display', time(a), a.PERIOD_OF_ && `· ${a.PERIOD_OF_}`, a.TARIFF1 && `· ${a.TARIFF1}`)],
  18: (a) => ['Pay and display or permit bay', join('Pay and display or permit holders', time(a), a.PERIOD_OF_ && `· ${a.PERIOD_OF_}`, a.TARIFF1 && `· ${a.TARIFF1}`)],
  19: (a) => ['Police bay', join('Police only', time(a) || 'at any time')],
  20: (a) => ['School keep clear', join('No stopping', a.TIMES_OF_STOPPING_PROHIBITION || 'at any time')],
  21: (a) => ['Taxi rank', join('Taxis only', time(a) || 'at any time')],
  22: () => ['Zebra crossing', 'Zebra crossing'],
  23: (a) => ['Disabled bay', join('Blue Badge holders only', time(a) || 'at any time')],
  28: (a) => ['Loading restriction', join('No loading', time(a))],
  34: (a) => ['Car club bay', join('Car club vehicles only', time(a) || 'at any time')],
};

// Westminster's bays (from Camden's open data portal, which hosts them) say
// which sub-zone they're in but not their hours. Those are in a PDF,
// transcribed here: sub-zone → [pay bays and single yellow lines, residents' bays].
// The script warns when the council links to a newer PDF.
export const WESTMINSTER_BAYS = 'https://opendata.camden.gov.uk/resource/2579-98vt.json';
const WESTMINSTER_PAGE = 'https://www.westminster.gov.uk/parking/parking-zones-and-prices';
const WESTMINSTER_PDF = 'hours-of-control-parking-tariffs-from-march-2026.pdf';
const MF = 'Mon-Fri 8.30am-6.30pm';
const MF_SAT = 'Mon-Fri 8.30am-6.30pm and Sat 8.30am-1.30pm';
const MS = 'Mon-Sat 8.30am-6.30pm';
const ALWAYS = 'at any time';
const EVENINGS = '8.30am-8.30pm every day';
export const WESTMINSTER_HOURS = {
  A1: [MF, MF],
  A2: [MF_SAT, 'Mon-Sat 8.30am-10pm'],
  A3: [MS, ALWAYS],
  A4: [MS, ALWAYS],
  BC1: [MF, MF],
  B2: [MF_SAT, MF_SAT],
  B3: [MF_SAT, '8.30am-10pm every day'],
  B4: [MF, MF],
  B5: [MS, EVENINGS],
  B6: [MF_SAT, EVENINGS],
  B7: [MS, ALWAYS],
  B10: [MF, ALWAYS],
  B11: [MF, 'Mon-Sat 8.30am-10pm'],
  CB1: [MF, MF],
  C1: [MF, MF],
  C2: [MF, MF],
  D1: [MF, MF],
  D4: [MF, MS],
  E1: [MS, ALWAYS],
  F1: [MS, ALWAYS],
  F2: [MS, EVENINGS],
  F3: [MS, EVENINGS],
  F4: [MS, ALWAYS],
  F5: [MS, ALWAYS],
  F6: [MS, ALWAYS],
  G1: [MS, ALWAYS],
  G2: [MS, null],
};
// Streets whose residents' bays differ from their sub-zone's (the PDF's footnotes).
const WESTMINSTER_STREETS = {
  'MAUNSEL STREET': 'Mon-Sat 8.30am-10.30pm',
  'KILBURN PARK ROAD': 'Mon-Sat 8am-6.30pm',
  'CARLTON VALE': 'Mon-Sat 8am-6.30pm',
  'RANDOLPH GARDENS': 'Mon-Sat 8am-6.30pm',
};

const WESTMINSTER_SPECIAL = {
  'DISABLED BAY': 'Blue Badge holders only',
  'MOTORCYCLE BAY': 'Motorcycles only',
  'ELECTRIC CHARGING BAY': 'Electric vehicle charging only',
  'LOADING BAY': 'Loading only',
  'CAR CLUB BAY': 'Car club vehicles only',
  'DIPLOMAT BAY': 'Diplomats only',
  'TAXI BAY': 'Taxis only',
  'DOCTOR BAY': 'Doctors only',
  'POLICE BAY': 'Police only',
  'BUS BAY': 'Buses only',
  'AMBULANCE BAY': 'Ambulances only',
};

/** A Westminster bay type, sub-zone and street → [type, restriction] in words kerbPart understands. */
export function westminsterRule(bayType, subZone, street) {
  const [paid, resident] = WESTMINSTER_HOURS[subZone] ?? [];
  const type = bayType.toLowerCase().replace(/\bpbp\b/, 'pay by phone').replace(/^./, (c) => c.toUpperCase());
  const residentHours = WESTMINSTER_STREETS[street] ?? resident;
  switch (bayType) {
    case 'RESIDENT BAY':
      return [type, residentHours ? `Resident permit holders only ${residentHours}` : 'Resident permit holders only: hours on the sign'];
    case 'PBP BAY':
      return [type, paid ? `Pay by phone ${paid}, max stay 4 hours` : 'Pay by phone: hours on the sign'];
    case 'SHARED USE BAY':
    case 'VISITOR SHARED USE BAY':
      return [type, paid ? `Pay by phone or resident permit holders ${paid}` : 'Pay by phone or permit holders: hours on the sign'];
    case 'COACH BAY':
      return [type, 'Coaches only 8.30am-midnight every day'];
    case 'ALL OTHER BAYS':
      return [type, 'Bay: see the sign'];
    default:
      return [type, WESTMINSTER_SPECIAL[bayType] ?? `${type.replace(/ bay$/i, '')} only`];
  }
}

/** "POLYGON ((x y, x y, …))" in British National Grid → rings of [lat, lon]. */
function wktRings(wkt) {
  return [...wkt.matchAll(/\(([^()]+)\)/g)].map(([, ring]) =>
    ring.split(',').map((pair) => {
      const [x, y] = pair.trim().split(/\s+/).map(Number);
      return osgbToWgs84(x, y).map(round);
    }),
  );
}

async function westminsterKerb() {
  const page = await get(WESTMINSTER_PAGE);
  if (!page.includes(WESTMINSTER_PDF)) console.log(`::warning::Westminster links to a new hours PDF: check WESTMINSTER_HOURS against ${WESTMINSTER_PAGE}`);
  const params = new URLSearchParams({ $limit: '100000', $select: 'wcc_bay_id,wcc_permit_type,wcc_controlled_parking_zone,wcc_lsg_street_name,wcc_space_geometry' });
  const spaces = await get(`${WESTMINSTER_BAYS}?${params}`, { as: 'json' });
  // One element per bay, with a ring for each space in it.
  const bays = new Map();
  for (const s of spaces) {
    if (!s.wcc_space_geometry) continue;
    if (!bays.has(s.wcc_bay_id)) {
      const [y, r] = westminsterRule(s.wcc_permit_type ?? '', s.wcc_controlled_parking_zone, s.wcc_lsg_street_name);
      bays.set(s.wcc_bay_id, { t: 'westminster', y, r, p: [] });
    }
    bays.get(s.wcc_bay_id).p.push(...wktRings(s.wcc_space_geometry));
  }
  const unknown = [...new Set(spaces.map((s) => s.wcc_controlled_parking_zone))].filter((z) => z && !WESTMINSTER_HOURS[z]);
  if (unknown.length) console.log(`::warning::Westminster sub-zones without hours: ${unknown.join(', ')}`);
  return [...bays.values()];
}

// Traffic orders that aren't about parking at the kerb.
const NOT_PARKING =
  /closure|copenhagen|hatched|cycle|pedestrian zone|test tile|footway parking|footway bay|wheel|pavement parking|box junction|experimental orders|^off-street car park$|access marking/i;

const MAX_ORDER = 1600;

const round = (n) => Math.round(n * 1e5) / 1e5;

export function decode(text) {
  let t = text;
  // TraffWeb escapes some apostrophes twice: "Residents&amp;#039; Parking".
  for (let i = 0; i < 2; i++) {
    t = t
      .replace(/&#0*39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/** "x y x y …" in British National Grid → [[lat, lon], …]. */
function posList(text) {
  const n = text.trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push(osgbToWgs84(n[i], n[i + 1]).map(round));
  return out;
}

/**
 * TraffWeb GML features (ordersl lines, ordersr regions, twpzones zones) →
 * [{ props, lines? | rings? }] with coordinates as [lat, lon].
 */
export function parseTraffweb(gml, layer) {
  const out = [];
  for (const [, body] of gml.matchAll(new RegExp(`<ms:${layer}>([\\s\\S]*?)</ms:${layer}>`, 'g'))) {
    const props = Object.fromEntries([...body.matchAll(/<ms:(\w+)>([^<]*)<\/ms:\1>/g)].map(([, k, v]) => [k, decode(v)]));
    const geometry = /<ms:msGeometry>([\s\S]*?)<\/ms:msGeometry>/.exec(body)?.[1] ?? '';
    const coords = [...geometry.matchAll(/<gml:posList[^>]*>([^<]*)<\/gml:posList>/g)].map(([, t]) => posList(t));
    if (!coords.length) continue;
    out.push(/<gml:(Polygon|MultiSurface|MultiPolygon)/.test(geometry) ? { props, rings: coords } : { props, lines: coords });
  }
  return out;
}

/** A TraffWeb restriction → a kerb element, or null when it isn't about parking. */
export function traffwebElement(id, { props, lines, rings }) {
  const type = props.order_type ?? '';
  const text = props.restriction || type;
  if (!text || NOT_PARKING.test(type) || NOT_PARKING.test(text)) return null;
  return { t: id, y: type, r: text, ...(lines ? { g: lines } : { p: rings }) };
}

async function get(url, { tries = 3, as = 'text' } = {}) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'parking-in-london (github.com/leohk23/parking-in-london)' }, signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`${res.status} from ${url.slice(0, 80)}`);
      return as === 'json' ? await res.json() : await res.text();
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

function traffwebUrl(tenant, layer, date) {
  // The map service wants the traffic order types to show, by number: under
  // 1,300 in use in 2026, and a longer list makes the address too long.
  const orders = Array.from({ length: MAX_ORDER }, (_, i) => i + 1).join(',');
  return `${TRAFFWEB}/${tenant}/parkmap?service=WFS&version=1.1.0&request=GetFeature&typename=${layer}&MYORDERS=${orders}&DTO=${date}`;
}

/** All features of an ArcGIS layer as GeoJSON in lon/lat; Harrow's server doesn't page, so ask by id. */
async function arcgisFeatures(layerUrl) {
  // An empty layer has no ids at all.
  const objectIds = (await get(`${layerUrl}/query?where=1%3D1&returnIdsOnly=true&f=json`, { as: 'json' })).objectIds ?? [];
  const features = [];
  for (let i = 0; i < objectIds.length; i += 400) {
    const params = new URLSearchParams({ objectIds: objectIds.slice(i, i + 400).join(','), outFields: '*', outSR: '4326', geometryPrecision: '6', f: 'geojson' });
    const json = await get(`${layerUrl}/query?${params}`, { as: 'json' });
    if (json.error) throw new Error(json.error.message);
    features.push(...json.features);
  }
  return features;
}

/** "TRANSPORTATION_USER.CPZ_ZONE_BOUNDARIES.TIMES" → "TIMES". */
const shortKeys = (props) => Object.fromEntries(Object.entries(props ?? {}).map(([k, v]) => [k.split('.').pop(), v]));

const flip = (line) => line.map(([lon, lat]) => [round(lat), round(lon)]);

/** A GeoJSON geometry in lon/lat → { g: lines } or { p: rings } with [lat, lon]. */
function shape(geometry) {
  switch (geometry?.type) {
    case 'LineString':
      return { g: [flip(geometry.coordinates)] };
    case 'MultiLineString':
      return { g: geometry.coordinates.map(flip) };
    case 'Polygon':
      return { p: geometry.coordinates.map(flip) };
    case 'MultiPolygon':
      return { p: geometry.coordinates.flat().map(flip) };
    default:
      return null;
  }
}

async function harrowKerb() {
  const out = [];
  for (const [layer, describe] of Object.entries(HARROW_LAYERS)) {
    for (const f of await arcgisFeatures(`${HARROW}/${layer}`)) {
      const s = shape(f.geometry);
      if (!s) continue;
      const [y, r] = describe(shortKeys(f.properties));
      out.push({ t: 'harrow', y, r, ...s });
    }
  }
  return out;
}

// Hours Harrow writes in an order the app would misread.
const HARROW_HOURS = { '10am-11am & 2pm-3pm & Sat-Sun 10am-11am Mon-Fri': 'Mon-Fri 10am-11am & 2pm-3pm; Sat-Sun 10am-11am' };

async function harrowZones() {
  const features = (await arcgisFeatures(`${HARROW}/1`)).map((f) => {
    const a = shortKeys(f.properties);
    const area = Object.entries(a).find(([k]) => k.endsWith('CPZ_ZONE_B'))?.[1];
    const hours = a.TIMES?.trim();
    return zoneFeature({ zone: a.CPZ, area, hours: HARROW_HOURS[hours] ?? hours }, f.geometry);
  });
  return { type: 'FeatureCollection', features };
}

// Zone rings in [lon, lat], simplified like the kerb shapes but to about 3 m.
const roundRing = (ring) => simplify(ring.map(([x, y]) => [y, x]), 3e-5).map(([y, x]) => [round(x), round(y)]);
function zoneFeature(properties, geometry) {
  const coordinates = geometry.type === 'Polygon' ? geometry.coordinates.map(roundRing) : geometry.coordinates.map((p) => p.map(roundRing));
  return { type: 'Feature', properties, geometry: { type: geometry.type, coordinates } };
}

/**
 * TraffWeb zones (Enfield's, Bexley's) as GeoJSON in lon/lat, like the councils'
 * own zone maps, with hours from the council's table (`hours`) where it has one.
 */
export function traffwebZones(features, hours = {}) {
  return {
    type: 'FeatureCollection',
    features: features.map(({ props, rings }) => {
      const area = props.polyname?.replace(/\.$/, '');
      const zone = props.zonecode || BEXLEY_NAMES[area] || undefined;
      const fill = hours[zone];
      return zoneFeature(
        { zone, area: fill?.area ?? area, hours: fill?.hours ?? props.poly_info, ...(fill?.notes?.length && { notes: fill.notes }) },
        { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring.map(([lat, lon]) => [lon, lat])]) },
      );
    }),
  };
}

/**
 * Douglas-Peucker on [lat, lon] points: drops points within `tolerance` degrees
 * of latitude (about 1 m) of the simplified line. Councils trace bays with
 * curved corners, which the map doesn't need.
 */
export function simplify(points, tolerance = 1e-5) {
  if (points.length < 3) return points;
  const k = Math.cos((points[0][0] * Math.PI) / 180); // a degree of longitude is shorter
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = [points[a][0], points[a][1] * k];
    const [by, bx] = [points[b][0], points[b][1] * k];
    const len = Math.hypot(by - ay, bx - ax);
    let far = -1;
    let farDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = [points[i][0], points[i][1] * k];
      const d = len ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len : Math.hypot(py - ay, px - ax);
      if (d > farDistance) [far, farDistance] = [i, d];
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return points.filter((_, i) => keep[i]);
}

/** [[lat, lon], …] → [lat, lon, Δlat, Δlon, …] in 1e-5 degrees: short integers. */
export function encodeLine(points) {
  const out = [];
  let [lat, lon] = [0, 0];
  for (const [y, x] of points) {
    const [Y, X] = [Math.round(y * 1e5), Math.round(x * 1e5)];
    out.push(Y - lat, X - lon);
    [lat, lon] = [Y, X];
  }
  return out;
}

/**
 * A tile's file: each wording once in `w` ([council, type, restriction]), and
 * each element as { i, w: its wording, g: lines | p: rings } with encoded points.
 */
export function tileFile(elements) {
  const words = new Map();
  const e = elements.map((el) => {
    const key = JSON.stringify([el.t, el.y, el.r]);
    if (!words.has(key)) words.set(key, words.size);
    const shapes = (el.g ?? el.p).map((line) => encodeLine(simplify(line)));
    return { i: el.i, w: words.get(key), [el.g ? 'g' : 'p']: shapes };
  });
  return { w: [...words.keys()].map((k) => JSON.parse(k)), e };
}

// Islington's and Lewisham's zones are only in their MapThat maps, which want a
// session: a few requests to log in as the public user, then the layer by its
// place in the map's layer tree, whose id changes with every session.

function mapThatSession(base) {
  const cookies = new Map();
  return async (path, body, headers = {}) => {
    for (let i = 1; ; i++) {
      try {
        const res = await fetch(`${base}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
            ...(body && { 'Content-Type': 'application/json; charset=utf-8' }),
            ...headers,
          },
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        for (const c of res.headers.getSetCookie()) {
          const [pair] = c.split(';');
          const eq = pair.indexOf('=');
          cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
        }
        return await res.text();
      } catch (err) {
        // Islington's server drops connections now and then.
        if (i >= 4) throw err;
        await new Promise((r) => setTimeout(r, 3000 * i));
      }
    }
  };
}

/** A logged-in MapThat session's layer: [{ RawData1: column names, RawData2: values, GeometryWKT }]. */
async function mapThatLayer(call, treeId, [north, west, south, east]) {
  const tree = JSON.parse(await call('/Default.aspx/GetMapThatData', {})).d.TreeNodes;
  const guid = tree.find((n) => n.TreeID === treeId)?.UniqueGUID;
  if (!guid) throw new Error(`no layer ${treeId} in the MapThat tree`);
  return JSON.parse(
    await call('/Default.aspx/GetGraphicsLayer', {
      UniqueGUID: guid, Lat1: north, Lon1: west, Lat2: south, Lon2: east,
      AreaSearchpoints: null, isNewSelectTool: false, showAllRecordsInHitsPanel: true, exportToExcel: false, temporalFilter: '', areaFilterType: '',
    }),
  ).d[1];
}

/** "a,b,c" columns and values → { a, b, c }. */
const rawData = ({ RawData1, RawData2 }) => Object.fromEntries(RawData1.split(',').map((k, i) => [k, RawData2.split(',')[i]?.trim()]));
const wktPolygons = (wkt) => [...wkt.matchAll(/\(\(([^()]+(?:\),\s*\([^()]+)*)\)\)/g)].map(([, polygon]) =>
  polygon.split(/\),\s*\(/).map((ring) => ring.split(',').map((pair) => pair.trim().split(/\s+/).map(Number))),
);

async function islingtonZones() {
  const call = mapThatSession('https://map.islington.gov.uk/MapThatPublic');
  await call('/login.html?user=public');
  await call('/Api/User', { LOGON_ID: 'Public', PASSWORD: 'xyz', IS_OPEN_ACCESS: true });
  await call('/Api/UserProject', { USER_ID: 1, ROLE_ID: 2, PROJECT_ID: 2 });
  await call('/Api/User/TermsAndCondition', { LOGON_ID: 'Public' });
  await call('/Default.aspx');
  // 224: "Controlled Parking Zones (CPZ)".
  const layer = await mapThatLayer(call, 224, [51.6, -0.16, 51.5, -0.06]);
  return { type: 'FeatureCollection', features: layer.map((f) => islingtonZone(f.RawData1, f.RawData2, f.GeometryWKT)) };
}

async function lewishamZones() {
  const base = 'https://lbl.dynamicmaps.co.uk/MapThatWeb';
  const call = mapThatSession(base);
  await call('/login.html?user=lewisham');
  await call('/Api/User/AuthenticateUser', undefined, { Referer: `${base}/login.html?user=lewisham` });
  await call('/Default.aspx');
  // 526: "Controlled parking zones".
  const layer = await mapThatLayer(call, 526, [51.52, -0.1, 51.4, 0.07]);
  return { type: 'FeatureCollection', features: layer.map((f) => lewishamZone(rawData(f), f.GeometryWKT)) };
}

/**
 * One Lewisham zone ({ zone_id, zone_name, operatingd, operatingt }): two-part
 * hours like "Mon-Fri/Sat" + "9am-6pm/9am-1.30pm" become "Mon-Fri 9am-6pm; Sat 9am-1.30pm".
 */
export function lewishamZone(v, wkt) {
  const days = (v.operatingd ?? '').split('/');
  const times = (v.operatingt ?? '').split('/');
  const hours = days.length === times.length ? days.map((d, i) => `${d} ${times[i]}`).join('; ') : v.control;
  return zoneFeature({ zone: v.zone_id, area: v.zone_name || undefined, hours }, { type: 'MultiPolygon', coordinates: wktPolygons(wkt) });
}

/** One Islington zone: its columns (CPZ, AREA_NAME, MON_TO_FRI, SAT, ADDITIONAL_MATCH_DAY_CONTROLS) as comma-joined text, and WKT in lon/lat. */
export function islingtonZone(columns, values, wkt) {
  const v = Object.fromEntries(columns.split(',').map((k, i) => [k, values.split(',')[i]?.trim()]));
  const zone = v.CPZ.replace(/^Zone\s+/i, '').replace(/\s+Matchday$/i, '');
  const none = (t) => !t || /^none$/i.test(t);
  // "Restrictions operate 24 hours a day" (Zones C and K).
  const allDay = (t) => /24 hours/i.test(t ?? '');
  let hours;
  if (allDay(v.MON_TO_FRI) && allDay(v.SAT) && /sunday/i.test(v.SAT)) hours = 'Mon-Sat at any time; Sun midnight-6am';
  else if (allDay(v.MON_TO_FRI) && allDay(v.SAT)) hours = 'At any time';
  else hours = [`Mon-Fri ${v.MON_TO_FRI}`, !none(v.SAT) && `Sat ${v.SAT}`].filter(Boolean).join('; ');
  const matchDay = none(v.ADDITIONAL_MATCH_DAY_CONTROLS) ? [] : [`Also on Emirates match days: ${v.ADDITIONAL_MATCH_DAY_CONTROLS.split('~').map((t) => t.trim()).join(', ')}.`];
  // Area names are often just the zone again; Zone E's match-day part is its own outline.
  const area = /matchday$/i.test(v.CPZ) ? 'Match day area' : v.AREA_NAME && !/^zone\b/i.test(v.AREA_NAME) ? v.AREA_NAME : undefined;
  const rings = [...wkt.matchAll(/\(([^()]+)\)/g)].map(([, ring]) => ring.split(',').map((pair) => pair.trim().split(/\s+/).map(Number)));
  return zoneFeature({ zone, area, hours, notes: matchDay }, { type: 'Polygon', coordinates: rings });
}

const HARINGEY_WFS = 'https://my.haringey.gov.uk/getows.ashx?mapsource=mapsources/AllMaps&service=WFS&version=1.0.0&request=GetFeature&typename=Controlled_Parking_Zones';

async function haringeyZones() {
  const gml = await get(HARINGEY_WFS);
  const features = [];
  for (const [, body] of gml.matchAll(/<ms:Controlled_Parking_Zones[^>]*>([\s\S]*?)<\/ms:Controlled_Parking_Zones>/g)) {
    const name = decode(/<ms:cpz_name>([^<]*)</.exec(body)?.[1] ?? '');
    const times = decode(/<ms:op_times>([^<]*)</.exec(body)?.[1] ?? '');
    // Polygons, each an outer ring then any holes, as "x,y x,y …" in British National Grid.
    const polygons = [...body.matchAll(/<gml:Polygon>([\s\S]*?)<\/gml:Polygon>/g)].map(([, polygon]) =>
      [...polygon.matchAll(/<gml:coordinates[^>]*>([^<]*)<\/gml:coordinates>/g)].map(([, text]) =>
        text.trim().split(/\s+/).map((pair) => {
          const [lat, lon] = osgbToWgs84(...pair.split(',').map(Number));
          return [lon, lat];
        }),
      ),
    );
    if (polygons.length) features.push(zoneFeature({ ...haringeyHours(times, name), area: name }, { type: 'MultiPolygon', coordinates: polygons }));
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Haringey's hours, without the event-day controls that follow them ("…, and
 * on event days (Tottenham Hotspur Stadium): …"), which go into notes.
 */
export function haringeyHours(text, name = '') {
  const t = text.replace(/â€“/g, '–').replace(/\s+/g, ' ').trim();
  // Event-day zones: "Tottenham Event Day", or hours starting "Event Days (…)".
  if (/event day/i.test(name) || /^event days?\b/i.test(t)) {
    return { hours: '', eventOnly: true, notes: [`Controlled on event days: ${t.replace(/^event days?\s*(\([^)]*\))?\s*:?\s*/i, '')}`] };
  }
  const cut = /,?\s*\.?\s*(?:and|or)\s+(on|for|in)\s+(.*)$/i.exec(t);
  if (!cut) return { hours: t, notes: [] };
  const [, prep, rest] = cut;
  const note = prep.toLowerCase() === 'in' ? `In ${rest.replace(/\s*-\s*(?=monday)/i, ': ')}` : `Also ${prep.toLowerCase()} ${rest}`;
  return { hours: t.slice(0, cut.index), notes: [note.endsWith('.') ? note : `${note}.`] };
}

// Brent's zone map loads a GeoJSON file. Its hours are sometimes cut short or
// shifted between fields, so the council's hours table wins for zones it lists once.
const BRENT_MAP = 'https://www.brent.gov.uk/-/media/maps/external/cpz.json';
const BRENT_PAGE = 'https://www.brent.gov.uk/parking-roads-and-travel/parking/where-you-can-park/controlled-parking-zones';

async function brentZones(now = new Date()) {
  const table = brentTable(await get(BRENT_PAGE));
  const map = await get(BRENT_MAP, { as: 'json' });
  return { type: 'FeatureCollection', features: map.features.map((f) => brentZone(f, table, now)).filter(Boolean) };
}

/** Zone code → hours, for codes with one row in the council's table (Zone | Hours). */
export function brentTable(html) {
  const rows = {};
  for (const [row] of html.matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const [code, hours] = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, c]) => decode(c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')));
    if (code && hours && /^[A-Z]{1,3}\d?$/.test(code)) (rows[code] ??= []).push(hours.replace(/\s*\(see notes below\)/i, ''));
  }
  return Object.fromEntries(Object.entries(rows).filter(([, h]) => h.length === 1).map(([code, [h]]) => [code, h]));
}

const EVENT_DAYS = /\bon even[ty] days?\b/i;

/** One feature of Brent's map → a zone feature, or null for a zone that hasn't started yet. */
export function brentZone({ properties: p, geometry }, table, now = new Date()) {
  const start = /to start on (\d+)\w*\s+(\w+)\s+(\d+)/i.exec(p.status ?? '');
  if (start && new Date(`${start[1]} ${start[2]} 20${start[3].slice(-2)}`) > now) return null;
  // "SZ2 (Annesley Close)", "KS (Subzone 3)", "KR_2", "GS - Extension", "Zone BA CPZ"; or a name.
  const name = (p.CPZ ?? '').trim();
  const m = /^(?:zone\s+)?([A-Z]{1,3}\d?)(?:_\d|\s*-\s*extension)?(?:\s*\(([^)]*)\))?(?:\s+CPZ)?$/i.exec(name);
  const zone = m?.[1];
  const fields = [p.Operational, p.operational_days, p.operational_times].join(' ');
  // The map's own hours: its summary up to "On event days" if readable, else days and times.
  const summary = (p.Operational ?? '').split(EVENT_DAYS)[0].replace(/[.\s]+$/, '');
  const times = (p.operational_times ?? '').split(EVENT_DAYS)[0].replace(/\s+/g, ' ').trim();
  const days = /^(mon|tue|wed|thu|fri|sat|sun)/i.test(p.operational_days ?? '') ? p.operational_days.split(/\s+and\s+/)[0] : '';
  const own = parseSchedule(summary) ? summary : `${days} ${times}`.trim();
  // Extra hours over the August bank holiday weekend, when the field has days and times.
  const august = /\d/.test(p['August ban'] ?? '') && /(mon|sat|sun)day/i.test(p['August ban']) ? [`Also over the August bank holiday weekend: ${p['August ban'].replace(/\.\s*/, ' ')}.`] : [];
  const event = EVENT_DAYS.test(fields) || /event/i.test(p.bank_holiday ?? '') ? ['Extra controls on Wembley event days: check the signs.'] : [];
  return zoneFeature(
    { zone, title: zone ? undefined : name, area: m?.[2], hours: (zone && table[zone]) || own, notes: [...event, ...august] },
    geometry,
  );
}

// Greenwich's zone map embeds its zones in the page; its hours lag behind the
// council's directory of zones, which wins.
const GREENWICH = 'https://www.royalgreenwich.gov.uk';
const GREENWICH_MAP = `${GREENWICH}/parking-transport-and-streets/check-if-you-need-parking-permit-or-update-your-details/check-if-you/map`;
const GREENWICH_DIRECTORY = `${GREENWICH}/directory/71/cpz_fees`;

async function greenwichZones() {
  const page = await get(GREENWICH_MAP);
  const settings = JSON.parse(/<script type="application\/json" data-drupal-selector="drupal-settings-json">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? 'null');
  const polygons = settings?.cpzMap?.polygons;
  if (!polygons?.features) throw new Error('no zones in the map page');
  const directory = {};
  for (const listing of [GREENWICH_DIRECTORY, `${GREENWICH_DIRECTORY}?page=1`]) {
    for (const [, path] of (await get(listing)).matchAll(/href="(\/directory_record\/\d+\/[^"]+)"/g)) {
      const record = greenwichRecord(await get(`${GREENWICH}${path}`));
      if (record.code) directory[record.code] = record;
    }
  }
  if (Object.keys(directory).length < 20) console.log(`::warning::Greenwich's directory has only ${Object.keys(directory).length} zones`);
  return { type: 'FeatureCollection', features: polygons.features.map((f) => greenwichZone(f, directory)).filter(Boolean) };
}

/** A directory record's labelled fields ("Zone code", "Days of operation", "Times of operation"). */
export function greenwichRecord(html) {
  const fields = Object.fromEntries(
    [...html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)].map(([, k, v]) => [decode(k.replace(/<[^>]+>/g, ' ')), decode(v.replace(/<[^>]+>/g, ' '))]),
  );
  const times = fields['Times of operation'] ?? '';
  // "Monday to Saturday 9am to 5pm, Sunday 9am to 6pm" already names its days.
  const hours = /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/i.test(times) ? times : `${fields['Days of operation'] ?? ''} ${times}`.trim();
  return { code: fields['Zone code'], name: fields['Zone name'], hours };
}

/**
 * A feature of Greenwich's map → a zone, or null for exempt areas and other
 * boroughs' zones near the edge ("…-CPZ-LB BEXLEY-ABBEY WOOD-AW"). The code
 * field goes with the hours; the label ("…-CPZ-CHARLTON-C") has Abbey Wood's
 * two zones swapped, so names come from the directory where it has them.
 */
export function greenwichZone({ properties: p, geometry }, directory = {}) {
  const label = /^EX-HATCH-PERMIT-ELIGIBLE-CPZ-(.+)-([A-Z]{1,3})$/.exec(p.CPZ ?? '');
  const zone = p['CPZ_eligbility_namelist_zoneinfo_CPZ code'];
  if (!label || /^LB /.test(label[1]) || !zone || zone.includes('*')) return null;
  const name = label[2] === zone ? label[1] : (p.CPZ_eligbility_namelist_zoneinfo_Text ?? label[1]);
  const mapHours = (p.CPZ_eligbility_namelist_zoneinfo_CPZ_optim ?? '').replace(/_(?=[A-Z]{3})/g, '; ').replace(/_/g, ' ');
  const area = directory[zone]?.name ?? name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return zoneFeature({ zone, area, hours: directory[zone]?.hours || mapHours }, geometry);
}

/** Every tile an element's bounding box touches. */
function tilesOf(el) {
  const points = (el.g ?? el.p).flat();
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  const keys = [];
  for (let a = Math.floor(Math.min(...lats) / STEP[0]); a <= Math.floor(Math.max(...lats) / STEP[0]); a++) {
    for (let b = Math.floor(Math.min(...lons) / STEP[1]); b <= Math.floor(Math.max(...lons) / STEP[1]); b++) keys.push(`${a}_${b}`);
  }
  return keys;
}

export function buildKerbTiles(elements) {
  const tiles = new Map();
  elements.forEach((el, i) => {
    el.i = i;
    for (const key of tilesOf(el)) {
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(el);
    }
  });
  return tiles;
}

async function main(dataDir) {
  await mkdir(`${dataDir}/zones`, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const elements = [];
  const sources = {};
  let failures = 0;
  const run = async (id, job) => {
    try {
      const started = Date.now();
      const found = await job();
      console.log(`${id}: ${found} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
      sources[id] = date;
    } catch (err) {
      failures++;
      console.log(`::warning::${id} kerbside map not copied: ${err.message}`);
    }
  };

  for (const { id, tenant, zones, hours } of TRAFFWEB_SOURCES) {
    await run(id, async () => {
      const found = [];
      for (const layer of ['ordersl', 'ordersr']) {
        for (const f of parseTraffweb(await get(traffwebUrl(tenant, layer, date)), layer)) {
          if (Number(f.props.order_id) > MAX_ORDER - 100) console.log(`::warning::${id} uses order type ${f.props.order_id}: raise MAX_ORDER`);
          const el = traffwebElement(id, f);
          if (el) found.push(el);
        }
      }
      if (found.length < 1000) throw new Error(`only ${found.length} restrictions`);
      if (zones) {
        const table = hours ? await hours().catch((err) => console.log(`::warning::${id} hours table not read: ${err.message}`)) : undefined;
        const z = traffwebZones(parseTraffweb(await get(traffwebUrl(tenant, 'twpzones', date)), 'twpzones'), table);
        if (z.features.length) await writeFile(`${dataDir}/zones/${id}.json`, JSON.stringify(z));
      }
      elements.push(...found);
      return found.length;
    });
  }
  await run('harrow', async () => {
    const found = await harrowKerb();
    if (found.length < 1000) throw new Error(`only ${found.length} restrictions`);
    const z = await harrowZones();
    if (z.features.length) await writeFile(`${dataDir}/zones/harrow.json`, JSON.stringify(z));
    elements.push(...found);
    return found.length;
  });
  await run('zone maps', async () => {
    let found = 0;
    for (const [id, load] of [['islington', islingtonZones], ['lewisham', lewishamZones], ['haringey', haringeyZones], ['brent', brentZones], ['greenwich', greenwichZones]]) {
      try {
        const z = await load();
        if (z.features.length < 20) throw new Error(`only ${z.features.length} zones`);
        await writeFile(`${dataDir}/zones/${id}.json`, JSON.stringify(z));
        found += z.features.length;
      } catch (err) {
        console.log(`::warning::${id} zone map not copied: ${err.message}`);
      }
    }
    return found;
  });
  await run('westminster', async () => {
    const found = await westminsterKerb();
    if (found.length < 1000) throw new Error(`only ${found.length} bays`);
    elements.push(...found);
    return found.length;
  });
  if (!elements.length) throw new Error('no council could be read');

  const tiles = buildKerbTiles(elements);
  const outDir = `${dataDir}/kerb`;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let bytes = 0;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const [key, els] of tiles) {
    const body = JSON.stringify(tileFile(els));
    bytes += body.length;
    await writeFile(`${outDir}/${key}.json`, body);
    const [a, b] = key.split('_').map(Number);
    south = Math.min(south, a * STEP[0]);
    north = Math.max(north, (a + 1) * STEP[0]);
    west = Math.min(west, b * STEP[1]);
    east = Math.max(east, (b + 1) * STEP[1]);
  }
  const index = { updated: date, sources, step: STEP, bbox: [south, west, north, east], tiles: [...tiles.keys()].sort() };
  await writeFile(`${outDir}/index.json`, JSON.stringify(index));
  console.log(`${elements.length} restrictions → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB.${failures ? ` ${failures} council(s) missing.` : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? 'data').catch((err) => {
    console.error(`Kerbside tiles not built: ${err.message}`);
    process.exit(1);
  });
}
