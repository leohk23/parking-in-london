// Page wiring: search form → geocode → fetch sources → evaluate → map and list.
/* global L */

import { geocode, reverseGeocode, councilAt } from './geocode.js';
import { attachSuggestions } from './autocomplete.js';
import { loadRecent, addRecent, clearRecent } from './recent.js';
import { loadSaved, isSaved, savePlace, removeSaved } from './saved.js';
import { createCache } from './cache.js';
import { fetchOsm } from './sources/osm.js';
import { loadOsmTiles } from './sources/osm-tiles.js';
import { coverageHtml } from './coverage.js';
import { fetchCamden } from './sources/camden.js';
import { fetchCouncilZones, outsideZones } from './sources/council-zones.js';
import { fetchBromleyZone } from './sources/bromley.js';
import { fetchPerthKinross } from './sources/perth-kinross.js';
import { extraAreaAt } from './areas.js';
import { fetchKerbside } from './sources/kerbside.js';
import { loadStreetLists, streetListOptions, outsideStreetLists, streetListsCover, normaliseName } from './sources/street-lists.js';
import { evaluateOption, STATUS_RANK, STATUS_LABELS } from './evaluate.js';
import { londonClock, isBankHoliday } from './schedule.js';
import { bboxAround, distanceToOption } from './geo.js';

const $ = (sel) => document.querySelector(sel);
const SOURCE_LABELS = {
  osm: 'OpenStreetMap',
  camden: 'Camden Council open data',
  'perth-kinross': 'Perth & Kinross Council open data',
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
const pinLayer = L.layerGroup().addTo(map);
const layersById = new Map();
// Leaflet stops clicks inside popups from reaching the page, so each popup's info button is bound when it opens.
map.on('popupopen', (e) => bindInfo(e.popup.getElement()));

// Map button that follows where you are, live, without changing the search.
const LOCATE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2"/></svg>';
const LocateControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const link = L.DomUtil.create('a', 'map-locate', bar);
    link.href = '#';
    link.setAttribute('role', 'button');
    link.title = 'Follow my location';
    link.setAttribute('aria-label', 'Follow my location');
    link.setAttribute('aria-pressed', 'false');
    link.innerHTML = LOCATE_ICON;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      toggleFollow(link);
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

// Map button for what data the app has in each borough, and where it comes from.
const ABOUT_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/></svg>';
const AboutControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const link = L.DomUtil.create('a', 'map-about', bar);
    link.href = '#';
    link.setAttribute('role', 'button');
    link.title = 'About the data';
    link.setAttribute('aria-label', 'About the data: what each borough has');
    link.innerHTML = ABOUT_ICON;
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      showCoverage();
    });
    return bar;
  },
});
new AboutControl().addTo(map);
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
  saved: { load: () => loadSaved(), remove: (label) => removeSaved(label) },
  onSavedChange: () => showSaveButton(),
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
$('#save').addEventListener('click', toggleSaved);
$('#about').addEventListener('click', showCoverage);
// "Now" shows the current time in the box and keeps it current; picking a
// time switches it off, and the Now button (or clearing the box) brings it back.
let arriveNow = true;
$('#now').addEventListener('click', () => setArriveNow(true));
for (const type of ['input', 'change']) {
  $('#arrive').addEventListener(type, () => setArriveNow(!$('#arrive').value));
}
setInterval(showNowTime, 30000);
document.addEventListener('visibilitychange', showNowTime);
$('#status').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'details') showCoverage();
  if (action === 'refresh' && current) search({ dest: current.dest });
});
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
// The app menu (the P logo) closes when you tap anywhere else.
document.addEventListener('click', (e) => !e.target.closest('.apps') && $('.apps').removeAttribute('open'));
// The info box closes with its button, Escape, or a tap outside it.
$('#info').addEventListener('click', (e) => e.target === $('#info') && $('#info').close());

restoreFromUrl();

// The offline cache (sw.js) is for the published site; local servers skip it so edits show at once.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

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
  await searchFrom(point, 'Your location');
}

/** Searches from a point, with its nearest address (if any) shown in the search box. */
async function searchFrom(point, fallbackLabel, place) {
  place ??= await reverseGeocode(point, { signal: AbortSignal.timeout?.(6000) }).catch(() => null);
  $('#q').value = place?.label ?? '';
  pickedPlace = place ? { label: place.label, point, street: place.street } : null;
  await search({ dest: { label: place?.label ?? fallbackLabel, point, street: place?.street ?? null } });
}

// Long-press the map (right-click on a computer) to drop a pin and search from
// there, for places the suggestions don't know.
const PIN_ICON = L.divIcon({
  className: 'drop-pin',
  html: '<svg viewBox="0 0 30 42" width="30" height="42" aria-hidden="true"><path d="M15 1C7.3 1 1 7.2 1 14.9 1 25.4 15 41 15 41s14-15.6 14-26.1C29 7.2 22.7 1 15 1z" fill="#c23a2b" stroke="#fff" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#fff"/></svg>',
  iconSize: [30, 42],
  iconAnchor: [15, 41],
  popupAnchor: [0, -38],
});
map.on('contextmenu', (e) => dropPin([e.latlng.lat, e.latlng.lng]));

// A hint on the map until the first pin is dropped (or it's closed), since long-press isn't obvious.
const PIN_HINT_KEY = 'park-nearby:pin-hint-seen';
const pinHint = L.DomUtil.create('div', 'map-hint', map.getContainer());
const touch = window.matchMedia('(pointer: coarse)').matches;
pinHint.innerHTML = `<span>📍 ${touch ? 'Long-press' : 'Right-click'} the map to drop a pin</span><button type="button" aria-label="Hide this tip">✕</button>`;
L.DomEvent.disableClickPropagation(pinHint);
pinHint.querySelector('button').addEventListener('click', hidePinHint);
pinHint.hidden = readFlag(PIN_HINT_KEY);

function hidePinHint() {
  pinHint.hidden = true;
  try {
    localStorage.setItem(PIN_HINT_KEY, '1');
  } catch {}
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function dropPin(point) {
  hidePinHint();
  pinLayer.clearLayers();
  const body = L.DomUtil.create('div', 'pin-popup');
  body.innerHTML = '<div class="pin-address">Finding the address…</div><button type="button">Find parking here</button>';
  let place;
  const lookup = reverseGeocode(point, { signal: AbortSignal.timeout?.(6000) })
    .then((p) => (place = p))
    .catch(() => null)
    .then(() => (body.querySelector('.pin-address').textContent = place?.label ?? 'Dropped pin'));
  body.querySelector('button').addEventListener('click', async () => {
    await lookup;
    pinLayer.clearLayers();
    searchFrom(point, 'Dropped pin', place);
  });
  L.marker(point, { icon: PIN_ICON, keyboard: false }).addTo(pinLayer).bindPopup(body, { closeButton: true, minWidth: 190 }).openPopup();
}

// Following: the blue dot moves as you do and the map stays centred on it,
// until you drag the map. Tapping the button then centres it again; tapping
// it while centred stops following. The screen is kept on meanwhile.
let follow = null;

function toggleFollow(link) {
  if (follow && !follow.centred) {
    follow.centred = true;
    syncFollowButton();
    if (follow.point) map.setView(follow.point, Math.max(map.getZoom(), 16));
    return;
  }
  if (follow) return stopFollow();
  if (!navigator.geolocation) return showProgress("Location isn't available in this browser.", 'error');
  follow = { link, centred: true, point: null, wakeLock: null };
  link.classList.add('busy');
  follow.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (!follow) return;
      const first = !follow.point;
      follow.point = [pos.coords.latitude, pos.coords.longitude];
      // Phones only know the direction while moving.
      const moving = pos.coords.speed == null || pos.coords.speed > 1;
      const heading = moving && Number.isFinite(pos.coords.heading) ? pos.coords.heading : null;
      showYou({ point: follow.point, accuracy: pos.coords.accuracy, heading });
      link.classList.remove('busy');
      if (follow.centred) map.setView(follow.point, first ? Math.max(map.getZoom(), 16) : map.getZoom(), { animate: !first });
      syncFollowButton();
    },
    (err) => {
      // A slow fix isn't fatal while following: keep waiting for the next one.
      if (err.code === 3 && follow?.point) return;
      showProgress(locationError(err), 'error');
      stopFollow();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
  keepScreenOn();
  syncFollowButton();
}

function stopFollow() {
  if (!follow) return;
  navigator.geolocation.clearWatch(follow.watchId);
  follow.wakeLock?.release().catch(() => {});
  follow.link.classList.remove('busy');
  const { link } = follow;
  follow = null;
  syncFollowButton(link);
}

function syncFollowButton(link = follow?.link) {
  if (!link) return;
  link.classList.toggle('active', Boolean(follow?.centred));
  link.classList.toggle('paused', Boolean(follow && !follow.centred));
  link.setAttribute('aria-pressed', String(Boolean(follow)));
  link.title = !follow ? 'Follow my location' : follow.centred ? 'Stop following' : 'Centre on my location';
  link.setAttribute('aria-label', link.title);
}

async function keepScreenOn() {
  try {
    if (follow && !follow.wakeLock && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock?.request('screen');
      if (!follow) return lock?.release();
      follow.wakeLock = lock ?? null;
      lock?.addEventListener('release', () => follow?.wakeLock === lock && (follow.wakeLock = null));
    }
  } catch {
    // Not supported, or refused (e.g. low battery): the screen may sleep as usual.
  }
}

// The browser drops the screen lock when the page is hidden; take it again on return.
document.addEventListener('visibilitychange', keepScreenOn);
// Dragging the map means you want to look around: stop centring until asked.
map.on('dragstart', () => {
  if (!follow?.centred) return;
  follow.centred = false;
  syncFollowButton();
});

/** Blue dot for your position, with a faint circle for how accurate it is and an arrow for your direction. */
const you = { dot: null, circle: null };
function showYou({ point, accuracy, heading = null }) {
  if (!you.dot || !youLayer.hasLayer(you.dot)) {
    youLayer.clearLayers();
    you.circle = L.circle(point, { radius: accuracy, color: '#1d73e8', weight: 1, interactive: false }).addTo(youLayer);
    const html = '<svg class="you-heading" viewBox="0 0 40 40" hidden><path d="M20 2 L27 14 L13 14 Z" fill="#1d73e8"/></svg><span class="you-dot"></span>';
    const icon = L.divIcon({ className: 'you', html, iconSize: [40, 40], iconAnchor: [20, 20] });
    you.dot = L.marker(point, { icon, keyboard: false, zIndexOffset: 1000 }).bindTooltip('You are here').addTo(youLayer);
  }
  you.dot.setLatLng(point);
  you.circle.setLatLng(point).setRadius(accuracy);
  you.circle.setStyle({ opacity: accuracy < 500 ? 0.4 : 0, fillOpacity: accuracy < 500 ? 0.08 : 0 });
  // Updated in place, so the arrow turns smoothly rather than jumping.
  const arrow = you.dot.getElement()?.querySelector('.you-heading');
  if (arrow) {
    arrow.hidden = heading == null;
    if (heading != null) arrow.style.transform = `rotate(${Math.round(heading)}deg)`;
  }
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
    const lookupStarted = performance.now();
    if (!dest) {
      showProgress('Finding the place…');
      dest = await geocode(query);
    }
    const lookupMs = performance.now() - lookupStarted;
    if (!isLatest()) return;
    saveToUrl(query ?? $('#q').value);
    if (dest.label !== 'Your location' && dest.label !== 'Dropped pin') addRecent(dest);
    savable = savablePlace(dest);
    showSaveButton();
    pinLayer.clearLayers();

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
    // Each source's load gives { options, skipped? (nothing for this area), via? (how OpenStreetMap was loaded) }.
    const started = performance.now();
    const osm = fetchOsm(area, { street: dest.street, center: dest.point, streets: streetListsCover(area), tiles: loadOsmTiles, cache: osmCache });
    const council = councilAt(dest.point).catch(() => null);
    const sources = [
      { name: 'OpenStreetMap', key: 'osm', load: osm.then((r) => ({ options: r.options, via: r.via })) },
      // Drawn along OpenStreetMap's streets; your own street is listed even without them.
      {
        name: "the council's street list",
        key: 'street-list',
        load: Promise.all([loadStreetLists(area), osm.then((r) => r.streets, () => []), council]).then(([lists, streets, district]) => ({
          options: [...streetListOptions(lists, { streets, dest }), ...outsideStreetLists(lists, { dest, council: district })],
          skipped: !lists.length,
        })),
      },
      {
        name: "the council's zone map",
        key: 'council-zones',
        // Bromley has no zone map, only a lookup of the zone at the spot searched.
        load: Promise.all([fetchCouncilZones(area), council, council.then((district) => fetchBromleyZone(dest.point, district))]).then(
          ([r, district, bromley]) => ({
            options: [...r.options, ...bromley, ...outsideZones(r, district, dest.point)],
            skipped: r.skipped && !bromley.length,
          }),
        ),
      },
      { name: "the council's kerbside map", key: 'kerbside', load: fetchKerbside(area) },
      { name: 'Camden bay data', key: 'camden', load: fetchCamden(area) },
      { name: "Perth & Kinross Council's car parks", key: 'perth-kinross', load: fetchPerthKinross(area, dest.point) },
    ];
    const waiting = new Set(sources.map((src) => src.name));
    current = { dest, radius, options: [], clock, isNow, searchedAt: Date.now(), sourceNotes: [], loading: true, timings: [], lookupMs };
    showProgress('Loading parking data…');
    render();

    await Promise.all(
      sources.map(({ name, key, load }) =>
        load
          .then(
            (r) => {
              if (!isLatest()) return;
              current.options.push(...r.options.map(prepare).filter((o) => o.here || o.distance <= radius));
              if (!r.skipped) current.timings.push({ name, key, ms: performance.now() - started, via: r.via });
            },
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

  const sorted = inRange
    .filter((o) => !freeOnly || o.status === 'free')
    .sort((a, b) =>
      sort === 'near'
        ? a.distance - b.distance
        : b.here - a.here || STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.distance - b.distance,
    );

  const counts = inRange.reduce((acc, o) => ({ ...acc, [o.status]: (acc[o.status] ?? 0) + 1 }), {});
  const warnings = [...sourceNotes];
  // England's bank holidays: Scotland's differ.
  if (isBankHoliday(clock.date) && !extraAreaAt(dest.point)) {
    warnings.push("It's a bank holiday. Many zones don't operate today, but some do. Check the signs.");
  }
  // Where and when are already in the boxes above, so the summary is just the counts;
  // how long it took and how fresh the data is are a tap away.
  current.staleShown = isStale(current);
  showStatus(
    `${counts.free ?? 0} free · ${counts.paid ?? 0} paid · ${counts.no ?? 0} not allowed · ${counts.unknown ?? 0} to check` +
      (current.loading ? '' : `<button type="button" class="link checked" data-action="details">Checked at ${clockTime(current.searchedAt)} · details</button>`) +
      (current.staleShown
        ? `<span class="warn stale">These results are for ${clockTime(current.searchedAt)}, when you searched. <button type="button" class="link" data-action="refresh">Update to now</button></span>`
        : '') +
      warnings.map((w) => `<span class="warn">${esc(w)}</span>`).join(''),
  );
  $('.controls').hidden = false;

  // Street bays with no terms mapped are one card at the end of the list, not one each.
  const unmapped = sorted.filter((o) => o.group === 'street-bays' && o.status === 'unknown');
  const options = sorted.filter((o) => !unmapped.includes(o));

  drawMap(dest, sorted);
  $('#list').innerHTML = sorted.length
    ? options.map((o) => `<li class="card ${o.status}" tabindex="0" data-id="${esc(o.id)}">${cardHtml(o)}</li>`).join('') +
      (unmapped.length ? `<li class="card unknown" tabindex="0" data-group="street-bays">${unmappedCardHtml(unmapped)}</li>` : '')
    : `<li class="status">${
        current.loading
          ? 'Loading…'
          : freeOnly
            ? 'Nothing free for your whole stay here. Try a bigger radius or untick the filter.'
            : 'No parking data found nearby. OpenStreetMap coverage of street parking is patchy outside some areas.'
      }</li>`;
  for (const el of document.querySelectorAll('#list .card')) {
    const open = (e) =>
      !e.target.closest('a, .info') && (el.dataset.group ? focusGroup(el, unmapped) : focusOption(el.dataset.id));
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && open(e));
  }
  bindInfo($('#list'));
}

function drawMap(dest, options) {
  const colors = COLORS();
  resultsLayer.clearLayers();
  layersById.clear();
  // Drag the destination to fine-tune it: the search runs again from where it's dropped.
  L.marker(dest.point, { title: `${dest.label} (drag to move)`, draggable: true, autoPan: true })
    .on('dragend', (e) => {
      const { lat, lng } = e.target.getLatLng();
      showProgress('Finding the address…');
      searchFrom([lat, lng], 'Dropped pin');
    })
    .addTo(resultsLayer);
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

function unmappedCardHtml(bays) {
  const nearest = Math.min(...bays.map((o) => o.distance));
  return `
    <div class="card-head">
      <span class="badge unknown">${STATUS_LABELS.unknown}</span>
      <span class="card-title">${bays.length} street-side ${bays.length > 1 ? 'bays' : 'bay'}</span>
      <span class="card-dist">from ${Math.round(nearest / 10) * 10} m</span>
    </div>
    <div class="card-sub">OpenStreetMap shows these bays but not whether they're free, paid or time-limited: check the signs.</div>`;
}

/** Shows every bay in the group on the map. */
function focusGroup(el, bays) {
  document.querySelectorAll('#list .card.selected').forEach((c) => c.classList.remove('selected'));
  el.classList.add('selected');
  const bounds = L.latLngBounds(bays.flatMap((o) => (o.point ? [o.point] : o.lines?.flat() ?? o.polygons?.flat() ?? [])));
  if (bounds.isValid()) map.fitBounds(bounds, { maxZoom: 18, padding: [30, 30] });
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

function timingFor(key) {
  const t = current?.timings.find((x) => x.key === key);
  return t ? `<br />Loaded in ${seconds(t.ms)}${t.via ? ` from the ${VIA_LABELS[t.via]}` : ''}` : '';
}

function showInfo(id) {
  const o = current?.options.find((x) => x.id === id);
  if (!o) return;
  const notes = [...(o.notes ?? []), ...new Set(o.results.flatMap((r) => r.notes))];
  $('#info-body').innerHTML = `
    <h2 id="info-title">${esc(o.title)}</h2>
    ${o.subtitle ? `<p class="info-sub">${esc(o.subtitle)}</p>` : ''}
    ${notes.length ? `<ul class="info-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <p class="info-src">Source: ${SOURCE_LABELS[o.source]}${o.checked ? `, updated ${esc(o.checked)}` : ''}${timingFor(o.source)}${
      o.link ? `<br /><a href="${esc(o.link)}" target="_blank" rel="noopener">Open the source page</a>` : ''
    }</p>`;
  if (!$('#info').open) $('#info').showModal();
}

/**
 * The "About the data" box: this search (when, how long), when the copied
 * data was last refreshed, and what each borough has.
 */
const updatedDates = {};
function showCoverage() {
  const fill = () => {
    const search = current && !current.loading ? { checkedAt: clockTime(current.searchedAt), isNow: current.isNow, timing: timingText(current) } : null;
    $('#info-body').innerHTML = coverageHtml({ ...updatedDates, search });
  };
  fill();
  if (!$('#info').open) $('#info').showModal();
  $('#info').scrollTop = 0;
  for (const [key, path] of [['updated', '../data/kerb/index.json'], ['osmUpdated', '../data/osm/index.json']]) {
    if (updatedDates[key]) continue;
    fetch(new URL(path, import.meta.url))
      .then((res) => (res.ok ? res.json() : null))
      .then((index) => {
        if (!index?.updated) return;
        updatedDates[key] = index.updated;
        if ($('#info').open && $('#info-title')?.textContent === 'About the data') fill();
      })
      .catch(() => {});
  }
}

const VIA_LABELS = { prebuilt: 'prebuilt copy', saved: 'saved on this phone', live: 'live servers' };
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** "Loaded in 1.2 s: OpenStreetMap 0.3 s (prebuilt copy) · zone map 0.8 s", so slow sources are easy to spot. */
function timingText({ timings, lookupMs }) {
  if (!timings.length) return '';
  const total = Math.max(...timings.map((t) => t.ms)) + lookupMs;
  const parts = [
    ...(lookupMs > 50 ? [`place lookup ${seconds(lookupMs)}`] : []),
    ...[...timings].sort((a, b) => b.ms - a.ms).map((t) => `${t.name.replace(/^the council's /, '')} ${seconds(t.ms)}${t.via ? ` (${VIA_LABELS[t.via]})` : ''}`),
  ];
  return `Loaded in ${seconds(total)}: ${parts.join(' · ')}`;
}

/** "14:05" in the device's time. */
const clockTime = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// Results for "now" go out of date while the page sits open: after this long, say so.
const STALE_AFTER = 10 * 60 * 1000;
const isStale = (c) => Boolean(c && !c.loading && c.isNow && Date.now() - c.searchedAt > STALE_AFTER);

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

// The ☆ in the search bar saves the place just searched (not "Your location",
// which moves); saved places are listed first when you tap the search box.
let savable = null;

/** The place to save for a destination: a dropped pin with no address gets its coordinates as a name. */
function savablePlace(dest) {
  if (dest.label === 'Your location') return null;
  const label = dest.label === 'Dropped pin' ? `Pin at ${dest.point.map((n) => n.toFixed(4)).join(', ')}` : dest.label;
  return { label, point: dest.point, street: dest.street ?? null };
}

function showSaveButton() {
  const btn = $('#save');
  btn.hidden = !savable;
  if (!savable) return;
  const saved = isSaved(savable);
  btn.textContent = saved ? '★' : '☆';
  btn.setAttribute('aria-pressed', String(saved));
  btn.title = saved ? 'Remove from saved places' : 'Save this place';
  btn.setAttribute('aria-label', btn.title);
}

function toggleSaved() {
  if (!savable) return;
  if (isSaved(savable)) removeSaved(savable.label);
  else if (!savePlace(savable)) showProgress("Couldn't save: this browser isn't keeping data for this site.", 'error');
  showSaveButton();
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
  // Also when you come back to the page: say if the results have gone out of date.
  if (current && isStale(current) !== current.staleShown) render();
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
