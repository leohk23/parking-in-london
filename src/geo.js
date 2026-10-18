// Small geometry helpers. Points are [lat, lon]; distances are metres using a
// flat-earth approximation, which is plenty accurate across a London borough.

const M_PER_DEG_LAT = 111320;

function metresPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** [south, west, north, east] around a point. */
export function bboxAround([lat, lon], radius) {
  const dLat = radius / M_PER_DEG_LAT;
  const dLon = radius / metresPerDegLon(lat);
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

export function inBbox([lat, lon], [s, w, n, e]) {
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

export function bboxesOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function distance(a, b) {
  const x = (b[1] - a[1]) * metresPerDegLon(a[0]);
  const y = (b[0] - a[0]) * M_PER_DEG_LAT;
  return Math.hypot(x, y);
}

/** Shortest distance from a point to a polyline. */
export function distanceToLine(p, line) {
  if (line.length === 1) return distance(p, line[0]);
  const kx = metresPerDegLon(p[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][1] - p[1]) * kx;
    const ay = (line[i - 1][0] - p[0]) * M_PER_DEG_LAT;
    const bx = (line[i][1] - p[1]) * kx;
    const by = (line[i][0] - p[0]) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Distance from a point to an option's marker or nearest line. */
export function distanceToOption(p, option) {
  if (option.point) return distance(p, option.point);
  return Math.min(...option.lines.map((line) => distanceToLine(p, line)));
}
