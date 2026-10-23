import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBromley, bromleyUrl, fetchBromleyZone } from '../src/sources/bromley.js';
import { evaluateOption } from '../src/evaluate.js';
import { londonClock } from '../src/schedule.js';
import { osgbToWgs84 } from '../src/osgb.js';

// The end of the lookup's answers, as Bromley's StatMap server gives them.
const MAPLE = "})();\n document.getElementById(\"DR1\").innerHTML=\"\\u003cul class=\\\"auroraList\\\"\\u003e\\r\\n\\u003cli class=\\\"auroraListItem\\\"\\u003e\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eYour address falls within a CPZ: Maple Road - MAP \\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eTimes: 8.30am - 6.30pm Monday - Saturday\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eResidents Permit: \u00a3150\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eBusiness Permit: \u00a3125\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eVisitors Voucher: \u00a355 for 15 vouchers\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eConditions: \\u003cbr\\u003e\\n\\u003c/p\\u003e\\u003c/li\\u003e\\r\\n\\u003c/ul\\u003e\\r\\n\";\n document.getElementById(\"DR2\").innerHTML=\"\";";
const TOWN = "})();\n document.getElementById(\"DR1\").innerHTML=\"\\u003cul class=\\\"auroraList\\\"\\u003e\\r\\n\\u003cli class=\\\"auroraListItem\\\"\\u003e\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eYour address falls within a CPZ: Bromley Town Centre - Central - AA \\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eTimes: 8.00am - 8:00pm, Monday to Saturday - 10:00am - 5:00pm Sunday\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eResidents Permit: \u00a3150\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eBusiness Permit: Unavailable for this zone.\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eVisitors Voucher: Unavailable for this zone.\\u003cbr\\u003e\\n\\u003c/p\\u003e\\n\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eConditions: Permits are not available just for Bromley Town Centre zone A. If you live in this zone, you can apply for one of the following permits: zone A\\u0026B/zone A\\u0026C/zone B/zone C and you can buy visitors\\u0027 vouchers only for zones B \\u0026 C.\\u003cbr\\u003e\\n\\u003c/p\\u003e\\u003c/li\\u003e\\r\\n\\u003c/ul\\u003e\\r\\n\";\n document.getElementById(\"DR2\").innerHTML=\"\";";
const OUTSIDE = "})();\n document.getElementById(\"DR1\").innerHTML=\"\";\n document.getElementById(\"DR2\").innerHTML=\"\\u003cul class=\\\"auroraList\\\"\\u003e\\r\\n\\u003cli class=\\\"auroraListItem\\\"\\u003e\\u003cp style=\\\"font-family:verdana;font-size:14px;font-weight:bold;color:#407199;\\\"\\u003eYour address is not in a controlled parking zone.\\u003cbr\\u003e\\u003c/li\\u003e\\r\\n\\u003c/ul\\u003e\\r\\n\";";

test("Bromley's lookup gives the zone and its hours", () => {
  assert.deepEqual(parseBromley(MAPLE), { zone: 'MAP', area: 'Maple Road', hours: '8.30am - 6.30pm Monday - Saturday', notes: [] });
  const town = parseBromley(TOWN);
  assert.equal(town.zone, 'AA');
  assert.equal(town.area, 'Bromley Town Centre - Central');
  assert.equal(town.hours, '8.00am - 8:00pm, Monday to Saturday - 10:00am - 5:00pm Sunday');
  assert.match(town.notes[0], /^Permits are not available just for Bromley Town Centre zone A/);
  assert.equal(parseBromley(OUTSIDE), null);
  assert.throws(() => parseBromley('<html>Service unavailable</html>'), /unexpected answer/);
});

test('it asks about the spot searched, in grid references, and only in Bromley', async () => {
  const point = osgbToWgs84(535364, 170287);
  const url = new URL(bromleyUrl(point));
  assert.equal(url.searchParams.get('query'), 'x=535364;y=170287;id=0');
  assert.equal(url.searchParams.get('script'), '\\Aurora\\Parking_CPZ_Cluster.AuroraScript$');

  const asked = [];
  const fetchImpl = async (u) => (asked.push(u), { ok: true, text: async () => MAPLE });
  assert.deepEqual(await fetchBromleyZone(point, 'Lewisham', { fetchImpl }), []);
  assert.equal(asked.length, 0);
  const [zone] = await fetchBromleyZone(point, 'Bromley', { fetchImpl });
  assert.equal(zone.title, 'Zone MAP');
  assert.equal(zone.subtitle, 'Maple Road · Bromley controlled parking zone');
  // Monday 14:00, for two hours: controlled, so pay or permit.
  const monday = londonClock(new Date('2026-10-19T13:00:00Z'));
  assert.equal(evaluateOption(zone, monday, 120).status, 'paid');
  const sunday = londonClock(new Date('2026-10-25T13:00:00Z'));
  assert.equal(evaluateOption(zone, sunday, 120).status, 'free');

  const special = MAPLE.replace('8.30am - 6.30pm Monday - Saturday', 'Special Conditions apply');
  const [inner] = await fetchBromleyZone(point, 'Bromley', { fetchImpl: async () => ({ ok: true, text: async () => special }) });
  assert.equal(evaluateOption(inner, monday, 120).status, 'unknown');
  assert.equal(inner.parts[0].otherwise.label, 'Special Conditions apply: see the signs at the entry to the zone');

  const [none] = await fetchBromleyZone(point, 'Bromley', { fetchImpl: async () => ({ ok: true, text: async () => OUTSIDE }) });
  assert.equal(none.title, 'No parking zone here');
});
