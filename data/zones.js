// Hand-maintained controlled parking zone (CPZ) hours for boroughs that don't
// publish bay-level open data. Each entry cites the council page it came from
// and when it was checked; re-check when the council reviews a zone.
//
// Zone hours cover the zone's bays and its single yellow lines. Outside them
// those are free unless a sign on the street says otherwise.
//
// To add a street: find its zone(s) with the council's zone finder, add any
// missing zones to ZONES, then add the street to STREETS.

export const BOROUGHS = {
  wandsworth: {
    name: 'Wandsworth',
    // Generous outline, used only to stop a street name matching in another borough.
    bbox: [51.41, -0.27, 51.49, -0.11],
    finder: 'https://www.wandsworth.gov.uk/parking/parking-zones/find-parking-zones/',
  },
};

const SOUTHFIELDS_PAGE = 'https://www.wandsworth.gov.uk/parking/parking-zones/southfields-parking-zones/';
const PUTNEY_PAGE = 'https://www.wandsworth.gov.uk/putney-parking-zones';
const WIMBLEDON_EVENT_ZONE =
  'During the Wimbledon Championships (late June to mid July) Southfields becomes an event zone controlled 8.30am-8.30pm every day.';

// `effect` is what applies during zone hours: 'controlled' (pay or permit,
// depending on the bay) unless the zone is permit holders only.
export const ZONES = [
  {
    borough: 'wandsworth',
    id: 'A6',
    area: 'Putney',
    hours: 'Mon-Fri 9.30am-4.30pm',
    maxStay: '4 hours',
    notes: ['Some A6 streets are instead controlled 2pm-3pm Mon-Fri, permit holders only.'],
    source: PUTNEY_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S1',
    area: 'Southfields',
    hours: 'Mon-Fri 9.30am-4.30pm',
    maxStay: '4 hours',
    notes: [WIMBLEDON_EVENT_ZONE],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S2',
    area: 'Southfields',
    hours: 'Mon-Fri 1.30pm-2.30pm',
    notes: ['The council consulted in early 2026 on longer S2 hours; check the signs.', WIMBLEDON_EVENT_ZONE],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S2-Replingham',
    name: 'S2 (Replingham Road)',
    area: 'Southfields',
    hours: 'Mon-Fri 9.30am-4.30pm',
    maxStay: '4 hours',
    notes: [WIMBLEDON_EVENT_ZONE],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S3',
    area: 'Southfields',
    hours: 'Mon-Fri 1.30pm-2.30pm',
    notes: [WIMBLEDON_EVENT_ZONE],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S4',
    area: 'Southfields',
    hours: 'Mon-Fri 1.30pm-2.30pm',
    effect: 'permit',
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    id: 'S5',
    area: 'Southfields',
    hours: 'Mon-Fri 2pm-3pm',
    notes: [WIMBLEDON_EVENT_ZONE],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
];

export const STREETS = [
  {
    borough: 'wandsworth',
    name: 'Wimbledon Park Road',
    zones: ['A6', 'S1', 'S5'],
    notes: [
      'The zone depends on the house number: check the zone sign as you enter, or the council zone finder.',
      'Some bays here are suspended during the Wimbledon Championships.',
    ],
    source: 'https://www.wandsworth.gov.uk/parking/parking-zones/cpz-street-finder-staff-version/?streetletter=W',
    checked: '2026-10-18',
  },
  {
    borough: 'wandsworth',
    name: 'Replingham Road',
    zones: ['S2-Replingham'],
    source: SOUTHFIELDS_PAGE,
    checked: '2026-10-18',
  },
];
