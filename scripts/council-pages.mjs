// Helpers for the scripts that copy councils' street lists into data/: fetching
// pages politely, reading text out of HTML, the borough outline, and writing
// the file the app loads (src/sources/street-lists.js describes its format).

import { readFile, writeFile } from 'node:fs/promises';
import { parseSchedule } from '../src/schedule.js';

const HEADERS = { 'User-Agent': 'parking-in-london (https://github.com/leohk23/parking-in-london)' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', rsquo: '’', lsquo: '‘' };

export function decode(s) {
  // Twice, because some names are double-escaped ("&amp;amp;").
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }
  return s;
}

export const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export async function get(url, as = 'text') {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res[as]();
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** A borough's outline from OpenStreetMap, as rings of [lat, lon]. */
async function boundary(name) {
  const params = new URLSearchParams({ q: name, format: 'geojson', polygon_geojson: '1', polygon_threshold: '0.0003', limit: '1' });
  const json = await get(`https://nominatim.openstreetmap.org/search?${params}`, 'json');
  const geometry = json.features?.[0]?.geometry;
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  const rings = polygons.flat().map((ring) => ring.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]));
  if (!rings.length) throw new Error('no boundary polygon');
  return rings;
}

/**
 * Writes the list with the borough outline (kept from the last copy if
 * OpenStreetMap is unavailable) and reports hours the app couldn't read.
 */
export async function saveList(out, { borough, source, streets, ...extra }) {
  let previous = {};
  try {
    previous = JSON.parse(await readFile(out, 'utf8'));
  } catch {}
  let rings = previous.boundary;
  try {
    rings = await boundary(borough);
  } catch (err) {
    console.warn(`Kept the previous borough outline (${err.message}).`);
  }
  const data = { source, updated: new Date().toISOString().slice(0, 10), ...extra, boundary: rings, streets };
  await writeFile(out, `${JSON.stringify(data)}\n`);

  const parts = Object.values(streets).flat();
  const unread = new Set(parts.filter((p) => p.hours && !parseSchedule(p.hours)).map((p) => p.hours));
  console.log(`${Object.keys(streets).length} streets, ${parts.length} zone rules.`);
  if (unread.size) console.log(`Hours not recognised (${unread.size}):\n  ${[...unread].join('\n  ')}`);
}
