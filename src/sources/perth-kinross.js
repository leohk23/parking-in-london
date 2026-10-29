// Perth & Kinross Council's car parks, from its open data (an ArcGIS layer
// that answers browsers), for Pitlochry, the one place in Perth & Kinross the
// app covers. The layer says which car parks charge, not when: Pitlochry's
// charge Monday to Saturday, 8am to 6pm (RingGo's listing for Atholl Road,
// checked 2026-10-29). Its town centre streets are mostly free for a short
// stay, which a card for the town says.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap } from '../geo.js';
import { arcgisQuery } from './council-zones.js';
import { extraAreaAt } from '../areas.js';

const CAR_PARKS = 'https://services-eu1.arcgis.com/WD0cvOmDKf7CA0Xy/ArcGIS/rest/services/Car_Parking_Points/FeatureServer/6';
const PITLOCHRY = [56.685, -3.78, 56.725, -3.69];
const CHARGE_HOURS = { PITLOCHRY: 'Mon-Sat 8am-6pm' };
const LINK = 'https://www.pkc.gov.uk/carparks';
const STREETS_LINK = 'https://www.pkc.gov.uk/ruralperthshireparking';

/** { options, skipped } for `bbox`: the council's car parks, and a card for Pitlochry's streets when `point` is in the town. */
export async function fetchPerthKinross(bbox, point, { fetchImpl = fetch } = {}) {
  if (!bboxesOverlap(bbox, PITLOCHRY)) return { options: [], skipped: true };
  const res = await fetchImpl(arcgisQuery(CAR_PARKS, bbox, 'CAR_PARK_NAME,STREET_NAME,STATUS,NO_BAYS,DISABLED_BAYS,FREE_OR_CHARGE,LENGTH_OF_STAY,ELEC_POINT,TOWN'));
  if (!res.ok) throw new Error(`Perth & Kinross car parks returned ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`Perth & Kinross car parks: ${json.error.message}`);
  const carParks = (json.features ?? []).map((f) => carParkOption(f.properties ?? {}, f.geometry)).filter(Boolean);
  return { options: [...carParks, ...(extraAreaAt(point)?.name === 'Pitlochry' ? [pitlochryStreets()] : [])] };
}

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** A car park on the council's layer → an option, or null for private ones. */
export function carParkOption(p, geometry) {
  if (geometry?.type !== 'Point' || (p.STATUS && p.STATUS !== 'PUBLIC')) return null;
  const [lon, lat] = geometry.coordinates;
  const name = titleCase(p.CAR_PARK_NAME?.trim() || p.STREET_NAME?.trim() || 'Car park');
  // Two halves of one car park ("Car park off Ferry Road West" and "… East") share a name.
  const side = /\b(EAST|WEST|NORTH|SOUTH)$/.exec(p.STREET_NAME ?? '')?.[1];
  const hours = CHARGE_HOURS[p.TOWN?.trim()];
  const charged = p.FREE_OR_CHARGE === 'CHARGE';
  const schedule = charged && hours ? parseSchedule(hours) : null;
  const part = !charged
    ? { label: '', rules: [], otherwise: { effect: 'free' }, notes: [] }
    : schedule
      ? { label: '', detail: `Pay and display ${hours}`, rules: [{ when: schedule, effect: 'paid' }], otherwise: { effect: 'free' }, notes: [] }
      : { label: '', rules: [], otherwise: { effect: 'paid' }, notes: [] };
  const spaces = Number(p.NO_BAYS) || null;
  const chargers = Number(p.ELEC_POINT) || 0;
  return {
    id: `pkc-${name}${side ? `-${side}` : ''}`,
    source: 'perth-kinross',
    kind: 'car-park',
    // "… car park", so it isn't taken for the street searched.
    title: `${name} car park${side ? ` (${side.toLowerCase()})` : ''}`,
    subtitle: ['Council car park', spaces && `${spaces} spaces`, p.DISABLED_BAYS && `${p.DISABLED_BAYS} Blue Badge`].filter(Boolean).join(' · '),
    point: [lat, lon],
    parts: [part],
    notes: [
      ...(charged && hours ? ['Charging hours from RingGo\'s listing: check the tariff board, which has the prices.'] : []),
      ...(chargers ? [`${chargers} electric vehicle charging point${chargers === 1 ? '' : 's'}`] : []),
      "From Perth & Kinross Council's open data.",
    ],
    link: LINK,
  };
}

function pitlochryStreets() {
  return {
    id: 'pkc-pitlochry-streets',
    source: 'perth-kinross',
    kind: 'area',
    title: "Pitlochry's streets",
    subtitle: 'On-street parking in Pitlochry',
    parts: [
      {
        label: '',
        rules: [],
        otherwise: { effect: 'unknown', label: 'Mostly free for up to 30 minutes in the town centre, no return within 30 minutes: check the signs' },
        notes: [],
      },
    ],
    notes: ['Limits vary from street to street, and the signs have the final word. Never on double yellows.', 'From local guides to parking in Pitlochry: the council publishes no list of its street restrictions.'],
    link: STREETS_LINK,
  };
}
