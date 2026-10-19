// Kerbside restrictions (yellow lines, bus stops, bays and markings) as the
// council maps them, queried live. Only Sutton publishes these so far.
// Kerb with no restriction drawn is free to park on, unless a parking zone
// (see council-zones.js) or a sign says otherwise.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap } from '../geo.js';
import { wfsQuery } from './council-zones.js';

const SUTTON_WFS = 'https://sutton.statmap.co.uk/map/wfs.svc/open_data_lbs_wfs';

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
];

export async function fetchKerbside(bbox, { fetchImpl = fetch, layers = KERB_LAYERS } = {}) {
  const relevant = layers.filter((layer) => bboxesOverlap(bbox, layer.bbox));
  const results = await Promise.all(
    relevant.flatMap((layer) =>
      layer.typeNames.map(async (typeName) => {
        const res = await fetchImpl(layer.url(typeName, bbox));
        if (!res.ok) throw new Error(`${layer.borough} kerbside map returned ${res.status}`);
        return parseKerbside(await res.json(), layer);
      }),
    ),
  );
  return { options: groupByRule(results.flat()), skipped: !relevant.length };
}

/** GeoJSON features → one option per stretch of kerb. */
export function parseKerbside(json, layer) {
  const out = [];
  for (const f of json.features ?? []) {
    const { type, text } = layer.read(f.properties ?? {});
    const rule = text || type;
    if (!rule) continue;
    const geometry = f.geometry ?? {};
    const shape = toShape(geometry);
    if (!shape) continue;
    out.push({
      id: `kerb-${layer.id}-${rule}`,
      source: 'kerbside',
      kind: 'kerb',
      title: tidy(rule),
      subtitle: type && type !== rule ? `${tidy(type)} · ${layer.borough}` : `${layer.borough} kerbside restriction`,
      ...shape,
      parts: [kerbPart(rule, type)],
      notes: ['From the council\'s kerbside map: signs and lines on the street have the final word.'],
      link: layer.link,
    });
  }
  return out;
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
  let rule;
  if (/disabled|blue badge/.test(t)) rule = { effect: 'restricted', label: 'Blue Badge holders only' };
  else if (/car club/.test(t)) rule = { effect: 'restricted', label: 'Car club vehicles only' };
  else if (/electric|charging/.test(t)) rule = { effect: 'restricted', label: 'Electric vehicle charging only' };
  else if (/loading bay|loading only/.test(t)) rule = { effect: 'restricted', label: 'Loading only' };
  else if (/ambulance|doctor|police|taxi|coach|motorcycle|diplomat/.test(t)) rule = { effect: 'restricted', label: `${tidy(text)} only` };
  else if (/zig.?zag|keep clear|crossing/.test(t)) rule = { effect: 'no-parking', label: 'No stopping (school or crossing markings)' };
  else if (/bus stop|bus stand|clearway|no stopping/.test(t)) rule = { effect: 'no-parking', label: 'No stopping' };
  else if (/no waiting|no loading|double yellow|single yellow|boxed junction|box junction/.test(t)) rule = { effect: 'no-parking' };
  else if (/pay|ticket|shared use/.test(t)) rule = { effect: 'paid' };
  else if (/permit|resident/.test(t)) rule = { effect: 'permit' };
  else if (/limited waiting|max(imum)? stay/.test(t)) {
    const max = /max(?:imum)? stay\s+(\d+(?:\.\d+)?\s*(?:hours?|hrs?|mins?|minutes?))/i.exec(text);
    rule = { effect: 'free', label: max ? `Free for up to ${max[1]}` : 'Free, limited stay (see sign)' };
  } else if (/free/.test(t)) rule = { effect: 'free' };
  else return { label: '', rules: [], otherwise: { effect: 'unknown', label: tidy(text) }, notes: [] };

  // "At any time", or no times at all (bus stops, box junctions), means always.
  const schedule = parseSchedule(text);
  const always = !schedule && !/\d/.test(text);
  if (!schedule && !always) return { label: '', rules: [], otherwise: { effect: 'unknown', label: `Times not recognised: ${tidy(text)}` }, notes: [] };
  return {
    label: '',
    rules: [{ ...(always ? {} : { when: schedule }), ...rule }],
    otherwise: { effect: 'free' },
    notes: [],
  };
}

function tidy(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
