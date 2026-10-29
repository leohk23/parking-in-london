// What the app knows about each of London's 33 areas, and the few places
// outside London it covers, for the "About the data" box behind the map's ⓘ
// button. Keep it in step with the sources: council-zones.js, kerbside.js,
// street-lists.js, camden.js, bromley.js, perth-kinross.js and
// scripts/build-kerb-tiles.mjs.

// How each kind of data is kept up to date.
const LIVE = 'Live from the council when you search';
const COPIED = 'Copied at each update and every Monday';
const MONTHLY = 'Copied monthly';

/** [borough, kinds of data, where from, how it's kept up to date]; no kinds where nothing is covered yet. */
export const COVERAGE = [
  ['Barking & Dagenham', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Barnet', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Bexley', ['kerb', 'zones'], "TraffWeb, with hours from the council's permits page", COPIED],
  ['Brent', ['zones'], "The council's zone map, with hours from its zone table", COPIED],
  ['Bromley', ['lookup'], "The council's zone lookup, for the spot you search: it publishes no zone map", LIVE],
  ['Camden', ['bays', 'kerb'], 'Bays from Camden open data, with tariffs (live); lines from TraffWeb', COPIED],
  ['City of London', ['zones', 'kerb'], "The City's map of lines and bays", LIVE],
  ['Croydon', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Ealing', ['streets'], "The council's 61 zone pages", COPIED],
  ['Enfield', ['kerb', 'zones'], 'TraffWeb traffic orders', COPIED],
  ['Greenwich', ['kerb', 'zones'], "TraffWeb; zones from the council's map, hours from its zone directory", COPIED],
  ['Hackney', ['zones', 'kerb'], "Zones from the council's map (live); lines and bays from TraffWeb", COPIED],
  ['Hammersmith & Fulham', ['zones', 'kerb'], "Zones from the council's map (live); lines and bays from TraffWeb", COPIED],
  ['Haringey', ['zones'], "The council's zone map", COPIED],
  ['Harrow', ['kerb', 'zones'], "The council's map of lines, bays and zones", COPIED],
  ['Havering', ['kerb'], "The council's traffic order map (StatMap)", COPIED],
  ['Hillingdon', ['zones'], "The council's 2013 map of its parking schemes, which may miss newer ones", LIVE],
  ['Hounslow', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Islington', ['zones'], "The council's zone map", COPIED],
  ['Kensington & Chelsea', ['zones', 'kerb'], "Zones and residents' bay hours from the council's map (live); lines and bays from TraffWeb", COPIED],
  ['Kingston', ['streets'], "The council's zone pages and on-street charges", COPIED],
  ['Lambeth', ['zones'], "The council's zone map", LIVE],
  ['Lewisham', ['kerb', 'zones'], "TraffWeb; zones from the council's map", COPIED],
  ['Merton', ['zones'], "The council's zone map", LIVE],
  ['Newham', ['zones'], "The council's zone map, which may miss newer zones", LIVE],
  ['Redbridge', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Richmond', ['streets'], "The council's address lookup, at both ends of every street", MONTHLY],
  ['Southwark', ['kerb', 'zones'], "The council's map of lines, bays and zones", COPIED],
  ['Sutton', ['zones', 'kerb'], "The council's map of zones, lines and bays", LIVE],
  ['Tower Hamlets', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Waltham Forest', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Wandsworth', ['streets'], "The council's zone street finder", COPIED],
  ['Westminster', ['kerb'], 'TraffWeb traffic orders', COPIED],
];

/** Places outside London the app covers (areas.js), the same way. */
export const EXTRA_COVERAGE = [
  ['Pitlochry', ['carparks'], "Perth & Kinross Council's car parks, with charging hours from RingGo; a note on the town's 30-minute street parking", LIVE],
];

export const KINDS = {
  kerb: ['Lines and bays', 'Every yellow line, bay and crossing, with its times'],
  zones: ['Zones', 'Parking zone outlines and their hours'],
  streets: ['Street list', "Each street's zone and hours, drawn along the street"],
  bays: ['Bays', 'Every bay, with its times and tariff'],
  lookup: ['Zone lookup', 'The zone and its hours at the spot you search, without an outline'],
  carparks: ['Car parks', "The council's car parks, with their charging hours"],
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The box's HTML. `updated` and `osmUpdated` are when the copied council data
 * and OpenStreetMap tiles were last refreshed; `search` is the last search's
 * { checkedAt, isNow, timing }; each shown when known.
 */
export function coverageHtml({ updated, osmUpdated, search } = {}) {
  const covered = COVERAGE.filter(([, kinds]) => kinds.length).length;
  const row = ([name, kinds, from, how]) => {
    const chips = kinds.map((k) => `<span class="chip-kind ${k}">${KINDS[k][0]}</span>`).join('');
    return `<li class="${kinds.length ? '' : 'none'}">
      <div class="cov-head"><strong>${esc(name)}</strong>${chips || '<span class="chip-kind none">Not yet</span>'}</div>
      <div class="cov-src">${esc(from)}${how ? ` · ${esc(how)}` : ''}</div>
    </li>`;
  };
  const rows = COVERAGE.map(row).join('');
  const thisSearch = search
    ? `<div class="cov-search"><strong>This search</strong> was checked at ${esc(search.checkedAt)}${search.isNow ? ', for parking then' : ''}.${
        search.timing ? `<br /><span class="cov-timing">${esc(search.timing)}</span>` : ''
      }</div>`
    : '';
  const dates = [updated && `council copies ${esc(updated)}`, osmUpdated && `OpenStreetMap ${esc(osmUpdated)}`].filter(Boolean);
  return `
    <h2 id="info-title">About the data</h2>
    <p class="info-sub">Council parking data for ${covered} of London's ${COVERAGE.length} areas.</p>
    ${thisSearch}
    ${dates.length ? `<p class="cov-dates">Data last refreshed: ${dates.join(' · ')}.</p>` : ''}
    <ul class="cov-kinds">${Object.entries(KINDS)
      .map(([kind, [label, what]]) => `<li><span class="chip-kind ${kind}">${label}</span> ${esc(what)}</li>`)
      .join('')}</ul>
    <p class="cov-note">Everywhere: car parks and street parking mapped on OpenStreetMap, refreshed weekly.
      Where a council's server doesn't allow browsers, its data is copied onto this site.</p>
    <ul class="cov-list">${rows}</ul>
    <h3 class="cov-extra">Outside London</h3>
    <ul class="cov-list">${EXTRA_COVERAGE.map(row).join('')}</ul>
    <p class="info-src">Always check the signs on the street: they override anything shown here.</p>`;
}
