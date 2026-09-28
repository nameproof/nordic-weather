# Nordic Weather for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that replaces the
built-in weather widget with forecasts from [MET Norway](https://api.met.no),
the data behind yr.no.

- **Bar:** the condition icon and the temperature.
- **Panel:**
  - Current conditions: feels-like temperature, wind with direction and
    gusts, humidity, and air pressure with its trend over the next 3 hours.
  - A radar nowcast for the next two hours ("Regn om ca 20 min"). Nordic
    countries only; there it also keeps the bar's temperature at most about
    15 minutes old.
  - Hourly rows for three days, showing forecast uncertainty (`12°±2`,
    `0–0,3 mm`).
  - A 10-day overview with temperature bars.
  - Sunrise and sunset, the moon phase, and when the moon is highest.
- **Radar map:** a side panel with a map in your theme's colours and
  yr.no's radar every 5 minutes for the last 1½ hours plus a 2-hour
  forecast. Zoomed out it shows the whole Nordic radar area; zoomed in it
  follows your location but never leaves the radar's coverage, and areas
  without radar are dimmed. On dark themes the rain is redrawn so heavier
  rain is brighter, rather than light rain standing out most. Lightning
  strikes flash up as bolts in the frame they happen in and leave a dot
  for ten minutes. A ruler along the bottom shows where the loop is, with
  −1 h / Nu / +1 h marked under the map; drag it to scrub, hover it for
  the exact time. The base map ships with the plugin (see below); the
  radar tiles and lightning come from yr.no's undocumented backend, so
  those parts may break if yr.no changes it.

  Nothing is downloaded or drawn until the side panel is open.
- **Location:** click the place name and search. The location is saved in the
  same file the built-in widget uses, so switching between the two keeps it.
  The star on a search result saves that place as a favourite; with the
  search field empty, your favourites are listed for a one-click switch.
- **Language:** Swedish, Norwegian (Bokmål, also for Nynorsk locales),
  Danish, Finnish or English, following the system locale; English for
  anything else.

Enabling the plugin puts it in the built-in widget's place in the bar.
Disabling or removing it brings the built-in back.

## Install

```sh
omarchy plugin add https://github.com/nameproof/omarchy-nordic-weather.git --enable
```

## Use

| Action | Result |
|---|---|
| Left click | Open or close the panel |
| Right click | Notification with current weather |
| Middle click, or `r` in the panel | Refresh now |
| Click the place name, or Enter in the panel | Search for a location, or pick a favourite |
| Click the ☆ / ★ on a search result | Add or remove that place as a favourite |
| Click **Radar ›**, or → / `l` in the panel (← / `h` closes) | Show the radar map beside the forecast |
| `+` / `−` or the mouse wheel on the map | Zoom the radar map |
| Click the map, or `p` | Pause or play the radar loop |
| `,` / `.` | Step the radar loop back or forward a frame |
| ↑ / ↓ (`k` / `j`), Tab | Scroll the panel, switch to the neighbouring panel |
| `omarchy-shell omarchy.weather toggle` / `edit` / `refresh` / `radar` | The same, from a keybind |
| `omarchy-shell omarchy.weather favorite next` / `favorite previous` | Switch to the next or previous favourite |

Settings live on the widget's entry in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.nameproof.nordic-weather", "hourStep": 3, "hourlyDays": 3, "longRangeDays": 10 }
```

## Data and requests

Forecasts come from `api.met.no`. Requests follow MET's
[terms of service](https://api.met.no/doc/TermsOfService):

- An identifying User-Agent is sent.
- Refreshes wait for the response's `Expires` time plus a little random
  jitter, and send `If-Modified-Since`.
- Coordinates are rounded to 4 decimals.

One cache file, `~/.cache/io.github.nameproof.nordic-weather/cache.json`, is
shared by every monitor's bar.

Place search uses the [Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api),
the same one the built-in widget uses. It only turns a typed name into
coordinates.

Weather data: MET Norway, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed ODbL.

## Development

```sh
npm test                    # model, shader build, Qt and service tests
RADAR_RENDER_TESTS=1 npm test # also check shader pixels with offscreen OpenGL
scripts/build-shaders       # compile shaders/*.frag to .qsb (dev-install runs it)
scripts/dev-install         # copy into ~/.config/omarchy/plugins/ (hot-reloads)
scripts/dev-install --enable
scripts/lint                # qmllint against the installed Omarchy shell
```

The shell notices changed plugin files but keeps using the widget's
already-compiled QML and JS while it is on screen, so `dev-install` restarts
the shell whenever the code changed.

Qt runtime tests use isolated temporary caches and make no network requests.
They require Qt Quick Test, ImageMagick, and (for the service test) Quickshell
and Omarchy. Missing runtime tools are reported as skipped tests. The optional
pixel test requires an OpenGL RHI renderer; the software scene graph cannot
render `ShaderEffect`.

### Base map

`map/` holds the radar map's base map: tiles for the Nordic radar coverage at
zoom 5–7 and `places.json` for labels. The tiles store water/road/border
masks rather than colours, and `shaders/mapdata.frag` colours them with the
current theme. They are rendered from OpenStreetMap by
`scripts/build-basemap.py`, which needs about 6 GB of downloads and a Python
environment with GIS libraries, so it is only run when the map should be
refreshed:

```sh
uv venv build/.venv && uv pip install --python build/.venv/bin/python osmium shapely pyshp pillow numpy
build/.venv/bin/python scripts/build-basemap.py   # download, extract, render
```

The regions it downloads (Geofabrik extracts) are listed in
`scripts/basemap-regions.txt`.

### Shaders

The map uses two small shaders in `shaders/`. Qt 6
only loads precompiled shaders, so the compiled `.qsb` files are committed
next to their source; `npm test` fails if a `.qsb` is older than its source.

`Service.qml` is the one data source (fetching, cache, radar, IPC) behind
every monitor's `BarWidget.qml` (the pill) and `Panel.qml` (the popout, only
loaded while open). `Model.js` holds the pure logic as plain JavaScript. See
`SPEC.md` for the design.
