// Refreshes data/richmond.json: which controlled parking zone each street in
// Richmond upon Thames is in, and its hours. The council publishes no zone map,
// only a lookup by address, so for every street (2,000) this asks for its
// addresses and looks up the lowest and highest numbered ones, and the middle
// one when they disagree. That's about 6,000 requests, so a monthly workflow
// runs it (.github/workflows/richmond.yml) rather than every deploy.
//
//   node scripts/update-richmond.mjs

import { fileURLToPath } from 'node:url';
import { get, text, saveList } from './council-pages.mjs';

const SITE = 'https://www.richmond.gov.uk';
const STREETS = `${SITE}/services/parking/cpz`;
const PROPERTY = `${SITE}/my_richmond?pid=`;
const OUT = new URL('../data/richmond.json', import.meta.url);
// Requests at a time: gentle on the council's site, about 40 minutes in all.
const PARALLEL = 4;

/** <option value="USRN">YORK STREET, TWICKENHAM</option> → [{ usrn, name, town }]. */
export function parseStreets(html) {
  return [...html.matchAll(/<option value="(\d+)">([^<]+)</g)].map(([, usrn, label]) => {
    const [name, town = ''] = text(label).split(/,\s*/);
    return { usrn, name: titleCase(name), town: titleCase(town) };
  });
}

/** A street's addresses: [{ uprn, number, postcode }]. */
export function parseProperties(html) {
  const select = /id="UPRN"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
  return [...select.matchAll(/<option value="(\d+)">([^<]+)</g)].map(([, uprn, label]) => {
    const address = text(label);
    return { uprn, number: Number(/^(?:flat \S+,?\s*)?(\d+)/i.exec(address)?.[1] ?? NaN), postcode: /[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.exec(address)?.[0] };
  });
}

/** An address's parking block → { zone, area, hours } or null when it's not in a zone. */
export function parseParking(html) {
  const block = /<div class="my-item my-parking">([\s\S]*?)<a id="my_/.exec(html)?.[1] ?? '';
  const zone = /Controlled Parking Zone \(CPZ\):\s*<strong>([^<]+)<\/strong>/.exec(block)?.[1];
  if (!zone) return /not in a controlled parking zone/i.test(text(block)) ? null : undefined;
  const [code, ...name] = text(zone).split(/\s+-\s+/);
  const hours = text(/<strong>Times:<\/strong>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '');
  return { zone: code, area: name.join(' - '), hours };
}

/**
 * The zone rules of a street from its looked-up addresses (null where not in a
 * zone, undefined where the lookup failed): one part per zone, marked as part
 * of the road when some addresses weren't in it.
 */
export function streetParts(found) {
  const known = found.filter((f) => f !== undefined);
  const zones = known.filter(Boolean);
  if (!zones.length) return [];
  const partial = zones.length < known.length || new Set(zones.map((z) => z.zone)).size > 1;
  const byZone = new Map(zones.map((z) => [z.zone, z]));
  return [...byZone.values()].map(({ zone, area, hours }) => {
    // "Monday to Saturday 8:30am to 6:30pm (part); Monday to Sunday … (part)": parts of the zone differ.
    const parts = hours.split(/\s*;\s*/).map((h) => h.replace(/\s*\(part\)\s*$/i, ''));
    return {
      zone,
      area,
      hours: parts.join('; ').replace(/\s*\(bank and public holidays free\)/gi, ''),
      ...(partial && { section: 'part of the road' }),
      notes: [
        parts.length > 1 && 'Hours differ in parts of this zone: check the signs.',
        /bank and public holidays free/i.test(hours) && 'Free on bank and public holidays.',
      ].filter(Boolean),
    };
  });
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\bSt\b/g, 'St').replace(/'S\b/g, "'s");
}

async function pool(items, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i], i);
      }
    }),
  );
  return out;
}

const lookup = (uprn) => get(`${PROPERTY}${uprn}`).then(parseParking, () => undefined);

async function main() {
  const streets = parseStreets(await get(STREETS));
  if (streets.length < 1500) throw new Error(`only ${streets.length} streets: the page layout may have changed`);
  let done = 0;
  const results = await pool(streets, async (street) => {
    const props = parseProperties(await get(`${STREETS}?USRN=${street.usrn}`).catch(() => ''));
    if (++done % 200 === 0) console.log(`${done} of ${streets.length} streets`);
    if (!props.length) return { street, parts: [] };
    const numbered = props.filter((p) => Number.isFinite(p.number)).sort((a, b) => a.number - b.number);
    const ends = numbered.length >= 2 ? [numbered[0], numbered.at(-1)] : [props[0], props.at(-1)];
    const found = [await lookup(ends[0].uprn), ...(ends[1].uprn !== ends[0].uprn ? [await lookup(ends[1].uprn)] : [])];
    if (found.length === 2 && JSON.stringify(found[0]) !== JSON.stringify(found[1])) {
      found.push(await lookup((numbered.length ? numbered : props)[Math.floor((numbered.length || props.length) / 2)].uprn));
    }
    return { street, parts: streetParts(found), postcode: ends[0].postcode };
  });

  // Same-named roads in different towns ("York Road, Richmond" and "…, Teddington")
  // keep their town; each town's centre is where its streets' postcodes are.
  const towns = new Map();
  for (const { street } of results) {
    const key = street.name.toLowerCase();
    towns.set(key, (towns.get(key) ?? new Set()).add(street.town));
  }
  const out = {};
  for (const { street, parts } of results) {
    if (!parts.length) continue;
    const key = towns.get(street.name.toLowerCase()).size > 1 && street.town ? `${street.name}, ${street.town}` : street.name;
    (out[key] ??= []).push(...parts);
  }
  const localities = await townCentres(results.filter((r) => r.parts.length && r.postcode));
  console.log(`${Object.keys(out).length} streets in zones, of ${streets.length}.`);
  await saveList(OUT, {
    borough: 'London Borough of Richmond upon Thames',
    source: STREETS,
    streets: Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b))),
    localities,
  });
}

/** Each town's centre: the average of its streets' postcodes, from postcodes.io. */
async function townCentres(results) {
  const points = new Map();
  for (let i = 0; i < results.length; i += 100) {
    const batch = results.slice(i, i + 100);
    const res = await fetch('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: batch.map((r) => r.postcode) }),
    }).then((r) => r.json());
    res.result.forEach(({ result }, j) => {
      if (!result) return;
      const town = batch[j].street.town;
      if (!points.has(town)) points.set(town, []);
      points.get(town).push([result.latitude, result.longitude]);
    });
  }
  const mean = (xs) => +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(4);
  return Object.fromEntries([...points].filter(([town]) => town).map(([town, ps]) => [town, [mean(ps.map((p) => p[0])), mean(ps.map((p) => p[1]))]]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Richmond list not updated: ${err.message}`);
    process.exit(1);
  });
}
