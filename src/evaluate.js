// Works out what a parking option means for a given arrival time and stay.
//
// An option has one or more parts (e.g. each side of a street, or each zone a
// street belongs to). A part is a list of rules, checked in order, plus what
// applies when no rule matches:
//   { label, rules: [{ when | whenNot: schedule, effect, label? }], otherwise: { effect, label? }, notes }

import { controlIntervals, timeLabel, DAY } from './schedule.js';

const HORIZON = 8 * DAY;

export const EFFECTS = {
  free: { label: 'Free', status: 'free' },
  paid: { label: 'Pay to park', status: 'paid' },
  controlled: { label: 'Pay or permit', status: 'paid' },
  permit: { label: 'Permit holders only', status: 'no' },
  restricted: { label: 'Restricted', status: 'no' },
  'no-parking': { label: 'No parking', status: 'no' },
  closed: { label: 'Closed', status: 'no' },
  unknown: { label: 'Terms unknown', status: 'unknown' },
};

/** Lower is better for someone looking for a space. */
export const STATUS_RANK = { free: 0, paid: 1, unknown: 2, no: 3 };

export const STATUS_LABELS = { free: 'Free', paid: 'Paid', unknown: 'Check', no: 'No' };

function state(effect, label) {
  const { label: fallback, status } = EFFECTS[effect] ?? EFFECTS.unknown;
  return { effect, label: label ?? fallback, status, key: `${effect}|${label ?? ''}` };
}

function invert(intervals) {
  const out = [];
  let cursor = -Infinity;
  for (const [a, b] of intervals) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < Infinity) out.push([cursor, Infinity]);
  return out;
}

export function evaluatePart(part, clock, stayMinutes) {
  const rules = part.rules.map((rule) => ({
    ...rule,
    intervals: rule.when
      ? controlIntervals(rule.when, clock, HORIZON)
      : rule.whenNot
        ? invert(controlIntervals(rule.whenNot, clock, HORIZON))
        : [[-Infinity, Infinity]],
  }));
  const at = (t) => {
    const rule = rules.find((r) => r.intervals.some(([a, b]) => a <= t && t < b));
    return rule ? state(rule.effect, rule.label) : state(part.otherwise.effect, part.otherwise.label);
  };

  const boundaries = [...new Set(rules.flatMap((r) => r.intervals.flat()))]
    .filter((t) => t > 0 && t < HORIZON)
    .sort((a, b) => a - b);

  const now = at(0);
  let next = null;
  let worst = now.status;
  let prev = now;
  for (const t of boundaries) {
    if (t >= stayMinutes && next) break;
    const s = at(t);
    if (s.key === prev.key) continue;
    next ??= { ...s, t, at: timeLabel(t, clock) };
    if (t < stayMinutes && STATUS_RANK[s.status] > STATUS_RANK[worst]) worst = s.status;
    prev = s;
  }

  return {
    label: part.label ?? '',
    detail: part.detail ?? '',
    notes: part.notes ?? [],
    now,
    next,
    status: worst,
    changesDuringStay: worst !== now.status,
    summary: next ? `${now.label} until ${next.at}, then ${lowerFirst(next.label)}` : now.label,
  };
}

/** Adds `results` (one per part) and an overall `status`: the best part for the whole stay. */
export function evaluateOption(option, clock, stayMinutes) {
  const results = option.parts.map((part) => evaluatePart(part, clock, stayMinutes));
  const status = results.reduce(
    (best, r) => (STATUS_RANK[r.status] < STATUS_RANK[best] ? r.status : best),
    'no',
  );
  return { ...option, results, status };
}

function lowerFirst(s) {
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}
