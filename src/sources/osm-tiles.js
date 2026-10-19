// OpenStreetMap data prebuilt into small tiles on this site each week
// (scripts/build-osm-tiles.mjs), so most searches don't wait on the Overpass
// servers. Returns the same shape as an Overpass answer, for parseOsm.

import { loadTiles } from './tiles.js';

const BASE = new URL('../../data/osm/', import.meta.url).href;

/**
 * Overpass-style { elements } for the tiles covering `bbox`. Rejects when the
 * tiles aren't available or don't cover the area, so the caller can ask Overpass.
 */
export async function loadOsmTiles(bbox, { fetchImpl = fetch, base = BASE } = {}) {
  const { elements, updated } = await loadTiles(bbox, { base, fetchImpl, whole: true, name: 'OpenStreetMap' });
  return {
    updated,
    elements: elements.map((el) => {
      const type = { n: 'node', w: 'way', r: 'relation' }[el.t];
      return el.c
        ? { type, id: el.i, tags: el.k, center: { lat: el.c[0], lon: el.c[1] } }
        : { type, id: el.i, tags: el.k, geometry: el.g.map(([lat, lon]) => ({ lat, lon })) };
    }),
  };
}
