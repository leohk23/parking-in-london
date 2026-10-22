// What the app knows about each of London's 33 areas, for the "About the data"
// box behind the map's ⓘ button. Keep it in step with the sources: council-zones.js,
// kerbside.js, street-lists.js, camden.js and scripts/build-kerb-tiles.mjs.

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
  ['Bromley', [], 'Nothing usable published yet'],
  ['Camden', ['bays', 'kerb'], 'Bays from Camden open data, with tariffs (live); lines from TraffWeb', COPIED],
  ['City of London', [], 'Only car parks published'],
  ['Croydon', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Ealing', ['streets'], "The council's 61 zone pages", COPIED],
  ['Enfield', ['kerb', 'zones'], 'TraffWeb traffic orders', COPIED],
  ['Greenwich', ['kerb', 'zones'], "TraffWeb; zones from the council's map, hours from its zone directory", COPIED],
  ['Hackney', ['zones', 'kerb'], "Zones from the council's map (live); lines and bays from TraffWeb", COPIED],
  ['Hammersmith & Fulham', ['zones', 'kerb'], "Zones from the council's map (live); lines and bays from TraffWeb", COPIED],
  ['Haringey', ['zones'], "The council's zone map", COPIED],
  ['Harrow', ['kerb', 'zones'], "The council's map of lines, bays and zones", COPIED],
  ['Havering', [], 'Nothing usable published yet'],
  ['Hillingdon', [], 'Nothing usable published yet'],
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
  ['Southwark', [], 'Nothing usable published yet'],
  ['Sutton', ['zones', 'kerb'], "The council's map of zones, lines and bays", LIVE],
  ['Tower Hamlets', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Waltham Forest', ['kerb'], 'TraffWeb traffic orders', COPIED],
  ['Wandsworth', ['streets'], "The council's zone street finder", COPIED],
  ['Westminster', ['kerb'], 'TraffWeb traffic orders', COPIED],
];

export const KINDS = {
  kerb: ['Lines and bays', 'Every yellow line, bay and crossing, with its times'],
  zones: ['Zones', 'Parking zone outlines and their hours'],
  streets: ['Street list', "Each street's zone and hours, drawn along the street"],
  bays: ['Bays', 'Every bay, with its times and tariff'],
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The box's HTML; `updated` is when the copied kerbside data was last refreshed, if known. */
export function coverageHtml({ updated } = {}) {
  const covered = COVERAGE.filter(([, kinds]) => kinds.length).length;
  const rows = COVERAGE.map(([name, kinds, from, how]) => {
    const chips = kinds.map((k) => `<span class="chip-kind ${k}">${KINDS[k][0]}</span>`).join('');
    return `<li class="${kinds.length ? '' : 'none'}">
      <div class="cov-head"><strong>${esc(name)}</strong>${chips || '<span class="chip-kind none">Not yet</span>'}</div>
      <div class="cov-src">${esc(from)}${how ? ` · ${esc(how)}` : ''}</div>
    </li>`;
  }).join('');
  return `
    <h2 id="info-title">About the data</h2>
    <p class="info-sub">Council parking data for ${covered} of London's ${COVERAGE.length} areas.</p>
    <ul class="cov-kinds">${Object.entries(KINDS)
      .map(([kind, [label, what]]) => `<li><span class="chip-kind ${kind}">${label}</span> ${esc(what)}</li>`)
      .join('')}</ul>
    <p class="cov-note">Everywhere: car parks and street parking mapped on OpenStreetMap, refreshed weekly.
      Where a council's server doesn't allow browsers, its data is copied onto this site${updated ? `; last copied ${esc(updated)}` : ''}.</p>
    <ul class="cov-list">${rows}</ul>
    <p class="info-src">Always check the signs on the street: they override anything shown here.</p>`;
}
