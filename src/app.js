// Page wiring: search form → geocode → fetch sources → evaluate → map and list.
/* global L */

import { geocode, reverseGeocode } from './geocode.js';
import { fetchOsm } from './sources/osm.js';
import { fetchCamden } from './sources/camden.js';
import { fetchCouncilZones } from './sources/council-zones.js';
import { zoneOptions, zonesCover, normaliseName } from './sources/zones.js';
import { evaluateOption, STATUS_RANK, STATUS_LABELS } from './evaluate.js';
import { londonClock, isBankHoliday, DAY_NAMES } from './schedule.js';
import { bboxAround, distanceToOption } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const SOURCE_LABELS = {
  osm: 'OpenStreetMap',
  camden: 'Camden Council open data',
  zones: 'Council zone hours',
  'council-zones': "Council's zone map",
};
const COLORS = () => {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(['free', 'paid', 'no', 'unknown'].map((s) => [s, css.getPropertyValue(`--${s}`).trim()]));
};

const map = L.map('map').setView([51.5074, -0.1278], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const resultsLayer = L.layerGroup().addTo(map);
const layersById = new Map();

let current = null;
let searchCount = 0;

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  search({ query: $('#q').value });
});
$('#locate').addEventListener('click', locate);
// An empty arrival time means "now"; the Now button clears it.
$('#now').addEventListener('click', () => {
  $('#arrive').value = '';
  syncNowButton();
});
$('#arrive').addEventListener('input', syncNowButton);
$('#arrive').addEventListener('change', syncNowButton);
$('#freeOnly').addEventListener('change', render);
$('#sort').addEventListener('change', render);

restoreFromUrl();

async function locate() {
  if (!navigator.geolocation) return showProgress('Location isn\'t available in this browser. Type a place instead.', 'error');
  setBusy(true);
  $('#locate').classList.add('busy');
  showProgress('Getting your location…');
  let point;
  try {
    point = await currentPosition();
  } catch (err) {
    setBusy(false);
    return showProgress(locationError(err), 'error');
  } finally {
    $('#locate').classList.remove('busy');
  }

  showProgress('Finding the address…');
  const place = await reverseGeocode(point, { signal: AbortSignal.timeout?.(6000) }).catch(() => null);
  $('#q').value = place?.label ?? '';
  await search({ dest: { label: place?.label ?? 'Your location', point, street: place?.street ?? null } });
}

function currentPosition() {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      reject,
      // A fix from the last minute is good enough and saves waiting for GPS.
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 },
    ),
  );
}

function locationError(err) {
  if (err.code === 1) return 'Location is blocked for this site. Allow it in your browser settings, or type a place.';
  if (err.code === 3) return 'Getting your location took too long. Try again, or type a place.';
  return "Couldn't get your location. Try again, or type a place.";
}

async function search({ query, dest }) {
  const id = ++searchCount;
  const isLatest = () => id === searchCount;
  const stay = Number($('#stay').value);
  const radius = Number($('#radius').value);
  const isNow = !$('#arrive').value;
  const arrival = isNow ? new Date() : new Date($('#arrive').value);
  setBusy(true);
  try {
    if (!dest) {
      showProgress('Finding the place…');
      dest = await geocode(query);
    }
    if (!isLatest()) return;
    saveToUrl(query ?? $('#q').value);

    const area = bboxAround(dest.point, radius);
    const clock = londonClock(arrival);
    const destStreet = dest.street && normaliseName(dest.street);
    const prepare = (o) => {
      const distance = distanceToOption(dest.point, o);
      const here = o.kind === 'zone' ? distance === 0 : Boolean(destStreet && normaliseName(o.title) === destStreet);
      return { ...evaluateOption(o, clock, stay), distance, here };
    };

    // Each source is shown as soon as it arrives: council zones take under a
    // second, OpenStreetMap can take much longer when its servers are busy.
    const sources = [
      {
        name: 'OpenStreetMap',
        load: fetchOsm(area, { street: dest.street, center: dest.point, streets: zonesCover(area) }).then((r) => [
          ...r.options,
          ...zoneOptions(r.streets),
        ]),
      },
      { name: "the council's zone map", load: fetchCouncilZones(area).then((r) => r.options) },
      { name: 'Camden bay data', load: fetchCamden(area).then((r) => r.options) },
    ];
    const waiting = new Set(sources.map((src) => src.name));
    current = { dest, options: [], clock, isNow, stay, sourceNotes: [], loading: true };
    showProgress('Loading parking data…');
    render();

    await Promise.all(
      sources.map(({ name, load }) =>
        load
          .then(
            (raw) => isLatest() && current.options.push(...raw.map(prepare).filter((o) => o.here || o.distance <= radius)),
            (err) => isLatest() && current.sourceNotes.push(`Couldn't load ${name} (${err.message}).`),
          )
          .finally(() => {
            if (!isLatest()) return;
            waiting.delete(name);
            current.loading = waiting.size > 0;
            if (current.loading) showProgress(`Still loading ${[...waiting].join(' and ')}…`);
            render();
          }),
      ),
    );
    if (isLatest()) showProgress(null);
  } catch (err) {
    if (isLatest()) showProgress(err.message, 'error');
  } finally {
    if (isLatest()) setBusy(false);
  }
}

function render() {
  if (!current) return;
  const { dest, clock, isNow, stay, sourceNotes } = current;
  const freeOnly = $('#freeOnly').checked;
  const sort = $('#sort').value;

  const options = current.options
    .filter((o) => !freeOnly || o.status === 'free')
    .sort((a, b) =>
      sort === 'near'
        ? a.distance - b.distance
        : b.here - a.here || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.distance - b.distance,
    );

  const counts = current.options.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
  const when = `${DAY_NAMES[clock.weekday]} ${clock.date.slice(8)}/${clock.date.slice(5, 7)} ${timeOfDay(clock.minutes)}`;
  const warnings = [...sourceNotes];
  if (isBankHoliday(clock.date)) {
    warnings.push("It's a bank holiday. Many zones don't operate today, but some do. Check the signs.");
  }
  showStatus(
    `<b>${esc(dest.label)}</b> · arriving ${isNow ? 'now, ' : ''}${esc(when)} for ${stayLabel(stay)}<br>` +
      `${counts.free ?? 0} free · ${counts.paid ?? 0} paid · ${counts.no ?? 0} not allowed · ${counts.unknown ?? 0} to check` +
      warnings.map((w) => `<span class="warn">${esc(w)}</span>`).join(''),
  );
  $('.controls').hidden = false;

  drawMap(dest, options);
  $('#list').innerHTML = options.length
    ? options.map((o) => `<li class="card ${o.status}" tabindex="0" data-id="${esc(o.id)}">${cardHtml(o)}</li>`).join('')
    : `<li class="status">${
        current.loading
          ? 'Loading…'
          : freeOnly
            ? 'Nothing free for your whole stay here. Try a bigger radius or untick the filter.'
            : 'No parking data found nearby. OpenStreetMap coverage of street parking is patchy outside some areas.'
      }</li>`;
  for (const el of document.querySelectorAll('#list .card')) {
    const open = (e) => !e.target.closest('details, a') && focusOption(el.dataset.id);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && open(e));
  }
}

function drawMap(dest, options) {
  const colors = COLORS();
  resultsLayer.clearLayers();
  layersById.clear();
  L.marker(dest.point, { title: dest.label }).addTo(resultsLayer);
  L.circle(dest.point, { radius: Number($('#radius').value), color: colors.unknown, weight: 1, fill: false, dashArray: '4 6' }).addTo(resultsLayer);

  // Zones go underneath; then worst first so free options end up on top.
  const order = (o) => (o.kind === 'zone' ? -1 : 0);
  for (const o of [...options].sort((a, b) => order(a) - order(b) || STATUS_RANK[b.status] - STATUS_RANK[a.status])) {
    const color = colors[o.status];
    let layer;
    if (o.polygons) {
      layer = L.polygon(o.polygons, {
        color,
        weight: 2,
        opacity: 0.8,
        fillColor: color,
        fillOpacity: o.here ? 0.12 : 0.05,
        dashArray: o.here ? null : '6 5',
      });
      layer.bindTooltip(esc(o.title), { permanent: true, direction: 'center', className: 'zone-label' });
    } else if (o.lines) {
      layer = L.polyline(o.lines, { color, weight: o.kind === 'bay' ? 7 : 6, opacity: 0.9 });
    } else {
      layer = L.circleMarker(o.point, { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
    }
    layer.bindPopup(`<div class="card ${o.status}">${cardHtml(o)}</div>`, { maxWidth: 320 });
    layer.addTo(resultsLayer);
    layersById.set(o.id, layer);
  }
  // Zones can be large, so the view fits the destination and nearby spaces only.
  const bounds = L.latLngBounds([dest.point]);
  for (const o of options.filter((o) => !o.polygons && (o.distance < 600 || o.here))) {
    if (o.point) bounds.extend(o.point);
    else o.lines.forEach((line) => bounds.extend(line));
  }
  map.fitBounds(bounds.pad(0.1), { maxZoom: 17 });
}

function focusOption(id) {
  const layer = layersById.get(id);
  if (!layer) return;
  document.querySelectorAll('#list .card.selected').forEach((el) => el.classList.remove('selected'));
  document.querySelector(`#list .card[data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
  if (layer.getBounds) map.fitBounds(layer.getBounds(), { maxZoom: 18, padding: [30, 30] });
  else map.setView(layer.getLatLng(), Math.max(map.getZoom(), 17));
  layer.openPopup();
  if (window.matchMedia('(max-width: 899px)').matches) $('#map').scrollIntoView({ behavior: 'smooth' });
}

function cardHtml(o) {
  const parts = o.results
    .map(
      (r) =>
        `<li class="${r.status}"><span class="dot"></span><span>${r.label ? `<b>${esc(r.label)}:</b> ` : ''}${esc(r.summary)}` +
        `${r.changesDuringStay ? ' <b>(changes during your stay)</b>' : ''}` +
        `${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></li>`,
    )
    .join('');
  const notes = [...(o.notes ?? []), ...new Set(o.results.flatMap((r) => r.notes))];
  const partlyFree = o.status === 'free' && o.results.some((r) => r.status !== 'free');
  const where = o.here
    ? o.kind === 'zone'
      ? "you're in this zone"
      : 'your street'
    : `${Math.round(o.distance / 10) * 10} m · ${Math.max(1, Math.round(o.distance / 80))} min walk`;
  return `
    <div class="card-head">
      <span class="badge ${o.status}">${partlyFree ? 'Part free' : STATUS_LABELS[o.status]}</span>
      <span class="card-title">${esc(o.title)}</span>
      <span class="card-dist">${where}</span>
    </div>
    ${o.subtitle ? `<div class="card-sub">${esc(o.subtitle)}</div>` : ''}
    <ul class="parts">${parts}</ul>
    ${notes.length ? `<details class="notes"><summary>Notes (${notes.length})</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <div class="card-src">${SOURCE_LABELS[o.source]}${o.checked ? `, checked ${esc(o.checked)}` : ''}${o.link ? ` · <a href="${esc(o.link)}" target="_blank" rel="noopener">source</a>` : ''}</div>`;
}

function showStatus(html) {
  $('#status').innerHTML = html;
}

function showProgress(message, kind = '') {
  const el = $('#progress');
  el.hidden = !message;
  el.className = `progress ${kind}`;
  el.textContent = message ?? '';
  if (message && kind !== 'error') el.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>');
}

function setBusy(busy) {
  $('#go').disabled = busy;
  $('#go').textContent = busy ? 'Searching…' : 'Find parking';
  $('#locate').disabled = busy;
}

function syncNowButton() {
  $('#now').setAttribute('aria-pressed', String(!$('#arrive').value));
}

function saveToUrl(query) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('stay', $('#stay').value);
  params.set('r', $('#radius').value);
  if ($('#arrive').value) params.set('at', $('#arrive').value);
  history.replaceState(null, '', `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, sel] of [['stay', '#stay'], ['r', '#radius'], ['at', '#arrive']]) {
    if (params.has(key)) $(sel).value = params.get(key);
  }
  syncNowButton();
  if (params.get('q')) {
    $('#q').value = params.get('q');
    search({ query: params.get('q') });
  }
}

function timeOfDay(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function stayLabel(minutes) {
  return minutes < 60 ? `${minutes} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
