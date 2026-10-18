// Controlled parking zone (CPZ) boundaries with their hours, queried live from
// councils' own ArcGIS map services. Every street inside a zone follows its
// hours, so this covers whole boroughs rather than only the streets someone
// has mapped. Councils' map data can lag behind recent hour changes, so the
// zone entry sign still has the final word.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap } from '../geo.js';

export const ZONE_LAYERS = [
  {
    id: 'lbhf',
    borough: 'Hammersmith & Fulham',
    url: 'https://www.rbkc.gov.uk/arcgis/rest/services//LBHF/INSPIRE/MapServer/10',
    bbox: [51.46, -0.26, 51.535, -0.17],
    fields: 'ZONE_,ZONE,DAYS,TIME_,COST',
    zone: (a) => a.ZONE_ || a.ZONE,
    hours: (a) => [a.DAYS, a.TIME_].filter(Boolean).join(' '),
    cost: (a) => a.COST,
    link: 'https://www.lbhf.gov.uk/parking/pay-and-display/parking-zone-times-and-charges',
  },
];

const ZONE_NOTE =
  'Covers every street in the zone. Outside these hours, residents, shared-use and pay bays and single yellow lines are free unless a sign says otherwise. Never double yellows.';
const LAG_NOTE = "From the council's zone map, which can lag behind recent changes: check the zone entry sign.";

export async function fetchCouncilZones(bbox, { fetchImpl = fetch, layers = ZONE_LAYERS } = {}) {
  const relevant = layers.filter((layer) => bboxesOverlap(bbox, layer.bbox));
  const results = await Promise.all(relevant.map((layer) => queryLayer(layer, bbox, fetchImpl)));
  return { options: results.flat(), skipped: !relevant.length };
}

async function queryLayer(layer, [s, w, n, e], fetchImpl) {
  const params = new URLSearchParams({
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: layer.fields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    maxAllowableOffset: '0.00002',
    f: 'geojson',
  });
  const res = await fetchImpl(`${layer.url}/query?${params}`);
  if (!res.ok) throw new Error(`${layer.borough} zone map returned ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${layer.borough} zone map: ${json.error.message}`);
  return parseZones(json, layer);
}

/** GeoJSON features → zone options with polygons as rings of [lat, lon]. */
export function parseZones(json, layer) {
  return (json.features ?? [])
    .map((f) => ({ a: f.properties ?? {}, rings: rings(f.geometry) }))
    .filter(({ rings }) => rings.length)
    .map(({ a, rings }) => {
      const zone = layer.zone(a);
      const hours = layer.hours(a);
      const cost = layer.cost?.(a);
      const permitOnly = /permit holders only/i.test(cost ?? '');
      const schedule = parseSchedule(hours);
      return {
        id: `zone-${layer.id}-${zone}`,
        source: 'council-zones',
        kind: 'zone',
        title: `Zone ${zone}`,
        subtitle: `${layer.borough} controlled parking zone`,
        polygons: rings.map((ring) => ring.map(([lon, lat]) => [lat, lon])),
        parts: [
          {
            label: '',
            detail: [hours, cost].filter(Boolean).join(' · '),
            rules: schedule ? [{ when: schedule, effect: permitOnly ? 'permit' : 'controlled' }] : [],
            otherwise: schedule ? { effect: 'free' } : { effect: 'unknown', label: `Hours not recognised: ${hours}` },
            notes: [],
          },
        ],
        notes: [ZONE_NOTE, LAG_NOTE],
        link: layer.link,
      };
    });
}

function rings(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}
