// Bromley publishes no map of its controlled parking zones, only a lookup of
// the zone at a place (its "Find my CPZ" page on StatMap), which answers
// browsers. So for a search in Bromley, ask it about the spot searched: the
// answer is a zone and its hours, without an outline to draw.

import { parseSchedule } from '../schedule.js';
import { wgs84ToOsgb } from '../osgb.js';

const LOOKUP = 'https://bromley.statmap.co.uk/map/Cluster.svc/getpage';
const SCRIPT = '\\Aurora\\Parking_CPZ_Cluster.AuroraScript$';
const LINK = 'https://www.bromley.gov.uk/parking-enforcement/controlled-parking-zone-cpz';
const NOTE = "From the council's zone lookup for this spot: signs at the entry to the zone have the final word.";

export function bromleyUrl([lat, lon]) {
  const [x, y] = wgs84ToOsgb(lat, lon).map(Math.round);
  const params = new URLSearchParams({ script: SCRIPT, taskId: 'CPZ_id', format: 'js', updateOnly: 'true', query: `x=${x};y=${y};id=0` });
  return `${LOOKUP}?${params}`;
}

/**
 * The lookup's answer, a script that fills in the page: "Your address falls
 * within a CPZ: Maple Road - MAP", "Times: 8.30am - 6.30pm Monday - Saturday",
 * "Conditions: …". { zone, area, hours, notes }, or null outside every zone.
 */
export function parseBromley(script) {
  // The zone goes in one box ("DR1"), "not in a controlled parking zone" in another.
  const box = (id) => {
    const literal = new RegExp(`getElementById\\("${id}"\\)\\.innerHTML=("(?:[^"\\\\]|\\\\.)*")`).exec(script)?.[1];
    return literal === undefined ? undefined : JSON.parse(literal);
  };
  const [zone, other] = [box('DR1'), box('DR2')];
  if (!zone) {
    if (/not in a controlled parking zone/i.test(other ?? '')) return null;
    throw new Error("Bromley's zone lookup gave an unexpected answer");
  }
  const lines = [...zone.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(([, p]) =>
    p.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
  );
  const field = (name) => lines.find((l) => l.startsWith(name))?.slice(name.length).trim();
  const where = field('Your address falls within a CPZ:');
  if (!where) return null;
  const [, area, code] = /^(.*?)\s+-\s+([A-Z0-9/]+)$/.exec(where) ?? [, where];
  const conditions = field('Conditions:');
  return { zone: code, area, hours: field('Times:'), notes: conditions ? [conditions] : [] };
}

/** The zone at `point` as an option, when the council there is Bromley; else none. */
export async function fetchBromleyZone(point, district, { fetchImpl = fetch } = {}) {
  if (district !== 'Bromley') return [];
  const res = await fetchImpl(bromleyUrl(point));
  if (!res.ok) throw new Error(`Bromley's zone lookup returned ${res.status}`);
  const found = parseBromley(await res.text());
  return [found ? zoneOption(found) : outsideOption()];
}

function zoneOption({ zone, area, hours, notes }) {
  const schedule = parseSchedule(hours ?? '');
  return {
    id: `zone-bromley-${zone ?? area}`,
    source: 'council-zones',
    kind: 'area',
    title: zone ? `Zone ${zone}` : area,
    subtitle: [zone && area, 'Bromley controlled parking zone'].filter(Boolean).join(' · '),
    parts: [
      {
        label: '',
        detail: hours,
        rules: schedule ? [{ when: schedule, effect: 'controlled' }] : [],
        // Bromley Town Centre's inner zone says only "Special Conditions apply".
        otherwise: schedule ? { effect: 'free' } : { effect: 'unknown', label: `${hours ? `${hours}: see` : 'Hours are on'} the signs at the entry to the zone` },
        notes: [],
      },
    ],
    notes: [
      ...notes,
      'Covers every street in the zone. Outside these hours, residents, shared-use and pay bays and single yellow lines are free unless a sign says otherwise. Never double yellows.',
      NOTE,
    ],
    link: LINK,
  };
}

function outsideOption() {
  return {
    id: 'zone-bromley-none',
    source: 'council-zones',
    kind: 'area',
    title: 'No parking zone here',
    subtitle: 'Bromley, outside its controlled parking zones',
    parts: [{ label: '', rules: [], otherwise: { effect: 'free', label: 'Free on streets without yellow lines or bays' }, notes: [] }],
    notes: ['Yellow lines, bays and signs still apply.', NOTE],
    link: LINK,
  };
}
