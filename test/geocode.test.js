import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode, reverseGeocode } from '../src/geocode.js';

// A fetch stand-in that answers by URL prefix and records what was asked.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const [, reply] = Object.entries(routes).find(([prefix]) => url.startsWith(prefix)) ?? [];
    if (!reply) throw new Error(`unexpected request: ${url}`);
    const { status = 200, body } = typeof reply === 'function' ? reply(url) : reply;
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

const NOMINATIM_REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const POSTCODES_REVERSE = 'https://api.postcodes.io/postcodes?';

test('reverse geocoding gives a street address with postcode', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [NOMINATIM_REVERSE]: {
      body: { address: { house_number: '12', road: 'Wimbledon Park Road', suburb: 'Southfields', postcode: 'SW19 6NL' } },
    },
  });
  const place = await reverseGeocode([51.444, -0.204], { fetchImpl });
  assert.deepEqual(place, { label: '12 Wimbledon Park Road, SW19 6NL', street: 'Wimbledon Park Road' });
  assert.match(calls[0], /lat=51.444&lon=-0.204/);
});

test('reverse geocoding without a house number uses the street', async () => {
  const { fetchImpl } = fakeFetch({
    [NOMINATIM_REVERSE]: { body: { address: { road: 'Replingham Road', postcode: 'SW18 5LS' } } },
  });
  assert.equal((await reverseGeocode([51.445, -0.207], { fetchImpl })).label, 'Replingham Road, SW18 5LS');
});

test('reverse geocoding falls back to the nearest postcode', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [NOMINATIM_REVERSE]: { status: 503 },
    [POSTCODES_REVERSE]: { body: { result: [{ postcode: 'SW19 6NL' }] } },
  });
  assert.deepEqual(await reverseGeocode([51.444, -0.204], { fetchImpl }), { label: 'SW19 6NL', street: null });
  assert.equal(calls.length, 2);
});

test('reverse geocoding fails cleanly when nothing is found', async () => {
  const { fetchImpl } = fakeFetch({
    [NOMINATIM_REVERSE]: { body: { error: 'Unable to geocode' } },
    [POSTCODES_REVERSE]: { body: { result: null } },
  });
  await assert.rejects(reverseGeocode([0, 0], { fetchImpl }), /No postcode/);
});

test('postcodes go to postcodes.io, places to Nominatim', async () => {
  const { fetchImpl } = fakeFetch({
    'https://api.postcodes.io/postcodes/': { body: { result: { postcode: 'SW19 6NL', region: 'London', latitude: 51.44, longitude: -0.2 } } },
    'https://nominatim.openstreetmap.org/search': {
      body: [{ lat: '51.444', lon: '-0.204', category: 'highway', type: 'residential', name: 'Wimbledon Park Road', display_name: 'Wimbledon Park Road, Southfields, London Borough of Wandsworth, London, Greater London, England, United Kingdom' }],
    },
  });
  assert.deepEqual(await geocode('sw19 6nl', { fetchImpl }), { label: 'SW19 6NL', point: [51.44, -0.2], street: null });
  const road = await geocode('Wimbledon Park Road', { fetchImpl });
  assert.equal(road.street, 'Wimbledon Park Road');
  assert.equal(road.label, 'Wimbledon Park Road, Southfields, London Borough of Wandsworth');
});

test('places and postcodes outside Greater London are refused', async () => {
  const { geocode } = await import('../src/geocode.js');
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url) =>
    url.includes('postcodes.io')
      ? reply({ result: { postcode: 'KT17 1AA', region: 'South East', latitude: 51.33, longitude: -0.27 } })
      : reply([{ lat: '51.33', lon: '-0.27', display_name: 'Epsom High Street, Epsom, Surrey, England, United Kingdom', address: { 'ISO3166-2-lvl6': 'GB-SRY' } }]);
  await assert.rejects(geocode('KT17 1AA', { fetchImpl }), /outside Greater London/);
  await assert.rejects(geocode('Epsom High Street', { fetchImpl }), /in Greater London/);
});

test("a bus stop named after a station isn't taken for a street", async () => {
  const { geocode } = await import('../src/geocode.js');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        lat: '51.5148', lon: '-0.3016', category: 'highway', type: 'bus_stop', name: 'Ealing Broadway Station',
        display_name: 'Ealing Broadway Station, The Broadway, Ealing, London Borough of Ealing, London, Greater London, England, United Kingdom',
        address: { road: 'The Broadway', 'ISO3166-2-lvl6': 'GB-LND' },
      },
    ],
  });
  assert.equal((await geocode('Ealing Broadway station', { fetchImpl })).street, 'The Broadway');
});
