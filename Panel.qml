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

  readonly property string radarSource: service ? service.radarSource : "met"
  readonly property double radarFileTimeMs: service ? service.radarFileTimeMs : 0
  readonly property bool metRadarActive: opened && radarOpen && radarSource === "met"
  readonly property bool yrRadarActive: opened && radarOpen && radarSource === "yr" && !!service && service.yrRadarActive

  readonly property int mapStep: service ? service.mapStep : Model.MAP_DEFAULT_STEP
  readonly property var mapViewState: yrRadarActive ? service.mapViewState : null
  readonly property var yrBaseTiles: yrRadarActive ? service.yrBaseTiles : []
  readonly property var yrRadarTiles: yrRadarActive ? service.yrRadarTiles : []
  readonly property int yrRadarRevision: service ? service.yrRadarRevision : 0
  readonly property int yrFramesRevision: service ? service.yrFramesRevision : 0
  readonly property string yrViewKey: service ? service.yrViewKey : ""
  readonly property bool yrShownValid: yrRadarActive && service.yrShownValid
  readonly property var yrDisplay: service ? service.yrDisplay : ({ frames: [], nowIndex: -1 })
  readonly property var yrCurrentFrame: service ? service.yrCurrentFrame : null
  readonly property int yrFrame: service ? service.yrFrame : 0
  readonly property bool yrPaused: service ? service.yrPaused : false
  readonly property bool yrPlaying: service ? service.yrPlaying : false
  readonly property int yrPlayLimit: service ? service.yrPlayLimit : 0

  // Smoothing test (see Service.qml): off, fade or flow.
  readonly property string radarSmoothing: service ? service.radarSmoothing : "off"
  readonly property int radarFps: service ? service.radarFps : 8
  readonly property bool yrSmooth: radarSmoothing !== "off"
  readonly property real yrBlend: service ? service.yrBlend : 0
  readonly property int yrCurrentIndex: service ? service.yrCurrentIndex : -1
  readonly property var yrSlots: service ? service.yrSlots : ({ frames: [null, null], current: 0 })
  readonly property bool yrFlowReady: service ? service.yrFlowReady : false
  readonly property var yrFlowInfo: service ? service.yrFlowInfo : null
  readonly property int yrFlowRevision: service ? service.yrFlowRevision : 0

  function yrFrameUrl(frame) {
    return frame ? "file://" + tilesDir + "/" + Model.radarFrameFile(frame, yrViewKey) + "?v=" + yrFramesRevision : ""
  }

  function refresh(force) { if (service) service.refresh(force) }
  function zoomMap(delta) { if (service) service.zoomMap(delta) }
  function setRadarSource(source) { if (service) service.setRadarSource(source) }
  function togglePause() { if (service) service.togglePause() }
  function seekFrame(index) { if (service) service.seekFrame(index) }
  function stepFrame(delta) { if (service) service.stepFrame(delta) }
  function setRadarSmoothing(mode) { if (service) service.setRadarSmoothing(mode) }
  function setRadarFps(fps) { if (service) service.setRadarFps(fps) }

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
  onLocationSuggestionsChanged: suggestionIndex = 0

  function startEditingLocation() {
    editingLocation = true
    suggestionIndex = 0
    if (service) service.clearSearch()
    Qt.callLater(function() {
      locationField.text = root.location.name
      locationField.selectAll()
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
    // An empty search is not a way to remove the location; it just cancels.
    if (locationField.text.trim() === "") {
      if (hasLocation) cancelEditingLocation()
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

  // Forecast column width; the radar side panel is added next to it.
  readonly property int forecastWidth: Style.space(540)
  readonly property int radarGap: Style.space(16)
  // MET's GIF is 659×761; shown 1:1 when it fits so its labels stay sharp.
  readonly property int radarNativeWidth: 659
  readonly property int radarNativeHeight: 761

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
    contentWidth: panel.fittedContentWidth(root.forecastWidth + (root.radarOpen ? root.radarGap + root.radarNativeWidth : 0))
    contentHeight: panel.fittedContentHeight(Math.max(weatherColumn.implicitHeight, root.radarOpen ? radarPane.implicitHeight : 0))

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

              // Place name; click to search.
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
                  onTextChanged: if (root.editingLocation && !root.savingLocation) geocodeDebounce.restart()
                  Keys.onPressed: function(event) {
                    if (event.key === Qt.Key_Escape) {
                      if (root.hasLocation) root.cancelEditingLocation()
                      else root.close()
                      event.accepted = true
                    } else if (event.key === Qt.Key_Down) {
                      if (root.suggestionIndex < root.locationSuggestions.length - 1) root.suggestionIndex++
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

              Row {
                anchors.right: parent.right
                visible: root.view.ready
                spacing: Style.space(28)

                Repeater {
                  model: root.view.current ? [
                    { label: root.t.feels, value: root.view.current.feelsLike === null ? "—" : root.view.current.feelsLike + "°", sub: "" },
                    { label: root.t.wind, value: root.view.current.wind.speed === null ? "—"
                        : root.view.current.wind.speed + " m/s " + root.view.current.wind.dirLabel + " " + root.view.current.wind.arrow,
                      sub: root.view.current.wind.gust === null ? "" : "(" + root.t.gust + " " + root.view.current.wind.gust + ")" },
                    { label: root.t.humidity, value: root.view.current.humidity === null ? "—" : root.view.current.humidity + "%", sub: "" }
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

          // ---- Search suggestions.
          Column {
            visible: root.editingLocation && !root.savingLocation
              && (root.locationSuggestions.length > 0 || root.geocodeSearched)
            width: parent.width
            spacing: 0

            Repeater {
              model: ScriptModel { values: root.locationSuggestions; objectProp: "key" }

              Rectangle {
                required property var modelData
                required property int index
                width: parent.width
                height: suggestionRow.implicitHeight + Style.space(12)
                radius: Style.cornerRadius
                color: index === root.suggestionIndex ? Style.hoverFillFor(root.fg, Color.accent) : "transparent"

                Row {
                  id: suggestionRow
                  anchors.left: parent.left
                  anchors.leftMargin: Style.space(16)
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)

                  Text {
                    textFormat: Text.PlainText
                    text: modelData.name
                    color: index === root.suggestionIndex ? Style.hoverStateColor(root.fg, Color.accent) : root.fg
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
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onPositionChanged: root.suggestionIndex = index
                  onClicked: root.pickSuggestion(modelData)
                }
              }
            }

            Text {
              visible: root.geocodeSearched && root.locationSuggestions.length === 0
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
              required property var modelData
              width: weatherColumn.width
              spacing: Style.space(2)

              PanelSeparator { width: parent.width }

              Text {
                topPadding: Style.space(6)
                bottomPadding: Style.space(4)
                leftPadding: Style.space(8)
                textFormat: Text.PlainText
                text: modelData.title.toUpperCase()
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
                font.bold: true
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
                    text: modelData.precip.text + (modelData.precip.text !== "" && modelData.periodHours === 6 ? "/6h" : "")
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

            Text {
              topPadding: Style.space(6)
              bottomPadding: Style.space(4)
              leftPadding: Style.space(8)
              textFormat: Text.PlainText
              text: root.t.comingDays.toUpperCase()
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1
              font.bold: true
            }

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

          // ---- Footer: sun, moon, attribution, freshness.
          Column {
            visible: root.view.ready
            width: parent.width
            spacing: Style.space(6)

            PanelSeparator { width: parent.width }

            Item {
              width: parent.width
              height: sunRow.implicitHeight

              Row {
                id: sunRow
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                spacing: Style.space(10)
                visible: !!root.view.sun

                Text {
                  textFormat: Text.PlainText
                  text: root.view.sun ? " " + root.view.sun.rise + "    " + root.view.sun.set : ""
                  color: root.fg
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                Text {
                  textFormat: Text.PlainText
                  visible: text !== ""
                  text: root.view.sun && root.view.sun.dayLength !== "" ? "(" + root.view.sun.dayLength + ")" : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }
              }

              Text {
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                visible: !!root.view.moon
                textFormat: Text.PlainText
                text: root.view.moon
                  ? root.view.moon.icon + " " + root.view.moon.name + " " + root.view.moon.illumination + "%" + (root.view.moon.rise !== "" ? "    " + root.view.moon.rise : "")
                  : ""
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
            }

            Item {
              width: parent.width
              height: attributionText.implicitHeight

              Text {
                id: attributionText
                anchors.left: parent.left
                anchors.leftMargin: Style.space(8)
                textFormat: Text.PlainText
                // The one place for credits; the map's are added while it is shown.
                text: root.view.attribution + (root.yrRadarActive ? Model.MAP_ATTRIBUTION : "")
                color: root.faint
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              Text {
                anchors.right: parent.right
                anchors.rightMargin: Style.space(8)
                textFormat: Text.PlainText
                text: (root.stale ? root.t.stale + " · " : "") + root.t.updated + " " + root.view.updatedAt
                color: root.stale ? root.fg : root.faint
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
      }

      // ---- Radar side panel: MET's Nordic radar GIF or the yr.no-style map,
      //      switched at the bottom. Each view is only created while shown.
      Column {
        id: radarPane
        visible: root.radarOpen
        anchors.left: weatherScroll.right
        anchors.leftMargin: root.radarGap
        anchors.top: parent.top
        width: Math.max(0, parent.width - weatherScroll.width - root.radarGap)
        spacing: Style.space(8)

        readonly property real imageScale: Math.min(1, width / root.radarNativeWidth)

        Rectangle {
          id: radarBox
          width: Math.round(root.radarNativeWidth * radarPane.imageScale) + 2
          height: Math.round(root.radarNativeHeight * radarPane.imageScale) + 2
          radius: Style.cornerRadius
          color: "transparent"
          border.width: 1
          border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.2)
          clip: true

          // MET: decode GIF frames on the fly (≈2 MB) instead of caching all 19 (≈38 MB).
          Loader {
            id: radarLoader
            anchors.fill: parent
            anchors.margins: 1
            active: root.metRadarActive && root.radarFileTimeMs > 0
            sourceComponent: AnimatedImage {
              cache: false
              asynchronous: true
              playing: visible
              smooth: radarPane.imageScale < 1
              fillMode: Image.PreserveAspectFit
              // The query changes per radar time so a new GIF is re-read.
              source: "file://" + root.cacheDir + "/radar.gif?t=" + root.radarFileTimeMs
            }
          }

          // yr.no: base map and radar tiles, each recoloured by a shader.
          Loader {
            id: yrMapLoader
            anchors.fill: parent
            anchors.margins: 1
            active: root.yrRadarActive
            sourceComponent: yrMapComponent
          }

          Text {
            anchors.centerIn: parent
            visible: root.radarSource === "met" && radarLoader.status !== Loader.Ready
            textFormat: Text.PlainText
            text: root.t.radarLoading
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.italic: true
          }
        }

        Item {
          width: radarBox.width
          height: radarFrameLabel.implicitHeight

          Text {
            id: radarFrameLabel
            anchors.left: parent.left
            anchors.leftMargin: Style.space(4)
            textFormat: Text.PlainText
            // Local time of the frame on screen (MET's GIF stamp is UTC).
            text: root.radarSource === "yr"
              ? Model.mapFrameLabel(root.yrCurrentFrame, root.lang) + (root.yrPaused ? "  ⏸" : "")
              : (radarLoader.item && radarLoader.item.frameCount > 0
                ? Model.radarFrameLabel(root.radarFileTimeMs, radarLoader.item.frameCount, radarLoader.item.currentFrame)
                : "")
            color: root.yrCurrentFrame && root.yrCurrentFrame.forecast && root.radarSource === "yr" ? Color.accent : root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
          }
          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: radarFrameLabel.verticalCenter
            textFormat: Text.PlainText
            // Only a status: while a zoom level's radar tiles are still
            // downloading (the first visit fetches several hundred). Credits
            // live in the panel footer.
            text: root.radarSource === "yr" && root.yrRadarActive && !root.yrPlaying ? root.t.radarLoading : ""
            color: root.faint
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        // Source toggle.
        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: 0

          Repeater {
            model: [{ id: "met", label: "MET" }, { id: "yr", label: "yr.no" }]

            Rectangle {
              required property var modelData
              required property int index
              readonly property bool selected: root.radarSource === modelData.id
              width: sourceLabel.implicitWidth + Style.space(24)
              height: sourceLabel.implicitHeight + Style.space(8)
              radius: Style.cornerRadius
              color: selected ? Style.hoverFillFor(root.fg, Color.accent)
                : (sourceArea.containsMouse ? Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.06) : "transparent")
              border.width: 1
              border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, selected ? 0.35 : 0.15)

              Text {
                id: sourceLabel
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: modelData.label
                color: selected ? root.fg : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }
              MouseArea {
                id: sourceArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.setRadarSource(modelData.id)
              }
            }
          }
        }

        // Smoothing test (temporary): how the frames in between radar frames
        // are drawn, and how many drawings per second.
        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          visible: root.radarSource === "yr"
          spacing: 0

          Repeater {
            model: [
              { kind: "mode", value: "off", label: "Off" },
              { kind: "mode", value: "fade", label: "Fade" },
              { kind: "mode", value: "flow", label: "Flow" },
              { kind: "gap" },
              { kind: "fps", value: 8, label: "8 fps" },
              { kind: "fps", value: 12, label: "12" },
              { kind: "fps", value: 16, label: "16" }
            ]

            Rectangle {
              required property var modelData
              readonly property bool gap: modelData.kind === "gap"
              readonly property bool selected: modelData.kind === "mode" ? root.radarSmoothing === modelData.value
                : modelData.kind === "fps" && root.radarFps === modelData.value
              width: gap ? Style.space(12) : smoothLabel.implicitWidth + Style.space(18)
              height: smoothLabel.implicitHeight + Style.space(8)
              radius: Style.cornerRadius
              opacity: modelData.kind === "fps" && !root.yrSmooth ? 0.4 : 1
              color: gap ? "transparent" : selected ? Style.hoverFillFor(root.fg, Color.accent)
                : (smoothArea.containsMouse ? Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.06) : "transparent")
              border.width: gap ? 0 : 1
              border.color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, selected ? 0.35 : 0.15)

              Text {
                id: smoothLabel
                anchors.centerIn: parent
                visible: !parent.gap
                textFormat: Text.PlainText
                text: modelData.label || ""
                color: parent.selected ? root.fg : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
              MouseArea {
                id: smoothArea
                anchors.fill: parent
                enabled: !parent.gap
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  if (modelData.kind === "mode") root.setRadarSmoothing(modelData.value)
                  else root.setRadarFps(modelData.value)
                }
              }
            }
          }
        }
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

          // Radar, assembled frames: the frame image feeds the radar shader
          // directly (a ShaderEffect can sample an Image; no offscreen pass
          // per frame), and decodes in a background thread while the previous
          // frame stays on screen (retainWhileLoading, Qt ≥ 6.8).
          Image {
            id: radarFrameImage
            anchors.fill: parent
            visible: false
            smooth: false
            cache: false
            asynchronous: true
            retainWhileLoading: true
            source: !root.yrSmooth && root.yrShownValid ? root.yrFrameUrl(root.yrCurrentFrame) : ""
          }
          ShaderEffect {
            anchors.fill: parent
            // Loading also counts: retainWhileLoading keeps the previous frame up.
            visible: !root.yrSmooth && root.yrShownValid && radarFrameImage.status !== Image.Null && radarFrameImage.status !== Image.Error
            property var source: radarFrameImage
            property real strength: root.radarStrength
            property real dimStrength: root.radarDimStrength
            property real lineStrength: root.radarLineStrength
            property real lineSpacing: root.radarLineSpacing
            property real lineWidth: root.radarLineWidth
            property color lineColor: root.radarLineColor
            fragmentShader: Qt.resolvedUrl("shaders/radar.frag.qsb")
          }

          // Smoothing test: the current and the upcoming frame in two images
          // that swap roles at every frame (Service.yrSlots), so each frame is
          // decoded once, while it waits as the upcoming one. Filtered, because flow
          // samples between pixels.
          Image {
            id: smoothImage0
            anchors.fill: parent
            visible: false
            smooth: true
            cache: false
            asynchronous: true
            retainWhileLoading: true
            source: root.yrSmooth && root.yrShownValid
              ? root.yrFrameUrl(root.yrSlots.frames[0]) : ""
          }
          Image {
            id: smoothImage1
            anchors.fill: parent
            visible: false
            smooth: true
            cache: false
            asynchronous: true
            retainWhileLoading: true
            source: root.yrSmooth && root.yrShownValid
              ? root.yrFrameUrl(root.yrSlots.frames[1]) : ""
          }
          // The loop's motion field atlas (Flow.mjs), filtered so motion
          // varies smoothly between cells.
          Image {
            id: flowImage
            visible: false
            smooth: true
            cache: false
            asynchronous: true
            source: root.radarSmoothing === "flow" && root.yrFlowReady
              ? "file://" + root.tilesDir + "/flow.ppm?v=" + root.yrFlowRevision : ""
          }
          ShaderEffect {
            anchors.fill: parent
            readonly property var current: root.yrSlots.current === 0 ? smoothImage0 : smoothImage1
            readonly property var upcoming: root.yrSlots.current === 0 ? smoothImage1 : smoothImage0
            readonly property bool upcomingReady: upcoming.status === Image.Ready
            readonly property bool flowUsable: root.radarSmoothing === "flow" && root.yrFlowReady
              && flowImage.status === Image.Ready && root.yrFlowInfo !== null
            visible: root.yrSmooth && root.yrShownValid && current.status !== Image.Null && current.status !== Image.Error
            property var sourceA: current
            property var sourceB: upcomingReady ? upcoming : current
            property var flowField: flowUsable ? flowImage : current
            property real blend: upcomingReady ? root.yrBlend : 0
            property real flowOn: flowUsable ? 1 : 0
            property real flowPair: Math.max(0, root.yrCurrentIndex)
            property real flowPairs: root.yrFlowInfo ? root.yrFlowInfo.pairs : 1
            property real flowUnit: root.yrFlowInfo ? root.yrFlowInfo.unit : 1
            property vector2d flowGrid: root.yrFlowInfo ? Qt.vector2d(root.yrFlowInfo.gx, root.yrFlowInfo.gy) : Qt.vector2d(1, 1)
            property vector2d flowCell: root.yrFlowInfo ? Qt.vector2d(root.yrFlowInfo.cellW, root.yrFlowInfo.cellH) : Qt.vector2d(1, 1)
            property vector2d mapSize: Qt.vector2d(width, height)
            property real strength: root.radarStrength
            property real dimStrength: root.radarDimStrength
            property real lineStrength: root.radarLineStrength
            property real lineSpacing: root.radarLineSpacing
            property real lineWidth: root.radarLineWidth
            property color lineColor: root.radarLineColor
            fragmentShader: Qt.resolvedUrl("shaders/radar-smooth.frag.qsb")
          }

          // Until then (first open, new zoom): the frame's tiles, combined in
          // a layer. Loaded synchronously so a frame never shows a mix of two.
          Item {
            anchors.fill: parent
            visible: !root.yrShownValid
            layer.enabled: visible
            layer.smooth: true
            layer.effect: ShaderEffect {
              property real strength: root.radarStrength
              property real dimStrength: root.radarDimStrength
              property real lineStrength: root.radarLineStrength
              property real lineSpacing: root.radarLineSpacing
              property real lineWidth: root.radarLineWidth
              property color lineColor: root.radarLineColor
              fragmentShader: Qt.resolvedUrl("shaders/radar.frag.qsb")
            }

            Repeater {
              model: ScriptModel { values: root.yrShownValid ? [] : root.yrRadarTiles; objectProp: "key" }

              Image {
                required property var modelData
                x: modelData.left
                y: modelData.top
                width: modelData.size
                height: modelData.size
                smooth: true
                // No pixmap cache: a full animation is ~1000 tiles (≈270 MB
                // decoded). No mipmaps: they would only be regenerated per
                // frame, and mixed settings on shared cached textures make Qt
                // warn and keep the old filtering (QSGPlainTexture).
                cache: false
                asynchronous: false
                source: root.yrCurrentFrame && root.yrRadarRevision > 0
                  ? "file://" + root.tilesDir + "/" + Model.radarTileFile(modelData, root.yrCurrentFrame) + "?v=" + root.yrRadarRevision
                  : ""
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

            readonly property var ticks: Model.rulerTicks(root.yrDisplay.frames, root.yrDisplay.nowIndex)
            readonly property int count: ticks.length
            readonly property int pad: Style.space(16)
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
                // Not downloaded yet: barely there. Now and full hours a bit
                // stronger.
                opacity: isCurrent ? 1
                  : modelData.level === 1 ? 0.8
                  : index >= root.yrPlayLimit ? 0.12
                  : (index < ruler.current ? 0.55 : 0.3) + (modelData.hour ? 0.15 : 0)
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
