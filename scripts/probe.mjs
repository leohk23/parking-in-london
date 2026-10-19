#!/usr/bin/env node
// Command-line version of the app, for checking what the live data sources
// return for a place:
//
//   node scripts/probe.mjs "Stamford Court, London" [--radius 500] [--stay 120] [--at 2026-10-19T10:00]
//   node scripts/probe.mjs 51.4441,-0.2041
//
// Prints the geocoder's candidates, what OpenStreetMap has nearby (including
// how many roads carry street-parking tags), and the same results list the app shows.

import { geocode, reverseGeocode } from '../src/geocode.js';
import { fetchSuggestions } from '../src/suggest.js';
import { overpassQuery, parseOsm, firstSuccessful, OVERPASS_URLS } from '../src/sources/osm.js';
import { fetchCamden } from '../src/sources/camden.js';
import { fetchCouncilZones, outsideZones } from '../src/sources/council-zones.js';
import { fetchKerbside } from '../src/sources/kerbside.js';
import { zoneOptions, normaliseName } from '../src/sources/zones.js';
import { evaluateOption, STATUS_RANK } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';
import { bboxAround, distanceToOption } from '../src/geo.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const radius = Number(flag('radius', 500));
const stay = Number(flag('stay', 120));
const at = flag('at', null);
const query = args.join(' ').trim();
if (!query) {
  console.error('Usage: node scripts/probe.mjs "<place or lat,lon>" [--radius 500] [--stay 120] [--at YYYY-MM-DDTHH:MM]');
  process.exit(1);
}

// Nominatim asks API users to identify themselves.
const UA = 'parking-in-london-probe (https://github.com/leohk23/parking-in-london)';
const fetchImpl = (url, opts = {}) => fetch(url, { ...opts, headers: { 'User-Agent': UA, ...opts.headers } });

let dest;
const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
if (coords) {
  const point = [Number(coords[1]), Number(coords[2])];
  const place = await reverseGeocode(point, { fetchImpl }).catch((err) => ({ label: `(reverse lookup failed: ${err.message})`, street: null }));
  dest = { label: place.label, point, street: place.street };
  console.log(`Reverse geocode: ${place.label}${place.street ? ` (street: ${place.street})` : ''}`);
} else {
  const suggestions = await fetchSuggestions(query, { fetchImpl }).catch((err) => [{ label: `(failed: ${err.message})`, point: [] }]);
  console.log(`Type-ahead suggestions for "${query}":`);
  for (const sug of suggestions) console.log(`  - ${sug.label}  ${sug.point.join(',')}${sug.street ? `  street=${sug.street}` : ''}`);
  const params = new URLSearchParams({ format: 'jsonv2', limit: '5', countrycodes: 'gb', viewbox: '-0.52,51.70,0.34,51.28', bounded: '1', q: query });
  const res = await fetchImpl(`https://nominatim.openstreetmap.org/search?${params}`);
  const hits = res.ok ? await res.json() : [];
  console.log(`Nominatim candidates for "${query}" (HTTP ${res.status}):`);
  for (const h of hits) console.log(`  - ${h.display_name}  [${h.category}/${h.type}]  ${h.lat},${h.lon}`);
  dest = await geocode(query, { fetchImpl });
}
console.log(`\nDestination: ${dest.label}  ${dest.point.join(',')}${dest.street ? `  street=${dest.street}` : ''}`);
// Which council's data would cover this place.
const council = await fetchImpl(`https://api.postcodes.io/postcodes?lon=${dest.point[1]}&lat=${dest.point[0]}&limit=1`)
  .then((r) => r.json())
  .then(({ result }) => result?.[0])
  .catch(() => null);
if (council) console.log(`Council: ${council.admin_district} (ward: ${council.admin_ward}, nearest postcode ${council.postcode})`);

const area = bboxAround(dest.point, radius);
const body = new URLSearchParams({ data: overpassQuery(area, { street: dest.street, center: dest.point }) });
// Same servers and fallback as the app.
const json = await firstSuccessful(OVERPASS_URLS, 6000, async (url, signal) => {
  const res = await fetchImpl(url, { method: 'POST', body, signal });
  if (!res.ok) throw new Error(`Overpass (${new URL(url).host}) returned ${res.status}`);
  return res.json();
});
const osm = parseOsm(json);

const roads = json.elements.filter((e) => e.tags?.highway);
const tagged = roads.filter((e) => Object.keys(e.tags).some((k) => k.startsWith('parking:')));
const keyCounts = {};
for (const e of tagged) for (const k of Object.keys(e.tags).filter((k) => k.startsWith('parking:'))) keyCounts[k] = (keyCounts[k] ?? 0) + 1;
console.log(`\nOpenStreetMap within ${radius} m: ${json.elements.filter((e) => e.tags?.amenity === 'parking').length} parking areas, ${roads.length} road segments, ${tagged.length} with street-parking tags`);
for (const [k, n] of Object.entries(keyCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${k}: ${n}`);

const camden = await fetchCamden(area, { fetchImpl }).catch((err) => ({ options: [], error: err.message }));
console.log(`Camden bays: ${camden.skipped ? 'outside Camden' : camden.error ? `failed (${camden.error})` : camden.options.length}`);
const zones = zoneOptions(osm.streets);
console.log(`Council zone streets (data/zones.js): ${zones.length}`);
const councilZones = await fetchCouncilZones(area, { fetchImpl }).catch((err) => ({ options: [], error: err.message }));
councilZones.options.push(...outsideZones(councilZones, council?.admin_district, dest.point));
const kerbside = await fetchKerbside(area, { fetchImpl }).catch((err) => ({ options: [], error: err.message }));
console.log(`Council kerbside map: ${kerbside.skipped ? 'no borough layer here' : kerbside.error ? `failed (${kerbside.error})` : `${kerbside.options.length} kinds of restriction`}`);
console.log(`Council zone map: ${councilZones.skipped ? 'no borough layer here' : councilZones.error ? `failed (${councilZones.error})` : councilZones.options.map((z) => z.title).join(', ') || 'none'}`);

const clock = londonClock(at ? new Date(at) : new Date());
const destStreet = dest.street && normaliseName(dest.street);
const options = [...osm.options, ...zones, ...camden.options, ...councilZones.options, ...kerbside.options]
  .map((o) => {
    const distance = distanceToOption(dest.point, o);
    const here = o.kind === 'zone' || o.kind === 'area' ? distance === 0 : Boolean(destStreet && normaliseName(o.title) === destStreet);
    return { ...evaluateOption(o, clock, stay), distance, here };
  })
  .filter((o) => o.here || o.distance <= radius)
  .sort((a, b) => b.here - a.here || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.distance - b.distance);

console.log(`\nResults for ${clock.date} ${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}, staying ${stay} min:`);
for (const o of options) {
  const where = o.here ? (o.kind === 'zone' ? 'you are in it' : o.kind === 'area' ? 'here' : 'your street') : `${Math.round(o.distance)} m`;
  console.log(`  [${o.status.toUpperCase()}] ${o.title} (${where}) - ${o.source}${o.subtitle ? ` - ${o.subtitle}` : ''}`);
  for (const r of o.results) console.log(`      ${r.label ? `${r.label}: ` : ''}${r.summary}${r.detail ? `  [${r.detail}]` : ''}`);
}
if (!options.length) console.log('  (nothing found)');
