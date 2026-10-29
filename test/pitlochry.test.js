import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraAreaAt, extraAreaNamed, COVERED_PLACES } from '../src/areas.js';
import { geocode } from '../src/geocode.js';
import { fetchSuggestions } from '../src/suggest.js';
import { carParkOption, fetchPerthKinross } from '../src/sources/perth-kinross.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const ATHOLL_ROAD = [56.7024, -3.7304];

test('Pitlochry is one of the places outside London the app covers', () => {
  assert.equal(extraAreaAt(ATHOLL_ROAD)?.name, 'Pitlochry');
  assert.equal(extraAreaAt([51.5, -0.12]), undefined);
  assert.equal(extraAreaNamed('Atholl Road, Pitlochry')?.name, 'Pitlochry');
  assert.equal(extraAreaNamed('Atholl Road'), undefined);
  assert.equal(COVERED_PLACES, 'Greater London or Pitlochry');
});

test('a search finds Pitlochry when London has nothing, or when it names the town', async () => {
  const urls = [];
  const atholl = { lat: '56.7024', lon: '-3.7304', display_name: 'Atholl Road, Pitlochry, Perth and Kinross, Scotland', category: 'highway', type: 'secondary', name: 'Atholl Road', address: {} };
  const fetchImpl = async (url) => {
    urls.push(url);
    return reply(new URL(url).searchParams.get('viewbox').startsWith('-3.78') ? [atholl] : []);
  };
  const found = await geocode('Atholl Road', { fetchImpl });
  assert.deepEqual(found.point, ATHOLL_ROAD);
  assert.equal(found.street, 'Atholl Road');
  assert.equal(urls.length, 2);
  urls.length = 0;
  await geocode('Atholl Road, Pitlochry', { fetchImpl });
  assert.equal(urls.length, 1);
  await assert.rejects(geocode('Nowhere Lane', { fetchImpl: async () => reply([]) }), /in Greater London or Pitlochry/);

  // Postcodes in the town.
  const postcode = await geocode('PH16 5BX', { fetchImpl: async () => reply({ result: { postcode: 'PH16 5BX', region: null, latitude: 56.7027, longitude: -3.7299 } }) });
  assert.equal(postcode.label, 'PH16 5BX');
  await assert.rejects(geocode('PH1 5PH', { fetchImpl: async () => reply({ result: { postcode: 'PH1 5PH', region: null, latitude: 56.39, longitude: -3.43 } }) }), /outside Greater London or Pitlochry/);
});

test('suggestions come from Pitlochry when London has none', async () => {
  const fetchImpl = async (url) => {
    const bbox = new URL(url).searchParams.get('bbox');
    if (!bbox.startsWith('-3.78')) return reply({ features: [] });
    return reply({
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-3.7304, 56.7024] }, properties: { name: 'Atholl Road', type: 'street', city: 'Pitlochry', county: 'Perth and Kinross' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-3.9, 56.6] }, properties: { name: 'Atholl Road', type: 'street', city: 'Aberfeldy' } },
      ],
    });
  };
  const found = await fetchSuggestions('Atholl Road', { fetchImpl });
  assert.deepEqual(found.map((s) => s.label), ['Atholl Road, Pitlochry']);
});

test("the council's car parks charge Monday to Saturday, 8am to 6pm", async () => {
  const feature = (p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-3.7304, 56.7024] }, properties: p });
  const atholl = feature({ CAR_PARK_NAME: 'ATHOLL ROAD', STREET_NAME: 'CAR PARK OFF ATHOLL ROAD', STATUS: 'PUBLIC', NO_BAYS: '63', DISABLED_BAYS: 2, FREE_OR_CHARGE: 'CHARGE', ELEC_POINT: '0', TOWN: 'PITLOCHRY' });
  const ferryWest = feature({ CAR_PARK_NAME: 'FERRY ROAD', STREET_NAME: 'CAR PARK OFF FERRY ROAD WEST', STATUS: 'PUBLIC', NO_BAYS: '60', FREE_OR_CHARGE: 'CHARGE', ELEC_POINT: '5', TOWN: 'PITLOCHRY' });
  const option = carParkOption(atholl.properties, atholl.geometry);
  assert.equal(option.title, 'Atholl Road car park');
  assert.equal(option.subtitle, 'Council car park · 63 spaces · 2 Blue Badge');
  assert.deepEqual(option.point, ATHOLL_ROAD);
  const monday = londonClock(new Date('2026-10-19T13:00:00Z'));
  const sunday = londonClock(new Date('2026-10-25T13:00:00Z'));
  assert.equal(evaluateOption(option, monday, 120).status, 'paid');
  assert.equal(evaluateOption(option, sunday, 120).status, 'free');
  const west = carParkOption(ferryWest.properties, ferryWest.geometry);
  assert.equal(west.title, 'Ferry Road car park (west)');
  assert.ok(west.notes.includes('5 electric vehicle charging points'));
  assert.equal(carParkOption({ ...atholl.properties, STATUS: 'PRIVATE' }, atholl.geometry), null);

  const asked = [];
  const fetchImpl = async (url) => (asked.push(url), reply({ type: 'FeatureCollection', features: [atholl, ferryWest] }));
  const { options } = await fetchPerthKinross([56.698, -3.737, 56.707, -3.723], ATHOLL_ROAD, { fetchImpl });
  assert.deepEqual(options.map((o) => o.title), ['Atholl Road car park', 'Ferry Road car park (west)', "Pitlochry's streets"]);
  assert.equal(evaluateOption(options[2], monday, 120).status, 'unknown');
  assert.deepEqual(await fetchPerthKinross([51.5, -0.13, 51.51, -0.12], [51.505, -0.125], { fetchImpl }), { options: [], skipped: true });
  assert.equal(asked.length, 1);
});
