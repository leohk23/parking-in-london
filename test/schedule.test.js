import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, londonClock, controlIntervals, timeLabel, isBankHoliday } from '../src/schedule.js';

const h = (hours) => hours * 60;

// Compact view of a schedule: { Mo: '9.5-16.5', ... }
function summary(text) {
  const s = parseSchedule(text);
  if (!s) return null;
  if (s.kind === 'always') return 'always';
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  return Object.fromEntries(
    s.byDay
      .map((ranges, d) => [names[d], ranges.map(([a, b]) => `${a / 60}-${b / 60}`).join(',')])
      .filter(([, r]) => r),
  );
}

const weekdays = (range) => ({ Mo: range, Tu: range, We: range, Th: range, Fr: range });

test('reads council sign formats', () => {
  assert.deepEqual(summary('Mon-Fri 9.30am-4.30pm'), weekdays('9.5-16.5'));
  assert.deepEqual(summary('Mon-Fri 1.30pm-2.30pm'), weekdays('13.5-14.5'));
  assert.deepEqual(summary('Mon - Fri 8am - 6.30pm Max stay 2 hours'), weekdays('8-18.5'));
  assert.deepEqual(summary('Mon-Fri 8.30-6.30'), weekdays('8.5-18.5'));
  assert.deepEqual(summary('1.30-2.30pm Mon-Fri'), weekdays('13.5-14.5'));
  assert.deepEqual(summary('weekdays 7-10am'), weekdays('7-10'));
  assert.deepEqual(summary('Monday to Friday 8.30 a.m. to 6.30 p.m. and Saturday 8.30am to 1.30pm'), {
    ...weekdays('8.5-18.5'),
    Sa: '8.5-13.5',
  });
});

test('reads OSM opening_hours style', () => {
  assert.deepEqual(summary('Mo-Sa 08:00-18:30; Su off'), { ...weekdays('8-18.5'), Sa: '8-18.5' });
  assert.deepEqual(summary('Mo-Fr 08:00-10:00,16:00-18:00; PH off'), weekdays('8-10,16-18'));
  assert.deepEqual(summary('Fr-Mo 10:00-12:00'), { Su: '10-12', Mo: '10-12', Fr: '10-12', Sa: '10-12' });
  assert.equal(parseSchedule('Mo-Fr 08:00-18:00; PH off').mentionsBankHolidays, true);
});

test('all-day and overnight controls', () => {
  assert.equal(summary('At any time'), 'always');
  assert.equal(summary('24/7'), 'always');
  assert.deepEqual(summary('Mon-Sat 24 hours'), { ...weekdays('0-24'), Sa: '0-24' });
  assert.equal(summary('22:00-06:00').Su, '22-30');
  assert.deepEqual(summary('Mon-Sat except bank holidays 8.30am-6.30pm'), { ...weekdays('8.5-18.5'), Sa: '8.5-18.5' });
});

test('refuses text it cannot model', () => {
  assert.equal(parseSchedule('Event days only'), null);
  assert.equal(parseSchedule(''), null);
  assert.equal(parseSchedule('See sign'), null);
});

test('London clock follows BST and GMT', () => {
  assert.deepEqual(londonClock(new Date('2026-10-18T14:41:00Z')), { date: '2026-10-18', weekday: 0, minutes: h(15) + 41 });
  assert.deepEqual(londonClock(new Date('2026-12-01T09:00:00Z')), { date: '2026-12-01', weekday: 2, minutes: h(9) });
});

test('intervals are relative to arrival and labelled by day', () => {
  const clock = londonClock(new Date('2026-10-18T14:41:00Z')); // Sunday 15:41
  const [first] = controlIntervals(parseSchedule('Mon-Fri 9.30am-4.30pm'), clock);
  assert.equal(timeLabel(first[0], clock), 'Mon 09:30');
  assert.equal(timeLabel(first[1], clock), 'Mon 16:30');
  assert.equal(timeLabel(30, clock), '16:11');
});

test('bank holidays', () => {
  for (const d of ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28']) {
    assert.equal(isBankHoliday(d), true, d);
  }
  assert.equal(isBankHoliday('2026-12-26'), false);
  assert.equal(isBankHoliday('2027-12-27'), true);
  assert.equal(isBankHoliday('2027-12-28'), true);
  assert.equal(isBankHoliday('2026-10-18'), false);
});

test('days sharing hours with bank holidays, and "12.00 midday"', () => {
  const w3 = parseSchedule('Mon-Sat 8:30am - 11:00pm; Sun & Bank Holidays 2:00pm - 6:00pm');
  assert.deepEqual(w3.byDay[0], [[14 * 60, 18 * 60]]);
  assert.deepEqual(w3.byDay[6], [[8 * 60 + 30, 23 * 60]]);
  assert.equal(w3.mentionsBankHolidays, true);
  assert.deepEqual(parseSchedule('Monday - Friday 11.00am - 12.00 Midday').byDay[1], [[11 * 60, 12 * 60]]);
  assert.deepEqual(parseSchedule('Mon-Fri 8am-12 midnight').byDay[1], [[8 * 60, 24 * 60]]);
});
