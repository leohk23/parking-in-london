import { test } from 'node:test';
import assert from 'node:assert/strict';
import { element, buildTiles, tileKey, STEP } from '../scripts/build-osm-tiles.mjs';
import { loadOsmTiles } from '../src/sources/osm-tiles.js';
import { fetchOsm } from '../src/sources/osm.js';

// Features as `osmium export --add-unique-id=type_id` writes them.
const carParkArea = {
  id: 'a246', // way 123, mapped as an area
  properties: { amenity: 'parking', name: 'Malden Centre', fee: 'yes', surface: 'asphalt' },
  geometry: { type: 'Polygon', coordinates: [[[-0.257, 51.401], [-0.255, 51.401], [-0.255, 51.402], [-0.257, 51.402], [-0.257, 51.401]]] },
};
const namedRoad = {
  id: 'w9',
  properties: { highway: 'residential', name: 'Sussex Road', maxspeed: '20 mph' },
  geometry: { type: 'LineString', coordinates: [[-0.2575, 51.4005], [-0.2556, 51.4015]] },
};
const taggedRoad = {
  id: 'w10',
  properties: { highway: 'service', 'parking:both': 'lane', 'parking:both:fee': 'no' },
  geometry: { type: 'LineString', coordinates: [[-0.256, 51.4008], [-0.2555, 51.4009]] },
};
const footway = { id: 'w11', properties: { highway: 'footway', name: 'Alley' }, geometry: { type: 'LineString', coordinates: [[-0.256, 51.4], [-0.255, 51.4]] } };
const unnamedRoad = { id: 'w12', properties: { highway: 'service' }, geometry: { type: 'LineString', coordinates: [[-0.256, 51.4], [-0.255, 51.4]] } };

test('car parks keep their centre and the tags the app reads', () => {
  const [el, keys] = element(carParkArea);
  assert.deepEqual(el, { t: 'w', i: 123, k: { amenity: 'parking', name: 'Malden Centre', fee: 'yes' }, c: [51.4015, -0.256] });
  assert.deepEqual(keys, [tileKey(51.4015, -0.256)]);
  // A relation's area id is odd.
  assert.deepEqual(element({ ...carParkArea, id: 'a247' })[0].t, 'r');
});

test('roads are kept when named and drivable, or tagged with street parking', () => {
  assert.deepEqual(element(namedRoad)[0].g, [[51.4005, -0.2575], [51.4015, -0.2556]]);
  assert.equal(element(taggedRoad)[0].k['parking:both:fee'], 'no');
  assert.equal(element(footway), null);
  assert.equal(element(unnamedRoad), null);
});

test('private car parks are left out, and a way exported twice is kept once', () => {
  assert.equal(element({ ...carParkArea, properties: { amenity: 'parking', access: 'private' } }), null);
  const asLine = { ...carParkArea, id: 'w123', geometry: { type: 'LineString', coordinates: carParkArea.geometry.coordinates[0] } };
  const tiles = buildTiles([carParkArea, asLine]);
  assert.equal([...tiles.values()].flat().length, 1);
});

test('a road crossing a tile edge is in both tiles', () => {
  const long = { ...namedRoad, geometry: { type: 'LineString', coordinates: [[-0.2575, 51.395], [-0.2556, 51.4115]] } };
  const tiles = buildTiles([long]);
  assert.equal(tiles.size, 3); // three tiles north to south, one column
});

function siteFetch(tiles) {
  const files = new Map([
    ['index.json', { updated: '2026-10-19', step: STEP, bbox: [51.28, -0.52, 51.7, 0.34], tiles: [...tiles.keys()] }],
    ...[...tiles].map(([key, e]) => [`${key}.json`, { e }]),
  ]);
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const name = url.replace(/^.*\//, '').replace(/\?.*$/, '');
    return files.has(name) ? { ok: true, json: async () => files.get(name) } : { ok: false, status: 404 };
  };
  return { fetchImpl, requests };
}

test('prebuilt tiles load as an Overpass-style answer, without duplicates', async () => {
  const tiles = buildTiles([carParkArea, namedRoad, taggedRoad, { ...namedRoad, geometry: { type: 'LineString', coordinates: [[-0.2575, 51.395], [-0.2556, 51.4115]] } }]);
  const { fetchImpl } = siteFetch(tiles);
  const json = await loadOsmTiles([51.395, -0.262, 51.406, -0.25], { fetchImpl, base: 'https://site.test/data/osm/' });
  const ids = json.elements.map((e) => `${e.type}${e.id}`);
  assert.deepEqual(ids.sort(), ['way10', 'way123', 'way9']);
  assert.deepEqual(json.elements.find((e) => e.id === 123).center, { lat: 51.4015, lon: -0.256 });
});

test('fetchOsm prefers the tiles, and asks Overpass when they fail', async () => {
  const tiles = buildTiles([carParkArea, namedRoad]);
  const { fetchImpl } = siteFetch(tiles);
  const area = [51.398, -0.26, 51.404, -0.252];
  const prebuilt = await fetchOsm(area, { tiles: (bbox) => loadOsmTiles(bbox, { fetchImpl, base: 'https://other.test/data/osm/' }), fetchImpl });
  assert.equal(prebuilt.via, 'prebuilt');
  assert.deepEqual(prebuilt.streets.map((s) => s.name), ['Sussex Road']);
  assert.equal(prebuilt.options[0].title, 'Malden Centre');

  const overpass = { elements: [] };
  const live = await fetchOsm(area, {
    tiles: async () => {
      throw new Error('no tiles');
    },
    fetchImpl: async () => ({ ok: true, json: async () => overpass }),
  });
  assert.equal(live.via, 'live');
});
