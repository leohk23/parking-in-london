// Place suggestions while typing, following the office picker in
// Where-to-live-in-London: Photon (built for search-as-you-type) limited to
// Greater London, trying "and"/"&" and ", London" variants, with duplicates removed.
// Postcode-shaped input goes to postcodes.io, which understands partial
// postcodes. Nominatim isn't used here: its usage policy rules out autocomplete.

const LONDON_BBOX = '-0.6,51.2,0.4,51.85';
const POSTCODE_START_RE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]{0,2})?$/i;
const LIMIT = 6;

/** Resolves to [{ label, point: [lat, lon], street }]; empty when nothing matches or a service is down. */
export async function fetchSuggestions(query, { fetchImpl = fetch, signal } = {}) {
  const q = query.trim();
  if (q.length < 3) return [];
  if (POSTCODE_START_RE.test(q)) {
    const postcodes = await fetchPostcodeSuggestions(q, fetchImpl, signal).catch(rethrowAbort);
    if (postcodes?.length) return postcodes;
  }
  for (const variant of queryVariants(q)) {
    let found;
    try {
      found = await fetchPhotonSuggestions(variant, fetchImpl, signal);
    } catch (err) {
      rethrowAbort(err);
      // A blocked or failed request won't succeed for the other variants either.
      return [];
    }
    if (found.length) return unique(found);
  }
  return [];
}

export function queryVariants(query) {
  const variants = [query.trim()];
  const add = (value) => {
    const v = value.trim();
    if (v && !variants.some((x) => x.toLowerCase() === v.toLowerCase())) variants.push(v);
  };
  add(query.replace(/\band\b/gi, '&'));
  add(query.replace(/&/g, 'and'));
  for (const v of [...variants]) if (!/\blondon\b/i.test(v)) add(`${v}, London`);
  return variants;
}

async function fetchPhotonSuggestions(q, fetchImpl, signal) {
  // The box takes in some of Surrey, Kent, Essex and Hertfordshire too: ask for
  // more, and keep Greater London's.
  const params = new URLSearchParams({ q, limit: String(LIMIT * 3), lang: 'en', bbox: LONDON_BBOX });
  const res = await fetchImpl(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) return [];
  const { features = [] } = await res.json();
  return features.filter((f) => f.properties?.county === 'Greater London').slice(0, LIMIT).map((f) => {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry.coordinates;
    return {
      label: photonLabel(p),
      point: [lat, lon],
      street: p.type === 'street' ? p.name ?? null : p.street ?? null,
    };
  });
}

export function photonLabel(p) {
  const parts = [];
  if (p.name && p.name !== p.street) parts.push(p.name);
  if (p.housenumber && p.street) parts.push(`${p.housenumber} ${p.street}`);
  else if (p.street) parts.push(p.street);
  if (p.district && p.district !== p.name) parts.push(p.district);
  else if (p.city) parts.push(p.city);
  if (p.postcode) parts.push(p.postcode);
  return parts.length ? parts.join(', ') : p.name ?? '';
}

async function fetchPostcodeSuggestions(q, fetchImpl, signal) {
  const params = new URLSearchParams({ q, limit: String(LIMIT) });
  const res = await fetchImpl(`https://api.postcodes.io/postcodes?${params}`, { signal });
  if (!res.ok) return [];
  const { result } = await res.json();
  return (result ?? [])
    .filter((r) => r.latitude != null && r.region === 'London')
    .map((r) => ({
      label: [r.postcode, r.admin_ward].filter(Boolean).join(', '),
      point: [r.latitude, r.longitude],
      street: null,
    }));
}

function unique(suggestions) {
  const seen = new Set();
  return suggestions.filter((s) => {
    const key = s.label.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rethrowAbort(err) {
  if (err?.name === 'AbortError') throw err;
}
