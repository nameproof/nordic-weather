import QtQuick
import qs.Commons
import qs.Ui

// Bar pill: condition icon + temperature, from Service.qml (one instance for
// every monitor). This widget forwards the shell's lifecycle calls to its
// panel and hands the panel the service.
BarWidget {
  id: root
  moduleName: "io.github.nameproof.nordic-weather"

  readonly property var service: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor(moduleName) : null

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    if ("service" in target) target.service = root.service
  }

  // The settings on this widget's bar entry shape the forecast the service
  // builds (hour step, days); every monitor's entry is the same one.
  function pushSettings() {
    if (service) service.setDisplaySettings(settings)
  }

  // The panel only exists while it is open, and for a few seconds after it
  // closes (its close animation; quick reopening). All data lives in the
  // service, so nothing is lost when it goes. Quickshell's guide: "The main
  // thing you can do to reduce the memory usage … is to use Loaders."
  property bool panelWanted: false

  function ensurePanel() {
    unloadPanel.stop()
    panelWanted = true
  }

  function togglePanel() {
    if (root.opened) root.close()
    else root.open()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  onOpenedChanged: if (!opened) unloadPanel.restart()

  function open() {
    ensurePanel()
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property var barView: service ? service.view.bar : null
  readonly property bool stale: service ? service.stale : false
  // No location yet: a map marker, so there is always something to click.
  readonly property bool needsLocation: service ? !service.hasLocation : false
  readonly property string pillText: needsLocation ? ""
    : barView ? (root.vertical ? barView.icon : barView.text) : ""

  visible: pillText !== ""
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: {
    injectPanel()
    pushSettings()
  }
  onServiceChanged: {
    injectPanel()
    pushSettings()
  }

  Timer {
    id: unloadPanel
    interval: 5000
    onTriggered: if (!root.opened) root.panelWanted = false
  }

  Loader {
    id: panelLoader
    active: root.panelWanted
    // Synchronous, so open() can use the panel as soon as it asks for it.
    asynchronous: false
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.pillText
    dimmed: root.stale
    // The panel is the detail view.
    tooltipText: ""

    onPressed: function(b) {
      if (!root.bar) return
      if (b === Qt.RightButton) { if (root.service) root.service.notify() }
      else if (b === Qt.MiddleButton) { if (root.service) root.service.refresh(true) }
      else root.togglePanel()
    }
  }
}
