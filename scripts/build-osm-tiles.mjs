// Cuts London's OpenStreetMap extract into small tiles the app loads instead
// of asking the Overpass servers, which are slow and often busy. The deploy
// workflow runs this weekly on Geofabrik's Greater London extract:
//
//   osmium tags-filter london.osm.pbf nwr/amenity=parking w/highway -o filtered.osm.pbf
//   osmium export filtered.osm.pbf -f geojsonseq --add-unique-id=type_id -o london.geojsonseq
//   node scripts/build-osm-tiles.mjs london.geojsonseq data/osm
//
// Each tile holds what the Overpass query would return for its area: car parks
// (with a centre point), roads with street-parking tags, and named roads with
// their geometry. If the build fails, the app simply keeps using Overpass.

import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Tile size in degrees: about 1.1 km north-south by 1.0 km east-west in London. */
export const STEP = [0.01, 0.015];

const NOT_DRIVABLE = new Set([
  'footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'track', 'corridor', 'elevator',
  'platform', 'construction', 'proposed', 'raceway', 'bus_guideway', 'escalator', 'motorway', 'motorway_link',
]);
// Car parks the app would leave out anyway.
const PRIVATE_ACCESS = new Set(['private', 'no', 'permit', 'residents', 'delivery']);
const PRIVATE_PARKING = new Set(['garage_boxes', 'carports', 'garages']);
const KEEP_TAGS = new Set([
  'name', 'highway', 'amenity', 'parking', 'fee', 'fee:conditional', 'opening_hours', 'access', 'maxstay',
  'capacity', 'operator', 'charge',
]);

export const tileKey = (lat, lon) => `${Math.floor(lat / STEP[0])}_${Math.floor(lon / STEP[1])}`;

const round = (n) => Math.round(n * 1e5) / 1e5;

/** osmium's "w123" / "n45" / "a246" (an area: twice the way id, or twice the relation id plus one). */
function osmRef(id) {
  const n = Number(id.slice(1));
  if (id[0] === 'a') return n % 2 ? ['r', (n - 1) / 2] : ['w', n / 2];
  return [id[0], n];
}

function keptTags(properties) {
  return Object.fromEntries(Object.entries(properties).filter(([k]) => KEEP_TAGS.has(k) || k.startsWith('parking:')));
}

function points(geometry) {
  const { type, coordinates } = geometry;
  if (type === 'Point') return [coordinates];
  if (type === 'LineString') return coordinates;
  if (type === 'MultiLineString' || type === 'Polygon') return coordinates.flat();
  if (type === 'MultiPolygon') return coordinates.flat(2);
  return [];
}

/**
 * One GeoJSON feature from osmium → [compact element, tile keys], or null when
 * the app wouldn't use it. Elements are { t, i, k: tags, c: [lat, lon] } for car
 * parks and { t, i, k, g: [[lat, lon], ...] } for roads.
 */
export function element(feature) {
  const tags = feature.properties ?? {};
  const coords = points(feature.geometry ?? {});
  if (!coords.length) return null;
  const [t, i] = osmRef(String(feature.id));

  if (tags.amenity === 'parking') {
    if (PRIVATE_ACCESS.has(tags.access) || PRIVATE_PARKING.has(tags.parking)) return null;
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    const c = [round((Math.min(...lats) + Math.max(...lats)) / 2), round((Math.min(...lons) + Math.max(...lons)) / 2)];
    return [{ t, i, k: keptTags(tags), c }, [tileKey(...c)]];
  }

  const hasParking = Object.keys(tags).some((k) => k.startsWith('parking:'));
  const drivable = tags.highway && !NOT_DRIVABLE.has(tags.highway);
  if (t !== 'w' || !feature.geometry.type.endsWith('LineString') || !(hasParking || (drivable && tags.name))) return null;
  const g = coords.map(([lon, lat]) => [round(lat), round(lon)]);
  // Every tile the road's bounding box touches, so a long road shows up wherever it passes.
  const lats = g.map((p) => p[0]);
  const lons = g.map((p) => p[1]);
  const keys = [];
  for (let a = Math.floor(Math.min(...lats) / STEP[0]); a <= Math.floor(Math.max(...lats) / STEP[0]); a++) {
    for (let b = Math.floor(Math.min(...lons) / STEP[1]); b <= Math.floor(Math.max(...lons) / STEP[1]); b++) keys.push(`${a}_${b}`);
  }
  return [{ t, i, k: keptTags(tags), g }, keys];
}

/**
 * Features → Map of tile key → elements. osmium exports a closed way both as a
 * line and as an area, so each element is kept once (`seen` carries across calls).
 */
export function buildTiles(features, tiles = new Map(), seen = new Set()) {
  for (const feature of features) {
    const result = element(feature);
    if (!result) continue;
    const [el, keys] = result;
    if (seen.has(`${el.t}${el.i}`)) continue;
    seen.add(`${el.t}${el.i}`);
    for (const key of keys) {
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push(el);
    }
  }
  return tiles;
}

async function* readFeatures(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    // geojsonseq lines may start with an ASCII record separator.
    const text = line.replace(/^\x1e/, '').trim();
    if (text) yield JSON.parse(text);
  }
}

async function main(input, outDir) {
  // Streamed a feature at a time: the whole extract wouldn't fit in memory as objects.
  const tiles = new Map();
  const seen = new Set();
  let count = 0;
  for await (const feature of readFeatures(input)) {
    buildTiles([feature], tiles, seen);
    count++;
  }
  if (tiles.size < 500) throw new Error(`only ${tiles.size} tiles: the extract looks wrong`);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  let bytes = 0;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const [key, elements] of tiles) {
    const body = JSON.stringify({ e: elements });
    bytes += body.length;
    await writeFile(`${outDir}/${key}.json`, body);
    const [a, b] = key.split('_').map(Number);
    south = Math.min(south, a * STEP[0]);
    north = Math.max(north, (a + 1) * STEP[0]);
    west = Math.min(west, b * STEP[1]);
    east = Math.max(east, (b + 1) * STEP[1]);
  }
  const updated = new Date().toISOString().slice(0, 10);
  const index = { updated, source: 'OpenStreetMap contributors, via Geofabrik', step: STEP, bbox: [south, west, north, east], tiles: [...tiles.keys()].sort() };
  await writeFile(`${outDir}/index.json`, JSON.stringify(index));
  console.log(`${count} features → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB (largest ${Math.max(...[...tiles.values()].map((e) => JSON.stringify(e).length)) / 1000 | 0} kB).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, outDir = 'data/osm'] = process.argv.slice(2);
  main(input, outDir).catch((err) => {
    console.error(`OpenStreetMap tiles not built: ${err.message}`);
    process.exit(1);
  });
}
