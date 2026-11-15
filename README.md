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

Shows weather warnings for your location in Sweden
(SMHI), Norway (MET Norway) and Finland (FMI).

Follows Omarchy's theming colors, including the Radar!

Languages: Swedish, Norwegian, Danish, Finnish or English, following the
language chosen in Omarchy, else the system locale; English for anything else.

<img width="1215" height="846" alt="1-dark-goteborg" src="https://github.com/user-attachments/assets/988bb816-85c7-4b08-896b-3be2761efc8f" />
<img width="1215" height="828" alt="2-dark-goteborg-radar" src="https://github.com/user-attachments/assets/afc73cf7-4ed6-4169-8c7f-4acee63aa941" />
<img width="1215" height="828" alt="3-light-helsinki-radar" src="https://github.com/user-attachments/assets/5f20e767-a920-4515-be9d-9a17cf1e2843" />

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
| Click a warning | Show the advice that comes with it |
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
scripts/build-shaders       # compile shaders/*.frag to .qsb (dev-sync runs it)
scripts/dev-sync            # copy into ~/.config/omarchy/plugins/ (hot-reloads)
scripts/dev-sync --enable
scripts/lint                # qmllint against the installed Omarchy shell
```

### Base map

`map/` (~7 MB) holds the base map tiles and `places.json` for labels. The
tiles are water/road/border masks that `shaders/mapdata.frag` colours with
the theme. Rebuilding them from OpenStreetMap needs ~6 GB of downloads
(regions in `scripts/basemap-regions.txt`) into the git-ignored `build/`:

```sh
uv run scripts/build-basemap.py   # download, extract, render, places
```

## Credits

- Weather: [MET Norway](https://api.met.no), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Radar and lightning: [yr.no](https://www.yr.no)
- Map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL
- Place search: [Open-Meteo](https://open-meteo.com/en/docs/geocoding-api)
- Location when none is set: Omarchy's geo service (geo.omarchy.org)
