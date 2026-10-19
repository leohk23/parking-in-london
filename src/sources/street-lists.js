// Council street lists: the controlled parking zone rules of every street in
// a borough, joined to street geometry from OpenStreetMap so they can be drawn.
// The councils' sites don't allow browser requests, so the deploy workflow
// copies them into data/ (scripts/update-wandsworth.mjs, update-kingston.mjs).
//
// A list file is { source, updated, localities?, boundary: rings of [lat, lon], streets },
// where streets maps a name ("Albert Road", or "Albert Road, New Malden" where
// the council names the locality) to its zone rules:
//   { zone, area, hours, permitOnly?, cost?, maxStay?, numbers? | section? | blocks?, unknown?, notes? }

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap, distance, inBbox, inPolygon } from '../geo.js';

const WIMBLEDON_EVENT_ZONE =
  'During the Wimbledon Championships (late June to mid July) Southfields becomes an event zone controlled 8.30am-8.30pm every day.';
const ZONE_NOTE =
  'Outside zone hours you can park free in residents, shared-use and pay bays and on single yellow lines, unless a sign says otherwise. Never on double yellows.';
// Data files get the same version as this module after a deploy, so a phone never mixes old and new.
const version = new URL(import.meta.url).search;

// `district` is the council's name as postcodes.io gives it. `complete` lists
// cover every controlled street, so a street that isn't in one has no zone.
export const STREET_LISTS = [
  {
    id: 'wandsworth',
    borough: 'Wandsworth',
    district: 'Wandsworth',
    complete: true,
    // Rough outline, used before the list (and its exact boundary) has loaded.
    bbox: [51.41, -0.27, 51.49, -0.11],
    url: new URL(`../../data/wandsworth.json${version}`, import.meta.url).href,
    link: 'https://www.wandsworth.gov.uk/parking/parking-zones/find-parking-zones/',
    areaNotes: { Southfields: WIMBLEDON_EVENT_ZONE },
  },
  {
    id: 'kingston',
    borough: 'Kingston',
    district: 'Kingston upon Thames',
    complete: true,
    bbox: [51.325, -0.335, 51.44, -0.235],
    url: new URL(`../../data/kingston.json${version}`, import.meta.url).href,
    link: 'https://www.kingston.gov.uk/parking/find-street-parking',
    // The council tells same-named roads apart by locality, e.g. "Albert Road, New Malden".
    localities: {
      'New Malden': [51.4013, -0.2565],
      Kingston: [51.4123, -0.3007],
      Surbiton: [51.3937, -0.3033],
      Tolworth: [51.3795, -0.2817],
      Chessington: [51.3605, -0.3005],
    },
  },
  {
    id: 'ealing',
    borough: 'Ealing',
    district: 'Ealing',
    complete: true,
    bbox: [51.487, -0.42, 51.56, -0.24],
    url: new URL(`../../data/ealing.json${version}`, import.meta.url).href,
    link: 'https://www.ealing.gov.uk/info/201333/controlled_parking_zone_cpz',
    // Same-named roads are told apart by postcode district or town ("Church Road, W7"),
    // whose centres are in the file's `localities`.
  },
  {
    id: 'richmond',
    borough: 'Richmond',
    district: 'Richmond upon Thames',
    complete: true,
    bbox: [51.4, -0.42, 51.49, -0.24],
    url: new URL(`../../data/richmond.json${version}`, import.meta.url).href,
    link: 'https://www.richmond.gov.uk/services/parking/cpz/cpz_times',
    // Built from the council's address lookup, monthly (scripts/update-richmond.mjs);
    // same-named roads are told apart by town ("York Road, Teddington").
  },
];

/** "St. Andrew's Road" and "St Andrews Road" both become "st andrews road". */
export function normaliseName(name) {
  return name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether a borough with a street list overlaps the area, i.e. street geometry is worth fetching. */
export function streetListsCover(bbox, lists = STREET_LISTS) {
  return lists.some((list) => bboxesOverlap(bbox, list.bbox));
}

const loaded = new Map();

/** The lists for boroughs near the area: [{ list, data }]. Each file is fetched once. */
export async function loadStreetLists(bbox, { fetchImpl = fetch, lists = STREET_LISTS } = {}) {
  const relevant = lists.filter((list) => bboxesOverlap(bbox, list.bbox));
  return Promise.all(
    relevant.map((list) => {
      if (!loaded.has(list.url)) {
        const load = fetchImpl(list.url).then((res) => {
          if (!res.ok) throw new Error(`${list.borough} street list returned ${res.status}`);
          return res.json();
        });
        load.catch(() => loaded.delete(list.url));
        loaded.set(list.url, load);
      }
      return loaded.get(list.url).then((data) => ({ list, data }));
    }),
  );
}

/**
 * Options for the listed streets among `streets` (named OSM ways: [{ name, line }]),
 * plus the destination's own street even when OpenStreetMap had nothing.
 */
export function streetListOptions(lists, { streets = [], dest } = {}) {
  const ways = new Map();
  for (const street of streets) {
    const key = normaliseName(street.name);
    if (!ways.has(key)) ways.set(key, []);
    ways.get(key).push(street);
  }

  const options = [];
  for (const { list, data } of lists) {
    const inBorough = boroughTest(list, data);
    const destKey = dest?.street && normaliseName(dest.street);
    for (const [key, entries] of streetIndex(list, data)) {
      // Each way takes the entry for its locality ("Albert Road, New Malden"), or the plain one.
      const entryAt = (p) => entries.get(nearestLocality(list, data, p)) ?? entries.get('');
      const groups = new Map();
      for (const way of ways.get(key) ?? []) {
        const entry = way.line.some(inBorough) && entryAt(way.line[0]);
        if (!entry) continue;
        if (!groups.has(entry)) groups.set(entry, []);
        groups.get(entry).push(way.line);
      }
      const destEntry = key === destKey && inBorough(dest.point) && entryAt(dest.point);
      if (destEntry && !groups.has(destEntry)) groups.set(destEntry, []);
      for (const [entry, lines] of groups) options.push(streetOption(list, data, key, entry, lines));
    }
  }
  return options;
}

/**
 * In a borough with a complete list, a destination street that isn't on it
 * has no parking zone: say so, as outsideZones does for councils' zone maps.
 */
export function outsideStreetLists(lists, { dest, council } = {}) {
  const key = dest?.street && normaliseName(dest.street);
  if (!key) return [];
  const found = lists.find(({ list, data }) => list.complete && list.district === council && boroughTest(list, data)(dest.point));
  if (!found || streetIndex(found.list, found.data).has(key)) return [];
  const { list, data } = found;
  return [
    {
      id: `street-${list.id}-none`,
      source: 'street-list',
      kind: 'area',
      title: 'No parking zone on this street',
      subtitle: `${dest.street} isn't in ${list.borough}'s list of zone streets`,
      parts: [{ label: '', rules: [], otherwise: { effect: 'free', label: 'Free where there are no yellow or red lines or bays' }, notes: [] }],
      notes: ['Yellow lines, bays and signs still apply.', "From the council's list of streets in parking zones, which can lag behind recent changes."],
      link: list.link,
      checked: data.updated,
    },
  ];
}

function boroughTest(list, data) {
  return (p) => (data.boundary?.length ? inPolygon(p, data.boundary) : inBbox(p, list.bbox));
}

/** A list's localities: in the code (Kingston's), or in its file (Ealing's postcode districts). */
const localitiesOf = (list, data) => list.localities ?? data.localities ?? {};

function nearestLocality(list, data, p) {
  let best = '';
  let bestDistance = Infinity;
  for (const [name, centre] of Object.entries(localitiesOf(list, data))) {
    const d = distance(p, centre);
    if (d < bestDistance) [best, bestDistance] = [name, d];
  }
  return best;
}

const indexes = new WeakMap();

/** Normalised street name → locality ('' when none) → { name, locality, parts }. */
function streetIndex(list, data) {
  if (indexes.has(data)) return indexes.get(data);
  const index = new Map();
  for (const [listed, parts] of Object.entries(data.streets)) {
    let name = listed;
    let locality = '';
    const comma = listed.lastIndexOf(', ');
    if (comma > 0 && localitiesOf(list, data)[listed.slice(comma + 2)]) [name, locality] = [listed.slice(0, comma), listed.slice(comma + 2)];
    // "Trinity Road (part)" and "Trinity Road" are the same road on the map.
    name = name.replace(/\s*\(.*?\)/g, '');
    const key = normaliseName(name);
    if (!index.has(key)) index.set(key, new Map());
    const byLocality = index.get(key);
    if (!byLocality.has(locality)) byLocality.set(locality, { name, locality, parts: [] });
    byLocality.get(locality).parts.push(...parts);
  }
  indexes.set(data, index);
  return index;
}

function streetOption(list, data, key, entry, lines) {
  const zones = [...new Set(entry.parts.filter((p) => !p.payOnly).map((p) => p.zone))];
  const areas = new Set(entry.parts.map((p) => p.area));
  const notes = Object.entries(list.areaNotes ?? {}).filter(([area]) => areas.has(area)).map(([, note]) => note);
  return {
    id: ['street', list.id, key, entry.locality && normaliseName(entry.locality)].filter(Boolean).join('-').replace(/ /g, '-'),
    source: 'street-list',
    kind: 'street',
    title: entry.name,
    subtitle: `${entry.locality ? `${entry.locality} · ` : ''}${
      zones.length ? `${list.borough} parking zone${zones.length > 1 ? 's' : ''} ${zones.join(', ')}` : `${list.borough} pay-to-park street`
    }`,
    ...(lines.length && { lines }),
    parts: entry.parts.map(streetPart),
    notes: [ZONE_NOTE, ...notes],
    link: list.link,
    checked: data.updated,
  };
}

/** Notes a driver needs on the card itself; the rest are in the info box. */
const FLAG_RE = /red route|private (road|street)/i;

function streetPart(p) {
  const schedule = parseSchedule(p.hours);
  const where = p.numbers
    ? `Nos. ${p.numbers.slice(0, 3).join(', ')}${p.numbers.length > 3 ? '…' : ''}`
    : p.section
      ? clip(p.section, 80)
      : p.blocks?.slice(0, 2).join(', ');
  const flags = [...new Set((p.notes ?? []).filter((n) => FLAG_RE.test(n)).map((n) => n.match(FLAG_RE)[0]))];
  const ringgo = p.ringgo && `RingGo ${p.ringgo}`;
  // Pay bays with no published hours: paid unless the sign says otherwise.
  if (p.payOnly) {
    return {
      label: 'Pay bays',
      detail: [where, p.cost, ringgo].filter(Boolean).join(' · '),
      rules: [],
      otherwise: { effect: 'paid', label: 'Pay to park: hours are on the signs' },
      notes: p.notes ?? [],
    };
  }
  return {
    label: `Zone ${p.zone}`,
    detail: [where, p.hours && shortDays(p.hours), p.permitOnly ? 'permit holders only' : p.cost, ringgo, p.maxStay && `max ${p.maxStay}`, ...flags]
      .filter(Boolean)
      .join(' · '),
    rules: schedule ? [{ when: schedule, effect: p.permitOnly ? 'permit' : 'controlled' }] : [],
    otherwise: schedule ? { effect: 'free' } : { effect: 'unknown', label: p.unknown ?? `Hours not recognised: ${p.hours}` },
    notes: p.notes ?? [],
  };
}

function clip(text, length) {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

function shortDays(text) {
  return text.replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b/gi, (m, d) => d[0].toUpperCase() + d.slice(1).toLowerCase()).replace(/\s+-\s+/g, '–');
}
