import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osgbToWgs84, wgs84ToOsgb } from '../src/osgb.js';

test('grid references become GPS coordinates within a few metres', () => {
  // Corners of two Harrow car parks, as Harrow's map server gives them in both systems.
  for (const [E, N, lat, lon] of [
    [515298.6626, 188230.6522, 51.581153960305905, -0.3373525441578751],
    [515163.5284, 188296.6042, 51.5817743300299, -0.33928036425289787],
  ]) {
    const [a, b] = osgbToWgs84(E, N);
    assert.ok(Math.abs(a - lat) * 111320 < 3 && Math.abs(b - lon) * 69400 < 3, `${E},${N} → ${a},${b}`);
  }
});

test('GPS coordinates become grid references, and back', () => {
  const [E, N] = wgs84ToOsgb(51.581153960305905, -0.3373525441578751);
  assert.ok(Math.hypot(E - 515298.6626, N - 188230.6522) < 3, `${E},${N}`);
  const [lat, lon] = osgbToWgs84(535364, 170287);
  const [e, n] = wgs84ToOsgb(lat, lon);
  assert.ok(Math.hypot(e - 535364, n - 170287) < 0.1);
});
