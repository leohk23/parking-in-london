// Joins the hand-maintained zone list (data/zones.js) to street geometry from
// OpenStreetMap, so zone hours can be drawn on the map.

import * as curated from '../../data/zones.js';
import { parseSchedule } from '../schedule.js';
import { inBbox, bboxesOverlap } from '../geo.js';

const ZONE_NOTE =
  'Outside zone hours you can park free in residents, shared-use and pay bays and on single yellow lines, unless a sign says otherwise. Never on double yellows.';

export function normaliseName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether any hand-maintained borough overlaps the area, i.e. street geometry is worth fetching. */
export function zonesCover(bbox, data = curated) {
  return Object.values(data.BOROUGHS).some((b) => bboxesOverlap(bbox, b.bbox));
}

/** `streets` are named OSM ways: [{ name, line }]. */
export function zoneOptions(streets, data = curated) {
  const byName = new Map();
  for (const street of streets) {
    const key = normaliseName(street.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(street);
  }

  const options = [];
  for (const entry of data.STREETS) {
    const borough = data.BOROUGHS[entry.borough];
    const ways = (byName.get(normaliseName(entry.name)) ?? []).filter((w) =>
      w.line.some((p) => inBbox(p, borough.bbox)),
    );
    if (!ways.length) continue;
    const zones = entry.zones
      .map((id) => data.ZONES.find((z) => z.borough === entry.borough && z.id === id))
      .filter(Boolean);
    options.push({
      id: `zone-${entry.borough}-${normaliseName(entry.name).replace(/ /g, '-')}`,
      source: 'zones',
      kind: 'street',
      title: entry.name,
      subtitle: `${borough.name} parking zone${zones.length > 1 ? 's' : ''} ${zones.map((z) => z.name ?? z.id).join(', ')}`,
      lines: ways.map((w) => w.line),
      parts: zones.map(zonePart),
      notes: [ZONE_NOTE, ...(entry.notes ?? [])],
      link: borough.finder,
      checked: entry.checked,
    });
  }
  return options;
}

function zonePart(zone) {
  const schedule = parseSchedule(zone.hours);
  return {
    label: `Zone ${zone.name ?? zone.id}`,
    detail: [zone.hours, zone.maxStay && `max stay ${zone.maxStay}`].filter(Boolean).join(' · '),
    rules: schedule ? [{ when: schedule, effect: zone.effect ?? 'controlled' }] : [],
    otherwise: schedule ? { effect: 'free' } : { effect: 'unknown', label: `Hours not recognised: ${zone.hours}` },
    notes: zone.notes ?? [],
  };
}
