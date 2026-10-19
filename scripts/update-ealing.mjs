// Refreshes data/ealing.json from Ealing Council's controlled parking zone
// pages, each of which gives the zone's hours and the streets in it. Most
// zones' hours are read from the page; the few written as prose with
// exceptions are transcribed into ZONES below, and the script warns when
// their wording changes. Ealing's zone map isn't open to other sites, so the
// deploy workflow runs this and publishes the result.
//
//   node scripts/update-ealing.mjs

import { fileURLToPath } from 'node:url';
import { get, text, saveList } from './council-pages.mjs';
import { normaliseName } from '../src/sources/street-lists.js';

const SITE = 'https://www.ealing.gov.uk';
const DIRECTORY = `${SITE}/info/201333/controlled_parking_zone_cpz`;
const OUT = new URL('../data/ealing.json', import.meta.url);
const SIGNS = 'Hours are on the signs at the entry to the zone';

// Zones whose hours the page gives with exceptions, checked 2026-10-19 against
// the wording in `was`. `parts` are zones listed together on one page.
export const ZONES = {
  'C/D': {
    was: 'Monday to Friday from 10am to 7:30pm in Zones C and D; Saturday from 10am to 4pm in Zone C',
    parts: [{ zone: 'C', hours: 'Mon-Fri 10am-7.30pm; Sat 10am-4pm' }, { zone: 'D', hours: 'Mon-Fri 10am-7.30pm' }],
    notes: ['The sign on the street says whether it is zone C or D.'],
  },
  'F/G': {
    was: 'Monday to Friday from 9am to10am, 3pm to 4pm and 6pm to 7pm in Zone F; Monday to Friday from 9am to 10am and 3pm to 4pm in Zone G',
    parts: [{ zone: 'F', hours: 'Mon-Fri 9am-10am, 3pm-4pm and 6pm-7pm' }, { zone: 'G', hours: 'Mon-Fri 9am-10am and 3pm-4pm' }],
    notes: ['The sign on the street says whether it is zone F or G.'],
  },
  H2: {
    was: 'Monday to Friday from 9am to 10am and 3pm to 4pm; Monday to Sunday from 9am to 5pm Church Road, W7 and Oakley Close only',
    hours: 'Mon-Fri 9am-10am and 3pm-4pm',
    streets: { 'Church Road': 'Mon-Sun 9am-5pm', 'Oakley Close': 'Mon-Sun 9am-5pm' },
  },
  PC: {
    was: 'Monday to Friday from 11am to 2pm; Saturday and Sunday from 11am to 2pm for Littlejohn Road only',
    hours: 'Mon-Fri 11am-2pm',
    streets: { 'Littlejohn Road': 'Mon-Sun 11am-2pm' },
  },
  S: {
    was: 'Monday to Friday from 10am to 7:30pm; Saturday from 10am to 4pm Northside on weekends; Saturday from 10am to 1pm Southside on weekends',
    hours: 'Mon-Fri 10am-7.30pm; Sat 10am-4pm',
    notes: ['On Saturdays the south side of the zone is controlled 10am-1pm only.'],
  },
};

// Town names the council puts after a street; postcode districts are found by pattern.
const TOWNS = { Southall: [51.5099, -0.3797], Greenford: [51.5287, -0.3555], Perivale: [51.5366, -0.3236], 'Park Royal': [51.5265, -0.2835], Northolt: [51.5486, -0.3683], Hanwell: [51.5098, -0.3384], Acton: [51.5079, -0.2706] };

const mainContent = (html) => {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  return html.slice(Math.max(0, start), end > start ? end : undefined);
};

/** Zone pages linked from the directory. */
export function zoneLinks(html) {
  return [...new Set([...html.matchAll(/href="((?:https:\/\/www\.ealing\.gov\.uk)?\/info\/201333\/controlled_parking_zone_cpz\/\d+\/zones?_[^"?#]+)"/g)].map((m) => new URL(m[1], SITE).href))];
}

/** The list items, or else paragraphs, under a page's <h2>heading</h2>. */
function section(main, heading) {
  const start = main.search(new RegExp(`<h2[^>]*>\\s*${heading}`, 'i'));
  if (start < 0) return [];
  const rest = main.slice(start).replace(/^<h2[^>]*>[\s\S]*?<\/h2>/i, '');
  const body = rest.slice(0, rest.search(/<h2|$/i));
  const items = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => text(m[1]));
  return (items.length ? items : [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => text(m[1]))).filter(Boolean);
}

/** "Zone A Central Ealing" or "Zones F and G Ealing Common", its hours and its streets. */
export function parseZonePage(html) {
  const main = mainContent(html);
  const title = text(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? '');
  const m = /^Zones?\s+([A-Z]{1,3}\d?(?:-[A-Z]+)?(?:\s+and\s+[A-Z]{1,3}\d?)?)\s+(.*)$/.exec(title);
  if (!m) return null;
  const hours = section(main, 'Operating days and hours')
    .filter((line) => !/other restrictions/i.test(line))
    .join('; ');
  // "List of streets affected in this zone", or "Street&nbsp;affected in this zone" for one.
  const streets = section(main, '(?:List of streets|Streets?(?:&nbsp;|\\s)+affected)').flatMap((item) => item.split(/\s*;\s*/)).map(parseStreet).filter((s) => s.name);
  return { title, code: m[1].split(/\s+and\s+/).join('/'), area: m[2], hours, streets };
}

/**
 * "Mattock Lane, W5 (between … numbers 1 to 36)" → name, locality (a postcode
 * district or town) and the part of the road.
 */
export function parseStreet(item) {
  const paren = item.indexOf('(');
  const head = (paren < 0 ? item : item.slice(0, paren)).trim();
  let section = paren < 0 ? '' : item.slice(paren + 1).replace(/\)\s*\.?\s*$/, '').trim();
  const [name, ...after] = head.split(',').map((s) => s.trim());
  const where = after.join(' ');
  const districts = [...new Set(where.match(/\b(?:W|NW|UB)\d{1,2}\b/g) ?? [])];
  const locality = districts.length === 1 ? districts[0] : (Object.keys(TOWNS).find((t) => where.replace(/\.$/, '') === t) ?? '');
  // "(including Allen Court)" adds to the road rather than limiting it.
  if (/^including\b/i.test(section)) section = '';
  return { name: name.replace(/\s+/g, ' '), locality, section };
}

/** Street name (with its locality where needed to tell same-named roads apart) → zone rules. */
export function buildStreets(pages) {
  const localitiesOf = new Map();
  for (const page of pages) for (const s of page.streets) {
    const key = normaliseName(s.name);
    if (!localitiesOf.has(key)) localitiesOf.set(key, new Set());
    localitiesOf.get(key).add(s.locality);
  }
  const streets = {};
  for (const page of pages) {
    const zone = ZONES[page.code];
    if (zone && zone.was !== page.hours) console.log(`::warning::Ealing zone ${page.code}'s hours now read "${page.hours}": check ZONES in update-ealing.mjs`);
    const overrides = new Map(Object.entries(zone?.streets ?? {}).map(([name, hours]) => [normaliseName(name), hours]));
    for (const street of page.streets) {
      const shared = localitiesOf.get(normaliseName(street.name)).size > 1;
      const key = shared && street.locality ? `${street.name}, ${street.locality}` : street.name;
      for (const variant of zone?.parts ?? [{}]) {
        const hours = overrides.get(normaliseName(street.name)) ?? variant.hours ?? zone?.hours ?? page.hours;
        const part = { zone: variant.zone ?? page.code, area: page.area };
        if (hours) part.hours = hours;
        else part.unknown = SIGNS;
        if (street.section) part.section = street.section;
        if (zone?.notes) part.notes = zone.notes;
        (streets[key] ??= []).push(part);
      }
    }
  }
  return Object.fromEntries(Object.entries(streets).sort(([a], [b]) => a.localeCompare(b)));
}

/** Centres of the postcode districts and towns used to tell same-named roads apart. */
async function localities(streets) {
  const names = new Set(Object.keys(streets).map((k) => k.split(', ')[1]).filter(Boolean));
  const out = {};
  for (const name of names) {
    if (TOWNS[name]) out[name] = TOWNS[name];
    else {
      const { result } = await get(`https://api.postcodes.io/outcodes/${name}`, 'json');
      out[name] = [+result.latitude.toFixed(4), +result.longitude.toFixed(4)];
    }
  }
  return out;
}

async function main() {
  const links = zoneLinks(await get(DIRECTORY));
  const pages = [];
  for (const link of links) {
    const page = parseZonePage(await get(link));
    if (page?.streets.length) pages.push(page);
    else console.warn(`No streets on ${link}`);
  }
  if (pages.length < 40) throw new Error(`only ${pages.length} zone pages: the site layout may have changed`);
  console.log(`${pages.length} zones: ${pages.map((p) => `${p.code} (${p.streets.length})`).join(', ')}`);
  const streets = buildStreets(pages);
  await saveList(OUT, { borough: 'London Borough of Ealing', source: DIRECTORY, streets, localities: await localities(streets) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Ealing list not updated: ${err.message}`);
    process.exit(1);
  });
}
