// Page wiring: search form → geocode → fetch sources → evaluate → map and list.
/* global L */

import { geocode, reverseGeocode, councilAt } from './geocode.js';
import { attachSuggestions } from './autocomplete.js';
import { loadRecent, addRecent, clearRecent } from './recent.js';
import { createCache } from './cache.js';
import { fetchOsm } from './sources/osm.js';
import { fetchCamden } from './sources/camden.js';
import { fetchCouncilZones, outsideZones } from './sources/council-zones.js';
import { fetchKerbside } from './sources/kerbside.js';
import { loadStreetLists, streetListOptions, outsideStreetLists, streetListsCover, normaliseName } from './sources/street-lists.js';
import { evaluateOption, STATUS_RANK, STATUS_LABELS } from './evaluate.js';
import { londonClock, isBankHoliday } from './schedule.js';
import { bboxAround, distanceToOption } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const SOURCE_LABELS = {
  osm: 'OpenStreetMap',
  camden: 'Camden Council open data',
  'street-list': "Council's street list",
  'council-zones': "Council's zone map",
  kerbside: "Council's kerbside map",
};
const INFO_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.5v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.3" r="1.3" fill="currentColor"/></svg>';
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
const youLayer = L.layerGroup().addTo(map);
const layersById = new Map();
// Leaflet stops clicks inside popups from reaching the page, so each popup's info button is bound when it opens.
map.on('popupopen', (e) => bindInfo(e.popup.getElement()));

// Map button that shows where you are, without changing the search.
const LOCATE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>';
const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const link = L.DomUtil.create('a', 'map-locate', bar);
    link.href = '#';
    link.setAttribute('role', 'button');
    link.title = 'Show my location';
    link.setAttribute('aria-label', 'Show my location');
    link.innerHTML = LOCATE_ICON;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      recenter(link);
    });
    return bar;
  },
});
new LocateControl().addTo(map);

// Full-screen map. iPhones don't allow real full screen for a page element, so
// there the map fills the browser window instead.
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const SHRINK_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
let fullscreenLink;
const FullscreenControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    fullscreenLink = L.DomUtil.create('a', 'map-fullscreen', bar);
    fullscreenLink.href = '#';
    fullscreenLink.setAttribute('role', 'button');
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(fullscreenLink, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      toggleFullscreen();
    });
    return bar;
  },
});
new FullscreenControl().addTo(map);
syncFullscreen();
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.contains('map-full') && setWindowFill(false));

function isFullscreen() {
  return document.fullscreenElement === $('#map') || document.body.classList.contains('map-full');
}

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (document.body.classList.contains('map-full')) return setWindowFill(false);
  const el = $('#map');
  if (el.requestFullscreen) el.requestFullscreen().catch(() => setWindowFill(true));
  else setWindowFill(true);
}

function setWindowFill(on) {
  document.body.classList.toggle('map-full', on);
  syncFullscreen();
}

function syncFullscreen() {
  const full = isFullscreen();
  fullscreenLink.innerHTML = full ? SHRINK_ICON : EXPAND_ICON;
  fullscreenLink.title = full ? 'Exit full screen' : 'Full screen map';
  fullscreenLink.setAttribute('aria-label', fullscreenLink.title);
  setTimeout(() => map.invalidateSize(), 50);
}

let current = null;
let searchCount = 0;
// OpenStreetMap is slow and its car parks rarely change, so answers are kept for a week.
const osmCache = createCache('osm', { maxAgeMs: 7 * 24 * 3600 * 1000, maxEntries: 8 });

// The place picked from the suggestions (or found from your location), reused
// by Find while the box still shows its name.
let pickedPlace = null;
attachSuggestions($('#q'), $('#suggestions'), {
  recent: { load: () => loadRecent(), clear: () => clearRecent() },
  onPick: (place) => {
    pickedPlace = place;
    search({ query: place.label, dest: place });
  },
});

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const query = $('#q').value;
  if (pickedPlace?.label !== query) pickedPlace = null;
  search({ query, dest: pickedPlace ?? undefined });
});
$('#locate').addEventListener('click', locate);
// "Now" shows the current time in the box and keeps it current; picking a
// time switches it off, and the Now button (or clearing the box) brings it back.
let arriveNow = true;
$('#now').addEventListener('click', () => setArriveNow(true));
for (const type of ['input', 'change']) {
  $('#arrive').addEventListener(type, () => setArriveNow(!$('#arrive').value));
}
setInterval(showNowTime, 30000);
document.addEventListener('visibilitychange', showNowTime);
$('#freeOnly').addEventListener('change', render);
// A smaller radius than the last search only filters and zooms; a bigger one searches again.
$('#radius').addEventListener('change', () => {
  if (!current) return;
  if (Number($('#radius').value) > current.radius) return search({ dest: current.dest });
  current.viewed = false;
  saveToUrl($('#q').value);
  render();
});
$('#sort').addEventListener('change', render);
// The info box closes with its button, Escape, or a tap outside it.
$('#info').addEventListener('click', (e) => e.target === $('#info') && $('#info').close());

restoreFromUrl();

async function locate() {
  if (!navigator.geolocation) return showProgress('Location isn\'t available in this browser. Type a place instead.', 'error');
  setBusy(true);
  $('#locate').classList.add('busy');
  showProgress('Getting your location…');
  let point;
  try {
    const here = await currentPosition();
    showYou(here);
    point = here.point;
  } catch (err) {
    setBusy(false);
    return showProgress(locationError(err), 'error');
  } finally {
    $('#locate').classList.remove('busy');
  }

  showProgress('Finding the address…');
  const place = await reverseGeocode(point, { signal: AbortSignal.timeout?.(6000) }).catch(() => null);
  $('#q').value = place?.label ?? '';
  pickedPlace = place ? { label: place.label, point, street: place.street } : null;
  await search({ dest: { label: place?.label ?? 'Your location', point, street: place?.street ?? null } });
}

async function recenter(link) {
  if (!navigator.geolocation) return showProgress("Location isn't available in this browser.", 'error');
  link.classList.add('busy');
  try {
    const here = await currentPosition();
    showYou(here);
    map.setView(here.point, Math.max(map.getZoom(), 16));
  } catch (err) {
    showProgress(locationError(err), 'error');
  } finally {
    link.classList.remove('busy');
  }
}

/** Blue dot for your position, with a faint circle for how accurate it is. */
function showYou({ point, accuracy }) {
  youLayer.clearLayers();
  if (accuracy < 500) {
    L.circle(point, { radius: accuracy, color: '#1d73e8', weight: 1, opacity: 0.4, fillOpacity: 0.08, interactive: false }).addTo(youLayer);
  }
  L.circleMarker(point, { radius: 7, color: '#fff', weight: 2, fillColor: '#1d73e8', fillOpacity: 1 })
    .bindTooltip('You are here')
    .addTo(youLayer);
}

function currentPosition() {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ point: [pos.coords.latitude, pos.coords.longitude], accuracy: pos.coords.accuracy }),
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
  const isNow = arriveNow || Number.isNaN(new Date($('#arrive').value).getTime());
  const arrival = isNow ? new Date() : new Date($('#arrive').value);
  setBusy(true);
  try {
    if (!dest) {
      showProgress('Finding the place…');
      dest = await geocode(query);
    }
    if (!isLatest()) return;
    saveToUrl(query ?? $('#q').value);
    if (dest.label !== 'Your location') addRecent(dest);

    const area = bboxAround(dest.point, radius);
    const clock = londonClock(arrival);
    const destStreet = dest.street && normaliseName(dest.street);
    const prepare = (o) => {
      const distance = distanceToOption(dest.point, o);
      const here =
        o.kind === 'zone' || o.kind === 'area' ? distance === 0 : Boolean(destStreet && normaliseName(o.title) === destStreet);
      return { ...evaluateOption(o, clock, stay), distance, here };
    };

    // Each source is shown as soon as it arrives: council zones take under a
    // second, OpenStreetMap can take much longer when its servers are busy.
    const osm = fetchOsm(area, { street: dest.street, center: dest.point, streets: streetListsCover(area), cache: osmCache });
    const council = councilAt(dest.point).catch(() => null);
    const sources = [
      { name: 'OpenStreetMap', load: osm.then((r) => r.options) },
      // Drawn along OpenStreetMap's streets; your own street is listed even without them.
      {
        name: "the council's street list",
        load: Promise.all([loadStreetLists(area), osm.then((r) => r.streets, () => []), council]).then(([lists, streets, district]) => [
          ...streetListOptions(lists, { streets, dest }),
          ...outsideStreetLists(lists, { dest, council: district }),
        ]),
      },
      {
        name: "the council's zone map",
        load: Promise.all([fetchCouncilZones(area), council]).then(([r, district]) => [
          ...r.options,
          ...outsideZones(r, district, dest.point),
        ]),
      },
      { name: "the council's kerbside map", load: fetchKerbside(area).then((r) => r.options) },
      { name: 'Camden bay data', load: fetchCamden(area).then((r) => r.options) },
    ];
    const waiting = new Set(sources.map((src) => src.name));
    current = { dest, radius, options: [], clock, sourceNotes: [], loading: true };
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
  const { dest, clock, sourceNotes } = current;
  const freeOnly = $('#freeOnly').checked;
  const sort = $('#sort').value;
  const radius = Number($('#radius').value);
  // Options are kept for the radius searched, which can be bigger than the one shown.
  const inRange = current.options.filter((o) => o.here || o.distance <= radius);

  const options = inRange
    .filter((o) => !freeOnly || o.status === 'free')
    .sort((a, b) =>
      sort === 'near'
        ? a.distance - b.distance
        : b.here - a.here || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.distance - b.distance,
    );

  const counts = inRange.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
  const warnings = [...sourceNotes];
  if (isBankHoliday(clock.date)) {
    warnings.push("It's a bank holiday. Many zones don't operate today, but some do. Check the signs.");
  }
  // Where and when are already in the boxes above, so the summary is just the counts.
  showStatus(
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
    const open = (e) => !e.target.closest('a, .info') && focusOption(el.dataset.id);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && open(e));
  }
  bindInfo($('#list'));
}

function drawMap(dest, options) {
  const colors = COLORS();
  resultsLayer.clearLayers();
  layersById.clear();
  L.marker(dest.point, { title: dest.label }).addTo(resultsLayer);
  L.circle(dest.point, { radius: Number($('#radius').value), color: colors.unknown, weight: 1, fill: false, dashArray: '4 6' }).addTo(resultsLayer);

  // Zones go underneath; then worst first so free options end up on top.
  // Area-wide notes ("no parking zone here") have nothing to draw.
  const order = (o) => (o.kind === 'zone' ? -1 : 0);
  const drawable = options.filter((o) => o.point || o.lines || o.polygons);
  for (const o of drawable.sort((a, b) => order(a) - order(b) || STATUS_RANK[b.status] - STATUS_RANK[a.status])) {
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
      if (o.kind === 'zone') layer.bindTooltip(esc(o.title), { permanent: true, direction: 'center', className: 'zone-label' });
    } else if (o.lines) {
      layer = L.polyline(o.lines, { color, weight: o.kind === 'bay' || o.kind === 'kerb' ? 5 : 6, opacity: 0.9 });
    } else {
      layer = L.circleMarker(o.point, { radius: 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 });
    }
    layer.bindPopup(`<div class="card popup ${o.status}">${cardHtml(o, { compact: true })}</div>`, { maxWidth: 280 });
    layer.addTo(resultsLayer);
    layersById.set(o.id, layer);
  }
  // Once per search, so the view doesn't jump as later sources arrive. Centred
  // on the destination; for the shorter distances one step closer than the whole
  // circle, since everything there is a short walk and streets are easier to tell apart.
  if (current.viewed) return;
  current.viewed = true;
  const radius = Number($('#radius').value);
  const zoom = map.getBoundsZoom(L.latLng(dest.point).toBounds(radius * 2)) + (radius <= 500 ? 1 : 0);
  map.setView(dest.point, Math.min(zoom, 18));
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

/** `compact` is for map popups: what you need to decide, without the subtitle. Notes and source are behind the info button. */
function cardHtml(o, { compact = false } = {}) {
  const parts = o.results
    .map(
      (r) =>
        `<li class="${r.status}"><span class="dot"></span><span>${r.label ? `<b>${esc(r.label)}:</b> ` : ''}${esc(r.summary)}` +
        `${r.changesDuringStay ? ' <b>(changes during your stay)</b>' : ''}` +
        `${r.detail ? `<small>${esc(r.detail)}</small>` : ''}</span></li>`,
    )
    .join('');
  const partlyFree = o.status === 'free' && o.results.some((r) => r.status !== 'free');
  const where = o.here
    ? o.kind === 'zone'
      ? "you're in this zone"
      : o.kind === 'area'
        ? 'here'
        : 'your street'
    : `${Math.round(o.distance / 10) * 10} m · ${Math.max(1, Math.round(o.distance / 80))} min walk`;
  const head = `
    <div class="card-head">
      <span class="badge ${o.status}">${partlyFree ? 'Part free' : STATUS_LABELS[o.status]}</span>
      <span class="card-title">${esc(o.title)}</span>
      <span class="card-dist">${where}</span>
      <button type="button" class="info" data-info="${esc(o.id)}" title="Notes and source" aria-label="Notes and source for ${esc(o.title)}">${INFO_ICON}</button>
    </div>`;
  if (compact) return `${head}<ul class="parts">${parts}</ul>`;
  return `${head}
    ${o.subtitle ? `<div class="card-sub">${esc(o.subtitle)}</div>` : ''}
    <ul class="parts">${parts}</ul>`;
}

/** Info buttons open a box with the option's notes and where the data came from. */
function bindInfo(root) {
  // Assigned rather than added: a popup's button is bound again each time it opens.
  for (const btn of root.querySelectorAll('[data-info]')) {
    btn.onclick = (e) => {
      e.stopPropagation();
      showInfo(btn.dataset.info);
    };
  }
}

function showInfo(id) {
  const o = current?.options.find((x) => x.id === id);
  if (!o) return;
  const notes = [...(o.notes ?? []), ...new Set(o.results.flatMap((r) => r.notes))];
  $('#info-body').innerHTML = `
    <h2 id="info-title">${esc(o.title)}</h2>
    ${o.subtitle ? `<p class="info-sub">${esc(o.subtitle)}</p>` : ''}
    ${notes.length ? `<ul class="info-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <p class="info-src">Source: ${SOURCE_LABELS[o.source]}${o.checked ? `, updated ${esc(o.checked)}` : ''}${
      o.link ? `<br /><a href="${esc(o.link)}" target="_blank" rel="noopener">Open the source page</a>` : ''
    }</p>`;
  if (!$('#info').open) $('#info').showModal();
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
  $('#go').classList.toggle('busy', busy);
  $('#locate').disabled = busy;
}

function setArriveNow(now) {
  arriveNow = now;
  $('#now').setAttribute('aria-pressed', String(now));
  showNowTime();
}

function showNowTime() {
  if (arriveNow) $('#arrive').value = localInputValue(new Date());
}

/** The "YYYY-MM-DDTHH:MM" a datetime-local input expects, in the device's time zone. */
function localInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function saveToUrl(query) {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('stay', $('#stay').value);
  params.set('r', $('#radius').value);
  if (!arriveNow) params.set('at', $('#arrive').value);
  history.replaceState(null, '', `?${params}`);
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, sel] of [['stay', '#stay'], ['r', '#radius'], ['at', '#arrive']]) {
    if (params.has(key)) $(sel).value = params.get(key);
  }
  setArriveNow(!params.get('at'));
  if (params.get('q')) {
    $('#q').value = params.get('q');
    search({ query: params.get('q') });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
