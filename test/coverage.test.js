import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COVERAGE, KINDS, coverageHtml } from '../src/coverage.js';
import { KERB_LAYERS } from '../src/sources/kerbside.js';
import { ZONE_LAYERS } from '../src/sources/council-zones.js';
import { STREET_LISTS } from '../src/sources/street-lists.js';

const kindsOf = (borough) => COVERAGE.find(([name]) => name === borough)?.[1] ?? [];

test("the About box lists London's 33 areas", () => {
  assert.equal(COVERAGE.length, 33);
  assert.equal(new Set(COVERAGE.map(([name]) => name)).size, 33);
  for (const [, kinds] of COVERAGE) for (const k of kinds) assert.ok(KINDS[k], k);
  assert.match(coverageHtml(), /for 29 of London's 33 areas/);
  const html = coverageHtml({ updated: '2026-10-20', osmUpdated: '2026-10-19', search: { checkedAt: '14:05', isNow: true, timing: 'Loaded in 1.2 s: zone map 0.8 s' } });
  assert.match(html, /This search<\/strong> was checked at 14:05, for parking then\..*Loaded in 1.2 s: zone map 0.8 s/s);
  assert.match(html, /Data last refreshed: council copies 2026-10-20 · OpenStreetMap 2026-10-19\./);
});

test('it says what the sources actually cover', () => {
  for (const layer of KERB_LAYERS) assert.ok(kindsOf(layer.borough).includes('kerb'), `${layer.borough} lines and bays`);
  for (const layer of ZONE_LAYERS) assert.ok(kindsOf(layer.borough).includes('zones'), `${layer.borough} zones`);
  for (const list of STREET_LISTS) assert.ok(kindsOf(list.borough).includes('streets'), `${list.borough} street list`);
  const listed = (kind, layers) => COVERAGE.filter(([, kinds]) => kinds.includes(kind)).map(([name]) => name).filter((name) => !layers.some((l) => l.borough === name));
  assert.deepEqual(listed('kerb', KERB_LAYERS), []);
  assert.deepEqual(listed('zones', ZONE_LAYERS), []);
  assert.deepEqual(listed('streets', STREET_LISTS), []);
});
