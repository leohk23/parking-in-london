// Weekly schedules for parking controls. Parses the "times of operation" text
// found on street signs, in council datasets and in OSM opening_hours, and
// works out when controls apply relative to an arrival time in London.

export const DAY = 24 * 60;
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const DAY_WORDS = {
  su: 0, sun: 0, sunday: 0,
  mo: 1, mon: 1, monday: 1,
  tu: 2, tue: 2, tues: 2, tuesday: 2,
  we: 3, wed: 3, weds: 3, wednesday: 3,
  th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fr: 5, fri: 5, friday: 5,
  sa: 6, sat: 6, saturday: 6,
};
const DAY_GROUPS = { daily: ALL_DAYS, everyday: ALL_DAYS, weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };
const DASH_WORDS = new Set(['to', 'until', 'till', 'til', 'through', 'thru']);
const BANK_HOLIDAY_WORDS = new Set(['ph', 'bank', 'public', 'holiday', 'holidays']);
// Conditions we can't turn into a weekly timetable.
const UNMODELLED_WORDS = new Set(['event', 'events', 'match', 'matches', 'school', 'term', 'season']);

const ALL_DAY_RE = /\b(at any time|any ?time|all times|24 ?\/ ?7|24 ?hours?|24 ?hrs?)\b/g;
const TOKEN_RE =
  /(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\b\.?|(\d{1,2})[:.](\d{2})|(\d{1,2})(?!\d)|(noon|midday|midnight)|([a-z]+)|(-)|([,;&])/g;

/**
 * Parses text such as "Mon-Fri 8.30am-6.30pm", "Mo-Sa 08:00-18:30; Su off"
 * or "At any time". Returns null when the text can't be read reliably.
 */
export function parseSchedule(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const clean = text
    .toLowerCase()
    .replace(/[‐-―]/g, '-')
    .split(/\bmax(?:imum)?\b|\bno return\b/)[0]
    .replace(ALL_DAY_RE, ' 00:00-24:00 ')
    // "M-Sat", "M-F": Monday to Saturday, Monday to Friday.
    .replace(/\bm\s*-\s*(?=(?:f|fri|sat|sun)\b)/g, 'mon-')
    .replace(/(\bmon\s*-\s*)f\b/g, '$1fri')
    // Durations ("limited waiting 2 hours") aren't clock times.
    .replace(/\b\d+(?:\.\d+)?\s*(?:hours?|hrs?|mins?|minutes?)\b/g, ' ');

  const tokens = tokenize(clean);
  if (!tokens) return null;

  const segments = [];
  let mentionsBankHolidays = false;
  let cur = newSegment();
  let except = false;
  const flush = () => {
    if (cur.days || cur.times.length || cur.off || cur.bankHoliday) segments.push(cur);
    cur = newSegment();
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type === 'day' || tok.type === 'days') {
      let list = tok.type === 'days' ? tok.days : [tok.day];
      if (tok.type === 'day' && tokens[i + 1]?.type === 'dash' && tokens[i + 2]?.type === 'day') {
        list = dayRange(tok.day, tokens[i + 2].day);
        i += 2;
      }
      if (except) {
        cur.days = (cur.days ?? ALL_DAYS).filter((d) => !list.includes(d));
        except = false;
      } else if (cur.trailing) {
        cur.days.push(...list);
      } else if (cur.times.length && !cur.days) {
        // Times written before the days, e.g. "8am-6pm Mon-Fri".
        cur.days = [...list];
        cur.trailing = true;
      } else {
        if (cur.times.length || cur.off) flush();
        cur.days = [...(cur.days ?? []), ...list];
      }
    } else if (tok.type === 'time') {
      if (tokens[i + 1]?.type !== 'dash' || tokens[i + 2]?.type !== 'time') return null;
      if (cur.trailing) flush();
      cur.times.push(timeRange(tok, tokens[i + 2]));
      except = false;
      i += 2;
    } else if (tok.type === 'off') {
      cur.off = true;
    } else if (tok.type === 'except') {
      except = true;
    } else if (tok.type === 'bank-holiday') {
      mentionsBankHolidays = true;
      if (except) {
        except = false;
      } else if (cur.days && !cur.times.length && !cur.off) {
        // "Sun & Bank Holidays 2pm-6pm": the bank holidays share the days' hours.
      } else if (!cur.bankHoliday) {
        // "PH off" or "PH 10:00-12:00" starts a bank-holiday-only rule.
        if (cur.days || cur.times.length) flush();
        cur.bankHoliday = true;
      }
    }
  }
  flush();

  const byDay = ALL_DAYS.map(() => []);
  let defined = false;
  for (const seg of segments) {
    // "PH off" and similar only tell us about bank holidays.
    if (seg.bankHoliday && !seg.days) continue;
    const days = seg.days ?? ALL_DAYS;
    defined = true;
    // Later rules replace earlier ones for the same day, as in OSM opening_hours.
    for (const d of days) byDay[d] = seg.off ? [] : seg.times.length ? [...seg.times] : [[0, DAY]];
  }
  if (!defined) return null;
  if (byDay.every((ranges) => ranges.some(([s, e]) => s <= 0 && e >= DAY))) return { kind: 'always', text };
  return { kind: 'weekly', byDay, text, mentionsBankHolidays };
}

function newSegment() {
  return { days: null, times: [], off: false, trailing: false, bankHoliday: false };
}

function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const [, h1, m1, mer, h2, m2, bare, named, word, dash, sep] = m;
    if (h1 !== undefined) tokens.push({ type: 'time', h: +h1, m: +(m1 ?? 0), mer });
    else if (h2 !== undefined) tokens.push({ type: 'time', h: +h2, m: +m2 });
    else if (bare !== undefined) tokens.push({ type: 'time', h: +bare, m: 0, bare: true });
    else if (named && tokens.at(-1)?.type === 'time' && tokens.at(-1).h === 12 && !tokens.at(-1).mer) {
      // "12.00 midday" is one time, not two.
      tokens.at(-1).named = named;
    } else if (named) tokens.push({ type: 'time', named });
    else if (dash) tokens.push({ type: 'dash' });
    else if (sep) tokens.push({ type: 'sep' });
    else if (word) {
      const w = word.endsWith('days') ? word.slice(0, -1) : word;
      if (w in DAY_WORDS) tokens.push({ type: 'day', day: DAY_WORDS[w] });
      else if (w in DAY_GROUPS) tokens.push({ type: 'days', days: DAY_GROUPS[w] });
      else if (DASH_WORDS.has(w)) tokens.push({ type: 'dash' });
      else if (w === 'and') tokens.push({ type: 'sep' });
      else if (w === 'off' || w === 'closed') tokens.push({ type: 'off' });
      else if (w === 'except' || w === 'excluding') tokens.push({ type: 'except' });
      else if (BANK_HOLIDAY_WORDS.has(w)) {
        if (tokens.at(-1)?.type !== 'bank-holiday') tokens.push({ type: 'bank-holiday' });
      }
      else if (UNMODELLED_WORDS.has(w)) return null;
      else if (w === 'every') tokens.push({ type: 'every' });
      else if (w === 'day' && tokens.at(-1)?.type === 'every') tokens.splice(-1, 1, { type: 'days', days: ALL_DAYS });
    }
  }
  return tokens;
}

function dayRange(from, to) {
  const days = [from];
  for (let d = from; d !== to; ) {
    d = (d + 1) % 7;
    days.push(d);
  }
  return days;
}

function clockMinutes(tok, isEnd) {
  if (tok.named === 'midnight') return isEnd ? DAY : 0;
  if (tok.named) return 12 * 60;
  let h = tok.h;
  if (tok.mer === 'p' && h < 12) h += 12;
  if (tok.mer === 'a' && h === 12) h = 0;
  const minutes = h * 60 + tok.m;
  return isEnd && minutes === 0 ? DAY : minutes;
}

function timeRange(a, b) {
  let start = clockMinutes(a, false);
  let end = clockMinutes(b, true);
  // "1.30-2.30pm": the start shares the end's pm when that keeps the range in order.
  if (!a.mer && !a.named && b.mer === 'p' && a.h < 12 && start + 12 * 60 < end) start += 12 * 60;
  // "8.30-6.30" on a sign means 8.30am to 6.30pm, not an overnight range.
  if (!a.mer && !b.mer && !a.named && !b.named && end <= start && a.h <= 12 && b.h < 12) end += 12 * 60;
  if (end <= start) end += DAY;
  return [start, end];
}

const LONDON = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Wall-clock time in London for a Date: { date: 'YYYY-MM-DD', weekday: 0-6, minutes }. */
export function londonClock(date) {
  const p = {};
  for (const { type, value } of LONDON.formatToParts(date)) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: DAY_NAMES.indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/**
 * Intervals [start, end) when the schedule applies, in minutes relative to the
 * clock (0 = arrival), covering at least `horizon` minutes ahead.
 */
export function controlIntervals(schedule, clock, horizon = 8 * DAY) {
  if (schedule.kind === 'always') return [[-Infinity, Infinity]];
  const out = [];
  for (let d = -1; d * DAY - clock.minutes <= horizon; d++) {
    for (const [s, e] of schedule.byDay[(clock.weekday + d + 7) % 7]) {
      out.push([d * DAY + s - clock.minutes, d * DAY + e - clock.minutes]);
    }
  }
  return mergeIntervals(out);
}

function mergeIntervals(intervals) {
  const sorted = intervals.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** "16:30" on the arrival day, otherwise "Mon 09:30". */
export function timeLabel(offset, clock) {
  const m = clock.minutes + offset;
  const dayOffset = Math.floor(m / DAY);
  const mins = ((m % DAY) + DAY) % DAY;
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  if (dayOffset === 0) return hhmm;
  const name = DAY_NAMES[(((clock.weekday + dayOffset) % 7) + 7) % 7];
  return dayOffset >= 7 ? `next ${name} ${hhmm}` : `${name} ${hhmm}`;
}

const bankHolidayCache = new Map();

/** England & Wales bank holidays, computed so the list never goes stale. */
export function isBankHoliday(isoDate) {
  const year = Number(isoDate.slice(0, 4));
  if (!bankHolidayCache.has(year)) bankHolidayCache.set(year, bankHolidays(year));
  return bankHolidayCache.get(year).has(isoDate);
}

function bankHolidays(y) {
  const utc = (m, d) => new Date(Date.UTC(y, m, d));
  const addDays = (date, n) => new Date(date.getTime() + n * 864e5);
  const toWeekday = (date) => {
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date = addDays(date, 1);
    return date;
  };
  const monday = (m, d, step) => {
    let date = utc(m, d);
    while (date.getUTCDay() !== 1) date = addDays(date, step);
    return date;
  };
  const easter = easterSunday(y);
  const christmas = toWeekday(utc(11, 25));
  const boxingDay = toWeekday(addDays(christmas, 1) > utc(11, 26) ? addDays(christmas, 1) : utc(11, 26));
  const days = [
    toWeekday(utc(0, 1)),
    addDays(easter, -2),
    addDays(easter, 1),
    monday(4, 1, 1), // early May
    monday(4, 31, -1), // spring
    monday(7, 31, -1), // summer
    christmas,
    boxingDay,
  ];
  return new Set(days.map((d) => d.toISOString().slice(0, 10)));
}

function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}
