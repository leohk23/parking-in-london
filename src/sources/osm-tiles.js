// OpenStreetMap data prebuilt into small tiles on this site each week
// (scripts/build-osm-tiles.mjs), so most searches don't wait on the Overpass
// servers. Returns the same shape as an Overpass answer, for parseOsm.

// Data files get the same version as this module after a deploy, so a phone never mixes old and new.
const version = new URL(import.meta.url).search;
const BASE = new URL('../../data/osm/', import.meta.url).href;

const indexes = new Map();

/**
 * Overpass-style { elements } for the tiles covering `bbox`. Rejects when the
 * tiles aren't available or don't cover the area, so the caller can ask Overpass.
 */
export async function loadOsmTiles([s, w, n, e], { fetchImpl = fetch, base = BASE } = {}) {
  if (!indexes.has(base)) {
    const index = fetchImpl(`${base}index.json${version}`).then(async (res) => {
      if (!res.ok) throw new Error(`no prebuilt OpenStreetMap tiles (${res.status})`);
      const json = await res.json();
      return { ...json, tiles: new Set(json.tiles) };
    });
    index.catch(() => indexes.delete(base));
    indexes.set(base, index);
  }
  const { step, bbox, tiles, updated } = await indexes.get(base);
  if (s < bbox[0] || w < bbox[1] || n > bbox[2] || e > bbox[3]) throw new Error('outside the prebuilt OpenStreetMap area');

  const keys = [];
  for (let a = Math.floor(s / step[0]); a <= Math.floor(n / step[0]); a++) {
    for (let b = Math.floor(w / step[1]); b <= Math.floor(e / step[1]); b++) {
      if (tiles.has(`${a}_${b}`)) keys.push(`${a}_${b}`);
    }
  }
  const loaded = await Promise.all(
    keys.map(async (key) => {
      const res = await fetchImpl(`${base}${key}.json?v=${updated}`);
      if (!res.ok) throw new Error(`OpenStreetMap tile ${key} returned ${res.status}`);
      return (await res.json()).e;
    }),
  );

  // Roads crossing tile edges are in several tiles: keep one of each.
  const seen = new Set();
  const elements = [];
  for (const el of loaded.flat()) {
    const id = `${el.t}${el.i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const type = { n: 'node', w: 'way', r: 'relation' }[el.t];
    elements.push(
      el.c
        ? { type, id: el.i, tags: el.k, center: { lat: el.c[0], lon: el.c[1] } }
        : { type, id: el.i, tags: el.k, geometry: el.g.map(([lat, lon]) => ({ lat, lon })) },
    );
  }
  return { elements, updated };
}
