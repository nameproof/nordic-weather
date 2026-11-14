import QtQuick
import Quickshell
import "." as Weather
import "Model.js" as Model

// Warning checks in the real service, without network: requests are
// recorded instead of started, and answers are fed to its response handler.
Scope {
  id: test
  property var started: []
  property int writes: 0

  Weather.Service {
    id: service
    location: ({ name: "Test", latitude: 57.93, longitude: 12.53 })
    function maybeFetch(force) { maybeFetchWarnings(force) }
    function setLocationIfChanged(next) {}
    function detectLocation() {}
    function startWarnFetch(proc, kind, url, due) { if (due) test.started.push(kind) }
    function writeWarnStore() { test.writes++ }
  }

  function check(ok, description) {
    if (!ok) throw new Error(description)
  }
  function viewer(open) { service.updateViewer("test", { open: open, radarOpen: false, width: 256, height: 192 }) }
  function take() { var s = started; started = []; return s.join(",") }
  function http(status, headers, body) { return "HTTP/2 " + status + "\r\n" + headers.join("\r\n") + "\r\n\r\n" + (body || "") }
  function rss(titles) {
    return "<rss version=\"2.0\"><channel>" + titles.map(function(t, i) {
      return "<item><title>" + t + "</title><guid>urn:" + i + "</guid></item>" }).join("") + "</channel></rss>"
  }
  function atom(ids) {
    return "<feed>" + ids.map(function(id) {
      return "<entry><alert><identifier>" + id + "</identifier><status>Actual</status><msgType>Alert</msgType></alert></entry>" }).join("") + "</feed>"
  }
  readonly property string seaTitle: "Yellow wind warning for sea area: Gulf of Finland, Sat 5.06 - 18.00"
  readonly property string landTitle: "Yellow traffic weather warning: Southern Lapland, Sat 5.06 - Sun 0.00"

  function run() {
    // Closed panel: nothing, ever.
    service.maybeFetch(true)
    check(take() === "", "no checks while every panel is closed")

    // Sweden: SMHI only, once per opening window.
    viewer(true)
    service.maybeFetch(false)
    check(take() === "warnSmhi", "Alingsås asks SMHI only")
    service.handleResponse("warnSmhi", Model.SMHI_WARNINGS_URL, http(200, ["etag: W/\"a\""], "[]"))
    service.maybeFetch(false)
    check(take() === "", "no second check right after the first")
    var stored = service.warnStore
    service.handleResponse("warnSmhi", Model.SMHI_WARNINGS_URL, http(200, ["etag: W/\"a\"", "last-modified: x"], "[]"))
    check(service.warnStore === stored, "an unchanged 200 leaves the store (and file) alone")
    service.handleResponse("warnSmhi", Model.SMHI_WARNINGS_URL, http(304, ["etag: W/\"a\""]))
    check(service.warnStore === stored, "a 304 with the same ETag leaves the store alone")
    service.handleResponse("warnSmhi", Model.SMHI_WARNINGS_URL, http(200, ["etag: W/\"a\""], "<html>"))
    check(service.warnStore === stored, "an unreadable body never replaces what is stored")

    // Finland: the RSS first; the Atom feed only for land warnings.
    service.location = ({ name: "Rovaniemi", latitude: 66.5, longitude: 25.73 })
    check(take() === "warnFmiRss", "Rovaniemi asks FMI's RSS only")
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r1\""], rss([seaTitle])))
    check(take() === "" && service.warnStore.fmi.warnings.length === 0 && service.warnStore.fmi.etag === "\"r1\"",
          "sea warnings only: stored as none, no Atom download")

    // The panel closes while the RSS is on its way: no Atom download.
    viewer(false)
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r2\""], rss([landTitle])))
    check(take() === "" && service.fmiPending === null, "no Atom download once the panel has closed")
    check(service.warnStore.fmi.etag === "\"r1\"", "the unfollowed RSS answer is not kept")

    // Open again: land warnings fetch the Atom feed; one out of step with the
    // RSS is kept without the RSS validators and retried.
    viewer(true)
    service.refresh(true)
    check(take() === "warnFmiRss", "a forced refresh asks the RSS again")
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r2\""], rss([seaTitle, landTitle])))
    check(take() === "warnFmiAtom" && service.fmiPending !== null, "land warnings fetch the Atom feed")
    service.handleResponse("warnFmiAtom", Model.FMI_ATOM_URL, http(200, [], atom(["urn:0"])))
    check(service.warnStore.fmi.etag === "" && !!service.failures.warnFmiRss, "an Atom feed out of step is retried")
    service.failures = ({})
    service.maybeFetch(false)
    check(take() === "warnFmiRss", "the retry asks the RSS again")
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r2\""], rss([seaTitle, landTitle])))
    take()
    service.handleResponse("warnFmiAtom", Model.FMI_ATOM_URL, http(200, [], atom(["urn:0", "urn:1"])))
    check(service.warnStore.fmi.etag === "\"r2\"" && !service.failures.warnFmiRss, "an Atom feed in step commits the RSS validators")
    service.maybeFetch(false)
    check(take() === "", "nothing more to ask once both are in")

    // A failed Atom download backs the pair off instead of re-asking every minute.
    service.refresh(true)
    take()
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r3\""], rss([landTitle])))
    take()
    service.handleResponse("warnFmiAtom", Model.FMI_ATOM_URL, http(503, [], ""))
    service.maybeFetch(false)
    check(take() === "" && service.fmiPending === null, "a failed Atom download backs off")

    // Moved out of Finland before the RSS answered: no Atom download.
    service.failures = ({})
    service.location = ({ name: "Oslo", latitude: 59.91, longitude: 10.75 })
    check(take() === "warnMet", "Oslo asks MET only")
    service.handleResponse("warnFmiRss", Model.FMI_RSS_URL, http(200, ["etag: \"r4\""], rss([landTitle])))
    check(take() === "", "no Atom download for a place outside Finland")

    // MET: the same warnings under a newer Last-Modified update the
    // validator in memory but don't rewrite the file.
    var metUrl = service.metWarningsUrl()
    var metBody = JSON.stringify({ features: [] })
    service.handleResponse("warnMet", metUrl, http(200, ["last-modified: Sat, 14 Nov 2026 05:00:00 GMT"], metBody))
    var before = writes
    service.handleResponse("warnMet", metUrl, http(200, ["last-modified: Sat, 14 Nov 2026 05:10:00 GMT"], metBody))
    check(writes === before && service.warnStore.met.lastModified === "Sat, 14 Nov 2026 05:10:00 GMT",
          "new validators alone are kept in memory, not written")

    // Denmark: no provider.
    service.location = ({ name: "København", latitude: 55.68, longitude: 12.57 })
    check(take() === "", "Copenhagen asks nobody")
  }

  Timer {
    interval: 50
    repeat: true
    running: true
    property int waited: 0
    onTriggered: {
      if (!service.countryOutlines || !service.warnStoreLoaded) {
        if (++waited > 100) { console.log("WARNINGS_SERVICE_FAIL: service not ready"); Qt.quit() }
        return
      }
      running = false
      try {
        test.run()
        console.log("WARNINGS_SERVICE_PASS")
      } catch (e) {
        console.log("WARNINGS_SERVICE_FAIL: " + e.message)
      }
      Qt.quit()
    }
  }
}
