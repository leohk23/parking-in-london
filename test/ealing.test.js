import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreet, parseZonePage, buildStreets, ZONES } from '../scripts/update-ealing.mjs';
import { STREET_LISTS, streetListOptions } from '../src/sources/street-lists.js';

const page = (title, hours, streets) => `<main><h1 class="page-heading"><span>${title}</span></h1>
  <h2>Operating days and hours</h2><ul>${hours.map((h) => `<li>${h}</li>`).join('')}</ul>
  <p>For all other restrictions, please check&nbsp;street parking signs.</p>
  <h2>Zone map</h2><p>Zoom in and out of the map.</p>
  <h2>List of streets affected in this zone</h2><ul>${streets.map((s) => `<li>${s}</li>`).join('')}</ul></main>`;

test('Ealing streets: locality, and the part of the road', () => {
  assert.deepEqual(parseStreet('Mattock Lane, W5 (between Culmington Road and Bond Street, numbers 1 to 36)'), {
    name: 'Mattock Lane', locality: 'W5', section: 'between Culmington Road and Bond Street, numbers 1 to 36',
  });
  assert.deepEqual(parseStreet('Ridding Lane, Greenford (including Allen Court)'), { name: 'Ridding Lane', locality: 'Greenford', section: '' });
  assert.deepEqual(parseStreet('Lexden Road (numbers 1 to 100 Moreton).'), { name: 'Lexden Road', locality: '', section: 'numbers 1 to 100 Moreton' });
  assert.equal(parseStreet('Acton Lane, W3 and W5').locality, '');
});

test('Ealing zones: hours from the page, with exceptions transcribed', () => {
  const a = parseZonePage(page('Zone A Central Ealing', ['Monday to Thursday from 8:30am to 7:30pm', 'Sunday from&nbsp;10am to 4pm'], ['Florence Road, W5', 'Bond Street, W5']));
  assert.deepEqual([a.code, a.area, a.hours], ['A', 'Central Ealing', 'Monday to Thursday from 8:30am to 7:30pm; Sunday from 10am to 4pm']);
  const h2 = parseZonePage(page('Zone H2 Hanwell Station (Hanwell Zoo)', [ZONES.H2.was], ['Church Road, W7 (odd numbers 23 to 103)', 'Campbell Road, W7']));
  const south = parseZonePage(page('Zone L Southall', ['Monday to Saturday from 8am to 6.30pm'], ['Florence Road, Southall']));
  const streets = buildStreets([a, h2, south]);
  // Same-named roads in different towns keep their locality; the rest don't need one.
  assert.deepEqual(Object.keys(streets), ['Bond Street', 'Campbell Road', 'Church Road', 'Florence Road, Southall', 'Florence Road, W5']);
  assert.equal(streets['Church Road'][0].hours, 'Mon-Sun 9am-5pm');
  assert.equal(streets['Campbell Road'][0].hours, 'Mon-Fri 9am-10am and 3pm-4pm');

  // Localities come from the file: a Florence Road way near Southall gets Southall's zone.
  const list = STREET_LISTS.find((l) => l.id === 'ealing');
  const data = { streets, localities: { W5: [51.5134, -0.3022], Southall: [51.5099, -0.3797] } };
  const [option] = streetListOptions([{ list, data }], { streets: [{ name: 'Florence Road', line: [[51.508, -0.378], [51.509, -0.377]] }] });
  assert.equal(option.subtitle, 'Southall · Ealing parking zone L');
});
