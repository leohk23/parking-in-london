import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreets, parseProperties, parseParking, streetParts } from '../scripts/update-richmond.mjs';

// Fragments of the council's pages, as they come.
const parking = (inner) => `<a id="my_parking"></a><div class="my-item my-parking"><div class="row"><h2>Parking</h2>${inner}</div></div><a id="my_schoolstreet"></a>`;
const D = parking('<p>Controlled Parking Zone (CPZ): <strong>D - Central Twickenham</strong></p><p><strong>Times:</strong> Monday to Saturday 8:30am to 6:30pm (Bank and Public holidays free)</p>');
const NONE = parking('<p>Not in a Controlled Parking Zone (CPZ)</p>');

test('Richmond streets, addresses and zones', () => {
  assert.deepEqual(parseStreets('<select name="USRN"><option value="22403980">YORK ROAD, TEDDINGTON</option><option value="22403983">YORK STREET, TWICKENHAM</option></select>'), [
    { usrn: '22403980', name: 'York Road', town: 'Teddington' },
    { usrn: '22403983', name: 'York Street', town: 'Twickenham' },
  ]);
  assert.deepEqual(parseProperties('<select name="UPRN" id="UPRN"><option value="1">10A YORK STREET, TWICKENHAM, TW1 3LD</option><option value="2">FLAT 2, 44 YORK STREET, TWICKENHAM, TW1 3LJ</option></select>'), [
    { uprn: '1', number: 10, postcode: 'TW1 3LD' },
    { uprn: '2', number: 44, postcode: 'TW1 3LJ' },
  ]);
  assert.deepEqual(parseParking(D), { zone: 'D', area: 'Central Twickenham', hours: 'Monday to Saturday 8:30am to 6:30pm (Bank and Public holidays free)' });
  assert.equal(parseParking(NONE), null);
  assert.equal(parseParking('<p>Something went wrong</p>'), undefined);
});

test('a street is in a zone where its addresses are, in part when only some are', () => {
  const d = parseParking(D);
  assert.deepEqual(streetParts([d, d]), [{ zone: 'D', area: 'Central Twickenham', hours: 'Monday to Saturday 8:30am to 6:30pm', notes: ['Free on bank and public holidays.'] }]);
  assert.equal(streetParts([d, null])[0].section, 'part of the road');
  // A failed lookup doesn't make it partial.
  assert.equal(streetParts([d, undefined])[0].section, undefined);
  assert.deepEqual(streetParts([null, null]), []);
});
