// Data prebuilt into small tiles on this site each week, so searches don't wait
// on slow servers, or on servers browsers can't read: OpenStreetMap
// (scripts/build-osm-tiles.mjs) and councils' kerbside maps (build-kerb-tiles.mjs).
// A folder holds index.json ({ updated, step, bbox, tiles }) and one file per
// tile, which `decode` turns into elements ({ e } by default), each tagged
// { t, i } so that one crossing tile edges is kept once.

// Data files get the same version as this module after a deploy, so a phone never mixes old and new.
const version = new URL(import.meta.url).search;

const indexes = new Map();

/**
 * The elements of the tiles covering `bbox`. With `whole`, rejects unless the
 * tiles' area covers all of it, so the caller can ask a live server instead.
 */
export async function loadTiles([s, w, n, e], { base, fetchImpl = fetch, whole = false, name = 'prebuilt', decode = (json) => json.e }) {
  if (!indexes.has(base)) {
    const index = fetchImpl(`${base}index.json${version}`).then(async (res) => {
      if (!res.ok) throw new Error(`no prebuilt ${name} tiles (${res.status})`);
      const json = await res.json();
      return { ...json, tiles: new Set(json.tiles) };
    });
    index.catch(() => indexes.delete(base));
    indexes.set(base, index);
  }
  const { step, bbox, tiles, updated } = await indexes.get(base);
  if (whole && (s < bbox[0] || w < bbox[1] || n > bbox[2] || e > bbox[3])) throw new Error(`outside the prebuilt ${name} area`);

  const keys = [];
  for (let a = Math.floor(s / step[0]); a <= Math.floor(n / step[0]); a++) {
    for (let b = Math.floor(w / step[1]); b <= Math.floor(e / step[1]); b++) {
      if (tiles.has(`${a}_${b}`)) keys.push(`${a}_${b}`);
    }
  }
  const loaded = await Promise.all(
    keys.map(async (key) => {
      const res = await fetchImpl(`${base}${key}.json?v=${updated}`);
      if (!res.ok) throw new Error(`${name} tile ${key} returned ${res.status}`);
      return decode(await res.json());
    }),
  );

  const seen = new Set();
  const elements = [];
  for (const el of loaded.flat()) {
    const id = `${el.t}${el.i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    elements.push(el);
  }
  return { elements, updated };
}
