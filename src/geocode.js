// Turns what the user typed into a point: UK postcodes via postcodes.io,
// anything else via OpenStreetMap's Nominatim, limited to Greater London.

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
      return { label: result.postcode, point: [result.latitude, result.longitude], street: null };
    }
    if (res.status !== 404) throw new Error(`Postcode lookup failed (${res.status})`);
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    countrycodes: 'gb',
    viewbox: LONDON_VIEWBOX,
    bounded: '1',
    q,
  });
  const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'Accept-Language': 'en-GB' },
  });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const [hit] = await res.json();
  if (!hit) throw new Error(`Couldn't find "${q}" in London`);
  const isRoad = (hit.category ?? hit.class) === 'highway';
  return {
    label: hit.display_name.split(', ').slice(0, 3).join(', '),
    point: [Number(hit.lat), Number(hit.lon)],
    street: isRoad ? hit.name : null,
  };
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
