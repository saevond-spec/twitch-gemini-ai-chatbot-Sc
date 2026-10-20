package com.saevond.sweatyobs

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Future network-mixer command bridge. No MediaProjection/AudioRecord dependencies.
 * The bridge is dormant until a real PS5 audio mixer and RTMPS transport exist.
 */
fun interface MusicControlSink {
  fun command(action: String)
}

class MusicBridgePoller(
  private val origin: String,
  private val token: String,
  private val mixer: MusicControlSink
) {
  @Volatile private var active = false
  private var worker: Thread? = null
  private var cursor = ""
  private var failures = 0

  companion object {
    @Volatile private var current: MusicBridgePoller? = null
    fun stopActive() { current?.stop(); current = null }
  }

  fun start() {
    if (active) return
    require(origin.startsWith("https://") && URL(origin).protocol == "https")
    require(token.length >= 32)
    stopActive()
    current = this
    active = true
    worker = thread(name = "SweatyOBS-chat", start = true) {
      while (active) {
        try {
          val endpoint = URL(origin.trimEnd('/') + "/api/encoder/commands" +
            (if (cursor.isEmpty()) "" else "?cursor=" + java.net.URLEncoder.encode(cursor, "UTF-8")))
          val connection = endpoint.openConnection() as HttpURLConnection
          connection.requestMethod = "GET"
          connection.connectTimeout = 5000
          connection.readTimeout = 5000
          connection.setRequestProperty("Authorization", "Bearer " + token)
          connection.instanceFollowRedirects = false
          try {
            check(connection.responseCode == 200) { "Bridge HTTP " + connection.responseCode }
            val packet = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            val reset = packet.getBoolean("reset")
            val nextCursor = packet.getString("cursor")
            require(nextCursor.length in 3..120)
            if (reset) {
              val state = packet.getJSONObject("state")
              mixer.command(if (state.optBoolean("playing")) "play" else "pause")
            } else {
              val events = packet.getJSONArray("events")
              require(events.length() <= 256)
              for (index in 0 until events.length()) {
                val action = events.getJSONObject(index).optString("action")
                if (action in listOf("play", "pause", "skip")) mixer.command(action)
                else if (action == "station") mixer.command("skip")
              }
            }
            cursor = nextCursor
            failures = 0
          } finally { connection.disconnect() }
        } catch (_: Exception) {
          failures++
          if (failures >= 3) mixer.command("pause")
          Log.w("SweatyClankerOBS", "Chat controls unavailable; retrying")
        }
        if (active) try { Thread.sleep(1500) } catch (_: InterruptedException) { break }
      }
    }
  }

  fun stop() { active = false; worker?.interrupt(); worker = null }
}
