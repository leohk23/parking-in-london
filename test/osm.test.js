import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsm, parseConditional, overpassQuery, firstSuccessful } from '../src/sources/osm.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';

const SUNDAY_AFTERNOON = londonClock(new Date('2026-10-18T14:41:00Z'));
const MONDAY_MORNING = londonClock(new Date('2026-10-19T09:00:00Z'));

const way = (id, tags) => ({
  type: 'way',
  id,
  tags: { highway: 'residential', ...tags },
  geometry: [
    { lat: 51.5, lon: -0.1 },
    { lat: 51.501, lon: -0.1 },
  ],
});

function evaluate(element, clock = SUNDAY_AFTERNOON, stay = 120) {
  const { options } = parseOsm({ elements: [element] });
  return options.map((o) => evaluateOption(o, clock, stay));
}

test('free car park with opening hours', () => {
  const [o] = evaluate({
    type: 'node',
    id: 1,
    lat: 51.5,
    lon: -0.1,
    tags: { amenity: 'parking', name: 'Station car park', fee: 'no', opening_hours: 'Mo-Su 07:00-22:00', capacity: '40' },
  });
  assert.equal(o.kind, 'car-park');
  assert.equal(o.status, 'free');
  assert.equal(o.results[0].summary, 'Free until 22:00, then closed');
  assert.match(o.subtitle, /40 spaces/);
});

test('car park with daytime charges', () => {
  const [o] = evaluate(
    { type: 'way', id: 2, center: { lat: 51.5, lon: -0.1 }, tags: { amenity: 'parking', fee: 'no', 'fee:conditional': 'yes @ (Mo-Sa 08:00-18:30)' } },
    MONDAY_MORNING,
  );
  assert.equal(o.status, 'paid');
  assert.equal(o.results[0].summary, 'Pay to park until 18:30, then free');
});

test('private car parks are left out', () => {
  assert.equal(evaluate({ type: 'node', id: 3, lat: 51.5, lon: -0.1, tags: { amenity: 'parking', access: 'private' } }).length, 0);
});

test('unknown fee is shown as unknown, not free', () => {
  const [o] = evaluate({ type: 'node', id: 4, lat: 51.5, lon: -0.1, tags: { amenity: 'parking' } });
  assert.equal(o.status, 'unknown');
});

test('street parking, current scheme: residents during the day, free otherwise', () => {
  const tags = {
    name: 'Test Street',
    'parking:both': 'lane',
    'parking:both:access:conditional': 'permit @ (Mo-Fr 09:30-16:30)',
  };
  const [sunday] = evaluate(way(10, tags));
  assert.equal(sunday.results[0].label, 'Both sides');
  assert.equal(sunday.status, 'free');
  const [monday] = evaluate(way(10, tags), MONDAY_MORNING);
  assert.equal(monday.status, 'no');
  assert.equal(monday.results[0].summary, 'Permit holders only until 16:30, then free');
});

test('street parking, current scheme: different sides', () => {
  const [o] = evaluate(
    way(11, {
      name: 'Test Street',
      'parking:left': 'no',
      'parking:left:restriction': 'no_stopping',
      'parking:right': 'lane',
      'parking:right:fee': 'yes',
    }),
  );
  assert.deepEqual(
    o.results.map((r) => [r.label, r.status]),
    [
      ['One side', 'no'],
      ['Other side', 'paid'],
    ],
  );
});

test('street parking, old scheme with time interval', () => {
  const [o] = evaluate(
    way(12, {
      name: 'Old Street',
      'parking:lane:both': 'parallel',
      'parking:condition:both': 'ticket',
      'parking:condition:both:time_interval': 'Mo-Sa 08:30-18:30',
      'parking:condition:both:default': 'free',
    }),
  );
  assert.equal(o.status, 'free');
  assert.equal(o.results[0].summary, 'Free until Mon 08:30, then pay to park');
});

test('roads with no parking tags still provide street geometry', () => {
  const { options, streets } = parseOsm({ elements: [way(13, { name: 'Plain Road' }), way(14, { highway: 'footway', name: 'Path' })] });
  assert.equal(options.length, 0);
  assert.deepEqual(streets.map((s) => s.name), ['Plain Road']);
});

test('identical neighbouring ways are merged', () => {
  const tags = { name: 'Long Road', 'parking:both': 'lane', 'parking:both:fee': 'no' };
  const { options } = parseOsm({ elements: [way(20, tags), way(21, tags)] });
  assert.equal(options.length, 1);
  assert.equal(options[0].lines.length, 2);
});

test('conditional values', () => {
  const [entry] = parseConditional('no_parking @ (Mo-Fr 07:00-09:00,16:00-18:00)');
  assert.equal(entry.value, 'no_parking');
  assert.deepEqual(entry.schedule.byDay[1], [[420, 540], [960, 1080]]);
  assert.equal(parseConditional('no @ (weight>3.5)'), null);
  assert.equal(parseConditional('yes @ (Mo-Fr 08:00-18:00; PH off)').length, 1);
});

test('query fetches the whole destination street', () => {
  const q = overpassQuery([51.4, -0.21, 51.41, -0.2], { street: 'Wimbledon Park Road', center: [51.44, -0.205] });
  assert.match(q, /way\["highway"\]\["name"="Wimbledon Park Road"\]\(around:2500,51.44,-0.205\)/);
  assert.match(overpassQuery([0, 0, 1, 1], { street: 'A "quoted" road', center: [0, 0] }), /A \\"quoted\\" road/);
});

test('street geometry is only requested when asked for', () => {
  const bbox = [51.49, -0.25, 51.5, -0.24];
  assert.match(overpassQuery(bbox), /way\["highway"\]\["name"\]\(51\.49/);
  assert.doesNotMatch(overpassQuery(bbox, { streets: false }), /way\["highway"\]\["name"\]\(51\.49/);
  assert.match(overpassQuery(bbox, { streets: false }), /amenity"="parking"/);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('first answer wins and slower requests are cancelled', async () => {
  const aborted = [];
  const value = await firstSuccessful(['slow', 'fast'], 20, async (url, signal) => {
    signal.addEventListener('abort', () => aborted.push(url));
    await wait(url === 'slow' ? 200 : 10);
    return url;
  });
  assert.equal(value, 'fast');
  assert.deepEqual(aborted, ['slow']);
});

test('a quick answer means no backup request', async () => {
  const asked = [];
  const value = await firstSuccessful(['a', 'b'], 50, async (url) => {
    asked.push(url);
    return url;
  });
  assert.equal(value, 'a');
  await wait(80);
  assert.deepEqual(asked, ['a']);
});

test('a failure moves straight on to the next endpoint', async () => {
  const started = Date.now();
  const value = await firstSuccessful(['down', 'up'], 1000, async (url) => {
    if (url === 'down') throw new Error('HTTP 429');
    return url;
  });
  assert.equal(value, 'up');
  assert.ok(Date.now() - started < 500);
});

test('rejects only when every endpoint fails', async () => {
  await assert.rejects(
    firstSuccessful(['a', 'b'], 10, async (url) => {
      throw new Error(`${url} failed`);
    }),
    /b failed/,
  );
});
