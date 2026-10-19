import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { streetListOptions, outsideStreetLists, loadStreetLists, STREET_LISTS } from '../src/sources/street-lists.js';
import { parseFinder, groupStreets } from '../scripts/update-wandsworth.mjs';
import { parseZonePage, parseStreet, buildStreets } from '../scripts/update-kingston.mjs';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock, parseSchedule } from '../src/schedule.js';

const WANDSWORTH = STREET_LISTS.find((l) => l.id === 'wandsworth');
const snapshot = JSON.parse(readFileSync(new URL('../data/wandsworth.json', import.meta.url), 'utf8'));
const lists = [{ list: WANDSWORTH, data: snapshot }];
// Geometry is a stand-in: only the street name and a point inside Wandsworth matter here.
const WPR = [[51.4405, -0.2045], [51.4425, -0.2035]];
const streets = [{ name: 'Wimbledon Park Road', line: WPR }];

// A cut-down street finder page, as the council's site writes it.
const PAGE = `
<h3>By street name</h3><form></form>
<h3>Wimbledon Park Road &ndash; SW18</h3>
<p>
Date activated: <strong>20/03/2023</strong><br />
Flat block: <strong>Riverstone Lodge (29)</strong><br />
CPZ:(A6)&ndash;Putney <br />
Even numbers: <strong>2 - 8</strong><br />
Odd numbers: <strong>1 - 7</strong><br />
Days of control: <strong>Monday - Friday</strong><br />
Hours of control: <strong>9.30am - 4.30pm</strong><br />
Pay and display cost:  <strong>&pound;3.70/Hr</strong><br />
Maximum stay:  <strong>4Hr</strong><br />
</p>
<h3>West Hill &ndash; SW15</h3>
<p>
<strong style="color: red;">Please note: Red Route</strong><br />
CPZ:(A4)&ndash;Putney <br />
Even numbers: <strong>2 - 14, 22 - 32</strong><br />
Odd numbers: <strong>No eligible properties</strong><br />
Days of control: <strong>Monday - Friday</strong><br />
Hours of control: <strong>9.30am - 10.30am</strong><br />
Pay and display cost:  <strong>&pound;No P&amp;D - Permit Holders Only</strong><br />
Maximum stay:  <strong>No P&amp;D</strong><br />
</p>
<h3>Wimbledon Park Road &ndash; SW19</h3>
<p>
<strong style="color: red;">Please note: PRS WIMBLEDON PARK ESTATE. Nos 227 - 231 (odd) EXCLUDED FROM CPZ</strong><br />
CPZ:(S1)&ndash;Southfields <br />
Even numbers: <strong>2 - 50</strong><br />
Odd numbers: <strong>1 - 51</strong><br />
Days of control: <strong>Monday - Friday</strong><br />
Hours of control: <strong>9.30am - 4.30pm</strong><br />
Pay and display cost:  <strong>&pound;1.60/Hr  &amp; 3.70/Hr</strong><br />
Maximum stay:  <strong>4Hr</strong><br />
</p>`;

test('street finder pages are read into one entry per street section', () => {
  const entries = parseFinder(PAGE);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    street: 'Wimbledon Park Road',
    postcode: 'SW18',
    zone: 'A6',
    area: 'Putney',
    block: 'Riverstone Lodge (29)',
    even: '2 - 8',
    odd: '1 - 7',
    days: 'Monday - Friday',
    hours: '9.30am - 4.30pm',
    cost: '£3.70/Hr',
    maxStay: '4Hr',
    notes: [],
  });

  const grouped = groupStreets(entries);
  assert.deepEqual(Object.keys(grouped), ['West Hill', 'Wimbledon Park Road']);
  assert.deepEqual(grouped['West Hill'][0], {
    zone: 'A4',
    area: 'Putney',
    postcodes: ['SW15'],
    hours: 'Monday - Friday 9.30am - 10.30am',
    permitOnly: true,
    numbers: ['2–14, 22–32 even'],
    notes: ['Red Route'],
  });
  const s1 = grouped['Wimbledon Park Road'][1];
  assert.equal(s1.cost, '£1.60/Hr & 3.70/Hr');
  assert.deepEqual(s1.numbers, ['1–51 odd', '2–50 even']);
  assert.deepEqual(s1.notes, ['Nos 227 - 231 (odd) EXCLUDED FROM CPZ']);
  // A flat block's own numbers are flats, so it's listed by name.
  assert.deepEqual(grouped['Wimbledon Park Road'][0].blocks, ['Riverstone Lodge (29)']);
});

test('the Wandsworth snapshot covers the borough and its hours are readable', () => {
  const parts = Object.values(snapshot.streets).flat();
  assert.ok(Object.keys(snapshot.streets).length > 1000);
  assert.ok(snapshot.boundary?.[0]?.length > 20);
  const unread = parts.filter((p) => !parseSchedule(p.hours));
  assert.ok(unread.length <= 3, unread.map((p) => p.hours).join('; '));
});

test('Wimbledon Park Road: one line per zone rule, drawn along the street', () => {
  const [o] = streetListOptions(lists, { streets });
  assert.equal(o.title, 'Wimbledon Park Road');
  assert.equal(o.source, 'street-list');
  assert.match(o.subtitle, /^Wandsworth parking zones A6, S1/);
  assert.deepEqual(o.lines, [WPR]);
  assert.ok(o.notes.some((n) => /Wimbledon Championships/.test(n)));
  assert.equal(o.checked, snapshot.updated);
  assert.ok(o.parts.every((p) => p.otherwise.effect === 'free'));
});

test('Sunday afternoon on Wimbledon Park Road: free until Monday', () => {
  const [o] = streetListOptions(lists, { streets });
  const result = evaluateOption(o, londonClock(new Date('2026-10-18T14:41:00Z')), 120);
  assert.equal(result.status, 'free');
  assert.ok(result.results.every((r) => r.summary.startsWith('Free until Mon')));
});

test('street names only match inside the borough', () => {
  assert.equal(streetListOptions(lists, { streets: [{ name: 'Wimbledon Park Road', line: [[51.6, -0.1]] }] }).length, 0);
  assert.equal(streetListOptions(lists, { streets: [{ name: 'wimbledon park road', line: WPR }] }).length, 1);
});

test('your own street is listed even when OpenStreetMap had nothing', () => {
  const dest = { point: WPR[0], street: 'Wimbledon Park Road' };
  const [o] = streetListOptions(lists, { streets: [], dest });
  assert.equal(o.title, 'Wimbledon Park Road');
  assert.equal(o.lines, undefined);
  // Not when the destination is a same-named street elsewhere.
  assert.equal(streetListOptions(lists, { dest: { point: [51.6, -0.1], street: 'Wimbledon Park Road' } }).length, 0);
});

test('lists are only fetched near their borough, and only once', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => snapshot };
  };
  const list = { ...WANDSWORTH, url: 'https://example.test/wandsworth.json' };
  assert.deepEqual(await loadStreetLists([51.53, -0.15, 51.54, -0.14], { fetchImpl, lists: [list] }), []);
  await loadStreetLists([51.44, -0.21, 51.445, -0.2], { fetchImpl, lists: [list] });
  const [{ data }] = await loadStreetLists([51.44, -0.21, 51.445, -0.2], { fetchImpl, lists: [list] });
  assert.equal(data, snapshot);
  assert.equal(urls.length, 1);
});

const KINGSTON = STREET_LISTS.find((l) => l.id === 'kingston');
const kingston = JSON.parse(readFileSync(new URL('../data/kingston.json', import.meta.url), 'utf8'));
const kingstonLists = [{ list: KINGSTON, data: kingston }];
const NEW_MALDEN = [51.4011, -0.2569]; // Sussex Road
const ALBERT_ROAD_NEW_MALDEN = [[51.4006, -0.2546], [51.3999, -0.2536]];
const ALBERT_ROAD_KINGSTON = [[51.4085, -0.2905], [51.4078, -0.2893]];

test('Kingston zone pages: zone codes, localities and the part of the road', () => {
  const page = parseZonePage(
    '<main><nav>Home</nav><h1>Zone G and G1 (Grove area)</h1><div>Street</div><div>Alfred Road</div><div>Street 1</div><div>Cambridge Road, Kingston Nos 3 to 39 (odd numbers only)</div><div>Street 2</div><div>Albany Park Road (from 29 February 2016)</div></main>',
  );
  assert.equal(page.code, 'G/G1');
  assert.equal(page.area, 'Grove area');
  assert.deepEqual(page.streets, [
    { name: 'Alfred Road', locality: '', section: '' },
    { name: 'Cambridge Road', locality: 'Kingston', section: 'Nos 3 to 39 (odd numbers only)' },
    { name: 'Albany Park Road', locality: '', section: '' },
  ]);
  assert.deepEqual(parseStreet('Villiers Road - east side from Hawks Road'), { name: 'Villiers Road', locality: '', section: 'east side from Hawks Road' });
  // G and G1 are listed together, so each street gets both.
  assert.deepEqual(buildStreets([page])['Alfred Road'].map((p) => [p.zone, p.hours]), [
    ['G', 'Mon-Fri 8.30am-6.30pm'],
    ['G1', 'Mon-Sat 8.30am-6.30pm'],
  ]);
});

test('Kingston: same-named roads are told apart by locality', () => {
  const streets = [
    { name: 'Albert Road', line: ALBERT_ROAD_NEW_MALDEN },
    { name: 'Albert Road', line: ALBERT_ROAD_KINGSTON },
  ];
  const options = streetListOptions(kingstonLists, { streets });
  assert.deepEqual(options.map((o) => [o.subtitle, o.parts.map((p) => p.label).join()]).sort(), [
    ['Kingston · Kingston parking zone N', 'Zone N'],
    ['New Malden · Kingston parking zone DD', 'Zone DD'],
  ]);
  const dd = options.find((o) => o.subtitle.startsWith('New Malden'));
  assert.deepEqual(dd.lines, [ALBERT_ROAD_NEW_MALDEN]);
  // Permit holders only, every day.
  const sunday = evaluateOption(dd, londonClock(new Date('2026-10-18T11:00:00Z')), 60);
  assert.equal(sunday.status, 'no');
});

test('Kingston: a New Malden street outside every zone is free', () => {
  const dest = { point: NEW_MALDEN, street: 'Sussex Road' };
  const [o] = outsideStreetLists(kingstonLists, { dest, council: 'Kingston upon Thames' });
  assert.equal(o.title, 'No parking zone on this street');
  assert.equal(evaluateOption(o, londonClock(new Date('2026-10-19T09:00:00Z')), 120).status, 'free');
  // Not for a street in a zone, nor when postcodes.io puts you in another borough.
  assert.deepEqual(outsideStreetLists(kingstonLists, { dest: { point: NEW_MALDEN, street: 'Lincoln Road' }, council: 'Kingston upon Thames' }), []);
  assert.deepEqual(outsideStreetLists(kingstonLists, { dest, council: 'Merton' }), []);
  assert.deepEqual(outsideStreetLists(kingstonLists, { dest: { point: NEW_MALDEN }, council: 'Kingston upon Thames' }), []);
});

test("Kingston's on-street charges: rates on zone streets, pay bays on New Malden High Street", async () => {
  const { parseCharges, addCharges } = await import('../scripts/update-kingston.mjs');
  const rows = parseCharges(
    '<main><h1>On street parking charges</h1><table><tr><th>Area</th><th>Location code</th><th>Charge per hour</th></tr>' +
      '<tr><td>CPZ S, Central Area, Including 30 min Free</td><td>26573</td><td>£3</td></tr>' +
      '<tr><td>Queens Road, High Street New Malden</td><td>26525</td><td>£3</td></tr>' +
      '<tr><td>Crescent Road, Queens Road</td><td>26516</td><td>£2.30</td></tr>' +
      '<tr><td>Brighton Road, St.James Road, Victoria Road</td><td>26520</td><td>£3</td></tr>' +
      '<tr><td>Church Road, Linden Crescent, Victoria Road</td><td>26544</td><td>£2.30</td></tr></table></main>',
  );
  // Area rows ("CPZ S, Central Area") can't be placed, so they're left out.
  assert.deepEqual(rows.map((r) => r.code), ['26525', '26516', '26520', '26544']);
  // The snapshot already has the charges; start from the zone pages alone.
  const zonesOnly = Object.fromEntries(
    Object.entries(structuredClone(kingston.streets))
      .map(([name, parts]) => [name, parts.filter((p) => !p.payOnly).map(({ cost, ringgo, ...p }) => p)])
      .filter(([, parts]) => parts.length),
  );
  const streets = addCharges(zonesOnly, rows);
  assert.deepEqual(streets['High Street, New Malden'], [{ zone: 'Pay', area: 'Pay to park', payOnly: true, cost: '£3.00/hr', ringgo: '26525' }]);
  // Queens Road in New Malden is a permit area with pay bays; in Kingston it's zone B.
  assert.deepEqual(streets['Queens Road, New Malden'].map((p) => p.zone), ['DD', 'Pay']);
  assert.equal(streets['Queens Road'][0].ringgo, '26516');
  // Same-named Victoria Roads are told apart by the zones of the rest of each row.
  assert.equal(streets['Victoria Road'][0].ringgo, '26520');
  assert.equal(streets['Victoria Road, Kingston'][0].ringgo, '26544');
  // "St.James Road" in the charges is "St. James’s Road" (zone S, Surbiton) in the zone pages.
  assert.equal(streets['St. James’s Road'][0].ringgo, '26520');
  assert.equal(streets["St. James's Road, Kingston"][0].ringgo, undefined);

  const [high] = streetListOptions([{ list: KINGSTON, data: { ...kingston, streets } }], {
    streets: [{ name: 'High Street', line: [[51.4021, -0.2562], [51.4012, -0.2551]] }],
  });
  assert.equal(high.subtitle, 'New Malden · Kingston pay-to-park street');
  const result = evaluateOption(high, londonClock(new Date('2026-10-19T09:00:00Z')), 60).results[0];
  assert.equal(result.status, 'paid');
  assert.equal(result.detail, '£3.00/hr · RingGo 26525');
});
