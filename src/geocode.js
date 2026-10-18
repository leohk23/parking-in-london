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
