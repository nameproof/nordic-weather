# Nordic Weather for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that replaces the
built-in weather widget with forecasts from [MET Norway](https://api.met.no),
the data behind yr.no.

- **Bar:** the condition icon and the temperature. At night, clear skies show
  the actual moon phase.
- **Panel:**
  - Current conditions: feels-like temperature, wind with direction and
    gusts, humidity.
  - A radar nowcast for the next two hours ("Regn om ca 20 min"). Nordic
    countries only; there it also keeps the bar's temperature at most about
    15 minutes old.
  - Hourly rows for three days, showing forecast uncertainty (`12°±2`,
    `0–0,3 mm`).
  - A 10-day overview with temperature bars.
  - Sunrise and sunset, moon phase and moonrise.
- **Radar map:** a side panel with two views, switched at its bottom:
  - **MET:** MET's animated Nordic radar GIF (last 3 hours, labelled in local time).
  - **yr.no:** a map in your theme's colours with yr.no's radar every 5
    minutes for the last 1½ hours plus a 2-hour forecast. Zoomed out it shows
    the whole Nordic radar area; zoomed in it follows your location but never
    leaves the radar's coverage, and areas without radar are dimmed. Zoom
    with + / − or the mouse wheel; click the map to pause. The
    base map ships with the plugin (see below); only the radar tiles come
    from yr.no's undocumented tile server, so that part may break if yr.no
    changes it.

  Nothing is downloaded or drawn until the side panel is open.
- **Location:** click the place name and search. The location is saved in the
  same file the built-in widget uses, so switching between the two keeps it.
- **Language:** Swedish when the system locale is Swedish, English otherwise.

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
| Click the place name, or Enter in the panel | Search for a location |
| Click **Radar ›**, or → / `l` in the panel (← / `h` closes) | Show the radar map beside the forecast |
| `omarchy-shell omarchy.weather toggle` / `edit` / `refresh` / `radar` | The same, from a keybind |
| `omarchy-shell omarchy.weather setRadarSource met` / `yr` | Pick the radar view |

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
npm test                    # Model.js unit tests against saved API responses
scripts/build-shaders       # compile shaders/*.frag to .qsb (dev-install runs it)
scripts/dev-install         # copy into ~/.config/omarchy/plugins/ (hot-reloads)
scripts/dev-install --enable
/usr/lib/qt6/bin/qmllint -I "$OMARCHY_PATH/shell" BarWidget.qml Panel.qml Service.qml
```

The shell notices changed plugin files but keeps using the widget's
already-compiled QML and JS while it is on screen, so `dev-install` restarts
the shell whenever the code changed.

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
