// Camden Council's open "Parking Bays" dataset: every on-street bay with its
// restriction type, times of operation, maximum stay and tariff.
// https://opendata.camden.gov.uk/Transport/Parking-Bays/7hiv-3r9k
//
// The whole dataset is fetched once per session and filtered locally, which
// avoids depending on the API's query syntax for its location columns.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap, inBbox } from '../geo.js';

const CAMDEN_URL = 'https://opendata.camden.gov.uk/resource/7hiv-3r9k.json?$limit=50000';
export const CAMDEN_BBOX = [51.505, -0.22, 51.58, -0.1];

let rowsPromise = null;

export async function fetchCamden(bbox, { fetchImpl = fetch } = {}) {
  if (!bboxesOverlap(bbox, CAMDEN_BBOX)) return { options: [], skipped: true };
  rowsPromise ??= fetchImpl(CAMDEN_URL).then((res) => {
    if (!res.ok) throw new Error(`Camden open data returned ${res.status}`);
    return res.json();
  });
  let rows;
  try {
    rows = await rowsPromise;
  } catch (err) {
    rowsPromise = null;
    throw err;
  }
  return { options: parseCamden(rows).filter((o) => inBbox(o.point, bbox)) };
}

export function parseCamden(rows) {
  return rows.map(camdenBay).filter(Boolean);
}

// Column names are matched loosely ("Times Of Operation", "times_of_operation", ...).
function fields(row) {
  const map = new Map();
  for (const [key, value] of Object.entries(row)) map.set(key.toLowerCase().replace(/[^a-z0-9]/g, ''), value);
  return (...names) => {
    for (const name of names) {
      const value = map.get(name);
      if (value != null && value !== '') return typeof value === 'string' ? value.trim() : value;
    }
    return undefined;
  };
}

function camdenBay(row, index) {
  const get = fields(row);
  const lat = Number(get('latitude', 'lat'));
  const lon = Number(get('longitude', 'lon', 'long'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !lat || !lon) return null;

  const type = get('restrictiontype', 'baytype') ?? 'Parking bay';
  const times = get('timesofoperation', 'hoursofoperation', 'operatinghours');
  const road = get('roadname', 'street', 'streetname');
  const zone = get('controlledparkingzone', 'cpz', 'zone');
  const spaces = get('parkingspaces', 'numberofspaces');
  const maxStay = get('maximumstay', 'maxstay');
  const tariff = get('tariff');
  const permits = get('validparkingpermits');

  const notes = [];
  if (maxStay) notes.push(`Max stay ${maxStay}`);
  if (tariff) notes.push(`Tariff: ${tariff}`);
  if (permits) notes.push(`Permits accepted: ${permits}`);

  return {
    id: `camden-${get('id', 'bayid', 'objectid') ?? index}`,
    source: 'camden',
    kind: 'bay',
    title: road ? titleCase(road) : 'Parking bay',
    subtitle: [type, spaces && `${spaces} space${Number(spaces) === 1 ? '' : 's'}`, zone && `zone ${zone}`]
      .filter(Boolean)
      .join(' · '),
    point: [lat, lon],
    lines: bayLine(row),
    parts: [bayPart(type, times)],
    notes,
    link: 'https://opendata.camden.gov.uk/Transport/Parking-Bays/7hiv-3r9k',
  };
}

function bayPart(type, times) {
  const rule = bayRule(type);
  if (!rule) return { label: '', rules: [], otherwise: { effect: 'unknown', label: `Bay type: ${type}` }, notes: [] };
  if (!times) return { label: '', rules: [], otherwise: { effect: 'unknown', label: 'No times given' }, notes: [] };
  const schedule = parseSchedule(times);
  if (!schedule) return { label: '', rules: [], otherwise: { effect: 'unknown', label: `Times: ${times}` }, notes: [] };
  // Bay restrictions only apply during the times on the sign.
  return { label: '', detail: times, rules: [{ when: schedule, ...rule }], otherwise: { effect: 'free' }, notes: [] };
}

const SPECIAL_BAYS = [
  [/disabled|blue badge/, 'Blue Badge holders only'],
  [/car club/, 'Car club vehicles only'],
  [/electric|charging|\bev\b/, 'Electric vehicle charging only'],
  [/motor ?cycle|motorbike|solo m/, 'Motorcycles only'],
  [/loading/, 'Loading only'],
  [/doctor|medical|ambulance|police|diplomat|embassy|taxi|coach|\bbus\b|bicycle|cycle hire|market|hotel|school|private/, null],
];

function bayRule(type) {
  const t = type.toLowerCase();
  for (const [re, label] of SPECIAL_BAYS) {
    if (re.test(t)) return { effect: 'restricted', label: label ?? onlyLabel(type) };
  }
  if (/pay|paid|ticket|shared/.test(t)) return { effect: 'paid', label: /permit|resident/.test(t) ? 'Pay to park (or permit)' : 'Pay to park' };
  if (/permit|resident|business/.test(t)) return { effect: 'permit', label: onlyLabel(type) };
  if (/free/.test(t)) return { effect: 'free' };
  return null;
}

// The dataset carries the bay outline as WKT and/or GeoJSON; use it when it's in lon/lat.
function bayLine(row) {
  for (const value of Object.values(row)) {
    if (value && typeof value === 'object' && /LineString/i.test(value.type ?? '')) {
      const lines = value.type === 'MultiLineString' ? value.coordinates : [value.coordinates];
      if (lines[0]?.[0] && Math.abs(lines[0][0][0]) <= 180) return lines.map((l) => l.map(([x, y]) => [y, x]));
    }
    if (typeof value === 'string' && /^\s*(MULTI)?LINESTRING/i.test(value)) {
      const lines = [...value.matchAll(/\(([^()]+)\)/g)].map((m) =>
        m[1].split(',').map((pair) => pair.trim().split(/\s+/).map(Number)),
      );
      if (lines[0]?.[0] && Math.abs(lines[0][0][0]) <= 180) return lines.map((l) => l.map(([x, y]) => [y, x]));
    }
  }
  return undefined;
}

function onlyLabel(type) {
  return /\bonly$/i.test(type) ? type : `${type} only`;
}

function titleCase(s) {
  return s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
}
