package com.saevond.sweatyobs

import java.net.URL
import javax.net.ssl.HttpsURLConnection
import org.json.JSONArray
import org.json.JSONObject

internal interface RemoteEncoderApi {
  fun status(serviceUrl: String, sessionToken: String): String
  fun action(serviceUrl: String, sessionToken: String, action: String, station: String? = null): String
  fun revokeSession(serviceUrl: String, sessionToken: String)
}

/** Small HTTPS control calls only. This client never accepts or sends media or platform keys. */
internal class HttpsRemoteEncoderClient : RemoteEncoderApi {
  override fun status(serviceUrl: String, sessionToken: String): String {
    val response = request(serviceUrl, sessionToken, "/api/encoder/remote/status", null)
    val json = JSONObject(response)
    if (!json.optBoolean("configured", false)) {
      return "Remote encoder bridge is not configured. No gameplay video is being sent by this phone."
    }
    if (!json.optBoolean("hostConnected", false)) {
      return "Remote encoder host is offline. The phone sent only a status request; no video was sent."
    }
    val outputs = json.optJSONArray("outputs") ?: JSONArray()
    val summary = (0 until outputs.length()).mapNotNull { index ->
      val output = outputs.optJSONObject(index) ?: return@mapNotNull null
      val platform = output.optString("platform", "").takeIf { it in PLATFORMS } ?: return@mapNotNull null
      val state = output.optString("state", "UNKNOWN").takeIf { it in OUTPUT_STATES } ?: "UNKNOWN"
      val bitrate = if (output.isNull("bitrateKbps")) "bitrate unknown" else "${output.optInt("bitrateKbps")} kbps"
      val retries = output.optInt("reconnects", 0).coerceAtLeast(0)
      val error = output.optString("errorCode", "UNKNOWN").takeIf { it in ERROR_CODES } ?: "UNKNOWN"
      "$platform $state · $bitrate · retries $retries · $error"
    }.joinToString(" · ").ifBlank { "No platform outputs reported" }
    val state = json.optString("state", "OFFLINE").takeIf { it in HOST_STATES } ?: "OFFLINE"
    val progress = if (json.optBoolean("outputProgress", false)) "FFmpeg output progress detected" else "no FFmpeg output progress yet"
    return "Remote host connected · $state · $progress · $summary. Platform playback is unverified."
  }

  override fun action(serviceUrl: String, sessionToken: String, action: String, station: String?): String {
    require(action in ACTIONS) { "Unsupported remote control action" }
    require((action == "station") == (station != null)) { "Station is required only for station changes" }
    if (station != null) require(station in STATIONS) { "Unsupported remote music station" }
    val payload = JSONObject().put("action", action).apply {
      if (station != null) put("station", station)
    }.toString()
    val json = JSONObject(request(serviceUrl, sessionToken, "/api/encoder/remote/actions", payload))
    if (!json.optBoolean("accepted", false)) throw IllegalStateException("Remote encoder rejected the action")
    val desired = json.optString("desiredState", "UNKNOWN").takeIf { it in setOf("RUNNING", "STOPPED") } ?: "UNKNOWN"
    val host = if (json.optBoolean("hostConnected", false)) "host connected" else "host offline; control change is queued"
    return "Remote $action request accepted · $host · desired state $desired. The phone sent no video."
  }

  override fun revokeSession(serviceUrl: String, sessionToken: String) {
    request(serviceUrl, sessionToken, "/api/encoder/remote/session/revoke", "{}")
  }

  private fun request(serviceUrl: String, sessionToken: String, path: String, body: String?): String {
    require(sessionToken.length in 40..128 && sessionToken.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
      "Remote control session is missing or expired"
    }
    val origin = URL(serviceUrl.trimEnd('/') + "/")
    require(origin.protocol.equals("https", ignoreCase = true) && origin.userInfo == null && origin.query == null && origin.ref == null) {
      "Remote encoder API must use a verified HTTPS origin"
    }
    var connection: HttpsURLConnection? = null
    return try {
      connection = URL(origin, path).openConnection() as HttpsURLConnection
      connection.requestMethod = if (body == null) "GET" else "POST"
      connection.instanceFollowRedirects = false
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Authorization", "Bearer $sessionToken")
      connection.setRequestProperty("Cache-Control", "no-store")
      if (body != null) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        connection.setFixedLengthStreamingMode(bytes.size)
        connection.outputStream.use { it.write(bytes) }
      }
      val code = connection.responseCode
      val input = if (code in 200..299) connection.inputStream else connection.errorStream
      val response = input?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
      if (code == HttpsURLConnection.HTTP_UNAUTHORIZED) throw IllegalStateException("Remote control session expired; unlock again")
      if (code == HttpsURLConnection.HTTP_CONFLICT) {
        val detail = runCatching { JSONObject(response).optString("error") }.getOrNull().orEmpty()
        throw IllegalStateException(detail.ifBlank { "Remote encoder rejected the control request." })
      }
      if (code !in 200..299) throw IllegalStateException("Remote encoder service returned HTTP $code")
      response
    } finally {
      connection?.disconnect()
    }
  }

  companion object {
    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 10_000
    private val ACTIONS = setOf("start", "stop", "reconnect", "play", "pause", "skip", "station")
    private val STATIONS = setOf("club", "dubstep")
    private val PLATFORMS = setOf("twitch", "youtube", "kick")
    private val ERROR_CODES = setOf("NONE", "NETWORK", "AUTH", "SOURCE", "ENCODER", "UNKNOWN")
    private val HOST_STATES = setOf("STOPPED", "STARTING", "WAITING_FOR_INGEST", "RUNNING_UNVERIFIED", "RETRYING", "FAILED", "OFFLINE")
    private val OUTPUT_STATES = setOf("STOPPED", "CONNECTING", "LIVE_UNVERIFIED", "RETRYING", "FAILED", "UNKNOWN")
  }
}
