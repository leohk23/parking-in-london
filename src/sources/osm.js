// OpenStreetMap via the Overpass API: car parks, street parking tagged on
// roads, and named street geometry (used to draw council zone data).
//
// Street parking follows the current OSM scheme (parking:left/right/both=*)
// and the older one (parking:lane:* / parking:condition:*).
// https://wiki.openstreetmap.org/wiki/Street_parking

import { parseSchedule } from '../schedule.js';

// The main Overpass server first; mirrors join in if it's slow or failing.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEDGE_AFTER_MS = 6000;

const NOT_DRIVABLE = new Set([
  'footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'track', 'corridor', 'elevator',
  'platform', 'construction', 'proposed', 'raceway', 'bus_guideway', 'escalator', 'motorway', 'motorway_link',
]);
const PRIVATE_ACCESS = new Set(['private', 'no', 'permit', 'residents', 'delivery']);
const PRIVATE_PARKING = new Set(['garage_boxes', 'carports', 'garages']);
const PARKING_TYPES = {
  'multi-storey': 'Multi-storey car park',
  underground: 'Underground car park',
  rooftop: 'Rooftop car park',
  surface: 'Car park',
  street_side: 'Street-side parking',
  lane: 'Parking lane',
  layby: 'Lay-by',
};

/**
 * `streets` adds every named road's geometry, which is only needed where
 * hand-maintained zone data (data/zones.js) has streets to draw.
 */
export function overpassQuery([s, w, n, e], { street, center, streets = true } = {}) {
  const bbox = `${s},${w},${n},${e}`;
  // The destination street is fetched in full, even beyond the search box.
  const wholeStreet =
    street && center
      ? `way["highway"]["name"="${street.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"](around:2500,${center[0]},${center[1]});`
      : '';
  const named = streets ? `way["highway"]["name"](${bbox});` : '';
  return `[out:json][timeout:25];
nwr["amenity"="parking"](${bbox})->.parking;
.parking out center;
(${named}way["highway"][~"^parking:"~"."](${bbox});${wholeStreet});
out geom;`;
}

export async function fetchOsm(bbox, { street, center, streets, fetchImpl = fetch, endpoints = OVERPASS_URLS, hedgeAfterMs = HEDGE_AFTER_MS } = {}) {
  const body = new URLSearchParams({ data: overpassQuery(bbox, { street, center, streets }) }).toString();
  const json = await firstSuccessful(endpoints, hedgeAfterMs, async (url, signal) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
      signal,
    });
    if (!res.ok) throw new Error(`OpenStreetMap (Overpass) returned ${res.status}`);
    return res.json();
  });
  return parseOsm(json);
}

/**
 * Asks the first endpoint, and the next one whenever `delayMs` passes without
 * an answer or a request fails. Resolves with the first success and cancels
 * the rest; rejects only when every endpoint has failed.
 */
export function firstSuccessful(endpoints, delayMs, request) {
  return new Promise((resolve, reject) => {
    const controllers = [];
    let failures = 0;
    let settled = false;
    let timer;
    const launch = () => {
      clearTimeout(timer);
      if (settled || controllers.length >= endpoints.length) return;
      const controller = new AbortController();
      controllers.push(controller);
      request(endpoints[controllers.length - 1], controller.signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          for (const c of controllers) if (c !== controller) c.abort();
          resolve(value);
        },
        (err) => {
          if (settled) return;
          if (++failures === endpoints.length) {
            settled = true;
            reject(err);
          } else launch();
        },
      );
      timer = setTimeout(launch, delayMs);
    };
    launch();
  });
}

/** Returns { options, streets }: parking options, and named roads with their geometry. */
export function parseOsm(json) {
  const options = [];
  const streets = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (tags.amenity === 'parking') {
      const option = carPark(el);
      if (option) options.push(option);
      continue;
    }
    if (!tags.highway || NOT_DRIVABLE.has(tags.highway) || !el.geometry?.length) continue;
    const line = el.geometry.map((g) => [g.lat, g.lon]);
    if (tags.name) streets.push({ id: el.id, name: tags.name, line });
    const parts = streetParts(tags);
    if (parts.length) {
      options.push({
        id: `osm-way-${el.id}`,
        source: 'osm',
        kind: 'street',
        title: tags.name ?? 'Unnamed road',
        subtitle: 'Street parking',
        lines: [line],
        parts,
        notes: [],
        link: `https://www.openstreetmap.org/way/${el.id}`,
      });
    }
  }
  return { options: mergeStreets(options), streets };
}

// Neighbouring ways of one street usually carry identical tags: show them once.
function mergeStreets(options) {
  const out = [];
  const byKey = new Map();
  for (const option of options) {
    if (option.kind !== 'street') {
      out.push(option);
      continue;
    }
    const key = `${option.title}|${JSON.stringify(option.parts)}`;
    const existing = byKey.get(key);
    if (existing) existing.lines.push(...option.lines);
    else {
      byKey.set(key, option);
      out.push(option);
    }
  }
  return out;
}

function carPark(el) {
  const t = el.tags;
  if (PRIVATE_ACCESS.has(t.access) || PRIVATE_PARKING.has(t.parking)) return null;
  const point = el.lat != null ? [el.lat, el.lon] : el.center ? [el.center.lat, el.center.lon] : null;
  if (!point) return null;

  const notes = [];
  if (t.access === 'customers') notes.push('Customers only');
  if (t.maxstay) notes.push(`Max stay ${t.maxstay}`);
  if (t.charge) notes.push(`Charge: ${t.charge}`);

  let part;
  const fee = feeRules(t.fee, t['fee:conditional']);
  if (!fee) {
    part = unknownPart(`Fee: ${t['fee:conditional']}`);
  } else {
    const rules = [];
    if (t.opening_hours && t.opening_hours !== '24/7') {
      const open = parseSchedule(t.opening_hours);
      if (open) rules.push({ whenNot: open, effect: 'closed' });
      else notes.push(`Opening hours: ${t.opening_hours}`);
    }
    part = { label: '', rules: [...rules, ...fee.rules], otherwise: fee.otherwise, notes: [] };
  }

  const type = PARKING_TYPES[t.parking] ?? 'Car park';
  return {
    id: `osm-${el.type}-${el.id}`,
    source: 'osm',
    kind: 'car-park',
    title: t.name ?? type,
    subtitle: [t.name ? type : null, t.operator, t.capacity && `${t.capacity} spaces`].filter(Boolean).join(' · '),
    point,
    parts: [part],
    notes,
    link: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

function feeRules(fee, conditional) {
  const rules = [];
  if (conditional) {
    const entries = parseConditional(conditional);
    if (!entries) return null;
    for (const { value, schedule } of entries) rules.push({ when: schedule, ...feeEffect(value) });
  }
  const otherwise =
    fee === 'yes' ? { effect: 'paid' }
      : fee === 'no' || conditional ? { effect: 'free' }
        : { effect: 'unknown', label: 'Fee not mapped' };
  return { rules, otherwise };
}

function feeEffect(value) {
  return value === 'yes' ? { effect: 'paid' } : value === 'no' ? { effect: 'free' } : { effect: 'unknown' };
}

/** "no_parking @ (Mo-Fr 07:00-09:00); ..." → [{ value, schedule }], or null if any part is unreadable. */
export function parseConditional(text) {
  const out = [];
  for (const piece of splitTopLevel(text, ';')) {
    const m = piece.match(/^\s*([^@]+?)\s*@\s*(.+?)\s*$/);
    if (!m) return null;
    const condition = m[2].replace(/^\((.*)\)$/, '$1');
    const schedule = parseSchedule(condition);
    if (!schedule) return null;
    out.push({ value: m[1].trim(), schedule });
  }
  return out.length ? out : null;
}

function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((s) => s.trim());
}

function unknownPart(note) {
  return { label: '', rules: [], otherwise: { effect: 'unknown', label: 'Terms not recognised' }, notes: [note] };
}

function streetParts(tags) {
  const [left, right] = ['left', 'right'].map((side) => newSchemeSide(tags, side) ?? oldSchemeSide(tags, side));
  if (left && right && JSON.stringify(left) === JSON.stringify(right)) return [{ ...left, label: 'Both sides' }];
  return [left && { ...left, label: 'One side' }, right && { ...right, label: 'Other side' }].filter(Boolean);
}

const PARKING_ROWS = new Set(['lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder', 'yes']);
const NEW_SCHEME_KEYS = ['', ':restriction', ':restriction:conditional', ':access', ':access:conditional', ':fee', ':fee:conditional'];

function restrictionEffect(value) {
  if (['no_parking', 'no_stopping', 'no_standing'].includes(value)) return { effect: 'no-parking' };
  if (value === 'loading_only') return { effect: 'restricted', label: 'Loading only' };
  if (value === 'charging_only') return { effect: 'restricted', label: 'Electric vehicle charging only' };
  if (value === 'disabled') return { effect: 'restricted', label: 'Blue Badge holders only' };
  return null;
}

function accessEffect(value) {
  if (value === 'private' || value === 'no') return { effect: 'restricted', label: 'Private' };
  if (value === 'permit' || value === 'residents') return { effect: 'permit' };
  if (value === 'customers') return { effect: 'restricted', label: 'Customers only' };
  if (value === 'delivery') return { effect: 'restricted', label: 'Deliveries only' };
  if (value === 'disabled') return { effect: 'restricted', label: 'Blue Badge holders only' };
  return null;
}

function newSchemeSide(tags, side) {
  const get = (key) => tags[`parking:${side}${key}`] ?? tags[`parking:both${key}`];
  if (!NEW_SCHEME_KEYS.some((k) => get(k) != null)) return null;
  const orientation = get('');
  if (orientation === 'separate') return null;

  const rules = [];
  let timed = false;
  for (const [key, toEffect] of [
    [':restriction', restrictionEffect],
    [':access', accessEffect],
    [':fee', feeEffect],
  ]) {
    const conditional = get(`${key}:conditional`);
    if (conditional) {
      const entries = parseConditional(conditional);
      if (!entries) return unknownPart(`${key.slice(1)}: ${conditional}`);
      for (const { value, schedule } of entries) {
        const effect = toEffect(value);
        if (effect) rules.push({ when: schedule, ...effect });
      }
      timed = true;
    }
    const plain = get(key);
    if (plain && key !== ':fee') {
      const effect = toEffect(plain);
      if (effect) rules.push(effect);
    }
  }

  const fee = get(':fee');
  let otherwise;
  if (orientation === 'no') otherwise = { effect: 'no-parking' };
  else if (fee === 'yes') otherwise = { effect: 'paid' };
  else if (fee === 'no' || timed) otherwise = { effect: 'free' };
  else otherwise = { effect: 'unknown', label: PARKING_ROWS.has(orientation) ? 'Parking, terms not mapped' : undefined };

  const notes = [];
  const maxstay = get(':maxstay');
  const zone = get(':zone');
  if (maxstay) notes.push(`Max stay ${maxstay}`);
  if (zone) notes.push(`Zone ${zone}`);
  return { label: '', rules, otherwise, notes };
}

function conditionEffect(value) {
  switch (value) {
    case 'free': return { effect: 'free' };
    case 'ticket': return { effect: 'paid' };
    case 'disc': return { effect: 'free', label: 'Free with a parking disc' };
    case 'residents': return { effect: 'permit', label: 'Residents only' };
    case 'customers': return { effect: 'restricted', label: 'Customers only' };
    case 'private': return { effect: 'restricted', label: 'Private' };
    case 'loading': return { effect: 'restricted', label: 'Loading only' };
    case 'disabled': return { effect: 'restricted', label: 'Blue Badge holders only' };
    case 'no_parking':
    case 'no_stopping':
    case 'no_standing': return { effect: 'no-parking' };
    default: return { effect: 'unknown' };
  }
}

function oldSchemeSide(tags, side) {
  const get = (base, suffix = '') => tags[`parking:${base}:${side}${suffix}`] ?? tags[`parking:${base}:both${suffix}`];
  const lane = get('lane');
  const condition = get('condition');
  if (!lane && !condition) return null;
  if (lane === 'separate') return null;

  const notes = [];
  const maxstay = get('condition', ':maxstay');
  if (maxstay) notes.push(`Max stay ${maxstay}`);
  if (!condition) {
    const noParking = ['no_parking', 'no_stopping', 'fire_lane', 'no'].includes(lane);
    return {
      label: '',
      rules: [],
      otherwise: noParking ? { effect: 'no-parking' } : { effect: 'unknown', label: 'Parking, terms not mapped' },
      notes,
    };
  }
  const interval = get('condition', ':time_interval');
  if (!interval) return { label: '', rules: [], otherwise: conditionEffect(condition), notes };
  const schedule = parseSchedule(interval);
  if (!schedule) return unknownPart(`Times: ${interval}`);
  const fallback = get('condition', ':default');
  return {
    label: '',
    rules: [{ when: schedule, ...conditionEffect(condition) }],
    otherwise: fallback ? conditionEffect(fallback) : { effect: 'free' },
    notes,
  };
}
