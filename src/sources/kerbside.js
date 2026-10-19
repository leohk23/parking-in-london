// Kerbside restrictions (yellow lines, bus stops, bays and markings) as the
// council maps them: Sutton's queried live, the rest copied into tiles on this
// site each week (scripts/build-kerb-tiles.mjs), since browsers can't read
// those councils' servers. Kerb with no restriction drawn is free to park on,
// unless a parking zone (see council-zones.js) or a sign says otherwise.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap } from '../geo.js';
import { wfsQuery } from './council-zones.js';
import { loadTiles } from './tiles.js';

const SUTTON_WFS = 'https://sutton.statmap.co.uk/map/wfs.svc/open_data_lbs_wfs';
const TILES = new URL('../../data/kerb/', import.meta.url).href;

/** A council in the prebuilt tiles, whose elements are { t: id, y: type, r: restriction, g: lines | p: rings }. */
const tiled = (id, borough, bbox, link) => ({ id, borough, bbox, tiled: true, read: (el) => ({ type: el.y, text: el.r }), link });

export const KERB_LAYERS = [
  {
    id: 'sutton',
    borough: 'Sutton',
    bbox: [51.325, -0.26, 51.395, -0.12],
    typeNames: ['statmap:sutton_parking_dataset_lines', 'statmap:sutton_parking_dataset_regions'],
    url: (typeName, bbox) => wfsQuery(SUTTON_WFS, typeName, bbox),
    read: (p) => ({ type: p.Type?.trim(), text: p.Restriction?.trim() }),
    link: 'https://www.data.gov.uk/dataset/bd943ff7-e654-4922-b1a4-4b242292cb15',
  },
  tiled('harrow', 'Harrow', [51.553, -0.407, 51.633, -0.264], 'https://www.harrow.gov.uk/parking'),
  tiled('enfield', 'Enfield', [51.606, -0.182, 51.685, -0.01], 'https://enfield.traffweb.app/'),
  tiled('redbridge', 'Redbridge', [51.542, 0.01, 51.627, 0.151], 'https://redbridge.traffweb.app/'),
  tiled('barking-dagenham', 'Barking & Dagenham', [51.517, 0.064, 51.599, 0.186], 'https://barking-dagenham.traffweb.app/'),
  tiled('waltham-forest', 'Waltham Forest', [51.549, -0.057, 51.649, 0.026], 'https://walthamforest.traffweb.app/'),
  tiled('westminster', 'Westminster', [51.481, -0.218, 51.541, -0.108], 'https://www.westminster.gov.uk/parking/parking-zones-and-prices'),
];

export async function fetchKerbside(bbox, { fetchImpl = fetch, layers = KERB_LAYERS, tilesBase = TILES } = {}) {
  const relevant = layers.filter((layer) => bboxesOverlap(bbox, layer.bbox));
  const live = relevant.filter((layer) => !layer.tiled);
  const fromTiles = relevant.filter((layer) => layer.tiled);
  const results = await Promise.all([
    ...live.flatMap((layer) =>
      layer.typeNames.map(async (typeName) => {
        const res = await fetchImpl(layer.url(typeName, bbox));
        if (!res.ok) throw new Error(`${layer.borough} kerbside map returned ${res.status}`);
        return parseKerbside(await res.json(), layer);
      }),
    ),
    fromTiles.length &&
      loadTiles(bbox, { base: tilesBase, fetchImpl, name: 'kerbside', decode: decodeTile }).then(({ elements }) =>
        fromTiles.flatMap((layer) =>
          elements.filter((el) => el.t === layer.id).map((el) => kerbOption(layer, layer.read(el), el.g ? { lines: el.g } : { polygons: el.p })),
        ),
      ),
  ]);
  return { options: groupByRule(results.flat().filter(Boolean)), skipped: !relevant.length };
}

/** A tile file ({ w: wordings, e: elements with encoded points }, see build-kerb-tiles.mjs) → elements. */
export function decodeTile({ w, e }) {
  return e.map(({ i, w: word, g, p }) => {
    const [t, y, r] = w[word];
    return { t, i, y, r, ...(g ? { g: g.map(decodeLine) } : { p: p.map(decodeLine) }) };
  });
}

/** [lat, lon, Δlat, Δlon, …] in 1e-5 degrees → [[lat, lon], …]. */
function decodeLine(flat) {
  const out = [];
  let [lat, lon] = [0, 0];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    lat += flat[i];
    lon += flat[i + 1];
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

/** GeoJSON features → one option per stretch of kerb. */
export function parseKerbside(json, layer) {
  return (json.features ?? []).map((f) => kerbOption(layer, layer.read(f.properties ?? {}), toShape(f.geometry ?? {}))).filter(Boolean);
}

function kerbOption(layer, { type, text }, shape) {
  const rule = text || type;
  if (!rule || !shape) return null;
  return {
    id: `kerb-${layer.id}-${rule}`,
    source: 'kerbside',
    kind: 'kerb',
    title: tidy(rule),
    subtitle: type && type !== rule ? `${tidy(type)} · ${layer.borough}` : `${layer.borough} kerbside restriction`,
    ...shape,
    parts: [kerbPart(rule, type)],
    notes: ["From the council's kerbside map: signs and lines on the street have the final word."],
    link: layer.link,
  };
}

// Many stretches share one rule ("No waiting Mon-Sat 8am-6.30pm"): show each rule once.
function groupByRule(options) {
  const byId = new Map();
  for (const o of options) {
    const existing = byId.get(o.id);
    if (!existing) {
      byId.set(o.id, { ...o, lines: o.lines ? [...o.lines] : undefined, polygons: o.polygons ? [...o.polygons] : undefined });
      continue;
    }
    if (o.lines) existing.lines = [...(existing.lines ?? []), ...o.lines];
    if (o.polygons) existing.polygons = [...(existing.polygons ?? []), ...o.polygons];
  }
  return [...byId.values()];
}

function toShape(geometry) {
  const flip = (line) => line.map(([lon, lat]) => [lat, lon]);
  switch (geometry.type) {
    case 'LineString':
      return { lines: [flip(geometry.coordinates)] };
    case 'MultiLineString':
      return { lines: geometry.coordinates.map(flip) };
    case 'Polygon':
      return { polygons: geometry.coordinates.map(flip) };
    case 'MultiPolygon':
      return { polygons: geometry.coordinates.flat().map(flip) };
    default:
      return null;
  }
}

/** What a restriction means for parking, from its wording. */
export function kerbPart(text, type = '') {
  const t = `${type} ${text}`.toLowerCase();
  // Event days aren't on a calendar the app knows: free otherwise.
  if (/event day|match day/.test(t)) {
    return { label: '', rules: [], otherwise: { effect: 'free', label: 'Free except on event days: check the signs' }, notes: [] };
  }
  // Exemption areas let only taxis or goods vehicles stop on a red route.
  if (/red route exemption/.test(t)) return { label: '', rules: [{ effect: 'no-parking', label: 'No stopping (red route)' }], otherwise: { effect: 'free' }, notes: [tidy(text)] };
  let rule;
  if (/red route/.test(t)) rule = { effect: 'no-parking', label: 'No stopping (red route)' };
  else if (/disabled|blue badge/.test(t)) rule = { effect: 'restricted', label: 'Blue Badge holders only' };
  else if (/car club/.test(t)) rule = { effect: 'restricted', label: 'Car club vehicles only' };
  else if (/electric|charging/.test(t)) rule = { effect: 'restricted', label: 'Electric vehicle charging only' };
  else if (/loading bay|loading only|loading place/.test(t)) rule = { effect: 'restricted', label: 'Loading only' };
  else if (/ambulance|doctor|police|taxi|coach|motorcycle|diplomat/.test(t)) {
    const who = /ambulance|doctor|police|taxi|coach|motorcycle|diplomat/.exec(t)[0];
    rule = { effect: 'restricted', label: `${{ ambulance: 'Ambulances', doctor: 'Doctors', police: 'Police', taxi: 'Taxis', coach: 'Coaches', motorcycle: 'Motorcycles', diplomat: 'Diplomats' }[who]} only` };
  }
  else if (/zig.?zag|keep clear|crossing|pelican|puffin|toucan|h-bar/.test(t)) rule = { effect: 'no-parking', label: 'No stopping (school or crossing markings)' };
  else if (/bus stop|bus stand|clearway|no stopping/.test(t)) rule = { effect: 'no-parking', label: 'No stopping' };
  else if (/no waiting|no loading|double yellow|single yellow|boxed junction|box junction/.test(t)) rule = { effect: 'no-parking' };
  else if (/unrestricted/.test(t)) rule = { effect: 'free' };
  else if (/pay|ticket|shared use/.test(t)) rule = { effect: 'paid' };
  else if (/permit|resident/.test(t)) rule = { effect: 'permit' };
  else if (/limited waiting|max(imum)? stay/.test(t)) {
    // The first length of stay that isn't how long before you can return.
    const max = /(\d+(?:\.\d+)?\s*(?:hours?|hrs?|mins?|minutes?))\b/i.exec(text.replace(/no\s+return(\s+within)?\s*\d+(\.\d+)?\s*\w+/gi, ''));
    rule = { effect: 'free', label: max ? `Free for up to ${max[1]}` : 'Free, limited stay (see sign)' };
  } else if (/free/.test(t)) rule = { effect: 'free' };
  // Bays kept for someone else: "Hospital only", "Supreme Court permit bay".
  else if (/\bonly\b/.test(t)) rule = { effect: 'restricted', label: tidy(text) };
  else return { label: '', rules: [], otherwise: { effect: 'unknown', label: tidy(text) }, notes: [] };

  // "At any time", or no times at all (bus stops, box junctions), means always.
  const when = scheduleText(text);
  let schedule = parseSchedule(when);
  // Wording without times can read as a week with no hours in it.
  if (schedule?.kind === 'weekly' && schedule.byDay.every((day) => !day.length)) schedule = null;
  const always = !schedule && !/\d/.test(when);
  if (!schedule && !always) return { label: '', rules: [], otherwise: { effect: 'unknown', label: `Times not recognised: ${tidy(text)}` }, notes: [] };
  return {
    label: '',
    rules: [{ ...(always ? {} : { when: schedule }), ...rule }],
    otherwise: { effect: 'free' },
    notes: [],
  };
}

/**
 * Just the days and times of a restriction: without zone, tariff and bay codes
 * ("Zone CH1", "(TC2)", "D3", "No. 281"), "Off-Street" (which would read as days off), lengths of stay ("Max stay 4hrs No return within 2hrs"),
 * or the second half of a shared bay ("Payment Parking …/Permit Holders Only …"),
 * whose hours are the same.
 */
function scheduleText(text) {
  return text
    .split('/')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bon school entrance markings\b|\boff-street\b/gi, ' ')
    .replace(/\b(zone\s+[a-z]*\d\w*|[a-z]{1,3}-?\d+|no\.\s*\d+)\b/gi, ' ')
    .replace(/\b(max(imum)?\s+stay|limited\s+waiting|no\s+return(\s+within)?)?\s*\d+(\.\d+)?\s*(hours?|hrs?|mins?|minutes?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidy(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
