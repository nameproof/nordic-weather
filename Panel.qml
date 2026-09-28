import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Popout for the weather pill: UI state and drawing only. Everything it
// shows comes from Service.qml, one instance behind every monitor's widget;
// this panel reports back what it shows (open, radar open, map size) with
// service.updateViewer(). The popout lifecycle (open/close/hotkey/popout
// switching) mirrors the built-in omarchy.weather panel.
//
// Lists use Quickshell's ScriptModel keyed by content (Model.addListKeys):
// a plain JS array as a Repeater model rebuilds every delegate whenever the
// array is replaced, i.e. on every minute's update; ScriptModel only
// rebuilds the rows whose content changed.
Panel {
  id: root
  moduleName: "io.github.nameproof.nordic-weather"
  // Service.qml owns the omarchy.weather IPC target.
  manageIpc: false

  property var anchorItem: null
  property bool openedFromHotkey: false

  // The bar tracks the widget mounted in its slot (BarWidget.qml), not this
  // nested panel, so that widget is our identity for popout coordination.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Injected by BarWidget.qml.
  property var service: null

  // ---------------------------------------------------------------- lifecycle

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
    root.panelOpened()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    root.panelOpened()
    // Set after showing: showing hands the popout coordinator over, which
    // closes whichever panel was open, and that close clears the shared flag.
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    if (root.editingLocation) root.cancelEditingLocation()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function panelOpened() {
    weatherScroll.contentY = 0
    // An IPC command (`radar`, `edit`) that summoned this panel.
    var action = root.service ? root.service.takePendingAction() : ""
    if (action === "radar") root.radarOpen = true
    if (action === "edit" || !root.hasLocation) Qt.callLater(root.startEditingLocation)
  }

  // ---------------------------------------------------------------- reporting to the service

  // Every open starts compact: the radar only loads when asked for.
  property bool radarOpen: false
  onOpenedChanged: {
    if (!opened) radarOpen = false
    reportViewer()
  }
  onRadarOpenChanged: reportViewer()
  onServiceChanged: reportViewer()

  function toggleRadar() {
    radarOpen = !radarOpen
  }

  // The map is laid out at the box's real pixel size (no scaling), so a
  // smaller box shows a smaller area; the service computes the view for it.
  readonly property int yrMapWidth: Math.max(1, Math.round(radarBox.width) - 2)
  readonly property int yrMapHeight: Math.max(1, Math.round(radarBox.height) - 2)
  onYrMapWidthChanged: reportViewer()
  onYrMapHeightChanged: reportViewer()

  readonly property string viewerId: "panel-" + Math.floor(Math.random() * 1e9)

  function reportViewer() {
    if (!service) return
    service.updateViewer(viewerId, { open: opened, radarOpen: opened && radarOpen,
                                     width: yrMapWidth, height: yrMapHeight })
  }

  Component.onDestruction: if (service) service.removeViewer(viewerId)

  Connections {
    target: root.service
    // IPC `radar`/`edit` while this panel is already open.
    function onPanelCommand(name) {
      if (!root.opened) return
      if (name === "radar") root.toggleRadar()
      else if (name === "edit") root.startEditingLocation()
    }
    // A picked place's forecast has arrived: close the search.
    function onLocationSaved() {
      if (root.editingLocation) root.cancelEditingLocation()
    }
  }

  // ---------------------------------------------------------------- from the service

  readonly property var emptyView: Model.buildView({ lang: Model.langFor(Qt.locale().name), nowMs: 0, location: null })
  readonly property var view: service ? service.view : emptyView
  readonly property string lang: service ? service.lang : Model.langFor(Qt.locale().name)
  readonly property var t: Model.strings(lang)
  readonly property var location: service ? service.location : ({ name: "", latitude: null, longitude: null })
  readonly property bool hasLocation: service ? service.hasLocation : false
  readonly property bool stale: service ? service.stale : false
  readonly property string lastError: service ? service.lastError : ""
  readonly property string cacheDir: service ? service.cacheDir : ""
  readonly property string tilesDir: service ? service.tilesDir : ""

  readonly property bool yrRadarActive: opened && radarOpen && !!service && service.yrRadarActive

  readonly property int mapStep: service ? service.mapStep : Model.MAP_DEFAULT_STEP
  readonly property var mapViewState: yrRadarActive ? service.mapViewState : null
  readonly property var yrBaseTiles: yrRadarActive ? service.yrBaseTiles : []
  readonly property var yrDisplay: service ? service.yrDisplay : ({ frames: [], nowIndex: -1 })
  readonly property var yrCurrentFrame: service ? service.yrCurrentFrame : null
  readonly property int yrFrame: service ? service.yrFrame : 0
  readonly property bool yrPaused: service ? service.yrPaused : false
  readonly property bool yrPlaying: service ? service.yrPlaying : false
  readonly property int yrPlayLimit: service ? service.yrPlayLimit : 0

  readonly property var yrImageLoop: service ? service.yrImageLoop : null
  readonly property var yrPlayhead: service && service.yrShownValid ? service.yrPlayhead : ({ frame: 0, tick: 0 })
  readonly property string yrPresentationToken: service ? service.yrPresentationToken : ""

  function refresh(force) { if (service) service.refresh(force) }
  function zoomMap(delta) { if (service) service.zoomMap(delta) }
  function togglePause() { if (service) service.togglePause() }
  function seekFrame(index) { if (service) service.seekFrame(index) }
  function stepFrame(delta) { if (service) service.stepFrame(delta) }

  // The time ruler's ticks (Model.rulerTicks), shared by the ruler on the map
  // and the stamps under it, which use the same inset.
  readonly property var rulerTicks: yrRadarActive ? Model.rulerTicks(yrDisplay.frames, yrDisplay.nowIndex, lang) : []
  readonly property int rulerPad: Style.space(16)

  // Labels depend on this panel's font, so they are placed here.
  FontMetrics {
    id: mapLabelMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
  readonly property var mapLabels: yrRadarActive && mapViewState
    ? Model.mapLabels(service.mapPlaces, mapViewState, yrMapWidth, yrMapHeight,
                      lang, mapLabelMetrics.averageCharacterWidth, location.name)
    : []

  // ---------------------------------------------------------------- location search

  // The search field is this panel's; the service does the geocoding.
  property bool editingLocation: false
  property int suggestionIndex: 0
  readonly property bool savingLocation: service ? service.savingLocation : false
  readonly property var locationSuggestions: service ? service.locationSuggestions : []
  readonly property bool geocodeSearched: service ? service.geocodeSearched : false
  onLocationSuggestionsChanged: if (!showingFavorites) suggestionIndex = 0
  // With the field empty the dropdown lists the favourites instead.
  property string searchText: ""
  readonly property var favorites: service ? service.favorites : []
  readonly property bool showingFavorites: searchText.trim() === ""
  readonly property var dropdownRows: showingFavorites ? Model.favoriteRows(favorites, location) : locationSuggestions
  onShowingFavoritesChanged: suggestionIndex = firstDropdownIndex()

  // The first row to select: with favourites, the first that isn't the
  // current place.
  function firstDropdownIndex() {
    if (!showingFavorites) return 0
    for (var i = 0; i < dropdownRows.length; i++) if (!dropdownRows[i].current) return i
    return 0
  }

  function startEditingLocation() {
    editingLocation = true
    if (service) service.clearSearch()
    Qt.callLater(function() {
      locationField.text = ""
      root.suggestionIndex = root.firstDropdownIndex()
      locationField.forceActiveFocus()
    })
  }

  function cancelEditingLocation() {
    editingLocation = false
    geocodeDebounce.stop()
    if (service) service.clearSearch()
    Qt.callLater(function() { if (keyCatcher) keyCatcher.forceActiveFocus() })
  }

  function commitLocation() {
    // Empty field: the selected favourite (the current place just closes);
    // with none, it cancels. It is never a way to remove the location.
    if (locationField.text.trim() === "") {
      pickFavorite(dropdownRows[suggestionIndex])
      return
    }
    // Enter before the debounce fired: search now, pick on the next Enter.
    if (geocodeDebounce.running || (service && service.searchBusy())) {
      geocodeDebounce.stop()
      if (service) service.search(locationField.text)
      return
    }
    pickSuggestion(Model.locationCommit(locationField.text, locationSuggestions, suggestionIndex))
  }

  function pickSuggestion(suggestion) {
    if (service) service.pickSuggestion(suggestion)
  }

  function pickFavorite(row) {
    if (row && !row.current) pickSuggestion(row)
    else if (hasLocation) cancelEditingLocation()
  }

  Timer {
    id: geocodeDebounce
    interval: 300
    onTriggered: if (root.service) root.service.search(locationField.text)
  }

  // ---------------------------------------------------------------- UI

  readonly property color fg: root.bar ? root.bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.5)
  readonly property color faint: Qt.darker(fg, 1.9)
  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  // Radar map palette, derived from the theme: land is the popup background
  // so the map sits in the panel, lines move towards the text colour, and
  // water gets a fixed blue tint so it reads as water in any theme.
  readonly property color mapLand: Qt.rgba(Color.popups.background.r, Color.popups.background.g, Color.popups.background.b, 1)
  readonly property color mapWater: Qt.tint(mapLand, Qt.rgba(0.35, 0.55, 0.85, 0.22))
  readonly property color mapRoad: Qt.tint(mapLand, Qt.rgba(fg.r, fg.g, fg.b, 0.30))
  readonly property color mapBorder: Qt.tint(mapLand, Qt.rgba(fg.r, fg.g, fg.b, 0.45))

  // Radar shader (shaders/radar.frag): rain opacity, and the look of areas
  // without radar coverage: faint diagonal lines over a slight darkening.
  readonly property real radarStrength: 0.85
  readonly property real radarDimStrength: 0.18
  readonly property real radarLineStrength: 0.35
  readonly property real radarLineSpacing: 8
  readonly property real radarLineWidth: 0.6
  readonly property color radarLineColor: Qt.darker(fg, 2.0)
  // How dark the map is: 0 for light themes (luma ≥ 0.45), 1 for dark ones
  // (≤ 0.15). The radar shader recolours rain for dark maps this much.
  readonly property real mapDarkness: Math.max(0, Math.min(1,
    (0.45 - (0.299 * mapLand.r + 0.587 * mapLand.g + 0.114 * mapLand.b)) / 0.3))

  // Forecast column width; the radar side panel is added next to it.
  readonly property int forecastWidth: Style.space(540)
  readonly property int radarGap: Style.space(16)
  // The radar map's size (Nordic proportions), smaller when the panel
  // doesn't fit it.
  readonly property int radarMapWidth: 659
  readonly property int radarMapHeight: 761

  // Column widths for the hourly table, shared by every row.
  readonly property int colHour: Style.space(26)
  readonly property int colIcon: Style.space(24)
  readonly property int colTemp: Style.space(52)
  readonly property int colPop: Style.space(40)
  readonly property int colAmount: Style.space(92)
  // Wind: speed | arrow | gust. Sized from the font so a two-digit gust
  // ends exactly at the row's right padding, mirroring the hour on the left.
  readonly property int windSpeedWidth: Style.space(18)
  readonly property int windArrowWidth: Style.space(12)
  readonly property int windGap: Style.space(4)
  readonly property int colWind: windSpeedWidth + windArrowWidth + Math.ceil(gustMetrics.advanceWidth) + windGap * 2

  TextMetrics {
    id: gustMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: "(00)"
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(root.forecastWidth + (root.radarOpen ? root.radarGap + root.radarMapWidth : 0))
    contentHeight: panel.fittedContentHeight(Math.max(weatherColumn.implicitHeight,
      root.radarOpen ? radarPane.implicitHeight + Style.space(8) + credits.implicitHeight : 0))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: root.editingLocation
      onReturnRequested: root.startEditingLocation()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        // → / l opens the radar side panel, ← / h closes it.
        if (dx > 0 && !root.radarOpen) { root.radarOpen = true; return }
        if (dx < 0 && root.radarOpen) { root.radarOpen = false; return }
        var maxY = Math.max(0, weatherScroll.contentHeight - weatherScroll.height)
        weatherScroll.contentY = Math.max(0, Math.min(maxY, weatherScroll.contentY + dy * Style.space(60)))
      }
      onTextKey: function(key) {
        if (key === "r") root.refresh(true)
        else if ((key === "+" || key === "=") && root.yrRadarActive) root.zoomMap(1)
        else if (key === "-" && root.yrRadarActive) root.zoomMap(-1)
        // Video-player keys: step a frame (pauses), play/pause.
        else if (key === "," && root.yrRadarActive) root.stepFrame(-1)
        else if (key === "." && root.yrRadarActive) root.stepFrame(1)
        else if (key === "p" && root.yrRadarActive) root.togglePause()
      }

      Flickable {
        id: weatherScroll
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: Math.min(root.forecastWidth, parent.width)
        contentWidth: width
        contentHeight: weatherColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: weatherColumn
          width: weatherScroll.width
          spacing: Style.space(12)

          // ---- Hero: icon + temperature + condition left; place and stats right.
          Item {
            width: parent.width
            height: Math.max(heroLeft.height, heroRight.height)

            // Icon + temperature + condition. The icon is centred on the
            // painted digits of the temperature (not on the whole block,
            // and not on the glyph's line box, which has uneven padding).
            Item {
              id: heroLeft
              anchors.left: parent.left
              anchors.leftMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              visible: root.view.ready
              width: heroIcon.implicitWidth + Style.space(14) + heroTemp.width
              height: heroTemp.height

              TextMetrics {
                id: heroIconMetrics
                font: heroIcon.font
                text: heroIcon.text
              }
              TextMetrics {
                id: tempMetrics
                font: tempBig.font
                text: tempBig.text
              }

              Text {
                id: heroIcon
                textFormat: Text.PlainText
                text: root.view.current ? root.view.current.icon : ""
                color: root.fg
                font.family: root.fontFamily
                // Decorative condition glyph, deliberately outside the Style.font scale.
                font.pixelSize: 56
                // Metrics rects are relative to the baseline (y grows downwards).
                y: (tempBig.baselineOffset + tempMetrics.tightBoundingRect.y + tempMetrics.tightBoundingRect.height / 2)
                  - (baselineOffset + heroIconMetrics.tightBoundingRect.y + heroIconMetrics.tightBoundingRect.height / 2)
              }

              Column {
                id: heroTemp
                anchors.left: heroIcon.right
                anchors.leftMargin: Style.space(14)
                spacing: Style.space(2)

                Row {
                  spacing: Style.space(2)
                  Text {
                    id: tempBig
                    textFormat: Text.PlainText
                    text: root.view.current ? String(root.view.current.temp) : "—"
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: 48
                    font.bold: true
                  }
                  Text {
                    textFormat: Text.PlainText
                    text: "°C"
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.display
                    anchors.top: tempBig.top
                    anchors.topMargin: Style.space(8)
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  text: root.view.current ? root.view.current.description : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
              }
            }

            Column {
              id: heroRight
              anchors.right: parent.right
              anchors.rightMargin: Style.space(16)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(12)

              // Place name; click to search or pick a favourite.
              Row {
                anchors.right: parent.right
                visible: !root.editingLocation && root.hasLocation
                spacing: Style.space(6)

                TapHandler { onTapped: root.startEditingLocation() }
                HoverHandler { cursorShape: Qt.PointingHandCursor }

                Text {
                  text: "\uf041"  // nf-fa-map_marker
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  anchors.verticalCenter: parent.verticalCenter
                }
                Text {
                  textFormat: Text.PlainText
                  text: root.location.name.toUpperCase()
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  font.letterSpacing: 1
                  anchors.verticalCenter: parent.verticalCenter
                }
              }

              Row {
                anchors.right: parent.right
                visible: root.editingLocation
                spacing: Style.space(6)

                TextField {
                  id: locationField
                  width: Style.space(210)
                  enabled: !root.savingLocation
                  placeholderText: root.t.searchPlaceholder
                  foreground: root.fg
                  font.family: root.fontFamily
                  onTextChanged: {
                    root.searchText = text
                    if (root.editingLocation && !root.savingLocation) geocodeDebounce.restart()
                  }
                  Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Escape) {
                      if (root.hasLocation) root.cancelEditingLocation()
                      else root.close()
                      event.accepted = true
                    } else if (event.key === Qt.Key_Down) {
                      if (root.suggestionIndex < root.dropdownRows.length - 1) root.suggestionIndex++
                      event.accepted = true
                    } else if (event.key === Qt.Key_Delete && root.showingFavorites) {
                      var row = root.dropdownRows[root.suggestionIndex]
                      if (row && root.service) root.service.removeFavorite(row.placeKey)
                      root.suggestionIndex = Math.max(0, Math.min(root.suggestionIndex, root.dropdownRows.length - 2))
                      event.accepted = true
                    } else if (event.key === Qt.Key_Up) {
                      if (root.suggestionIndex > 0) root.suggestionIndex--
                      event.accepted = true
                    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                      root.commitLocation()
                      event.accepted = true
                    }
                  }
                }

                // Spinner while a picked place's forecast loads. Only ever
                // shown spinning, so a stopped animation can't leave it tilted.
                Text {
                  width: Style.space(18)
                  anchors.verticalCenter: parent.verticalCenter
                  horizontalAlignment: Text.AlignHCenter
                  visible: root.savingLocation
                  textFormat: Text.PlainText
                  text: "󰦖"
                  font.family: root.fontFamily
                  color: root.dim
                  font.pixelSize: Style.font.bodySmall
                  RotationAnimator on rotation {
                    running: root.savingLocation
                    from: 0; to: 360
                    duration: 800
                    loops: Animation.Infinite
                  }
                }
              }

              // Gaps shrink (24 down to 10) when wide values would otherwise
              // run into the temperature.
              Row {
                id: statsRow
                anchors.right: parent.right
                visible: root.view.ready
                readonly property real available: heroRight.parent.width - heroRight.anchors.rightMargin
                  - (heroLeft.x + heroLeft.width) - Style.space(16)
                readonly property real columnsWidth: {
                  var sum = 0
                  for (var i = 0; i < children.length; i++) sum += children[i].implicitWidth
                  return sum
                }
                spacing: Math.max(Style.space(10), Math.min(Style.space(24), Math.floor((available - columnsWidth) / 3)))

                Repeater {
                  model: root.view.current ? [
                    { label: root.t.feels, value: root.view.current.feelsLike === null ? "—" : root.view.current.feelsLike + "°", sub: "" },
                    { label: root.t.wind, value: root.view.current.wind.speed === null ? "—"
                        : root.view.current.wind.speed + " m/s " + root.view.current.wind.arrow,
                      sub: root.view.current.wind.gust === null ? "" : "(" + root.t.gust + " " + root.view.current.wind.gust + ")" },
                    { label: root.t.humidity, value: root.view.current.humidity === null ? "—" : root.view.current.humidity + "%", sub: "" },
                    { label: root.t.pressure, value: root.view.current.pressure === null ? "—"
                        : root.view.current.pressure.value + " hPa " + root.view.current.pressure.arrow,
                      sub: root.view.current.pressure && root.view.current.pressure.changeText !== ""
                        ? "(" + root.view.current.pressure.changeText + ")" : "" }
                  ] : []

                  Column {
                    required property var modelData
                    spacing: Style.space(4)

                    Text {
                      textFormat: Text.PlainText
                      text: modelData.label.toUpperCase()
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.letterSpacing: 1
                    }
                    Text {
                      textFormat: Text.PlainText
                      text: modelData.value
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.title
                    }
                    Text {
                      textFormat: Text.PlainText
                      visible: modelData.sub !== ""
                      text: modelData.sub
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }
              }
            }
          }

          // ---- Favourites (empty field) or search suggestions.
          Column {
            visible: root.editingLocation && !root.savingLocation
              && (root.dropdownRows.length > 0 || (!root.showingFavorites && root.geocodeSearched))
            width: parent.width
            spacing: 0

            Repeater {
              model: ScriptModel { values: root.dropdownRows; objectProp: "key" }

              Rectangle {
                id: dropdownRow
                required property var modelData
                required property int index
                width: parent.width
                height: suggestionRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: index === root.suggestionIndex ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"

                // Favourite rows: a star first; the current place dimmed.
                readonly property bool favorite: modelData.placeKey !== undefined
                readonly property bool current: favorite && modelData.current

                Row {
                  id: suggestionRow
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(16)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)

                  Text {
                    visible: dropdownRow.favorite
                    anchors.verticalCenter: parent.verticalCenter
                    text: "\uf005"  // nf-fa-star
                    color: dropdownRow.current ? root.faint : Color.accent
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                  Text {
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: dropdownRow.current ? root.dim
                      : index === root.suggestionIndex ? Style.hoverStateColor(root.fg, Color.accent) : root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    textFormat: Text.PlainText
                    visible: text !== ""
                    text: modelData.description
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    anchors.verticalCenter: parent.verticalCenter
                  }
                }

                MouseArea {
                  id: rowArea
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onPositionChanged: root.suggestionIndex = index
                  onClicked: dropdownRow.favorite ? root.pickFavorite(dropdownRow.modelData) : root.pickSuggestion(dropdownRow.modelData)
                }
                // Remove a favourite (also Delete on the selected row). Its
                // own MouseArea on top, so the click doesn't pick the row.
                MouseArea {
                  id: removeArea
                  visible: dropdownRow.favorite && (rowArea.containsMouse || containsMouse)
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(24)
                  height: parent.height
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.service.removeFavorite(dropdownRow.modelData.placeKey)

                  Text {
                    anchors.centerIn: parent
                    text: "\uf00d"  // nf-fa-times
                    color: removeArea.containsMouse ? root.fg : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }
                // Search results: \u2606 adds the place as a favourite, \u2605 removes
                // it, without switching to it. A full list takes no more
                // (Model.FAVORITES_MAX).
                MouseArea {
                  id: starArea
                  readonly property bool starred: Model.isFavorite(root.favorites, dropdownRow.modelData)
                  readonly property bool canAdd: root.favorites.length < Model.FAVORITES_MAX
                  visible: !dropdownRow.favorite
                  anchors.right: parent.right
                  anchors.rightMargin: Style.space(8)
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(24)
                  height: parent.height
                  hoverEnabled: true
                  cursorShape: starred || canAdd ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: if (starred || canAdd) root.service.toggleFavorite(dropdownRow.modelData)

                  Text {
                    anchors.centerIn: parent
                    text: starArea.starred ? "\uf005" : "\uf006"  // nf-fa-star / star_o
                    color: starArea.starred ? Color.accent
                      : starArea.containsMouse && starArea.canAdd ? root.fg : root.dim
                    opacity: starArea.starred || starArea.canAdd ? 1 : 0.4
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                }
              }
            }

            Text {
              visible: !root.showingFavorites && root.geocodeSearched && root.locationSuggestions.length === 0
              leftPadding: Style.space(16)
              text: root.t.noResults
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.italic: true
            }
          }

          // ---- No location yet.
          Column {
            visible: !root.hasLocation
            width: parent.width
            spacing: Style.space(10)

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              textFormat: Text.PlainText
              text: root.t.noLocation
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }
            Button {
              anchors.horizontalCenter: parent.horizontalCenter
              visible: !root.editingLocation
              text: root.t.chooseLocation
              onClicked: root.startEditingLocation()
            }
          }

          Text {
            visible: root.hasLocation && !root.view.ready
            leftPadding: Style.space(12)
            text: root.lastError !== "" ? root.t.fetching + " (" + root.lastError + ")" : root.t.fetching
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.italic: true
          }

          // ---- Radar nowcast: one sentence + 2-hour precipitation sparkline.
          Item {
            visible: root.view.ready && !!root.view.nowcast
            width: parent.width
            height: Style.space(28)

            Rectangle {
              anchors.fill: parent
              radius: Style.cornerRadius
              color: root.fg
              opacity: root.view.nowcast && root.view.nowcast.wet ? 0.10 : 0.05
            }

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(12)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "  " + (root.view.nowcast ? root.view.nowcast.summary : "")  // raindrop
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            // Radar map toggle.
            Rectangle {
              id: radarToggle
              anchors.right: parent.right
              anchors.rightMargin: Style.space(4)
              anchors.verticalCenter: parent.verticalCenter
              width: radarToggleText.implicitWidth + Style.space(14)
              height: parent.height - Style.space(8)
              radius: Style.cornerRadius
              color: radarToggleArea.containsMouse || root.radarOpen ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"

              Text {
                id: radarToggleText
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: root.t.radar + (root.radarOpen ? " ‹" : " ›")
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              MouseArea {
                id: radarToggleArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.toggleRadar()
              }
            }

            Row {
              id: sparkline
              anchors.right: radarToggle.left
              anchors.rightMargin: Style.space(10)
              anchors.bottom: parent.bottom
              anchors.bottomMargin: Style.space(6)
              height: Style.space(16)
              spacing: 1

              Repeater {
                model: ScriptModel { values: root.view.nowcast ? root.view.nowcast.points : []; objectProp: "key" }

                Rectangle {
                  required property var modelData
                  anchors.bottom: parent.bottom
                  width: Style.space(4)
                  // Scaled to yr.no's "heavy" level (2.7 mm/h).
                  height: Math.max(1, Math.min(1, modelData.rate / 2.7) * sparkline.height)
                  color: root.fg
                  opacity: modelData.rate > 0 ? 0.8 : 0.25
                }
              }
            }
          }

          // ---- Hourly forecast per day.
          Repeater {
            model: ScriptModel { values: root.view.ready ? root.view.days : []; objectProp: "key" }

            Column {
              id: daySection
              required property var modelData
              required property int index
              width: weatherColumn.width
              spacing: Style.space(2)

              PanelSeparator { width: parent.width }

              Item {
                width: parent.width
                height: dayTitle.implicitHeight

                Text {
                  id: dayTitle
                  topPadding: Style.space(6)
                  bottomPadding: Style.space(4)
                  leftPadding: Style.space(8)
                  textFormat: Text.PlainText
                  text: daySection.modelData.title.toUpperCase()
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.letterSpacing: 1
                  font.bold: true
                }

                // Column icons over temperature, precipitation chance and
                // wind, on the first day only. Column edges as in the rows
                // below (laid out right to left from the row's padding).
                Item {
                  id: columnIcons
                  visible: daySection.index === 0
                  anchors.fill: parent
                  anchors.topMargin: dayTitle.topPadding
                  anchors.bottomMargin: dayTitle.bottomPadding

                  readonly property real charWidth: gustMetrics.advanceWidth / 4
                  readonly property real gap: Style.space(6)
                  readonly property real windX: width - Style.space(8) - root.colWind
                  readonly property real popRight: windX - gap - root.colAmount - gap
                  readonly property real tempRight: popRight - root.colPop - gap

                  component ColumnIcon: Text {
                    required property real center
                    property real glyphScale: 1
                    x: Math.round(center - width / 2)
                    width: Style.space(16)
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Math.round(Style.font.body * glyphScale)
                  }
                  // Over "16°" (the "±2" after it is dim).
                  ColumnIcon { center: columnIcons.tempRight - 3.5 * columnIcons.charWidth; text: "\ue34e"; glyphScale: 11 / 14 }  // thermometer exterior
                  ColumnIcon { center: columnIcons.popRight - columnIcons.charWidth; text: daySection.modelData.precipGlyph }  // rain, sleet or snow
                  // Over the arrow, between speed and gust.
                  ColumnIcon {
                    center: columnIcons.windX + root.windSpeedWidth + root.windGap + root.windArrowWidth / 2
                    text: "\ue34b"  // strong wind
                  }
                }
              }

              Repeater {
                model: ScriptModel { values: modelData.rows; objectProp: "key" }

                Row {
                  required property var modelData
                  x: Style.space(8)
                  width: weatherColumn.width - Style.space(16)
                  height: Style.space(20)
                  spacing: Style.space(6)

                  Text {
                    width: root.colHour
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: modelData.hour
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    width: root.colIcon
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignHCenter
                    textFormat: Text.PlainText
                    text: modelData.icon
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.title
                  }
                  Text {
                    width: parent.width - root.colHour - root.colIcon - root.colTemp - root.colPop - root.colAmount - root.colWind - parent.spacing * 6
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: modelData.description
                    elide: Text.ElideRight
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    width: root.colTemp
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.StyledText
                    text: modelData.temp + "°" + (modelData.tempSpread > 0
                      ? "<font color=\"" + root.faint + "\">±" + modelData.tempSpread + "</font>"
                      : "<font color=\"transparent\">±0</font>")
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    width: root.colPop
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.PlainText
                    text: modelData.precip.probability === null ? "" : modelData.precip.probability + "%"
                    color: modelData.precip.probability >= 30 ? root.fg : root.faint
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }
                  Text {
                    width: root.colAmount
                    anchors.verticalCenter: parent.verticalCenter
                    horizontalAlignment: Text.AlignRight
                    textFormat: Text.PlainText
                    text: modelData.precip.text + (modelData.precip.text !== "" && modelData.periodHours === 6 ? "/6" + root.t.hour : "")
                    color: root.fg
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }
                  // Speed (right-aligned), arrow and gust (left-aligned) in
                  // fixed sub-columns so each lines up across rows.
                  Row {
                    width: root.colWind
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: root.windGap
                    visible: modelData.wind.speed !== null

                    Text {
                      width: root.windSpeedWidth
                      horizontalAlignment: Text.AlignRight
                      textFormat: Text.PlainText
                      text: String(modelData.wind.speed)
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      width: root.windArrowWidth
                      horizontalAlignment: Text.AlignHCenter
                      textFormat: Text.PlainText
                      text: modelData.wind.arrow
                      color: root.fg
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                    Text {
                      textFormat: Text.PlainText
                      text: modelData.wind.gust === null ? "" : "(" + modelData.wind.gust + ")"
                      color: root.faint
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                    }
                  }
                }
              }
            }
          }

          // ---- Daily overview with temperature range bars on a shared scale.
          Column {
            visible: root.view.ready && root.view.longRange.length > 0
            width: parent.width
            spacing: Style.space(2)

            PanelSeparator { width: parent.width }

            // Room between the separator and the first day.
            Item { width: 1; height: Style.space(6) }

            Repeater {
              model: ScriptModel { values: root.view.ready ? root.view.longRange : []; objectProp: "key" }

              Row {
                id: dayRow
                required property var modelData
                x: Style.space(8)
                width: weatherColumn.width - Style.space(16)
                height: Style.space(20)
                spacing: Style.space(8)

                readonly property var rangeScale: root.view.longRangeScale
                readonly property real span: Math.max(1, rangeScale.max - rangeScale.min)

                Text {
                  width: Style.space(40)
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: modelData.day
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
                Text {
                  width: root.colIcon
                  anchors.verticalCenter: parent.verticalCenter
                  horizontalAlignment: Text.AlignHCenter
                  textFormat: Text.PlainText
                  text: modelData.icon
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                }
                Text {
                  width: Style.space(34)
                  anchors.verticalCenter: parent.verticalCenter
                  horizontalAlignment: Text.AlignRight
                  textFormat: Text.PlainText
                  text: modelData.min + "°"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
                Item {
                  id: rangeTrack
                  width: dayRow.width - Style.space(40) - root.colIcon - Style.space(34) * 2 - Style.space(70) - dayRow.spacing * 5
                  height: Style.space(6)
                  anchors.verticalCenter: parent.verticalCenter

                  Rectangle {
                    anchors.fill: parent
                    radius: height / 2
                    color: root.fg
                    opacity: 0.08
                  }
                  Rectangle {
                    x: (dayRow.modelData.min - dayRow.rangeScale.min) / dayRow.span * rangeTrack.width
                    width: Math.max(height, (dayRow.modelData.max - dayRow.modelData.min) / dayRow.span * rangeTrack.width)
                    height: parent.height
                    radius: height / 2
                    color: root.fg
                    opacity: 0.6
                  }
                }
                Text {
                  width: Style.space(34)
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: modelData.max + "°"
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                }
                Text {
                  width: Style.space(70)
                  anchors.verticalCenter: parent.verticalCenter
                  horizontalAlignment: Text.AlignRight
                  textFormat: Text.PlainText
                  text: modelData.precip
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }
          }

          // ---- Footer: sun, moon, and a warning when the forecast is stale.
          Column {
            visible: root.view.ready
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { width: parent.width }

            Item {
              width: parent.width
              height: sunRow.implicitHeight

              Text {
                id: sunRow
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                visible: !!root.view.sun
                textFormat: Text.PlainText
                text: root.view.sun ? " " + root.view.sun.rise + "    " + root.view.sun.set : ""
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                visible: !!root.view.moon
                textFormat: Text.PlainText
                text: root.view.moon
                  ? root.view.moon.icon + " " + root.view.moon.name + " " + root.view.moon.illumination + "%" + (root.view.moon.high !== "" ? "   " + root.view.moon.high : "")
                  : ""
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }

            Item {
              width: parent.width
              height: staleText.implicitHeight
              visible: root.stale

              // Only when the forecast is well past its expiry (offline, or
              // MET down): how old it is. Its parts refresh on their own
              // schedules, so one "updated" time would mislead otherwise.
              Text {
                id: staleText
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                textFormat: Text.PlainText
                text: root.t.stale + (root.view.updatedAt !== "" ? " · " + root.t.forecastFrom + " " + root.view.updatedAt : "")
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }

      // ---- Radar side panel: yr.no's radar on our own map of the Nordics,
      //      only created while shown.
      Column {
        id: radarPane
        visible: root.radarOpen
        anchors.left: weatherScroll.right
        anchors.leftMargin: root.radarGap
        anchors.top: parent.top
        width: Math.max(0, parent.width - weatherScroll.width - root.radarGap)
        spacing: Style.space(8)

        readonly property real mapScale: Math.min(1, width / root.radarMapWidth)

        Rectangle {
          id: radarBox
          width: Math.round(root.radarMapWidth * radarPane.mapScale) + 2
          height: Math.round(root.radarMapHeight * radarPane.mapScale) + 2
          radius: Style.cornerRadius
          color: "transparent"
          border.width: 1
          border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.2)
          clip: true

          // Base map and radar frames, each recoloured by a shader.
          Loader {
            id: yrMapLoader
            anchors.fill: parent
            anchors.margins: 1
            active: root.yrRadarActive
            sourceComponent: yrMapComponent
          }

          // The map needs a place to centre on.
          Text {
            anchors.centerIn: parent
            visible: !root.hasLocation
            textFormat: Text.PlainText
            text: root.t.noLocation
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.italic: true
          }
        }

        // Under the ruler's stamped ticks: how far they are from now. On the
        // right, a status: loading, or paused. The exact time of any frame
        // shows while hovering the ruler.
        Item {
          id: stampRow
          width: radarBox.width
          height: radarStatus.implicitHeight
          visible: root.yrRadarActive

          readonly property int count: root.rulerTicks.length
          // The map inside radarBox's 1 px border, as the ruler measures it.
          readonly property real step: count > 1 ? (width - 2 - 2 * root.rulerPad) / (count - 1) : 0

          Repeater {
            model: ScriptModel {
              values: root.rulerTicks.filter(function(t) { return t.stamp !== "" })
              objectProp: "key"
            }

            Text {
              required property var modelData
              x: Math.round(1 + root.rulerPad + modelData.index * stampRow.step - width / 2)
              // Clear of the status text when it shows.
              visible: radarStatus.text === "" || x + width < radarStatus.x - Style.space(8)
              textFormat: Text.PlainText
              text: modelData.stamp
              color: modelData.forecast ? Color.accent : modelData.level === 1 ? root.dim : root.faint
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Text {
            id: radarStatus
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            textFormat: Text.PlainText
            // While a zoom level's first frames are still downloading (a
            // first visit fetches several hundred tiles), or paused.
            text: !root.yrPlaying ? root.t.radarLoading : root.yrPaused ? "⏸" : ""
            color: root.faint
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }

      // The one place for credits: the forecast (MET Norway), the base map
      // and the radar. Bottom right, level with the footer's sun and moon.
      Text {
        id: credits
        visible: root.radarOpen
        // Right-aligned with the map (which can be narrower than its pane).
        x: radarPane.x + radarBox.width - width - Style.space(4)
        anchors.bottom: parent.bottom
        anchors.bottomMargin: Math.round((sunRow.implicitHeight - implicitHeight) / 2)
        textFormat: Text.PlainText
        text: root.view.attribution + Model.MAP_ATTRIBUTION
        color: root.faint
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Component {
        id: yrMapComponent

        Item {
          id: yrMap
          clip: true

          Rectangle {
            anchors.fill: parent
            color: root.mapLand
          }

          // Base map: mask tiles shipped in map/tiles, coloured by the theme.
          Item {
            anchors.fill: parent
            layer.enabled: true
            layer.effect: ShaderEffect {
              property color landColor: root.mapLand
              property color waterColor: root.mapWater
              property color roadColor: root.mapRoad
              property color borderColor: root.mapBorder
              fragmentShader: Qt.resolvedUrl("shaders/mapdata.frag.qsb")
            }

            Repeater {
              model: ScriptModel { values: root.yrBaseTiles; objectProp: "key" }

              Image {
                required property var modelData
                x: modelData.left
                y: modelData.top
                width: modelData.size
                height: modelData.size
                asynchronous: true
                // Decoded at the drawn size, so tiles shown smaller (zoom 5.5,
                // overview) stay sharp without mipmaps.
                sourceSize.width: Math.min(modelData.size, Model.MAP_TILE_PX)
                sourceSize.height: Math.min(modelData.size, Model.MAP_TILE_PX)
                source: Qt.resolvedUrl(Model.mapTilePath(modelData))
              }
            }
          }

          // The radar shader samples the frame images directly (no offscreen
          // pass). The old loop stays on screen while a replacement decodes.
          RadarImages {
            id: radarImages
            loop: root.yrImageLoop
            playhead: root.yrPlayhead
            directory: root.tilesDir
            token: root.yrPresentationToken
            onPrepared: function(token, ready) {
              if (root.service) root.service.radarImagesPrepared(token, ready)
            }
          }
          // Stands in for a missing image (e.g. right after a zoom): a
          // ShaderEffect warns about any texture property that is null.
          Image {
            id: noRadarImage
            visible: false
          }
          ShaderEffect {
            anchors.fill: parent
            visible: radarImages.current !== null
            property var source: radarImages.current || noRadarImage
            property var coverageMap: radarImages.coverage || noRadarImage
            property real strength: root.radarStrength
            property real dimStrength: root.radarDimStrength
            property real lineStrength: root.radarLineStrength
            property real lineSpacing: root.radarLineSpacing
            property real lineWidth: root.radarLineWidth
            property color lineColor: root.radarLineColor
            property real darkMap: root.mapDarkness
            fragmentShader: Qt.resolvedUrl("shaders/radar.frag.qsb")
          }

          // Lightning (yr.no): strikes from the shown moment's own 5 minutes
          // get a bolt that flares as it appears, those from the 5 minutes
          // before a dimmer one (Model.lightningBolts). Under them, each
          // strike leaves a small dot that fades over
          // Model.LIGHTNING_TRAIL_MS. Dots and dim bolts are drawn once per
          // frame; only the few new bolts are redrawn while they flare.
          Item {
            id: lightning
            anchors.fill: parent
            readonly property var points: root.yrRadarActive && root.mapViewState && root.service
              ? Model.lightningPoints(root.service.lightningStrikes, root.mapViewState, width, height, 30) : []
            readonly property double frameMs: root.yrCurrentFrame ? root.yrCurrentFrame.timeMs : 0
            // The time strikes are shown for; null on forecast frames.
            readonly property var moment: root.service && frameMs && points.length
              ? Model.lightningMoment(frameMs, root.service.yrNowMs, root.service.lightningDataMs) : null
            readonly property var bolts: moment !== null ? Model.lightningBolts(points, moment) : ({ fresh: [], after: [] })
            readonly property color glow: "#ffdf8f"
            readonly property color core: "#fffdf7"
            readonly property color edge: "#0b0d14"
            // 0 → 1 while new bolts flare; 1 at rest.
            property real flash: 1
            onBoltsChanged: {
              if (bolts.fresh.length) flashAnim.restart()
              else { flashAnim.stop(); flash = 1 }
              trail.requestPaint()
              flashes.requestPaint()
            }
            onFlashChanged: flashes.requestPaint()
            NumberAnimation { id: flashAnim; target: lightning; property: "flash"; from: 0; to: 1; duration: 220 }

            function traceLine(ctx, p, pts) {
              ctx.moveTo(p.x + pts[0][0], p.y + pts[0][1])
              for (var i = 1; i < pts.length; i++) ctx.lineTo(p.x + pts[i][0], p.y + pts[i][1])
            }
            function strokeBolt(ctx, p, color, width, alpha) {
              ctx.globalAlpha = alpha
              ctx.strokeStyle = String(color)
              ctx.lineWidth = width
              ctx.beginPath()
              traceLine(ctx, p, p.shape.main)
              for (var b = 0; b < p.shape.branches.length; b++) traceLine(ctx, p, p.shape.branches[b])
              ctx.stroke()
            }
            // A dark edge first, so the bolt stands out on blue rain.
            function drawBolt(ctx, p, alpha, flare) {
              strokeBolt(ctx, p, edge, 4, alpha * 0.55)
              strokeBolt(ctx, p, glow, 2.6 + 3 * flare, alpha * (0.45 + 0.4 * flare))
              strokeBolt(ctx, p, core, 1.2, alpha)
            }

            Canvas {
              id: trail
              anchors.fill: parent
              onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                var moment = lightning.moment
                if (moment === null) return
                ctx.lineJoin = "round"
                ctx.lineCap = "round"
                ctx.fillStyle = String(lightning.glow)
                var points = lightning.points
                for (var i = 0; i < points.length; i++) {
                  var age = moment - points[i].ms
                  if (age < 0 || age >= Model.LIGHTNING_TRAIL_MS) continue
                  ctx.globalAlpha = 0.6 * (1 - age / Model.LIGHTNING_TRAIL_MS)
                  ctx.beginPath()
                  ctx.arc(points[i].x, points[i].y, 1.6, 0, 2 * Math.PI)
                  ctx.fill()
                }
                var after = lightning.bolts.after
                for (var j = 0; j < after.length; j++) lightning.drawBolt(ctx, after[j], 0.35, 0)
                ctx.globalAlpha = 1
              }
            }
            Canvas {
              id: flashes
              anchors.fill: parent
              onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                var fresh = lightning.bolts.fresh
                if (!fresh.length) return
                ctx.lineJoin = "round"
                ctx.lineCap = "round"
                for (var i = 0; i < fresh.length; i++) lightning.drawBolt(ctx, fresh[i], 1, 1 - lightning.flash)
                ctx.globalAlpha = 1
              }
            }
          }

          // Nearby cities and towns (map/places.json), picked per zoom level.
          Repeater {
            model: ScriptModel { values: root.mapLabels; objectProp: "key" }

            Item {
              required property var modelData
              x: modelData.x
              y: modelData.y

              Rectangle {
                x: -width / 2
                y: -height / 2
                width: modelData.capital ? 5 : 4
                height: width
                radius: width / 2
                color: root.dim
              }
              Text {
                x: 6
                y: -height / 2
                textFormat: Text.PlainText
                text: modelData.text
                color: root.dim
                style: Text.Outline
                styleColor: root.mapLand
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: modelData.capital
              }
            }
          }

          // The chosen place: centred when possible, but views stay inside
          // the radar coverage, so near its edge the marker moves off-centre.
          Item {
            readonly property real mx: root.mapViewState ? root.mapViewState.markerX : -100
            readonly property real my: root.mapViewState ? root.mapViewState.markerY : -100
            visible: mx >= 0 && mx <= yrMap.width && my >= 0 && my <= yrMap.height
            x: Math.round(mx)
            y: Math.round(my)

            Rectangle {
              x: -width / 2
              y: -height / 2
              width: 16
              height: 16
              radius: 8
              color: "transparent"
              border.width: 3
              border.color: Color.accent
            }
            Rectangle {
              x: -2
              y: -2
              width: 4
              height: 4
              radius: 2
              color: Color.accent
            }
            Text {
              x: 14
              y: -height / 2
              textFormat: Text.PlainText
              text: root.location.name
              color: root.fg
              style: Text.Outline
              styleColor: root.mapLand
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: root.togglePause()
            onWheel: function(wheel) {
              if (wheel.angleDelta.y !== 0) root.zoomMap(wheel.angleDelta.y > 0 ? 1 : -1)
            }
          }

          // Time ruler: one tick per frame, tallest at "now" and shorter
          // further out, with the frame on screen lit (and the ones played
          // before it brighter), so where the loop is in time stays in the
          // corner of the eye while watching the rain. Press or drag to
          // scrub; that pauses, and a click on the map resumes.
          Item {
            id: ruler
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            // Hit and hover area; the ticks sit at its bottom.
            height: Style.space(36)
            visible: count > 1

            readonly property var ticks: root.rulerTicks
            readonly property int count: ticks.length
            readonly property int pad: root.rulerPad
            readonly property real step: count > 1 ? (width - 2 * pad) / (count - 1) : 0
            readonly property int current: Math.min(root.yrFrame, count - 1)
            readonly property int tickMin: Style.space(2)
            readonly property int tickMax: Style.space(20)
            readonly property bool active: rulerArea.containsMouse || rulerArea.pressed
            readonly property int hoverIndex: rulerArea.pressed ? current : indexAt(rulerArea.mouseX)
            // Hovering or scrubbing makes the ruler taller.
            property real grow: active ? 1.5 : 1
            Behavior on grow { NumberAnimation { duration: 120; easing.type: Easing.OutCubic } }

            function indexAt(x) {
              return step > 0 ? Math.max(0, Math.min(count - 1, Math.round((x - pad) / step))) : 0
            }

            // A light wash so the ticks read over rain and roads alike.
            Rectangle {
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              height: Math.round(Style.space(22) * ruler.grow)
              gradient: Gradient {
                GradientStop { position: 0; color: Qt.rgba(root.mapLand.r, root.mapLand.g, root.mapLand.b, 0) }
                GradientStop { position: 1; color: Qt.rgba(root.mapLand.r, root.mapLand.g, root.mapLand.b, 0.75) }
              }
            }

            Repeater {
              model: ScriptModel { values: ruler.ticks; objectProp: "key" }

              Rectangle {
                required property var modelData
                required property int index
                readonly property bool isCurrent: index === ruler.current
                readonly property real base: ruler.tickMin + (ruler.tickMax - ruler.tickMin) * modelData.level
                x: Math.round(ruler.pad + index * ruler.step - width / 2)
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Style.space(6)
                width: isCurrent ? 3 : 2
                // The lit tick: at least 18 px, and always a head taller than
                // the tick it stands on.
                height: Math.round((isCurrent ? Math.max(Style.space(18), base + Style.space(6)) : base) * ruler.grow)
                radius: 1
                color: isCurrent && modelData.forecast ? Color.accent : root.fg
                // Not downloaded yet: barely there. Now and the stamped hours
                // a bit stronger.
                opacity: isCurrent ? 1
                  : modelData.level === 1 ? 0.8
                  : index >= root.yrPlayLimit ? 0.12
                  : (index < ruler.current ? 0.55 : 0.3) + (modelData.stamp !== "" ? 0.15 : 0)
              }
            }

            // The time under the pointer while hovering or scrubbing.
            Text {
              readonly property var frame: root.yrDisplay.frames[ruler.hoverIndex] || null
              visible: ruler.active && frame !== null
              x: Math.max(Style.space(4), Math.min(parent.width - width - Style.space(4),
                Math.round(ruler.pad + ruler.hoverIndex * ruler.step - width / 2)))
              y: parent.height - Style.space(6) - Math.round(ruler.tickMax * 1.5) - Style.space(8) - height
              textFormat: Text.PlainText
              text: Model.mapFrameLabel(frame, root.lang)
              color: frame && frame.forecast ? Color.accent : root.fg
              style: Text.Outline
              styleColor: root.mapLand
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            MouseArea {
              id: rulerArea
              anchors.fill: parent
              hoverEnabled: true
              preventStealing: true
              cursorShape: Qt.PointingHandCursor
              onPressed: function(mouse) { root.seekFrame(ruler.indexAt(mouse.x)) }
              onPositionChanged: function(mouse) { if (pressed) root.seekFrame(ruler.indexAt(mouse.x)) }
              // Zooming with the wheel works over the ruler too.
              onWheel: function(wheel) {
                if (wheel.angleDelta.y !== 0) root.zoomMap(wheel.angleDelta.y > 0 ? 1 : -1)
              }
            }
          }

          // Zoom buttons.
          Column {
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Style.space(8)
            spacing: Style.space(4)

            Repeater {
              model: [{ label: "+", delta: 1 }, { label: "−", delta: -1 }]

              Rectangle {
                required property var modelData
                readonly property bool enabledStep: modelData.delta > 0
                  ? root.mapStep < Model.MAP_ZOOM_STEPS.length - 1
                  : root.mapStep > 0
                width: Style.space(24)
                height: width
                radius: Style.cornerRadius
                color: zoomArea.containsMouse && enabledStep ? Style.hoverFillFor(root.fg, Color.accent) : root.mapLand
                border.width: 1
                border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.25)
                opacity: enabledStep ? 1 : 0.4

                Text {
                  anchors.centerIn: parent
                  textFormat: Text.PlainText
                  text: modelData.label
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.title
                }
                MouseArea {
                  id: zoomArea
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: enabledStep ? Qt.PointingHandCursor : Qt.ArrowCursor
                  onClicked: root.zoomMap(modelData.delta)
                }
              }
            }
          }
        }
      }
    }
  }
}
