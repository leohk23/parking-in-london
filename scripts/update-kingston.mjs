// Refreshes data/kingston.json from Kingston Council's parking zone pages,
// which list the streets in each controlled parking zone and permit parking
// area. The hours come from the council's "when the rules apply" list, copied
// into ZONES below because it's written as prose. Kingston's zone map isn't open
// to other sites, so the deploy workflow runs this and publishes the result.
//
//   node scripts/update-kingston.mjs

import { fileURLToPath } from 'node:url';
import { get, text, saveList } from './council-pages.mjs';
import { normaliseName } from '../src/sources/street-lists.js';

const SITE = 'https://www.kingston.gov.uk';
const DIRECTORY = `${SITE}/parking/parking-zones`;
const HOURS_PAGE = `${SITE}/parking/find-street-parking`;
const CHARGES_PAGE = `${SITE}/parking/how-to-pay-for-parking/on-street-parking-charges`;
const OUT = new URL('../data/kingston.json', import.meta.url);
const LOCALITIES = ['New Malden', 'Kingston', 'Surbiton', 'Tolworth', 'Norbiton', 'Chessington'];
// Misspellings on the council's pages, corrected so they match each other and OpenStreetMap.
const SPELLINGS = { 'Angelsea Road': 'Anglesea Road', 'Cheaham Road': 'Chesham Road' };
const spell = (name) => SPELLINGS[name] ?? name;

// From HOURS_PAGE, checked 2026-10-19. Each zone's hours, and the streets in it
// whose hours differ. Permit parking areas (D...) are for permit holders only;
// in the lettered zones you can pay or use a permit.
const SIGNS = 'Hours are on the signs at the entry to the area';
const A = { zone: 'A', hours: 'Mon-Sat 8.30am-6.30pm including bank holidays' };
const A1_SUNDAY = { zone: 'A1', hours: 'Mon-Sat 8.30am-10.30pm; Sun 12pm-5pm' };
const B_TOWN = { hours: 'Mon-Sat 8.30am-10.30pm; Sun 11am-10.30pm', section: 'town centre part' };
const B_INNER = { hours: 'Mon-Sat 8.30am-6.30pm; Sun 11am-5pm', section: 'inner part' };
const B_MAIN = { hours: 'Mon-Sat 8.30am-6.30pm' };
const B_OUTER1 = { hours: 'Mon-Fri 10am-3pm' };
const B_OUTER2 = { hours: 'Mon-Fri 10am-3.30pm' };
const SHORT_DAY = { hours: 'Mon-Fri 10am-3pm' };

export const ZONES = {
  DB: { hours: 'Mon-Sat 8am-6.30pm; Sun 11am-5pm', permitOnly: true },
  DC: { hours: 'Mon-Sat 8am-6.30pm; Sun 11am-5pm', permitOnly: true },
  DD: { hours: 'Mon-Sun 8.30am-8.30pm', permitOnly: true },
  DE: { hours: 'Mon-Sat 11am-2pm', permitOnly: true },
  DF: { hours: 'Mon-Sat 11am-2pm', permitOnly: true, streets: { 'Latchmere Lane': [{ hours: 'Mon-Fri 11am-2pm' }] } },
  DG: { permitOnly: true, unknown: SIGNS },
  DI: { permitOnly: true, unknown: SIGNS },
  DJ: { permitOnly: true, unknown: SIGNS },
  // Made in May 2026 for Lincoln, Stafford and Warwick Roads; only the ends of the other two are in it.
  DK: {
    hours: 'Mon-Sat 8.30am-6.30pm',
    permitOnly: true,
    streets: {
      'Kingston Road': [{ unknown: 'Only part of the road is in this permit area: check the signs' }],
      'Dickerage Lane': [{ unknown: 'Only part of the road is in this permit area: check the signs' }],
    },
  },
  'A/A1': {
    zone: 'A1',
    hours: 'Mon-Sat 8.30am-10.30pm; Sun 11am-10.30pm',
    notes: ['Pay and shared-use bays in zones A and A1 are charged on bank holidays too.'],
    streets: { 'Avenue Road': [A], 'Milner Road': [A], 'Woodbines Avenue': [A], 'The Bittoms': [A], 'Thames Street': [A1_SUNDAY], 'Bishops Hall': [A1_SUNDAY] },
  },
  B: {
    ...B_MAIN,
    streets: {
      'Acre Road': [B_TOWN, B_INNER],
      'Canbury Park Road': [B_TOWN, B_MAIN],
      'Cowleaze Road': [B_TOWN],
      'East Road': [B_TOWN],
      'Elm Crescent': [B_TOWN],
      'Elm Grove': [B_TOWN],
      'Burton Road': [B_INNER],
      'Gibbon Road': [B_INNER],
      'Richmond Park Road': [B_INNER],
      'Dinton Road': [B_OUTER1],
      'Wyndham Road': [B_OUTER1],
      'Bockhampton Road': [B_OUTER1],
      'Park Road': [B_MAIN, B_OUTER1],
      ...Object.fromEntries(
        ['Boyd Close', 'Crescent Road', 'Deer Park Close', 'Dutch Gardens', 'Heatherdale Close', 'Liverpool Road', 'Queens Road', 'Windmill Rise'].map((s) => [s, [B_OUTER2]]),
      ),
    },
  },
  C: { hours: 'Mon-Sat 8.30am-6.30pm', streets: { 'Lower Ham Road': [{ hours: 'Mon-Sat 8.30am-6.30pm' }, { hours: 'Mon-Sat 11am-2pm', section: 'Bank Lane to Richmond Road' }] } },
  // The council lists G and G1 streets together.
  'G/G1': { parts: [{ zone: 'G', hours: 'Mon-Fri 8.30am-6.30pm' }, { zone: 'G1', hours: 'Mon-Sat 8.30am-6.30pm' }], notes: ['The sign on the street says whether it is zone G or G1.'] },
  H: { hours: 'Mon-Sat 8.30am-6.30pm' },
  N: { hours: 'Mon-Sat 8.30am-6.30pm', notes: ['Some streets have shorter hours: the Coombe Road shops Mon-Fri 8.30am-6.30pm, outer streets Mon-Fri 10am-3pm.'] },
  R: { hours: 'Mon-Fri 10am-4pm' },
  S: {
    hours: 'Mon-Sat 8am-6.30pm',
    notes: ['Outer streets of zone S are controlled Mon-Fri only.'],
    streets: { 'Cottage Grove': [{ hours: 'Mon-Sun 8am-10.30pm', permitOnly: true }], 'Selsdon Close': [{ hours: 'Mon-Fri 10am-4pm', permitOnly: true }] },
  },
  T: { hours: 'Mon-Sat 8am-6.30pm', streets: { 'Kingsdowne Road': [SHORT_DAY] } },
  V: { hours: 'Mon-Fri 8.30am-6.30pm', streets: { 'Hill Crescent': [SHORT_DAY], 'Hillside Road': [SHORT_DAY], 'Minstrel Gardens': [SHORT_DAY] } },
};

const mainContent = (html) => {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  return html.slice(Math.max(0, start), end > start ? end : undefined);
};

/** Zone pages linked from the directory, which runs over a few pages. */
export function zoneLinks(html) {
  return [...mainContent(html).matchAll(/href="([^"?#]*parking-zones\/[^"?#]+)"/g)].map((m) => new URL(m[1], SITE).href);
}

/** "Zone B (Canbury)" or "Parking Permit Area DB", and its list of streets. */
export function parseZonePage(html) {
  const main = mainContent(html);
  const title = text(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1] ?? '');
  const m = /^(?:Parking Permit Area|Zones?)\s+(.+?)(?:\s*\((.*)\))?$/i.exec(title);
  if (!m) return null;
  const code = m[1].split(/\s+and\s+/).join('/');
  const area = m[2] ?? (/permit area/i.test(title) ? 'Permit parking area' : '');
  // The streets follow the title, each labelled "Street", "Street 1", "Street 2"...
  const body = text(main.slice(main.search(/<\/h1>/i) + 5));
  const streets = body
    .replace(/^Street\s+/, '')
    .split(/\s+Street \d+\s+/)
    .map(parseStreet)
    .filter((s) => s.name);
  return { title, code, area, streets };
}

/** "Cambridge Road, Kingston Nos 3 to 39 (odd numbers only)" → name, locality and the part of the road. */
export function parseStreet(item) {
  const cut = /\s*(?:,|\(|\s-\s|\s(?:nos?\.?|odd|even|between|from)\s|\s(?:north|south|east|west)(?:-(?:east|west))?\s+side\b)/i.exec(item);
  const name = spell((cut ? item.slice(0, cut.index) : item).trim());
  let rest = cut ? item.slice(cut.index).replace(/^\s*,?\s*/, '') : '';
  const locality = LOCALITIES.find((l) => rest === l || rest.startsWith(`${l} `)) ?? '';
  rest = rest.slice(locality.length).trim().replace(/^[-–]\s*/, '');
  if (/^\(.*\)$/.test(rest) && !/\)\s*\(/.test(rest)) rest = rest.slice(1, -1);
  // "(from 29 February 2016)" is when the street joined, not which part of it.
  if (/^from \d{1,2} \w+ \d{4}$/i.test(rest)) rest = '';
  return { name, locality, section: rest };
}

/** Street name (with its locality when the council gives one) → zone rules. */
export function buildStreets(pages) {
  const streets = {};
  for (const page of pages) {
    const zone = ZONES[page.code];
    if (!zone) console.warn(`No hours for ${page.title}: it is listed as "${SIGNS}".`);
    const overrides = new Map(Object.entries(zone?.streets ?? {}).map(([name, parts]) => [normaliseName(name), parts]));
    for (const street of page.streets) {
      const key = street.locality ? `${street.name}, ${street.locality}` : street.name;
      const variants = overrides.get(normaliseName(street.name)) ?? zone?.parts ?? [{}];
      for (const variant of variants) {
        const rule = { ...zone, ...variant };
        const part = { zone: rule.zone ?? page.code, area: page.area };
        if (rule.hours && !variant.unknown) part.hours = rule.hours;
        else part.unknown = rule.unknown ?? SIGNS;
        if (rule.permitOnly) part.permitOnly = true;
        const section = [street.section, variant.section].filter(Boolean).join('; ');
        if (section) part.section = section;
        if (zone?.notes) part.notes = zone.notes;
        (streets[key] ??= []).push(part);
      }
    }
  }
  return Object.fromEntries(Object.entries(streets).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The on-street charges table: "Queens Road, High Street New Malden | 26525 | £3".
 * Rows that name an area rather than streets ("CPZ S, Central Area", "Tolworth
 * 2 Hour Stay") can't be placed on the map, so they're left out.
 */
export function parseCharges(html) {
  const body = text(mainContent(html));
  const header = body.search(/charge per hour/i);
  const pieces = body.slice(header < 0 ? 0 : header + 'charge per hour'.length).split(/\s(\d{5})\s+£(\d+(?:\.\d{1,2})?)/);
  const rows = [];
  for (let i = 0; i + 2 < pieces.length; i += 3) {
    let area = pieces[i].trim();
    if (!area || /\bCPZ\b|\bstay\b|\d\s*hours?\b|bus lane/i.test(area)) continue;
    // "High Street New Malden": the locality applies to the whole row.
    const locality = LOCALITIES.find((l) => area.endsWith(` ${l}`)) ?? '';
    if (locality) area = area.slice(0, -locality.length).trim();
    const streets = area.split(/\s*,\s*/).filter(Boolean).map((s) => {
      const m = /^(.*?)\s*\((.*)\)$/.exec(s);
      return { name: spell((m ? m[1] : s).replace(/^St\.(?=\S)/, 'St. ')), section: m?.[2] ?? '', locality };
    });
    rows.push({ code: pieces[i + 1], cost: `£${Number(pieces[i + 2]).toFixed(2)}/hr`, streets });
  }
  return rows;
}

/**
 * Adds each paid street's hourly charge and RingGo code to its zone rules, or
 * as pay bays where the street's only rules are for permit holders (or it has
 * none, like New Malden High Street). Same-named roads are told apart by the
 * zones of the other streets in the row.
 */
export function addCharges(streets, rows) {
  // Loose enough that "St.James Road" finds "St. James's Road" and "Oak Hill Road" finds "Oakhill Road".
  const loose = (name) => normaliseName(name).replace(/s+\b/g, '').replace(/ /g, '');
  const byBase = new Map();
  for (const key of Object.keys(streets)) {
    const base = loose(key.replace(new RegExp(`, (${LOCALITIES.join('|')})$`), ''));
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(key);
  }
  for (const row of rows) {
    const candidates = row.streets.map((s) => {
      const keys = byBase.get(loose(s.name)) ?? [];
      const exact = s.locality ? keys.filter((k) => k.endsWith(`, ${s.locality}`)) : keys;
      return { street: s, keys: exact };
    });
    const rowZones = new Set(candidates.filter((c) => c.keys.length === 1).flatMap((c) => streets[c.keys[0]].map((p) => p.zone)));
    for (const { street, keys } of candidates) {
      const key =
        keys.length > 1
          ? keys.find((k) => streets[k].some((p) => rowZones.has(p.zone))) ?? keys[0]
          : keys[0] ?? (street.locality ? `${street.name}, ${street.locality}` : street.name);
      const parts = (streets[key] ??= []);
      // A charge for one stretch ("Portsmouth Road (Anglers Green)") is pay bays there, not the whole road's rate.
      const paid = street.section ? [] : parts.filter((p) => !p.permitOnly && !p.payOnly);
      if (paid.length) {
        for (const p of paid) Object.assign(p, { cost: row.cost, ringgo: row.code });
      } else {
        parts.push({ zone: 'Pay', area: 'Pay to park', payOnly: true, cost: row.cost, ringgo: row.code, ...(street.section && { section: street.section }) });
      }
    }
  }
  return Object.fromEntries(Object.entries(streets).sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const links = new Set();
  for (let page = 0; page < 5; page++) {
    const found = zoneLinks(await get(`${DIRECTORY}?page=${page}`));
    if (found.every((link) => links.has(link))) break;
    found.forEach((link) => links.add(link));
  }
  const pages = [];
  for (const link of links) {
    const page = parseZonePage(await get(link));
    if (page?.streets.length) pages.push(page);
  }
  if (pages.length < 15) throw new Error(`only ${pages.length} zone pages: the site layout may have changed`);
  console.log(`${pages.length} zones: ${pages.map((p) => `${p.code} (${p.streets.length})`).join(', ')}`);
  const charges = parseCharges(await get(CHARGES_PAGE));
  if (charges.length < 20) throw new Error(`only ${charges.length} rows of charges: the page layout may have changed`);
  console.log(`${charges.length} rows of on-street charges.`);
  await saveList(OUT, { borough: 'Royal Borough of Kingston upon Thames', source: HOURS_PAGE, streets: addCharges(buildStreets(pages), charges) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Kingston zone list not updated: ${err.message}`);
    process.exit(1);
  });
}
