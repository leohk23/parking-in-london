// Controlled parking zone (CPZ) boundaries with their hours, queried live from
// councils' own map services. Every street inside a zone follows its hours, so
// this covers whole boroughs rather than only the streets someone has mapped.
// Councils' map data can lag behind recent hour changes, so the zone entry
// sign still has the final word.

import { parseSchedule } from '../schedule.js';
import { bboxesOverlap, inPolygon } from '../geo.js';

const SUTTON_WFS = 'https://sutton.statmap.co.uk/map/wfs.svc/open_data_lbs_wfs';

// `district` is the council's name as postcodes.io gives it, used to tell
// "outside every zone" apart from "in another borough".
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
];

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

/** GeoJSON features → zone options with polygons as rings of [lat, lon]. */
export function parseZones(json, layer) {
  return (json.features ?? [])
    .map((f) => ({ a: f.properties ?? {}, rings: rings(f.geometry) }))
    .filter(({ rings }) => rings.length)
    .map(({ a, rings }) => {
      const { zone, area, hours, cost, permitOnly } = layer.read(a);
      const schedule = parseSchedule(hours);
      return {
        id: `zone-${layer.id}-${zone}`,
        source: 'council-zones',
        kind: 'zone',
        layer: layer.id,
        title: `Zone ${zone}`,
        subtitle: [area, `${layer.borough} controlled parking zone`].filter(Boolean).join(' · '),
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
        link: a.link || layer.link,
      };
    });
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
      notes: ['Yellow lines, bays and signs still apply.', LAG_NOTE],
      link: layer.link,
    },
  ];
}

function rings(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}
