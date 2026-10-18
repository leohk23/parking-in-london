# parking-in-london

**Park Nearby** is a small personal web app. Tell it where you're going in London, when you'll arrive and how long you're staying. It shows nearby parking on a map and in a list, coloured by whether it's free for your whole stay:

- **Free** (green): free now, with the time it stops being free, e.g. "Free until Mon 09:30, then pay or permit".
- **Paid** (amber): pay to park, or a controlled zone where you need to pay or have a permit.
- **No** (red): permit holders only, no parking, Blue Badge, car club, loading and so on.
- **Check** (grey): there's parking here but the terms aren't in the data.

> Always check the signs on the street. They override anything this app shows.

## Run it

It's a static site with no build step and no dependencies.

```sh
npm start                    # serves on http://localhost:8080
# or: python3 -m http.server 8080
```

```sh
npm test                     # unit tests (Node 20+)
```

## Put it on your phone (GitHub Pages)

`.github/workflows/pages.yml` runs the tests on every pull request. On every push to `main` it also publishes the site to GitHub Pages, at `https://<user>.github.io/parking-in-london/`. To switch it on:

1. GitHub Pages needs a **public repo**, unless your account is on GitHub Pro. To make it public: Settings → General → Danger Zone → Change visibility. Nothing in the repo is secret: there are no API keys.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Push to `main`, or run the workflow from the Actions tab. The site URL appears on the workflow run.
4. On your phone, open the URL and choose **Add to Home Screen**. It opens full-screen with its own icon.

Searches go in the URL (`?q=Wimbledon+Park+Road&stay=120`), so you can bookmark the places you go often.

## Where the data comes from

London has no single open dataset of parking restrictions, so the app combines four sources. Each result shows which source it came from, and each appears as soon as it loads.

| Source | Covers | Notes |
| --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org) via the Overpass API | All of London: car parks (fee and opening hours), plus street parking where mappers have tagged it | Street parking coverage is patchy. You can improve it yourself, e.g. with the StreetComplete app. |
| Councils' own zone maps (`src/sources/council-zones.js`) | Every street in a borough: controlled parking zone boundaries with their days, hours and charges, queried live | Hammersmith & Fulham so far. The council's map can lag behind recent hour changes, so the zone entry sign has the final word. |
| [Camden Council "Parking Bays"](https://opendata.camden.gov.uk/Transport/Parking-Bays/7hiv-3r9k) | Every on-street bay in Camden, with type, times, max stay and tariff | Loaded only when you search in or near Camden. |
| `data/zones.js` | Controlled parking zone (CPZ) hours for streets you add by hand, taken from council websites | Seeded with Wandsworth's Southfields and Putney A6 zones and Wimbledon Park Road. |

Postcodes are looked up with [postcodes.io](https://postcodes.io); other places with OpenStreetMap's Nominatim.

OpenStreetMap's Overpass servers can be slow when busy. If the main server hasn't answered within 6 seconds, the same request also goes to a mirror, and whichever answers first is used.

### Checking a place against the live data

```sh
node scripts/probe.mjs "Stamford Court, London"    # or a postcode, or 51.4957,-0.2437
```

It prints the geocoder's matches, how much street-parking detail OpenStreetMap has nearby, the council zones, and the same results list the app shows. You can run it without a computer too: Actions → **Probe live data** → Run workflow.

### Adding your streets

For a borough that doesn't publish bay data, look up the street's zone on the council website and add it to `data/zones.js`:

1. Add the borough to `BOROUGHS` if it's new. Its `bbox` only needs to be roughly right; it stops a common street name matching in another borough.
2. Add any missing zones to `ZONES`, with the hours as the sign shows them (e.g. `'Mon-Fri 8.30am-6.30pm'`), the source page and the date you checked.
3. Add the street to `STREETS` with its zone IDs.

The street is then drawn on the map from OpenStreetMap geometry, using the zone hours.

## How it decides

- Times like `Mon-Fri 8.30am-6.30pm`, `Mo-Sa 08:00-18:30; Su off` or `At any time` are parsed into a weekly timetable (`src/schedule.js`). Text it can't read reliably, such as "event days", is shown as **Check** rather than guessed.
- All times are London time, including clock changes. Bank holidays are flagged, because some zones stop on bank holidays and some don't.
- Bays and single yellow lines in a CPZ only apply during the hours shown. Outside them they're free, unless a sign says otherwise.
- A street in several zones (Wimbledon Park Road is in A6, S1 and S5, depending on house number) gets one line per zone. The card says **Part free** when only some zones are free.

### Adding another borough's zone map

Many councils publish their zone boundaries on an ArcGIS map service (search data.gov.uk for "controlled parking zones"). If the layer has fields for days and hours, add an entry to `ZONE_LAYERS` in `src/sources/council-zones.js` with its URL, a rough `bbox` and functions that read the zone name, hours and cost.

## Not covered yet

- Temporary suspensions, event days (football, the Wimbledon Championships) and TfL red routes. The Wimbledon tennis event zone is mentioned in the notes but not applied.
- The Department for Transport's [Digital TRO service](https://d-tro.dft.gov.uk/) should eventually publish every council's traffic orders through one API. It's in public beta, free to register for as a data user, and would be the natural next data source.
