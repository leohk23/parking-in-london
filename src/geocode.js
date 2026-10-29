// Turns what the user typed into a point: UK postcodes via postcodes.io,
// anything else via OpenStreetMap's Nominatim, limited to Greater London and
// the few other places the app covers (areas.js).

import { EXTRA_AREAS, extraAreaAt, extraAreaNamed, COVERED_PLACES } from './areas.js';

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const LONDON_VIEWBOX = '-0.52,51.70,0.34,51.28';

/** Returns { label, point: [lat, lon], street } where street is set when the place is a road. */
export async function geocode(query, { fetchImpl = fetch } = {}) {
  const q = query.trim();
  if (!q) throw new Error('Type a postcode, street or place');

  if (POSTCODE_RE.test(q)) {
    const res = await fetchImpl(`https://api.postcodes.io/postcodes/${encodeURIComponent(q)}`);
    if (res.ok) {
      const { result } = await res.json();
      if (result.region !== 'London' && !extraAreaAt([result.latitude, result.longitude])) throw new Error(`${result.postcode} is outside ${COVERED_PLACES}`);
      return { label: result.postcode, point: [result.latitude, result.longitude], street: null };
    }
    if (res.status !== 404) throw new Error(`Postcode lookup failed (${res.status})`);
  }

  // London first, then the other places, unless the search names one of them.
  const named = extraAreaNamed(q);
  const places = [
    ...(named ? [] : [{ viewbox: LONDON_VIEWBOX, inside: inGreaterLondon }]),
    ...(named ? [named] : EXTRA_AREAS).map(({ bbox: [s, w, n, e] }) => ({
      viewbox: `${w},${n},${e},${s}`,
      inside: (hit) => Boolean(extraAreaAt([Number(hit.lat), Number(hit.lon)])),
    })),
  ];
  let hit;
  for (const { viewbox, inside } of places) {
    const params = new URLSearchParams({
      format: 'jsonv2',
      // The box takes in some places outside the area too: pick the first inside it.
      limit: '5',
      addressdetails: '1',
      countrycodes: 'gb',
      viewbox,
      bounded: '1',
      q,
    });
    const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'Accept-Language': 'en-GB' },
    });
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    hit = (await res.json()).find(inside);
    if (hit) break;
  }
  if (!hit) throw new Error(`Couldn't find "${q}" in ${COVERED_PLACES}`);
  // Bus stops and crossings are "highway" too: only roads count, and anything else
  // is on the road in its address.
  const isRoad = (hit.category ?? hit.class) === 'highway' && ROAD_TYPES.has(hit.type);
  return {
    label: hit.display_name.split(', ').slice(0, 3).join(', '),
    point: [Number(hit.lat), Number(hit.lon)],
    street: isRoad ? hit.name : hit.address?.road ?? null,
  };
}

const ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service', 'living_street',
  'pedestrian', 'road', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

function inGreaterLondon(hit) {
  return hit.address?.['ISO3166-2-lvl6'] === 'GB-LND' || /\bGreater London\b/.test(hit.display_name ?? '');
}

/**
 * Nearest address to a point, e.g. { label: '12 Wimbledon Park Road, SW19 6NL', street: 'Wimbledon Park Road' }.
 * Falls back to the nearest postcode when there's no street address.
 */
export async function reverseGeocode([lat, lon], { fetchImpl = fetch, signal } = {}) {
  try {
    const params = new URLSearchParams({ format: 'jsonv2', lat, lon, zoom: '18', addressdetails: '1' });
    const res = await fetchImpl(`https://nominatim.openstreetmap.org/reverse?${params}`, {
      headers: { 'Accept-Language': 'en-GB' },
      signal,
    });
    if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
    const { address = {} } = await res.json();
    const street = address.road ?? address.pedestrian ?? null;
    const first = [address.house_number, street].filter(Boolean).join(' ') || address.neighbourhood || address.suburb;
    const label = [first, address.postcode].filter(Boolean).join(', ');
    if (!label) throw new Error('No address here');
    return { label, street };
  } catch (err) {
    if (signal?.aborted) throw err;
    const res = await fetchImpl(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&limit=1`, { signal });
    if (!res.ok) throw new Error(`Postcode lookup failed (${res.status})`);
    const { result } = await res.json();
    if (!result?.length) throw new Error('No postcode here');
    return { label: result[0].postcode, street: null };
  }
}

/** The council (local authority) a point is in, e.g. "Sutton", or null when unknown. */
export async function councilAt([lat, lon], { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.postcodes.io/postcodes?lon=${lon}&lat=${lat}&radius=300&limit=1`);
  if (!res.ok) return null;
  const { result } = await res.json();
  return result?.[0]?.admin_district ?? null;
}
