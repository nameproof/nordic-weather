// WorkerScript for Service.qml: estimates a loop's motion (Flow.mjs) off
// the GUI thread. Created for one loop and destroyed after it.
import { loopFlow } from "Flow.mjs"

WorkerScript.onMessage = function(message) {
  const started = Date.now()
  let result = null
  let error = ""
  try {
    result = loopFlow(message.data, message.w, message.h, message.count, message.mapWidth, message.mapHeight, message.options)
  } catch (e) {
    error = String(e)
  }
  WorkerScript.sendMessage({ key: message.key, result: result, error: error, ms: Date.now() - started })
}
