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
  tiled('lewisham', 'Lewisham', [51.415, -0.076, 51.495, 0.042], 'https://lewisham.traffweb.app/'),
  tiled('greenwich', 'Greenwich', [51.423, -0.031, 51.511, 0.125], 'https://greenwich.traffweb.app/'),
  tiled('bexley', 'Bexley', [51.407, 0.073, 51.513, 0.213], 'https://bexley.traffweb.app/'),
  tiled('havering', 'Havering', [51.485, 0.13, 51.63, 0.339], 'https://havering.statmap.co.uk/tro/map.html?login=tro_public'),
  tiled('croydon', 'Croydon', [51.293, -0.164, 51.425, 0.003], 'https://croydon.traffweb.app/'),
  tiled('hounslow', 'Hounslow', [51.421, -0.462, 51.504, -0.242], 'https://hounslow.traffweb.app/'),
  tiled('barnet', 'Barnet', [51.553, -0.3, 51.667, -0.127], 'https://barnet.traffweb.app/'),
  tiled('tower-hamlets', 'Tower Hamlets', [51.484, -0.082, 51.545, 0.012], 'https://towerhamlets.traffweb.app/'),
  tiled('hackney', 'Hackney', [51.518, -0.107, 51.579, -0.018], 'https://hackney.traffweb.app/'),
  tiled('westminster', 'Westminster', [51.483, -0.219, 51.542, -0.11], 'https://westminster.traffweb.app/'),
  tiled('kensington-chelsea', 'Kensington & Chelsea', [51.475, -0.232, 51.532, -0.147], 'https://rbkc.traffweb.app/'),
  tiled('hammersmith-fulham', 'Hammersmith & Fulham', [51.463, -0.256, 51.535, -0.177], 'https://lbhf.traffweb.app/'),
  // Only Camden's lines and markings: its bays come from its open data (camden.js).
  tiled('camden', 'Camden', [51.511, -0.216, 51.574, -0.103], 'https://camden.traffweb.app/'),
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

/**
 * Controls on days the app can't know, after the usual hours: "… and Emirates
 * Stadium events", "… and Sat-Sun 8.30am-6.30pm when test matches … are held at
 * Lord's", "… during school term time". The rest, and a note saying so.
 */
export function occasionalClause(text) {
  const event = /\s+(?:and|or)\s+((?:(?!\band\b).)*?\bevents?)\s*$/i.exec(text);
  if (event) return { rest: text.slice(0, event.index), note: `Also controlled during ${event[1].replace(/^(?:on|for)\s+/i, '')}: check the signs.` };
  const when = /\s+and\s+((?:(?!\band\b).)*?)\s+when\s+(.*)$/i.exec(text);
  if (when) return { rest: text.slice(0, when.index), note: `Also ${when[1]} when ${when[2]}.` };
  const term = /\s*\b(?:(?:during|in)\s+)?(?:school\s+)?term(?:\s+time)?\b/i.exec(text);
  if (term) return { rest: text.slice(0, term.index) + text.slice(term.index + term[0].length), note: 'During school term time only: the app applies it every week.' };
  return { rest: text };
}

/** What a restriction means for parking, from its wording. */
export function kerbPart(fullText, type = '') {
  const { rest: text, note } = occasionalClause(fullText);
  const notes = note ? [note] : [];
  const t = `${type} ${text}`.toLowerCase();
  // Event days aren't on a calendar the app knows: free otherwise.
  if (/event day|match day/.test(t)) {
    return { label: '', rules: [], otherwise: { effect: 'free', label: 'Free except on event days: check the signs' }, notes: [] };
  }
  // Exemption areas let only taxis or goods vehicles stop on a red route.
  if (/red route exemption/.test(t)) return { label: '', rules: [{ effect: 'no-parking', label: 'No stopping (red route)' }], otherwise: { effect: 'free' }, notes: [tidy(text)] };
  // Blue Badge bays: whatever their hours, not for other drivers.
  if (/disabled|blue badge/.test(t)) return { label: '', rules: [{ effect: 'restricted', label: 'Blue Badge holders only' }], otherwise: { effect: 'free' }, notes };
  let rule;
  if (/red route/.test(t)) rule = { effect: 'no-parking', label: 'No stopping (red route)' };
  else if (/car club|streetcar/.test(t)) rule = { effect: 'restricted', label: 'Car club vehicles only' };
  else if (/electric|charging/.test(t)) rule = { effect: 'restricted', label: 'Electric vehicle charging only' };
  else if (/loading bay|loading only|loading place/.test(t)) rule = { effect: 'restricted', label: 'Loading only' };
  else if (/ambulance|doctor|police|taxi|coach|motorcycle|\bmc\b|diplomat/.test(t)) {
    const who = /ambulance|doctor|police|taxi|coach|motorcycle|\bmc\b|diplomat/.exec(t)[0];
    rule = { effect: 'restricted', label: `${{ ambulance: 'Ambulances', doctor: 'Doctors', police: 'Police', taxi: 'Taxis', coach: 'Coaches', motorcycle: 'Motorcycles', mc: 'Motorcycles', diplomat: 'Diplomats' }[who]} only` };
  }
  else if (/zig.?zag|keep clear|crossing|pelican|puffin|toucan|h.?bar/.test(t)) rule = { effect: 'no-parking', label: 'No stopping (school or crossing markings)' };
  else if (/bus stop|bus stand|clearway|no stopping/.test(t)) rule = { effect: 'no-parking', label: 'No stopping' };
  // "NWAAT": no waiting at any time.
  else if (/market trader/.test(t)) rule = { effect: 'restricted', label: 'Market traders only' };
  else if (/no waiting|no loading|nwaat|prohibition of waiting|double yellow|single yellow|boxed junction|box junction/.test(t)) rule = { effect: 'no-parking' };
  else if (/unrestricted/.test(t)) rule = { effect: 'free' };
  else if (/pay|paid|ticket|shared use|chargeable/.test(t)) rule = { effect: 'paid' };
  // "Permit Holders or Limited Waiting …": anyone may stay a while.
  else if (/limited waiting/.test(t)) rule = { effect: 'free', label: stayLabel(text) };
  // "RP 9": a residents' parking bay.
  else if (/permit|resident|\brp\s*\d/.test(t)) rule = { effect: 'permit' };
  else if (/max(imum)? stay/.test(t)) rule = { effect: 'free', label: stayLabel(text) };
  else if (/free/.test(t)) rule = { effect: 'free' };
  // Bays kept for someone else: "Hospital only", "Supreme Court permit bay".
  else if (/\bonly\b/.test(t)) rule = { effect: 'restricted', label: tidy(text) };
  else return { label: '', rules: [], otherwise: { effect: 'unknown', label: tidy(fullText) }, notes };

  // "At any time", or no times at all (bus stops, box junctions), means always.
  const when = scheduleText(text);
  let schedule = parseSchedule(when);
  // Wording without times can read as a week with no hours in it.
  if (schedule?.kind === 'weekly' && schedule.byDay.every((day) => !day.length)) schedule = null;
  const always = !schedule && !/\d/.test(when);
  if (!schedule && !always) return { label: '', rules: [], otherwise: { effect: 'unknown', label: `Times not recognised: ${tidy(fullText)}` }, notes };
  return {
    label: '',
    rules: [{ ...(always ? {} : { when: schedule }), ...rule }],
    otherwise: { effect: 'free' },
    notes,
  };
}

/** "Free for up to 2 hours": the first length of stay that isn't how long before you can return. */
function stayLabel(text) {
  const max = /(\d+(?:\.\d+)?\s*(?:hours?|hrs?|mins?|minutes?))\b/i.exec(text.replace(/no\s+return(\s+within)?\s*\d+(\.\d+)?\s*\w+/gi, ''));
  return max ? `Free for up to ${max[1]}` : 'Free, limited stay (see sign)';
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
    .replace(/\bon school entrance markings?\b|\boff-street\b/gi, ' ')
    // "School Keep Clear", "School Buses": names, not school terms (which the hours reader refuses).
    .replace(/\bschool\b/gi, ' ')
    // Codes first, whole: "Zone CH1", "TH-0106" (not Thursday), "D3".
    .replace(/\b(zone\s+[a-z]*\d\w*|[a-z]{1,3}-?\d+|no\.\s*\d+)\b/gi, ' ')
    // Then bay numbers: "RP 9", "bay 2", "DIS 16", "CC- 09", "Permit holder only 00176".
    .replace(/\b(?:rp\s*\d+|bay\s+\d+|dis\s*\d+|cc-\s*\d+|0\d+)\b/gi, ' ')
    .replace(/\b(max(imum)?\s+stay|limited\s+waiting|no\s+return(\s+(within|for))?)?\s*\d+(\.\d+)?\s*(hours?|hrs?|mins?|minutes?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidy(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
