// Page wiring: search form → geocode → fetch sources → evaluate → map and list.
/* global L */

import { geocode } from './geocode.js';
import { fetchOsm } from './sources/osm.js';
import { fetchCamden } from './sources/camden.js';
import { zoneOptions, normaliseName } from './sources/zones.js';
import { evaluateOption, STATUS_RANK, STATUS_LABELS } from './evaluate.js';
import { londonClock, isBankHoliday, DAY_NAMES } from './schedule.js';
import { bboxAround, distanceToOption } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const SOURCE_LABELS = { osm: 'OpenStreetMap', camden: 'Camden Council open data', zones: 'Council zone hours' };
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

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  search({ query: $('#q').value });
});
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return showStatus('Location is not available in this browser.', 'error');
  showStatus('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => search({ point: [pos.coords.latitude, pos.coords.longitude] }),
    (err) => showStatus(`Couldn't get your location: ${err.message}`, 'error'),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});
$('#freeOnly').addEventListener('change', render);
$('#sort').addEventListener('change', render);

restoreFromUrl();

async function search({ query, point }) {
  const stay = Number($('#stay').value);
  const radius = Number($('#radius').value);
  const arrival = $('#arrive').value ? new Date($('#arrive').value) : new Date();
  setBusy(true);
  try {
    showStatus('Finding the place…');
    const dest = point ? { label: 'Your location', point, street: null } : await geocode(query);
    saveToUrl(query);

    showStatus('Loading parking data…');
    const area = bboxAround(dest.point, radius);
    const [osm, camden] = await Promise.allSettled([
      fetchOsm(area, { street: dest.street, center: dest.point }),
      fetchCamden(area),
    ]);

    const raw = [];
    const sourceNotes = [];
    if (osm.status === 'fulfilled') {
      raw.push(...osm.value.options, ...zoneOptions(osm.value.streets));
    } else {
      sourceNotes.push(`OpenStreetMap didn't load (${osm.reason.message}), so car parks and zone streets are missing.`);
    }
    if (camden.status === 'fulfilled') raw.push(...camden.value.options);
    else sourceNotes.push(`Camden bay data didn't load (${camden.reason.message}).`);

    const clock = londonClock(arrival);
    const destStreet = dest.street && normaliseName(dest.street);
    const options = raw
      .map((o) => ({
        ...evaluateOption(o, clock, stay),
        distance: distanceToOption(dest.point, o),
        onStreet: Boolean(destStreet && normaliseName(o.title) === destStreet),
      }))
      .filter((o) => o.onStreet || o.distance <= radius);

    current = { dest, options, clock, stay, sourceNotes };
    render();
  } catch (err) {
    showStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function render() {
  if (!current) return;
  const { dest, clock, stay, sourceNotes } = current;
  const freeOnly = $('#freeOnly').checked;
  const sort = $('#sort').value;

  const options = current.options
    .filter((o) => !freeOnly || o.status === 'free')
    .sort((a, b) =>
      sort === 'near'
        ? a.distance - b.distance
        : b.onStreet - a.onStreet || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.distance - b.distance,
    );

  const counts = current.options.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
  const when = `${DAY_NAMES[clock.weekday]} ${clock.date.slice(8)}/${clock.date.slice(5, 7)} ${timeOfDay(clock.minutes)}`;
  const warnings = [...sourceNotes];
  if (isBankHoliday(clock.date)) {
    warnings.push("It's a bank holiday. Many zones don't operate today, but some do. Check the signs.");
  }
  showStatus(
    `<b>${esc(dest.label)}</b> · arriving ${esc(when)} for ${stayLabel(stay)}<br>` +
      `${counts.free ?? 0} free · ${counts.paid ?? 0} paid · ${counts.no ?? 0} not allowed · ${counts.unknown ?? 0} to check` +
      warnings.map((w) => `<span class="warn">${esc(w)}</span>`).join(''),
    '',
    true,
  );
  $('.controls').hidden = false;

  drawMap(dest, options);
  $('#list').innerHTML = options.length
    ? options.map((o) => `<li class="card ${o.status}" tabindex="0" data-id="${esc(o.id)}">${cardHtml(o)}</li>`).join('')
    : `<li class="status">${freeOnly ? 'Nothing free for your whole stay here. Try a bigger radius or untick the filter.' : 'No parking data found nearby. OpenStreetMap coverage of street parking is patchy outside some areas.'}</li>`;
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

  // Draw worst first so free options end up on top.
  for (const o of [...options].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])) {
    const color = colors[o.status];
    const layer = o.lines
      ? L.polyline(o.lines, { color, weight: o.kind === 'bay' ? 7 : 6, opacity: 0.9 })
      : L.circleMarker(o.point, { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
    layer.bindPopup(`<div class="card ${o.status}">${cardHtml(o)}</div>`, { maxWidth: 320 });
    layer.addTo(resultsLayer);
    layersById.set(o.id, layer);
  }
  const bounds = L.latLngBounds([dest.point]);
  for (const o of options.filter((o) => o.distance < 600 || o.onStreet)) {
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
  const where = o.onStreet ? 'your street' : `${Math.round(o.distance / 10) * 10} m · ${Math.max(1, Math.round(o.distance / 80))} min walk`;
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

function showStatus(message, kind = '', html = false) {
  const el = $('#status');
  el.className = `status ${kind}`;
  if (html) el.innerHTML = message;
  else el.textContent = message;
}

function setBusy(busy) {
  $('#go').disabled = busy;
  $('#locate').disabled = busy;
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
