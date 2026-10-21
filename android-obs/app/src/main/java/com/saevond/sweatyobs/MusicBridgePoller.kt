package com.saevond.sweatyobs

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Authenticated control-only bridge for user-started Android streaming service.
 * This never downloads music and never starts a broadcast on its own.
 */
fun interface MusicControlSink {
  fun command(action: String, volumePercent: Int?, station: String?)
}

class MusicBridgePoller(
  private val origin: String,
  private val token: String,
  private val statusSink: (String) -> Unit = {},
  private val onConnectionState: (Boolean, EncoderDiagnosticError) -> Unit = { _, _ -> },
  private val mixer: MusicControlSink
) {
  @Volatile private var active = false
  private var worker: Thread? = null
  private var cursor = ""
  private var failures = 0
  private var lastStatus = ""
  private var lastConnectionState: Boolean? = null
  private fun status(message: String) {
    if (message != lastStatus) {
      lastStatus = message
      statusSink(message)
    }
  }

  private fun connectionState(connected: Boolean, error: EncoderDiagnosticError = EncoderDiagnosticError.NONE) {
    if (lastConnectionState == connected) return
    lastConnectionState = connected
    onConnectionState(connected, error)
  }

  companion object {
    @Volatile private var current: MusicBridgePoller? = null
    fun stopActive() { current?.stop(); current = null }

    /** One-shot bridge check. 200 is proof of authentication, not of Twitch audio. */
    fun verify(origin: String, token: String): String {
      if (origin != "https://twitch-gemini-ai-chatbot-sc-2.onrender.com")
        return "Bridge check blocked: unrecognized server."
      if (token.length !in 32..256) return "Bridge token not saved or invalid (32-256 characters)."
      var connection: HttpURLConnection? = null
      return try {
        connection = (URL(origin + "/api/encoder/commands").openConnection() as HttpURLConnection).apply {
          requestMethod = "GET"
          connectTimeout = 5000
          readTimeout = 5000
          instanceFollowRedirects = false
          setRequestProperty("Authorization", "Bearer " + token)
        }
        when (connection.responseCode) {
          200 -> {
            val obj = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
            if (obj.optString("cursor").length in 3..120 && obj.has("state"))
              "Remote music bridge authenticated. Controls available when a public stream is running."
            else "Bridge returned invalid response; not connected."
          }
          401 -> "Bridge rejected token. Check that the bot server and Android use the same secret."
          404 -> "Bridge not enabled on the bot server. Configure ENCODER_BRIDGE_TOKEN on Render."
          429 -> "Bridge is rate-limited. Try again later."
          else -> "Bridge returned HTTP " + connection.responseCode + "; not connected."
        }
      } catch (e: Exception) {
        "Bridge unavailable (" + e.javaClass.simpleName + "). Check internet and bot service."
      } finally { connection?.disconnect() }
    }
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
              val station = state.optString("station")
              if (station in GenrePlaylist.STATIONS) mixer.command("station", null, station)
              val volume = state.optInt("volumePercent", -1)
              if (volume in 0..100) mixer.command("volume", volume, null)
              mixer.command(if (state.optBoolean("playing")) "play" else "pause", null, null)
            } else {
              val events = packet.getJSONArray("events")
              require(events.length() <= 256)
              for (index in 0 until events.length()) {
                val event = events.getJSONObject(index)
                val action = event.optString("action")
                if (action == "volume") {
                  val amount = event.optInt("volumePercent", -1)
                  if (amount in 0..100) mixer.command("volume", amount, null)
                } else if (action in listOf("play", "pause", "skip")) mixer.command(action, null, null)
                else if (action == "station") {
                  val genre = event.optString("station")
                  if (genre in GenrePlaylist.STATIONS) mixer.command("station", null, genre)
                }
              }
            }
            cursor = nextCursor
            failures = 0
            connectionState(true)
            status("Remote music bridge connected; bot commands synced.")
          } finally { connection.disconnect() }
        } catch (error: Exception) {
          failures++
          if (failures == 3) {
            mixer.command("pause", null, null)
            connectionState(false, EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
            status("Remote music bridge disconnected; licensed music paused until reconnection.")
          }
        }
        val delay = if (failures >= 3) (1500L * (1L shl (failures - 3).coerceIn(0, 5))).coerceAtMost(60_000L) else 1500L
        if (active) try { Thread.sleep(delay) } catch (_: InterruptedException) { break }
      }
    }
  }

  fun stop() { active = false; worker?.interrupt(); worker = null }
}
