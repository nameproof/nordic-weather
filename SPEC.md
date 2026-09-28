# Nordic Weather for Omarchy: spec

Status: v0.1. Layout is expected to change as it gets used.

A pure QML/JS Omarchy 4 shell bar widget that replaces the built-in
`omarchy.weather`. Forecasts come only from MET Norway (api.met.no, the data
behind yr.no). Open-Meteo is used only to search for places.

## Goals

- Drop-in replacement for `omarchy.weather`. Enabling it takes the built-in's
  bar slot. Disabling or removing it restores the built-in.
- Content: current conditions, a 3-day forecast in 3-hour steps, radar-based
  "precipitation soon", uncertainty ranges, a 10-day overview, sun and moon.
- Finds a location the same way as the built-in: click the place name, search,
  pick a result.
- In the system's language when it is Swedish, Norwegian, Danish or
  Finnish, English otherwise.
- Follows MET's terms of service: User-Agent, caching, no synchronized
  requests, attribution.

## Non-goals (v1)

- Other weather providers, IP-based auto location, imperial units.
- Weather warnings. MetAlerts covers Norway only; the other Nordic
  countries each have their own service.

## Naming

MET's terms forbid "Yr" in the service name.

- Name: "Nordic Weather"
- id: `io.github.nameproof.nordic-weather`
- User-Agent: `io.github.nameproof.nordic-weather/<version> github.com/nameproof`

## Files

```
manifest.json    kinds: service + bar-widget
Service.qml      the one data source: location, cache, fetching, timers, view
                 model, search, notification, radar data and animation, IPC
BarWidget.qml    bar pill (one per monitor); loads its Panel only while open
Panel.qml        popout UI (one per monitor while open); reports what it shows
                 back to the service (open, radar open, map size)
Model.js         pure functions (.pragma library: one shared copy)
RadarImages.qml  rotating image providers and staging for loop replacements
shaders/         radar and base-map shaders (+ compiled .qsb)
map/             base-map tiles and place names (scripts/build-basemap.py)
scripts/         dev-install, build-shaders, lint, build-basemap.py
tests/           node tests for Model.js, Qt tests (images, service, shader
                 pixels), saved API fixtures
README.md, LICENSE
```

**Why a service.** Omarchy creates a bar widget per monitor. Quickshell's guide
puts processes and timers in one shared place and keeps per-screen
components presentational ("when the window is created multiple times, we
also make a new Process and Timer"); in an Omarchy plugin that place is the
host-managed service (a `pragma Singleton` would outlive disabling the
plugin). Widgets reach it with `bar.shell.serviceFor(id)`. IPC lives only in
the service and opens panels through the shell's `summon`/`toggle`, which
pick the focused monitor's widget; `radar`/`edit` are handed to the panel
that opens (`takePendingAction`).

`Model.js` has no QML dependencies. It ends with a `module.exports` block
(the same trick the built-in uses), so `node --test tests/` runs it directly
(tests/load-model.js strips its `.pragma library` line).

## Manifest

`manifest.json` declares the service and the bar widget, the three
settings below, and `omarchy.clonedFrom: "omarchy.weather"`. Its `version`
is also in `Model.js` (`VERSION`, sent in the User-Agent); a test checks
the two and the id match.

`omarchy.clonedFrom` is what makes the shell swap our plugin into the
built-in's slot, route `omarchy.weather` IPC calls to us, and restore the
built-in on disable or removal (see `PluginRegistry.qml`). The upstream publish
guide says to drop that field, but only for clones that become independent
widgets. Here, replacing the built-in is the point.

Settings use only `integer` fields (the only type seen in use; `longRangeDays: 0`
hides the overview instead of a boolean). Nothing in `$OMARCHY_PATH`
renders the `schema` field, and the built-in's `settingsForm: "weatherSettings"`
isn't referenced anywhere either. The settings are read via
`setting(key, default)` against the widget's `shell.json` entry, so editing
`shell.json` by hand always works.

## Data sources and request policy

All requests use `curl -sS --compressed --max-time 10 -A "$UA"`. The response
headers and body are captured so `Expires` and `Last-Modified` can be read.

| What | Endpoint | When |
|---|---|---|
| Forecast | `api.met.no/weatherapi/locationforecast/2.0/complete?lat&lon&altitude` | When cached `Expires` has passed (≈30 min), plus 0–120 s random jitter. Always sends `If-Modified-Since`. A 304 just refreshes `Expires`. |
| Nowcast | `api.met.no/weatherapi/nowcast/2.0/complete?lat&lon` | Every 15 min in the background (keeps the bar's temperature fresh), and as often as `Expires` allows (≈5 min) while the panel is open. A 422 (outside the Nordic radar area) is remembered for a day. |
| Sun | `api.met.no/weatherapi/sunrise/3.0/sun?lat&lon&date&offset` | Once per local date |
| Moon | `api.met.no/weatherapi/sunrise/3.0/moon?lat&lon&date&offset` | Once per local date (gives `moonphase` in degrees) |
| yr.no radar indexes | `tiles.yr.no/api/precipitation-observations/available.json`, `…/precipitation-nowcast/available.json` | Only while the radar side panel is open; at most every 2 min. Undocumented yr.no backend. |
| yr.no radar tiles | from the indexes (z5–6; z7 view uses z6 scaled) | Per new frame and zoom, 12 at a time over one HTTP/2 connection, only missing files, pruned after 2 h. A batch counts as done only when all its tiles are on disk; otherwise it is retried after 5 s, doubling up to 60 s. |
| yr.no lightning | `www.yr.no/api/v0/lightning-events?fromHours=2` | Only while the radar side panel is open; at most every minute (yr.no caches it for 30 s). Kept in memory, not in the cache file. Undocumented yr.no backend. |
| Base map | none: `map/tiles/{z}/{x}/{y}.png` and `map/places.json` ship with the plugin | Built from OpenStreetMap by `scripts/build-basemap.py`. |
| Radar frames | none: assembled locally | Once a view's radar tiles are downloaded, ImageMagick (in Omarchy's base packages) assembles each frame into one map-sized PNG (`f_*.png`, pruned after 2 h). A frame with a tile missing is never written; the loop is only swapped in when every frame exists. Playback then decodes one image per frame instead of 20–25 tiles (≈3× less CPU). |
| Place search | `geocoding-api.open-meteo.com/v1/search?name&count=6&language=<lang>` | Typing in the search field, debounced 300 ms, one request in flight |

Rules:

- **Coordinates:** round to 4 decimals before building URLs.
- **Altitude:** from the saved location's elevation when we have it. Open-Meteo
  returns `elevation`. Otherwise leave it out, and MET uses its own terrain
  model.
- **`offset`:** computed from the local zone *for that date*. Never
  hard-coded, so daylight saving time is right.
- **Status codes:**
  - 429: pause that service's requests (MET's API or yr.no) for 10 min.
  - 403: log the URL.
  - 203: log a deprecation warning.
  - 422 from the nowcast: outside the Nordic radar area; remembered for a
    day.
- **Failures:** keep the last good data. A failed request is retried after
  15 s, doubling up to 15 min. The forecast counts as stale an hour past
  its `Expires` (see the bar pill).
- **Cache:** one file, `~/.cache/io.github.nameproof.nordic-weather/cache.json`,
  shared by every monitor's widget: per request kind, the response body with
  its URL, `Last-Modified`, `Expires` and fetch time; plus `elevations` (from
  place search, by coordinates) and `prefs` (the map zoom). On shell start
  the panel renders from it at once, then refreshes what has expired.
  Lightning is kept in memory only. Radar tiles and assembled frames live
  in `tiles/` next to it.
- **Location change:** responses are cached by URL, so a new place simply
  fetches its own; nothing of the old place is shown.

## Location

- **Source of truth:** `~/.local/state/omarchy/settings/weather.json`
  (`{name, latitude, longitude}`, owned by `omarchy-weather-location`). A
  `FileView` watches it, so hand edits and edits from the built-in apply
  immediately.
- **Saving:** `omarchy-weather-location --set "<name>" <lat>,<lon>`. Clearing
  runs `omarchy-weather-location --clear`.
- **Elevation:** `omarchy-weather-location` only stores
  name/latitude/longitude, so we keep the elevation from the last search in
  our cache dir, keyed by lat,lon.
- **No location set:** the pill shows a location icon, and the panel says
  "Choose a place to see the weather" / "Välj en plats för att se vädret"
  with a button that opens the search.

### Search UI (same behavior as the built-in)

1. Click the place name in the hero, or press Enter while the panel is
   focused, or call the `edit` IPC. The name is replaced by an empty text
   field. While it is empty the list shows the favourites (below), with
   the first one that isn't the current place selected.
2. Suggestions start 300 ms after the last keystroke. Each row shows the name
   in bold, with `admin1, country` dimmed after it.
3. ↑/↓ moves the selection, Enter picks the selected row (the first row by
   default), Esc cancels.
4. While the picked place's forecast is loading, a spinner shows next to
   the field, which stays open.
5. If the search returns nothing, show a "No places found" / "Inga platser
   hittades" row.

### Favourites

- **Adding and removing:** a star at the end of each search result: ☆ adds
  that place, ★ (accent) removes it, without switching to it. At most 8
  (`FAVORITES_MAX`); with a full list the ☆ is dimmed and does nothing.
- **Picking:** with the search field empty, the list shows the favourites
  (★ before each name, `admin1, country` after it). The current place is
  dimmed; picking it just closes the search. ↑/↓ and Enter work as for
  search results; Delete, or the ✕ that appears on hover, removes one.
- **From a keybind:** `omarchy-shell omarchy.weather favorite next` (or
  `previous`) switches to the next favourite, wrapping; from a place that
  isn't a favourite, to the first one.
- **Storage:** `~/.local/state/omarchy/settings/nordic-weather-favorites.json`,
  this plugin's own (the built-in has no favourites): a list of
  `{ name, description, latitude, longitude, elevation }` in the order
  added, the same shape as a search result, so switching needs no search.
  A place is identified by its coordinates (rounded to 4 decimals). The
  file is watched, so hand edits apply at once.

## Language

Swedish (`sv`), Norwegian Bokmål (`nb`), Danish (`da`), Finnish (`fi`) and
English (`en`).

- **Picking the language:** the first `STRINGS` entry whose `locales`
  prefixes match `Qt.locale().name` (`sv_SE.UTF-8` → `sv`, also `sv_FI`;
  `nb`, `nn` and `no` → `nb`; `da` → `da`; `fi` → `fi`); anything else
  gives `en`. It is read when the shell starts.
- **One place per language:** everything language-specific lives in its
  `STRINGS` entry in `Model.js`, not in code:
  - the UI strings, weekday and month names, compass points, moon phases;
  - `decimal`: decimal separator (`0,4 mm`; `0.4 mm` in en);
  - `dayDate`: a date in day titles (`{day}`, `{month}` or `{monthNumber}`);
  - `hour`: the hour unit in short texts (`−1 h`, `/6h`; `t` in nb and da);
  - `geocode`: the place-search language (`no` for nb, which gives
    Norwegian place names where `nb` doesn't);
  - `precip`: the grammar for precipitation descriptions (below).

  Adding a language is one more entry, plus a `name_<lang>` column in
  `map/places.json` (`LABEL_NAMES` in `scripts/build-basemap.py`, then
  `--places`); without one the map labels use the English names. A test
  checks that every entry has every key English has, with lists of the
  same length.
- **Dates:**
  - sv: "Idag 26 sep", "Imorgon 27 sep", "Måndag 28 sep"
  - nb: "I dag 26. sep", "I morgen 27. sep", "Mandag 28. sep"
  - da: "I dag 26. sep", "I morgen 27. sep", "Mandag 28. sep"
  - fi: "Tänään 26.9.", "Huomenna 27.9.", "Maanantai 28.9."
  - en: "Today Sep 26", "Tomorrow Sep 27", "Monday Sep 28"
- **Numbers:** temperatures are whole degrees.
- **Units:** °C, m/s, mm, %. Wind stays in m/s for English too, which matches
  yr.no.
- **Map labels:** a place name in Latin script is shown as it is (Göteborg,
  not Gothenburg); others use the language's own name from OpenStreetMap
  (`name:sv`; `name:nb` or `name:no`; `name:da`; `name:fi`), then English
  (`Санкт-Петербург` → Sankt Petersburg / Sankt Petersborg / Pietari /
  Saint Petersburg).

### Weather descriptions

MET symbol codes are `<base>[_day|_night|_polartwilight]`.

- **Without precipitation** (clear sky, fair, partly cloudy, cloudy, fog):
  one word per language in `symbols`, following yr.no's wording in
  Norwegian ("Klarvær", "Lettskyet", "Delvis skyet", "Skyet", "Tåke").
- **With precipitation** (the other ~36 codes): built from the code's
  parts (`light|heavy`, `rain|sleet|snow`, `showers`, `andthunder`) with
  the language's `precip` grammar: nouns per kind as [plain, showers], the
  light/heavy words in the matching form, and a thunder suffix. So
  `lightrainshowers` is "Lätta regnskurar" / "Lette regnbyger" / "Lette
  regnbyger" (da) / "Heikkoja sadekuuroja" / "Light rain showers". Finnish
  uses the partitive throughout ("Heikkoa vesisadetta"), and nominative
  kinds in the nowcast line ("Vesisade alkaa noin 20 min kuluttua").
- **API typos:** MET really does send the misspelled
  `lightssleetshowersandthunder` and `lightssnowshowersandthunder`. Map both
  to the same entry as the correctly spelled code, and cover them in a test.
- **Unknown codes:** fall back to the text before `_`.

## Icons

We use the Nerd Font weather set (U+E300–E3FF), the same as the built-in. It's
monochrome, so it picks up the theme's foreground color.

- **Day or night:** comes from the symbol code's suffix, so no sunrise lookup
  is needed. `_polartwilight` counts as day.
- **Moon:** clear and fair nights use a crescent: near full or new moon the
  phase glyphs are a plain disc or ring, which reads as a glitch in the
  bar. The footer shows the phase glyph (28 steps) next to its name.
- **Mapping:** base code → glyph, covering clear, fair, partly cloudy, cloudy,
  fog, and rain, sleet and snow (each plain or showers), plus thunder variants.
  Light and heavy intensity share a glyph; the text carries the intensity.

## View model

`Model.buildView({ forecast, nowcast, sun, moon, location, lang, nowMs,
settings })` returns a single object. QML only binds to it and never touches
raw API JSON. List entries carry a `key` (their content) for the panel's
`ScriptModel`s.

```js
{
  lang: "sv",
  ready: true,
  location: { name: "Alingsås", set: true },
  updatedAt: "14:30",            // MET meta.updated_at, local time
  bar: { icon: "", text: " 16°" },   // no hover tooltip: the panel is the detail view
  current: {
    icon: "", description: "Klart",
    temp: 16, feelsLike: 16,
    wind: { speed: 5, gust: 13, dirDeg: 259, dirLabel: "V", arrow: "→" },
    humidity: 57,
    pressure: { value: 1016, change: -1.4, arrow: "↘", changeText: "−1,4 på 3 h" }   // or null
  },
  nowcast: {                      // null without radar coverage
    summary: "Uppehåll närmaste 110 min",   // or "Regn om ca 20 min"
    wet: false,
    points: [ { minutes: 5, rate: 0.0, kind: "" }, ... ]   // 5-min steps, for the sparkline
  },
  days: [                         // hourlyDays entries
    { start: <ms>, title: "Idag 26 sep", sixHour: false, precipGlyph: "",
      rows: [ { ms: <ms>, hour: "15", periodHours: 1, icon: "", description: "Klart",
                temp: 16, tempSpread: 1,           // half the p10–p90 span, 0 if under 2°
                precip: { probability: 0, text: "", kind: "" },   // kind: rain/sleet/snow
                wind: { speed: 6, gust: 12, dirDeg: 259, arrow: "→" } } ] }
  ],
  longRange: [                    // one row per day after the hourly ones, up to 10
    { start: <ms>, day: "Tis", icon: "", min: 12, max: 18, precip: "1,2 mm" }
  ],
  longRangeScale: { min: 6, max: 20 },   // shared by the 10-day bars
  sun:  { rise: "07:02", set: "18:57" },
  moon: { icon: "", name: "Fullmåne", illumination: 99, high: "högst 01:08" },
  attribution: "♥ MET Norway"
}
```

### Rules the view model follows

- **"Now":**
  - Temperature, wind and humidity come from the nowcast's first step (the
    only one that has them) while it is at most 30 min old.
  - Otherwise they come from the forecast step closest to now, not
    `timeseries[0]`. The symbol comes from that step's `next_1_hours`, falling
    back to `next_6_hours`.
  - Pressure is `air_pressure_at_sea_level`, interpolated between forecast
    steps to now. Its trend is the forecast change over the next 3 hours
    (MET gives no past values): → under 1 hPa, ↗/↘ from 1 hPa, ↑/↓ from
    3 hPa.
  - The stats sit right of the temperature; the gaps between them shrink
    (24 down to 10) when wide values would otherwise run into it.
- **Hourly rows:**
  - A row is kept when `(local hour % hourStep) == 0` and the step is still in
    the future.
  - Symbol and precipitation come from `next_1_hours` where it exists.
  - The day after tomorrow, and any day where the hourly data runs out
    part-way (≈54–60 h ahead), is all 6-hour rows on MET's 00/06/12/18 UTC
    steps, using `next_6_hours`; their amounts get a "/6h" suffix.
- **Precipitation amount:**
  - 0 shows nothing, under 0.1 shows "<0,1 mm", otherwise one decimal.
  - When min ≠ max, show "0,2–1,4 mm".
- **10-day list:**
  - Rows are grouped by local calendar date.
  - min/max come from the `next_6_hours` `air_temperature_min/max`.
  - The icon is the `next_6_hours` symbol of the step starting at 12:00 local,
    or the one closest to noon.
  - Precipitation is the sum of the non-overlapping `next_6_hours` amounts.
- **Wind direction:** 8-point compass, localized (N, NO/NE, O/E, SO/SE, S,
  SV/SW, V/W, NV/NW). An arrow glyph is rotated by `dirDeg + 180`, since MET
  gives the direction the wind blows from.

## Bar pill

- **Text:** `<icon> <temp>°`, e.g. ` 16°`. Hidden until the first data or
  cache load (the built-in's `visible: label !== ""` rule).
- **Stale data:** the pill uses the bar's dimmed style, and the panel footer
  says how old the forecast is ("Inaktuell · prognos från 14:30"). Otherwise
  the footer shows no update time.
- **Clicks:**
  - Left click opens or closes the panel.
  - Middle click refreshes. `Expires` is ignored, but `If-Modified-Since` is
    still sent.
  - Right click sends a notification: `Alingsås · Klart 16° · Vind 6 m/s V · Regn om 20 min`.

## Panel mockup

Width about 480 px (the built-in uses `Style.space(480)`). It scrolls when it
gets taller than the screen allows.

```
┌──────────────────────────────────────────────────────────────┐
│                                           ⌖ ALINGSÅS          │
│      16°C            KÄNNS   VIND        FUKT   TRYCK         │
│                      16°     6 m/s ↗     55%    1016 hPa ↘    │
│   Klart                      (byar 12)          (−1,4 på 3 h) │
├──────────────────────────────────────────────────────────────┤
│  ☂ Uppehåll närmaste 110 min     ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁   Radar ›   │
├──────────────────────────────────────────────────────────────┤
│  IDAG 26 SEP                                               │
│  15    Klart              16°      0%          6 ↗  (12)     │
│  18    Växlande           14°     10%          4 ↗  ( 9)     │
│  21    Vackert            12°     10%          3 →  ( 7)     │
│  IMORGON 27 SEP                                               │
│  00    Mulet              11°     20%  <0,1 mm  3 →  ( 6)     │
│  03    Lätt regn          10°±2   60%  0,2–1,1  5 ↘  (11)     │
│  …                                                             │
│  MÅNDAG 28 SEP                                                │
│  …                                                             │
├──────────────────────────────────────────────────────────────┤
│  Tis     12° ████████░░ 18°    0 mm                          │
│  Ons     12° ██████████ 21°    0 mm                          │
│  Tor     12° ██████████ 21°    0 mm                          │
│  …                                                             │
├──────────────────────────────────────────────────────────────┤
│  07:02 18:57                  Fullmåne 99%   högst 01:08  │
└──────────────────────────────────────────────────────────────┘
```

The icons over temperature, precipitation chance and wind appear on the
first day only. The precipitation icon is a raindrop, a raindrop and a
snowflake (sleet), or a snowflake: the kind of the day's most likely
precipitation, or with none in any symbol, a snowflake when every row is
at or below 0°. The credits sit under the radar pane while it is open.

While searching, the hero's place name becomes the field, and the suggestions
push the rest of the panel down:

```
│                              [ Göteb█                ]       │
│  ▸ Göteborg          Västra Götalands län, Sverige        ☆   │
│    Göteborgs hamn    Västra Götalands län, Sverige        ☆   │
```

Notes:

- **Hero:** condition icon 56 px, temperature 48 px bold, centred on the
  painted digits.
- **Temperature ranges** (`10°±2`): only shown when the p10–p90 spread is 2°
  or more.
- **10-day bars:** each day's min–max is drawn on a scale shared by all
  10 days.
- **Nowcast row:** hidden when there's no radar coverage. The sparkline sits to
  the right of the text, then the **Radar ›** button.
- **Keyboard** (`PanelKeyCatcher`): Tab / Shift+Tab switch to the
  neighbouring panel; Enter opens the search, Esc closes; ↑/↓ (`k`/`j`)
  scroll; → / `l` opens the radar, ← / `h` closes it; `r` refreshes. With
  the radar open: `+`/`−` zoom, `,`/`.` step a frame (and pause), `p`
  pauses or plays.

## Radar map

The radar side panel shows our base map with yr.no's radar tiles on top.
yr.no's radar only covers the Nordic radar network, ≈0.5–35.5°E,
54.2–72.8°N (`RADAR_COVERAGE` in Model.js, `COVERAGE` in the build script,
kept in sync by a test; measured from the tiles, which are white outside
coverage). Views never leave that box (`Model.mapView`):

| Step | Tiles | px/tile | View |
|---|---|---|---|
| 0 | z5 | fitted | The whole coverage, same for every location |
| 1 (default) | z6 | 181 | ≈1200 km around the location |
| 2 | z6 | 256 | ≈850 km |
| 3 | z7 | 256 | ≈425 km |

On steps 1–3 the view centres on the location but is shifted to stay in
the coverage box, so the marker can sit off-centre. Parts of the box
without radar (open sea) are dimmed and hatched by the radar shader, from
one image for the whole loop: its latest observation (while the loop is
still being assembled and that frame isn't yet, the newest one that is;
`Model.radarCoverageIndex`). yr.no's frames
disagree on coverage (a radar missing from one observation, forecast
frames filling the gaps as they run ahead), so taken per frame the
hatching would change shape through the loop.

Rain keeps yr.no's colours on light themes. yr.no's palette is made for a
light map (light rain pale cyan `#91e4ff`, heavy rain deep blue `#0055ff`,
extreme rain purple), so on a dark map the lightest rain would stand out
most. There the blues are redrawn as a ramp that brightens with intensity:
light rain a dim steel blue, partly see-through, rising to bright sky blue
for heavy rain; purples are kept. The shader reads intensity from the
colour (blue stays full while green falls). How much applies follows how
dark the theme's map is (`Panel.mapDarkness`: none at luma ≥ 0.45, fully
at ≤ 0.15), so in-between themes get part of it.

The base map is rendered by `scripts/build-basemap.py` from OpenStreetMap
extracts (`scripts/basemap-regions.txt`) for the coverage box and the
overview frame around it. Tiles hold masks (R water, G roads by class,
B national borders), coloured by `shaders/mapdata.frag` with the theme.
Labels come from `map/places.json`, chosen per step by population and
placed without overlaps (`Model.mapLabels`).

Playback shows the real radar frames only, 250 ms per five-minute frame.
In-between frames can't be made to look real from five-minute data: rain
changes shape between frames and radars update at different moments, so
interpolated frames show as pulsing or twitching. A shared timer steps one
frame per 250 ms tick; it holds while that frame's images are still
decoding, while paused, or while the panel is closed.

On a first open or new zoom, the latest observation is assembled as a
still preview; then frames are assembled batch by batch as their tiles
arrive and play at once, waiting on the newest assembled frame (about 1–2 s
to the first frames; all 41 take about 4–9 s). Each batch only extends the
loop on screen: its images, frame and timing carry on. Once a complete
loop plays, a replacement is published at a frame boundary and carries on
at the same time. Paused playback keeps its loop. `RadarImages.qml` keeps
three rotating image slots that decode frames ahead, plus a staging set while a
loop is replaced; the previous set stays on screen until the new frames
are decoded. Images skip Qt's decoded-image cache and are sampled directly
by the radar shader, without offscreen layers. ImageMagick assembles
frames in four processes of one thread each.

### Lightning

Strikes come from yr.no's lightning map: `{ historicalData }`, a JSON
string holding `[time (s), lon, lat, …]` per strike, the last 2 hours of
the Nordics (both cloud-to-ground and cloud-to-cloud). They are drawn on a
canvas over the radar, placed like the location marker:

- Each strike gets its own bolt (`Model.lightningShape`, seeded by the
  strike so it keeps its shape): a jagged channel 13–22 px tall ending at
  the strike, forking once or twice about half the time. It has a dark
  edge (to stand out on rain), a pale gold glow and a near-white core.
- At a past frame, strikes up to that frame's time are shown. At "now",
  strikes up to the latest lightning data, which runs a few minutes ahead
  of the radar. Forecast frames show no lightning: strikes can't be
  forecast, and a held trail would sit on the map for the whole forecast.
- A bolt shows for strikes in the moment's own 5 minutes (its glow flares
  briefly as the frame appears) and dimmer for the 5 minutes before. A
  bolt within 10 px of a newer one is left out, so a dense cell reads as
  separate bolts.
- Every strike leaves a small dot that fades out over 10 minutes.
- Which bolts to draw is worked out once per frame
  (`Model.lightningBolts`). Dots and dim bolts are painted once per frame;
  a second canvas holds only the new bolts and is the only one repainted
  while they flare. With no new bolts nothing animates, so a loop without
  lightning costs nothing extra.

## Testing

### Checks

- **Tests:** `npm test` against saved API responses; Qt tests also exercise
  image buffering, loop replacement, progressive loading, pause/resume and
  bounded retries:
  - an ordinary complete forecast (the Alingsås response from 2026-09-26)
  - a forecast with precipitation and thunder
  - the switch from hourly to 6-hour steps
  - both daylight-saving switches: a date in the last week of March and in the
    last week of October
  - nowcast with and without radar coverage
  - the misspelled symbol codes
  - moon phase bucket edges
  - an empty search result
- **Shader pixels:** `RADAR_RENDER_TESTS=1 npm test` adds an offscreen OpenGL
  RHI check of how rain and no-coverage are drawn.
- **Lint:** `scripts/lint` (qmllint against the installed shell; clean
  apart from the shell's own objects, which it only knows as `QObject`).
- **Manifest:** `omarchy-plugin-validate .` (`scripts/dev-install` runs it).
- **Manual:**
  - Enable the plugin and check it takes the `omarchy.weather` slot.
  - Remove it and check the built-in comes back.
  - Change location from our panel and check the built-in picks up the same
    place.
