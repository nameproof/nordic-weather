# Nordic Weather for Omarchy

A bar widget for the [Omarchy](https://omarchy.org) shell that replaces
the built-in weather widget.

A detailed weather widget using Yr as the backend without making it too
bloated. Perfect for me, might still be too much for you!

Includes a weather radar that is lazy-loaded. This keeps the forecast
light. Radar playback loads in batches like streaming platforms so
it's still fast. Rain clouds and lightning are seen on the radar map.

The radars map is locked to the Nordic region as seen in the screenshots. It
can be used for other locations but the radar map and cloud data is
limited to this region. Locations works the same way the built-in Omarchy
weather widget does, just with added favorites.

Follows Omarchy's theming colors, including the Radar!

Languages: Swedish, Norwegian, Danish, Finnish or English, following the system
locale; English for anything else.

<img width="1215" height="898" alt="screenshot-2026-09-29_12-15-56-cropped" src="https://github.com/user-attachments/assets/4551c485-867e-451f-8977-b1164179a2df" />
<img width="1215" height="898" alt="screenshot-2026-09-29_12-15-28-cropped" src="https://github.com/user-attachments/assets/4ae46c34-307f-4d34-963b-9cc370fdbff1" />
<img width="1215" height="898" alt="screenshot-2026-09-29_12-17-15-cropped" src="https://github.com/user-attachments/assets/9c9b6283-bd6d-47e2-8252-276dcad05874" />

## Install

```sh
omarchy plugin add https://github.com/nameproof/nordic-weather.git --enable
```

Remove it with `omarchy plugin remove io.github.nameproof.nordic-weather`.
Optionally remove the cache that holds up to ~100MB:
`rm -rf ~/.cache/io.github.nameproof.nordic-weather`

Needs `curl` and ImageMagick (for the radar), both included in Omarchy.

Enabling the plugin puts it in the built-in weather widget's place in the bar.
Disabling or removing it brings the built-in back.

## Use

Just click around, some advanced motions do exist however:

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

Settings live on the widget's entry in `~/.config/omarchy/shell.json`

## Development

`Service.qml` is the one data source (fetching, cache, radar, IPC) behind
every monitor's `BarWidget.qml` (the pill) and `Panel.qml` (the popout, only
loaded while open). `Model.js` holds the pure logic as plain JavaScript.

```sh
npm test                    # model, shader build, Qt and service tests
RADAR_RENDER_TESTS=1 npm test # also check shader pixels with offscreen OpenGL
scripts/build-shaders       # compile shaders/*.frag to .qsb (dev-install runs it)
scripts/dev-install         # copy into ~/.config/omarchy/plugins/ (hot-reloads)
scripts/dev-install --enable
scripts/lint                # qmllint against the installed Omarchy shell
```

### Base map

`map/` (~5 MB) holds the base map tiles and `places.json` for labels. The
tiles are water/road/border masks that `shaders/mapdata.frag` colours with
the theme. Rebuilding them from OpenStreetMap needs ~6 GB of downloads
(regions in `scripts/basemap-regions.txt`) into the git-ignored `build/`:

```sh
uv venv build/.venv && uv pip install --python build/.venv/bin/python osmium shapely pyshp pillow numpy
build/.venv/bin/python scripts/build-basemap.py   # download, extract, render, places
```

## Credits

- Weather: [MET Norway](https://api.met.no), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Radar and lightning: [yr.no](https://www.yr.no)
- Map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL
- Place search: [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api)
