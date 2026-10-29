// Places outside Greater London the app also covers, each with a box
// [south, west, north, east]. Searches are limited to Greater London and these.
export const EXTRA_AREAS = [{ name: 'Pitlochry', bbox: [56.685, -3.78, 56.725, -3.69] }];

/** The extra area a point is in, if any. */
export function extraAreaAt([lat, lon]) {
  return EXTRA_AREAS.find(({ bbox: [s, w, n, e] }) => lat >= s && lat <= n && lon >= w && lon <= e);
}

/** The extra area a search names ("Atholl Road, Pitlochry"), if any. */
export function extraAreaNamed(query) {
  return EXTRA_AREAS.find(({ name }) => new RegExp(`\\b${name}\\b`, 'i').test(query));
}

/** "Greater London or Pitlochry", for messages. */
export const COVERED_PLACES = ['Greater London', ...EXTRA_AREAS.map((a) => a.name)].join(' or ');
