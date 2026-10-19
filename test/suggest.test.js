import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSuggestions, queryVariants, photonLabel } from '../src/suggest.js';

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
// Places in London, as Photon tags them; pass county to say otherwise.
const photonFeature = (properties, [lon, lat]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { county: 'Greater London', ...properties } });

test('query variants swap "and"/"&" and add London', () => {
  assert.deepEqual(queryVariants('Elephant and Castle'), [
    'Elephant and Castle',
    'Elephant & Castle',
    'Elephant and Castle, London',
    'Elephant & Castle, London',
  ]);
  assert.deepEqual(queryVariants('Stamford Court, London'), ['Stamford Court, London']);
});

test('Photon labels read like an address', () => {
  assert.equal(
    photonLabel({ name: 'Stamford Court', street: 'Goldhawk Road', district: 'Hammersmith', city: 'London', postcode: 'W6 0LF' }),
    'Stamford Court, Goldhawk Road, Hammersmith, W6 0LF',
  );
  assert.equal(photonLabel({ housenumber: '12', street: 'Wimbledon Park Road', city: 'London', postcode: 'SW19 6NL' }), '12 Wimbledon Park Road, London, SW19 6NL');
  assert.equal(photonLabel({ name: 'Wimbledon Park Road', type: 'street', city: 'London' }), 'Wimbledon Park Road, London');
});

test('places come from Photon, limited to Greater London, with streets and duplicates handled', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return reply({
      features: [
        photonFeature({ name: 'Wimbledon Park Road', type: 'street', city: 'London', postcode: 'SW18' }, [-0.204, 51.444]),
        photonFeature({ name: 'Wimbledon Park Road', type: 'street', city: 'London', postcode: 'SW18' }, [-0.2, 51.45]),
        photonFeature({ housenumber: '12', street: 'Wimbledon Park Road', type: 'house', city: 'London' }, [-0.205, 51.443]),
        photonFeature({ name: 'Epsom Road', type: 'street', city: 'Epsom', county: 'Surrey' }, [-0.27, 51.33]),
      ],
    });
  };
  const found = await fetchSuggestions('wimbledon park rd', { fetchImpl });
  assert.match(urls[0], /^https:\/\/photon\.komoot\.io\/api\/\?q=wimbledon\+park\+rd&limit=18&lang=en&bbox=-0\.6%2C51\.2%2C0\.4%2C51\.85$/);
  assert.deepEqual(found, [
    { label: 'Wimbledon Park Road, London, SW18', point: [51.444, -0.204], street: 'Wimbledon Park Road' },
    { label: '12 Wimbledon Park Road, London', point: [51.443, -0.205], street: 'Wimbledon Park Road' },
  ]);
});

test('later variants are tried when the first finds nothing', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(decodeURIComponent(url));
    return reply({ features: url.includes('%26') ? [photonFeature({ name: 'Elephant & Castle' }, [-0.1, 51.49])] : [] });
  };
  const found = await fetchSuggestions('Elephant and Castle', { fetchImpl });
  assert.equal(found[0].label, 'Elephant & Castle');
  assert.equal(urls.length, 2);
});

test('postcodes, even partial ones, come from postcodes.io', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return reply({
      result: [
        { postcode: 'W6 0LF', admin_ward: 'Ravenscourt', region: 'London', latitude: 51.4957, longitude: -0.2437 },
        { postcode: 'W6 0LG', admin_ward: 'Ravenscourt', region: 'London', latitude: 51.4959, longitude: -0.2431 },
      ],
    });
  };
  const found = await fetchSuggestions('w6 0l', { fetchImpl });
  assert.match(urls[0], /^https:\/\/api\.postcodes\.io\/postcodes\?q=w6\+0l&limit=6$/);
  assert.deepEqual(found[0], { label: 'W6 0LF, Ravenscourt', point: [51.4957, -0.2437], street: null });
  assert.equal(urls.length, 1);
});

test('a postcode with no match falls back to Photon', async () => {
  const fetchImpl = async (url) =>
    url.includes('postcodes.io') ? reply({ result: null }) : reply({ features: [photonFeature({ name: 'SW19' }, [-0.2, 51.42])] });
  assert.equal((await fetchSuggestions('SW19', { fetchImpl }))[0].label, 'SW19');
});

test('nothing for short input, and an empty list when the service is unreachable', async () => {
  let called = false;
  assert.deepEqual(await fetchSuggestions('ab', { fetchImpl: async () => { called = true; } }), []);
  assert.equal(called, false);
  const down = async () => {
    throw new TypeError('NetworkError when attempting to fetch resource.');
  };
  assert.deepEqual(await fetchSuggestions('Stamford Court', { fetchImpl: down }), []);
});

test('a cancelled lookup stays cancelled', async () => {
  const aborted = async () => {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(fetchSuggestions('Stamford Court', { fetchImpl: aborted }), { name: 'AbortError' });
});
