// British National Grid (EPSG:27700) eastings and northings to WGS84 latitude
// and longitude, via a Helmert transformation: good to about 5 m, plenty for
// kerbside lines. After Ordnance Survey's "A guide to coordinate systems in Great Britain".

const AIRY = { a: 6377563.396, b: 6356256.909 };
const WGS84 = { a: 6378137, b: 6356752.3142 };
const F0 = 0.9996012717;
const LAT0 = (49 * Math.PI) / 180;
const LON0 = (-2 * Math.PI) / 180;
const N0 = -100000;
const E0 = 400000;
// OSGB36 → WGS84: translations in metres, scale in ppm, rotations in arc seconds.
const HELMERT = { tx: 446.448, ty: -125.157, tz: 542.06, s: -20.4894, rx: 0.1502, ry: 0.247, rz: 0.8421 };

/** Grid easting and northing → OSGB36 [lat, lon] in radians (inverse transverse Mercator). */
function gridToOsgb36(E, N) {
  const { a, b } = AIRY;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;
  let lat = LAT0;
  let M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const d = lat - LAT0;
    const s = lat + LAT0;
    M =
      b *
      F0 *
      ((1 + n + (5 / 4) * (n2 + n3)) * d -
        (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(d) * Math.cos(s) +
        ((15 / 8) * (n2 + n3)) * Math.sin(2 * d) * Math.cos(2 * s) -
        ((35 / 24) * n3) * Math.sin(3 * d) * Math.cos(3 * s));
  } while (Math.abs(N - N0 - M) >= 0.00001);

  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (a * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;
  const tan = Math.tan(lat);
  const tan2 = tan * tan;
  const tan4 = tan2 * tan2;
  const tan6 = tan4 * tan2;
  const sec = 1 / cos;
  const nu3 = nu * nu * nu;
  const nu5 = nu3 * nu * nu;
  const nu7 = nu5 * nu * nu;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = (tan / (720 * rho * nu5)) * (61 + 90 * tan2 + 45 * tan4);
  const X = sec / nu;
  const XI = (sec / (6 * nu3)) * (nu / rho + 2 * tan2);
  const XII = (sec / (120 * nu5)) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = (sec / (5040 * nu7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);
  const dE = E - E0;
  return [
    lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6,
    LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7,
  ];
}

function toCartesian([lat, lon], { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  return [nu * Math.cos(lat) * Math.cos(lon), nu * Math.cos(lat) * Math.sin(lon), (1 - e2) * nu * Math.sin(lat)];
}

function fromCartesian([x, y, z], { a, b }) {
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * nu * Math.sin(lat), p);
  }
  return [lat, Math.atan2(y, x)];
}

function helmert([x, y, z], { tx, ty, tz, s, rx, ry, rz }) {
  const k = 1 + s * 1e-6;
  const r = (sec) => ((sec / 3600) * Math.PI) / 180;
  const [X, Y, Z] = [r(rx), r(ry), r(rz)];
  return [tx + k * x - Z * y + Y * z, ty + Z * x + k * y - X * z, tz - Y * x + X * y + k * z];
}

const deg = (rad) => (rad * 180) / Math.PI;

/** [easting, northing] → WGS84 [lat, lon] in degrees. */
export function osgbToWgs84(E, N) {
  const [lat, lon] = fromCartesian(helmert(toCartesian(gridToOsgb36(E, N), AIRY), HELMERT), WGS84);
  return [deg(lat), deg(lon)];
}
