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

London has no single open dataset of parking restrictions, so the app combines several sources. Each result's ⓘ button shows its notes and which source it came from, and each source's results appear as soon as they load.

| Source | Covers | Notes |
| --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org) via the Overpass API | All of London: car parks (fee and opening hours), plus street parking where mappers have tagged it | Street parking coverage is patchy. You can improve it yourself, e.g. with the StreetComplete app. |
| Councils' own zone maps (`src/sources/council-zones.js`) | Every street in a borough: controlled parking zone boundaries with their days, hours and charges, queried live | Hammersmith & Fulham, Sutton and Merton. Inside one of these boroughs but outside every zone, the app says there's no parking zone (it checks the borough with postcodes.io). The council's map can lag behind recent changes, so the zone entry sign has the final word. |
| Councils' street lists (`data/wandsworth.json`, `data/kingston.json`) | Every street in a parking zone, drawn on the map along OpenStreetMap's streets | **Wandsworth**: each street's zone, house numbers, hours, charge and maximum stay, from the council's CPZ street finder. **Kingston**, including New Malden: the streets in each zone and permit parking area, from the council's zone pages, with hours from its list of when the rules apply. A street that isn't on the list has no parking zone. |
| Councils' kerbside maps (`src/sources/kerbside.js`) | Yellow lines, bus stops, school markings and bays, with their times | Sutton so far. |
| [Camden Council "Parking Bays"](https://opendata.camden.gov.uk/Transport/Parking-Bays/7hiv-3r9k) | Every on-street bay in Camden, with type, times, max stay and tariff | Loaded only when you search in or near Camden. |

As you type, suggestions come from [Photon](https://photon.komoot.io) (built for search-as-you-type, limited to London) and, for postcodes, [postcodes.io](https://postcodes.io). Pressing Find without picking a suggestion looks the text up with postcodes.io or OpenStreetMap's Nominatim.

OpenStreetMap's Overpass servers can be slow when busy. If the main server hasn't answered within 6 seconds, the same request also goes to a mirror, and whichever answers first is used. Answers are kept in the browser for a week, so a repeat search of the same place doesn't wait for them.

Recent destinations (the last six) are kept in the browser too, and shown when you tap the empty search box.

If the suggestions don't have your place, long-press the map (right-click on a computer) to drop a pin, then tap **Find parking here**. After a search you can also drag the destination pin to fine-tune it, and the search runs again from where you drop it.

The location button on the map follows you live: the blue dot moves (with an arrow for your direction while moving) and the map stays centred on it. Drag the map to look around, and tap the button to centre again; tap it once more to stop. The screen stays on while following. Like any website, it only gets your location while the page is open on screen.

### Checking a place against the live data

```sh
node scripts/probe.mjs "Stamford Court, London"    # or a postcode, or 51.4957,-0.2437
```

It prints the geocoder's matches, how much street-parking detail OpenStreetMap has nearby, the council zones, and the same results list the app shows. You can run it without a computer too: Actions → **Probe live data** → Run workflow.

### Councils' street lists

Wandsworth's and Kingston's websites can't be read from a browser, so `scripts/update-wandsworth.mjs` and `scripts/update-kingston.mjs` copy their lists into `data/`. The deploy workflow runs them before every deploy and every Monday morning, so the site stays current without commits. If a council's site is down, the copy in the repo is published instead. To refresh the copy in the repo, run the scripts on your computer and commit the result.

Kingston writes its zone hours as prose, so they're kept in `ZONES` in `scripts/update-kingston.mjs`. When the council adds a zone, the script warns and the app shows its streets as "hours on the signs" until the hours are added there.

## How it decides

- Times like `Mon-Fri 8.30am-6.30pm`, `Mo-Sa 08:00-18:30; Su off`, `Sun & Bank Holidays 2pm-6pm` or `At any time` are parsed into a weekly timetable (`src/schedule.js`). Text it can't read reliably, such as "event days", is shown as **Check** rather than guessed.
- All times are London time, including clock changes. Bank holidays are flagged, because some zones stop on bank holidays and some don't.
- Bays and single yellow lines in a CPZ only apply during the hours shown. Outside them they're free, unless a sign says otherwise.
- A street in several zones (Wimbledon Park Road is in A6, S1 and S5, depending on house number) gets one line per zone. The card says **Part free** when only some zones are free.

### Adding another borough's zone map

Many councils publish their zone boundaries on an ArcGIS or WFS map service (search data.gov.uk for "controlled parking zones"). If the layer has days and hours, add an entry to `ZONE_LAYERS` in `src/sources/council-zones.js`: a rough `bbox`, the council's name as postcodes.io gives it (`district`), a `url` built with `arcgisQuery` or `wfsQuery`, and a `read` function that returns the zone, hours and cost. Kerbside layers go in `KERB_LAYERS` in `src/sources/kerbside.js` the same way. The service must allow browser requests (CORS); the probe workflow is a quick way to check a layer from GitHub's servers.

## Not covered yet

- Temporary suspensions, event days (football, the Wimbledon Championships) and TfL red routes. The Wimbledon tennis event zone is mentioned in the notes but not applied, and Wandsworth's red-route streets are flagged but not modelled.
- Kingston lists zones G and G1 together, so those streets show both sets of hours. Some of its zones have outer streets with shorter hours that the council doesn't list by street: the app uses the main hours, and says so in the notes.
- The Department for Transport's [Digital TRO service](https://d-tro.dft.gov.uk/) should eventually publish every council's traffic orders through one API. It's in public beta, free to register for as a data user, and would be the natural next data source.
