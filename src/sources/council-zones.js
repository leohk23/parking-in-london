// Controlled parking zone (CPZ) boundaries with their hours, queried live from
// councils' own map services. Every street inside a zone follows its hours, so
// this covers whole boroughs rather than only the streets someone has mapped.
// Councils' map data can lag behind recent hour changes, so the zone entry
// sign still has the final word.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap, inPolygon } from '../geo.js';

const SUTTON_WFS = 'https://sutton.statmap.co.uk/map/wfs.svc/open_data_lbs_wfs';
const MERTON_CPZ =
  'https://services-eu1.arcgis.com/lDzXrGJF6LKIhYUB/arcgis/rest/services/Controlled_Parking_Zone_Boundaries/FeatureServer/5';
const LAMBETH_CPZ = 'https://gis.lambeth.gov.uk/arcgis/rest/services/LambethControlledParkingZones/MapServer/1';
const RBKC_INSPIRE = 'https://www.rbkc.gov.uk/arcgis/rest/services/RBKC/INSPIRE/MapServer';
const HACKNEY_WFS = 'https://map2.hackney.gov.uk/geoserver/ows';
const NEWHAM_CPZ = 'https://services1.arcgis.com/trOdpHvvP7HrTfdb/arcgis/rest/services/Controlled_Parking_Zones/FeatureServer/0';
// Zone maps browsers can't read, copied here each week by scripts/build-kerb-tiles.mjs.
// Data files get the same version as this module after a deploy.
const copied = (id) => new URL(`../../data/zones/${id}.json${new URL(import.meta.url).search}`, import.meta.url).href;
const RBKC_LINK = 'https://www.rbkc.gov.uk/media/document/controlled-parking-hours-map-september-2024';
const EVENT_RE = /event|occasion/i;

// `district` is the council's name as postcodes.io gives it, used to tell
// "outside every zone" apart from "in another borough"; it's left out where the
// map may miss newer zones. A layer's `read` turns a feature's properties into
// { zone | title, area?, hours, when? (the hours to go by, when they differ from
// those shown), cost?, permitOnly?, unknown?, eventOnly? (controlled on event
// days only), notes? }.
export const ZONE_LAYERS = [
  {
    id: 'lbhf',
    borough: 'Hammersmith & Fulham',
    district: 'Hammersmith and Fulham',
    bbox: [51.46, -0.26, 51.535, -0.17],
    url: (bbox) =>
      arcgisQuery('https://www.rbkc.gov.uk/arcgis/rest/services//LBHF/INSPIRE/MapServer/10', bbox, 'ZONE_,ZONE,DAYS,TIME_,COST'),
    read: (a) => ({
      zone: a.ZONE_ || a.ZONE,
      hours: [a.DAYS, a.TIME_].filter(Boolean).join(' '),
      cost: a.COST,
      permitOnly: /permit holders only/i.test(a.COST ?? ''),
    }),
    link: 'https://www.lbhf.gov.uk/parking/pay-and-display/parking-zone-times-and-charges',
  },
  {
    id: 'sutton',
    borough: 'Sutton',
    district: 'Sutton',
    bbox: [51.325, -0.26, 51.395, -0.12],
    url: (bbox) => wfsQuery(SUTTON_WFS, 'statmap:controlled_parking_zones', bbox),
    // Names look like "Wellington Road and Lingfield Road Zone (A) Mon to Sat 8am to 6.30pm".
    read: (p) => {
      const m = /^(.*?)\s*\(([^)]+)\)\s*(.*)$/.exec(p.name ?? '');
      return {
        zone: m ? m[2] : p.name,
        area: m?.[1].replace(/\s*Zone$/i, ''),
        hours: m ? m[3] : '',
        permitOnly: /ppa|permit/i.test(p.type ?? ''),
      };
    },
    link: 'https://www.sutton.gov.uk/info/200195/parking/1296/about_controlled_parking_zones_cpzs/3',
  },
  {
    id: 'merton',
    borough: 'Merton',
    district: 'Merton',
    bbox: [51.385, -0.255, 51.445, -0.14],
    url: (bbox) => arcgisQuery(MERTON_CPZ, bbox, 'Zone_ID,Zone_Area,Zone_Type,Operation_Summary'),
    // Operation_Summary reads like "Mon-Sat 8:30am - 6:30pm; Sun 11:00am - 3:00pm".
    // One area has no zone ID: its bays are pay and display only, at the times on their signs.
    read: (a) =>
      a.Zone_ID
        ? { zone: a.Zone_ID, area: a.Zone_Area, hours: a.Operation_Summary, permitOnly: /permit/i.test(a.Zone_Type ?? '') }
        : { title: 'Pay and display area', unknown: 'Pay and display bays: times are on the signs' },
    link: 'https://www.merton.gov.uk/streets-parking-transport/parking/cpz/cpz-list',
  },
  {
    id: 'lambeth',
    borough: 'Lambeth',
    district: 'Lambeth',
    bbox: [51.42, -0.155, 51.512, -0.087],
    url: (bbox) => arcgisQuery(LAMBETH_CPZ, bbox, 'NAME,HOURS,CODE_1'),
    // Names look like "Brixton Hill (D)". Hours like "8:30am - 6:30pm Monday - Friday & 10:00am - 12:00pm
    // Monday - Friday" mean some streets have the shorter hours: go by the longer ones.
    read: (a) => {
      const hours = (a.HOURS ?? '').replace(/\s*\(check individual bays\)/i, '');
      const [main, other] = hours.split(/\s+&\s+/);
      return {
        zone: a.CODE_1,
        area: a.NAME?.replace(/\s*\([^)]*\)$/, ''),
        hours,
        when: main,
        notes: [
          other && `Some streets in this zone are controlled ${other} instead: check the signs.`,
          /check individual bays/i.test(a.HOURS ?? '') && 'Some bays have their own hours: check the sign by the bay.',
        ].filter(Boolean),
      };
    },
    link: 'https://www.lambeth.gov.uk/parking/parking-restrictions/where-you-can-park/controlled-parking-zones-cpzs',
  },
  // Kensington & Chelsea is controlled everywhere. Its zones set the hours of
  // single yellow lines and pay bays; residents' bays follow their own, longer, controls.
  {
    id: 'rbkc',
    borough: 'Kensington & Chelsea',
    bbox: [51.476, -0.23, 51.531, -0.149],
    url: (bbox) => arcgisQuery(`${RBKC_INSPIRE}/4`, bbox, 'Name,Type,Zone'),
    read: (a) =>
      a.Zone === 'Restricted'
        ? { title: a.Name?.replace(/^Restricted Zone - /, 'Restricted zone: '), unknown: 'No yellow lines: the times are on the zone entry signs' }
        : { zone: a.Zone, hours: a.Type },
    notes: [
      'Hours for single yellow lines and pay bays across the zone. Outside them you can park on single yellows, and pay bays are free, unless a sign says otherwise. Never on double yellows.',
      "Residents' bays have their own, longer hours.",
    ],
    link: RBKC_LINK,
  },
  {
    id: 'rbkc-bays',
    borough: 'Kensington & Chelsea',
    label: "residents' bay hours",
    bbox: [51.476, -0.23, 51.531, -0.149],
    url: (bbox) => arcgisQuery(`${RBKC_INSPIRE}/13`, bbox, 'Control,Control_1,Control_2,Control_3,Area_Name'),
    // Control_3 is sometimes only for event days or special occasions. Empty fields hold a space.
    read: (a) => {
      const times = [a.Control_1, a.Control_2, a.Control_3].map((t) => t?.trim()).filter(Boolean);
      return {
        zone: a.Control?.trim().replace(/\s+/g, '-'),
        title: a.Area_Name?.trim() || "Residents' bays",
        area: a.Control,
        hours: times.filter((t) => !EVENT_RE.test(t)).join('; '),
        permitOnly: true,
        notes: times.filter((t) => EVENT_RE.test(t)).map((t) => `Also ${t}.`),
      };
    },
    notes: ["Hours for residents' bays: permit holders only then, open to anyone outside them unless a sign says otherwise."],
    link: RBKC_LINK,
  },
  {
    id: 'hackney',
    borough: 'Hackney',
    district: 'Hackney',
    bbox: [51.519, -0.106, 51.579, -0.016],
    url: (bbox) => wfsQuery(HACKNEY_WFS, 'parking:controlled_parking_zone', bbox),
    // Hours read like "Mon-Fri 8.30am-6.30pm<br>Sat 8.30am-1.30pm<br>Emirates Stadium events".
    read: (p) => {
      const lines = (p.controlled_hours ?? '').split(/<br\s*\/?>/i).map((l) => l.trim()).filter(Boolean);
      return {
        zone: p.zone?.replace(/^Zone\s+/i, ''),
        hours: lines.filter((l) => !EVENT_RE.test(l)).join('; '),
        notes: lines.filter((l) => EVENT_RE.test(l)).map((l) => `Extra controls on ${l.replace(/s$/, '')} days: check the signs.`),
      };
    },
    link: 'https://www.hackney.gov.uk/parking-streets-and-transport/where-park/parking-zones',
  },
  // Newham's map lags behind its newer zones, so it can't say a street has none.
  {
    id: 'newham',
    borough: 'Newham',
    bbox: [51.497, -0.022, 51.558, 0.099],
    url: (bbox) => arcgisQuery(NEWHAM_CPZ, bbox, 'NAME,PREFIX,TIMES,CPZ_Status'),
    read: (a) => ({
      zone: a.PREFIX,
      area: a.NAME,
      hours: a.TIMES,
      notes: EVENT_RE.test(a.CPZ_Status ?? '') ? ['Extra controls on event days: check the signs.'] : [],
    }),
    link: 'https://www.newham.gov.uk/parking-rules',
  },
  // The whole City is one controlled zone.
  {
    id: 'city-of-london',
    borough: 'City of London',
    district: 'City of London',
    bbox: [51.506, -0.115, 51.524, -0.07],
    url: (bbox) => arcgisQuery('https://www.mapping.cityoflondon.gov.uk/arcgis/rest/services/COMPASS_Boundary/MapServer/0', bbox, 'OBJECTID'),
    read: () => ({
      title: 'City of London',
      hours: 'Mon-Fri 7am-7pm; Sat 7am-11am',
      notes: ['Pay bays charge Mon-Fri 8am-7pm and Sat 8am-11am, for up to 4 hours. Not on bank holidays.'],
    }),
    label: 'controlled zone',
    link: 'https://www.cityoflondon.gov.uk/services/parking/parking-restrictions',
  },
  {
    id: 'harrow',
    borough: 'Harrow',
    district: 'Harrow',
    bbox: [51.553, -0.407, 51.633, -0.264],
    url: () => copied('harrow'),
    read: (p) => ({ zone: p.zone, area: p.area, hours: p.hours, permitOnly: /permits? only/i.test(p.hours ?? '') }),
    link: 'https://www.harrow.gov.uk/parking',
  },
  {
    id: 'enfield',
    borough: 'Enfield',
    district: 'Enfield',
    bbox: [51.606, -0.182, 51.685, -0.01],
    url: () => copied('enfield'),
    read: traffwebZone,
    link: 'https://enfield.traffweb.app/',
  },
  {
    id: 'bexley',
    borough: 'Bexley',
    district: 'Bexley',
    bbox: [51.408, 0.07, 51.51, 0.22],
    url: () => copied('bexley'),
    read: traffwebZone,
    link: 'https://www.bexley.gov.uk/services/parking-transport-and-streets/parking-permits/residents-parking-permits',
  },
  {
    id: 'islington',
    borough: 'Islington',
    district: 'Islington',
    bbox: [51.515, -0.145, 51.578, -0.075],
    url: () => copied('islington'),
    read: (p) => ({ zone: p.zone, area: p.area, hours: p.hours, notes: p.notes }),
    link: 'https://www.islington.gov.uk/parking/parking-restrictions/controlled-parking-zones',
  },
  {
    id: 'brent',
    borough: 'Brent',
    district: 'Brent',
    bbox: [51.525, -0.34, 51.6, -0.19],
    url: () => copied('brent'),
    read: (p) => ({ zone: p.zone, title: p.title, area: p.area, hours: p.hours, notes: p.notes }),
    // Much of the borough around the stadium is controlled on event days only.
    outsideNotes: ['Around Wembley Stadium, event day restrictions apply on match and concert days: check the signs.'],
    link: 'https://www.brent.gov.uk/parking-roads-and-travel/parking/where-you-can-park/controlled-parking-zones',
  },
  {
    id: 'lewisham',
    borough: 'Lewisham',
    district: 'Lewisham',
    bbox: [51.41, -0.08, 51.495, 0.04],
    url: () => copied('lewisham'),
    read: (p) => ({ zone: p.zone, area: p.area, hours: p.hours }),
    link: 'https://lewisham.gov.uk/myservices/parking/permits/controlled-parking-zones-and-operating-times',
  },
  {
    id: 'greenwich',
    borough: 'Greenwich',
    district: 'Greenwich',
    bbox: [51.42, -0.03, 51.515, 0.125],
    url: () => copied('greenwich'),
    read: (p) => ({ zone: p.zone, area: p.area, hours: p.hours }),
    link: 'https://www.royalgreenwich.gov.uk/directory/71/cpz_fees',
  },
  {
    id: 'haringey',
    borough: 'Haringey',
    district: 'Haringey',
    bbox: [51.562, -0.175, 51.612, -0.04],
    url: () => copied('haringey'),
    read: (p) => ({ title: p.area, hours: p.hours, eventOnly: p.eventOnly, notes: p.notes }),
    link: 'https://haringey.gov.uk/parking/cpzs/all-cpz-hours',
  },
];

/**
 * A zone copied from a TraffWeb council's map: names like "GRANGE PARK CPZ"; a
 * few zones have a code, and some no hours on the map.
 */
function traffwebZone(p) {
  const name = shout(p.area ?? '').replace(/\s*\bC\.?P\.?Z\.?(?=\s|$)/i, '');
  return {
    zone: p.zone,
    title: p.zone ? undefined : name,
    area: p.zone ? name : undefined,
    hours: p.hours ?? '',
    notes: p.notes,
    eventOnly: /event day/i.test(name),
    unknown: 'Hours are on the zone entry signs',
  };
}

/** "GRANGE PARK" → "Grange Park"; names already in mixed case stay as they are. */
function shout(name) {
  return name === name.toUpperCase() ? name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : name;
}

const ZONE_NOTE =
  'Covers every street in the zone. Outside these hours, residents, shared-use and pay bays and single yellow lines are free unless a sign says otherwise. Never double yellows.';
const LAG_NOTE = "From the council's zone map, which can lag behind recent changes: check the zone entry sign.";

export function arcgisQuery(layerUrl, [s, w, n, e], fields) {
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: fields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    maxAllowableOffset: '0.00002',
    f: 'geojson',
  });
  return `${layerUrl}/query?${params}`;
}

/** WFS 1.1 GetFeature as GeoJSON in lon/lat; the bbox is given lon,lat first. */
export function wfsQuery(serviceUrl, typeName, [s, w, n, e], maxFeatures = 1000) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '1.1.0',
    request: 'GetFeature',
    typeName,
    outputFormat: 'application/json',
    srsName: 'EPSG:4326',
    bbox: `${w},${s},${e},${n},EPSG:4326`,
    maxFeatures: String(maxFeatures),
  });
  return `${serviceUrl}?${params}`;
}

export async function fetchCouncilZones(bbox, { fetchImpl = fetch, layers = ZONE_LAYERS } = {}) {
  const relevant = layers.filter((layer) => bboxesOverlap(bbox, layer.bbox));
  const results = await Promise.all(relevant.map((layer) => queryLayer(layer, bbox, fetchImpl)));
  return { options: results.flat(), layers: relevant, skipped: !relevant.length };
}

async function queryLayer(layer, bbox, fetchImpl) {
  const res = await fetchImpl(layer.url(bbox));
  if (!res.ok) throw new Error(`${layer.borough} zone map returned ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${layer.borough} zone map: ${json.error.message}`);
  return parseZones(json, layer);
}

/**
 * GeoJSON features → zone options with polygons as rings of [lat, lon]. Pieces
 * of one zone with the same hours become one option.
 */
export function parseZones(json, layer) {
  const options = new Map();
  for (const f of json.features ?? []) {
    const polygons = rings(f.geometry).map((ring) => ring.map(([lon, lat]) => [lat, lon]));
    if (!polygons.length) continue;
    const read = layer.read(f.properties ?? {});
    const key = JSON.stringify([read.zone ?? read.title, read.area, read.hours, read.notes]);
    if (options.has(key)) options.get(key).polygons.push(...polygons);
    else options.set(key, zoneOption(layer, read, polygons, f.properties?.link));
  }
  // A zone with different hours in different places gets one option for each.
  const ids = new Map();
  return [...options.values()].map((o) => {
    const n = (ids.get(o.id) ?? 0) + 1;
    ids.set(o.id, n);
    return n > 1 ? { ...o, id: `${o.id}-${n}` } : o;
  });
}

function zoneOption(layer, { zone, title, area, hours, when, cost, permitOnly, unknown, eventOnly, notes = [] }, polygons, link) {
  const schedule = parseSchedule(when ?? hours);
  return {
    id: `zone-${layer.id}-${zone ?? title}`,
    source: 'council-zones',
    kind: 'zone',
    layer: layer.id,
    title: title ?? `Zone ${zone}`,
    subtitle: [area, `${layer.borough} ${layer.label ?? 'controlled parking zone'}`].filter(Boolean).join(' · '),
    polygons,
    parts: [
      {
        label: '',
        detail: [hours, cost].filter(Boolean).join(' · '),
        rules: schedule ? [{ when: schedule, effect: permitOnly ? 'permit' : 'controlled' }] : [],
        otherwise: schedule
          ? { effect: 'free' }
          : eventOnly
            ? { effect: 'free', label: 'Free except on event days: check the signs' }
            : { effect: 'unknown', label: unknown ?? `Hours not recognised: ${hours}` },
        notes: [],
      },
    ],
    notes: [...notes, ...(layer.notes ?? [ZONE_NOTE]), LAG_NOTE],
    link: link || layer.link,
  };
}

/**
 * When the council (from postcodes.io) has a zone map and the point is in none
 * of its zones, on-street parking there is uncontrolled: say so explicitly.
 */
export function outsideZones(result, district, point) {
  const layer = result.layers?.find((l) => l.district === district);
  if (!layer) return [];
  const zones = result.options.filter((o) => o.layer === layer.id);
  if (zones.some((z) => inPolygon(point, z.polygons))) return [];
  return [
    {
      id: `zone-${layer.id}-none`,
      source: 'council-zones',
      kind: 'area',
      title: 'No parking zone here',
      subtitle: `${layer.borough}, outside its controlled parking zones`,
      parts: [{ label: '', rules: [], otherwise: { effect: 'free', label: 'Free on streets without yellow lines or bays' }, notes: [] }],
      notes: [...(layer.outsideNotes ?? []), 'Yellow lines, bays and signs still apply.', LAG_NOTE],
      link: layer.link,
    },
  ];
}

function rings(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}
