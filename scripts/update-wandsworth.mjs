// Refreshes data/wandsworth.json from Wandsworth Council's CPZ street finder,
// which lists every controlled street with its zone, house numbers, days and
// hours of control, pay-and-display charge and maximum stay. The council's
// site doesn't allow browser requests, so the deploy workflow runs this and
// publishes the result. If the site is down it leaves the committed copy alone.
//
//   node scripts/update-wandsworth.mjs

import { fileURLToPath } from 'node:url';
import { get, text, saveList } from './council-pages.mjs';

const FINDER = 'https://www.wandsworth.gov.uk/parking/parking-zones/cpz-street-finder-staff-version/';
const OUT = new URL('../data/wandsworth.json', import.meta.url);

/** One entry per street section (or flat block) on a street finder page. */
export function parseFinder(html) {
  const entries = [];
  for (const chunk of html.split(/<h3[^>]*>/i).slice(1)) {
    const end = chunk.search(/<\/h3>/i);
    if (end < 0) continue;
    const heading = text(chunk.slice(0, end));
    const name = /^(.*?)\s*[–-]\s*([A-Z]{1,2}\d{1,2}[A-Z]?)$/.exec(heading);
    const body = chunk.slice(end).split(/<\/p>/i)[0];
    const cpz = /CPZ:\s*\(([^)]*)\)\s*(?:&ndash;|–|-)?\s*([^<]*)/i.exec(body);
    if (!name || !cpz) continue; // the search forms' headings, and streets without a zone
    const field = (label) => {
      const m = new RegExp(`${label}:\\s*<strong>([\\s\\S]*?)</strong>`, 'i').exec(body);
      return m ? text(m[1]) : '';
    };
    entries.push({
      street: name[1],
      postcode: name[2],
      zone: cpz[1].trim(),
      area: text(cpz[2]),
      block: field('Flat block'),
      even: field('Even numbers'),
      odd: field('Odd numbers'),
      days: field('Days of control'),
      hours: field('Hours of control'),
      cost: field('Pay and display cost'),
      maxStay: field('Maximum stay'),
      notes: [...body.matchAll(/<strong[^>]*color:\s*red[^>]*>([\s\S]*?)<\/strong>/gi)]
        .map((m) => text(m[1]).replace(/^please note:\s*/i, ''))
        .filter(Boolean),
    });
  }
  return entries;
}

/** Notes worth showing a driver; "PRS ... ESTATE" and back-office notes are about permits. */
function usefulNotes(note) {
  return note
    .split(/\.\s+/)
    .map((s) => s.replace(/\.$/, '').trim())
    .filter((s) => s && !/^PRS\b|back office/i.test(s))
    .map((s) => (s === s.toUpperCase() ? s[0] + s.slice(1).toLowerCase() : s));
}

/**
 * Street name → its distinct zone rules, with the house numbers each covers.
 * Flat blocks have their own entries, numbered by flat, so they're listed by name.
 */
export function groupStreets(entries) {
  const streets = new Map();
  for (const e of entries) {
    const permitOnly = /no p&d|permit holders only/i.test(e.cost);
    const cost = permitOnly ? '' : e.cost.replace(/^£\s*(?=£)/, '');
    const maxStay = /no p&d/i.test(e.maxStay) ? '' : e.maxStay;
    const key = [e.zone, e.days, e.hours, cost, maxStay, permitOnly].join('|');
    if (!streets.has(e.street)) streets.set(e.street, new Map());
    const parts = streets.get(e.street);
    if (!parts.has(key)) {
      parts.set(key, { zone: e.zone, area: e.area, days: e.days, hours: e.hours, cost, maxStay, permitOnly, postcodes: new Set(), numbers: new Set(), blocks: new Set(), notes: new Set() });
    }
    const part = parts.get(key);
    part.postcodes.add(e.postcode);
    if (e.block) part.blocks.add(e.block);
    else {
      for (const [side, range] of [['odd', e.odd], ['even', e.even]]) {
        if (/^\d/.test(range)) part.numbers.add(`${range.replace(/\s*-\s*/g, '–')} ${side}`);
      }
    }
    for (const n of e.notes.flatMap(usefulNotes)) part.notes.add(n);
  }

  const out = {};
  for (const name of [...streets.keys()].sort((a, b) => a.localeCompare(b))) {
    out[name] = [...streets.get(name).values()].map((p) => {
      const part = { zone: p.zone, area: p.area, postcodes: [...p.postcodes], hours: `${p.days} ${p.hours}` };
      if (p.permitOnly) part.permitOnly = true;
      if (p.cost) part.cost = p.cost;
      if (p.maxStay) part.maxStay = p.maxStay;
      if (p.numbers.size) part.numbers = [...p.numbers];
      else if (p.blocks.size) part.blocks = [...p.blocks];
      if (p.notes.size) part.notes = [...p.notes];
      return part;
    });
  }
  return out;
}

async function main() {
  const entries = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    entries.push(...parseFinder(await get(`${FINDER}?streetletter=${letter}`)));
  }
  if (entries.length < 1000) throw new Error(`only ${entries.length} entries: the page layout may have changed`);
  console.log(`${entries.length} entries.`);
  await saveList(OUT, { borough: 'London Borough of Wandsworth', source: FINDER, streets: groupStreets(entries) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Wandsworth street finder not updated: ${err.message}`);
    process.exit(1);
  });
}
