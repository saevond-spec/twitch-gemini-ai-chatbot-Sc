package com.saevond.sweatyobs

import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject
import java.net.URL

internal enum class AdminKeyUnlockResult { ACCEPTED, REJECTED, RATE_LIMITED, UNAVAILABLE }

internal fun interface AdminKeyVerifier {
  fun verify(key: String): AdminKeyUnlockResult
}

/** Checks the owner-provided key over verified HTTPS and never persists or logs it. */
internal class RemoteAdminKeyVerifier : AdminKeyVerifier {
  override fun verify(key: String): AdminKeyUnlockResult {
    if (key.isEmpty() || key.length > MAX_KEY_LENGTH) return AdminKeyUnlockResult.REJECTED
    var connection: HttpsURLConnection? = null
    return try {
      val body = JSONObject().put("key", key).toString().toByteArray(Charsets.UTF_8)
      connection = URL(UNLOCK_URL).openConnection() as HttpsURLConnection
      connection.requestMethod = "POST"
      connection.instanceFollowRedirects = false
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.doOutput = true
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      connection.setRequestProperty("Cache-Control", "no-store")
      connection.setFixedLengthStreamingMode(body.size)
      connection.outputStream.use { it.write(body) }

      when (connection.responseCode) {
        HttpsURLConnection.HTTP_OK -> {
          val response = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
          if (JSONObject(response).optBoolean("unlocked", false)) AdminKeyUnlockResult.ACCEPTED
          else AdminKeyUnlockResult.UNAVAILABLE
        }
        HttpsURLConnection.HTTP_UNAUTHORIZED -> AdminKeyUnlockResult.REJECTED
        HTTP_TOO_MANY_REQUESTS -> AdminKeyUnlockResult.RATE_LIMITED
        else -> AdminKeyUnlockResult.UNAVAILABLE
      }
    } catch (_: Exception) {
      AdminKeyUnlockResult.UNAVAILABLE
    } finally {
      connection?.disconnect()
    }
  }

  companion object {
    const val MAX_KEY_LENGTH = 256
    private const val CONNECT_TIMEOUT_MS = 15_000
    // Render's free service can take about a minute to wake after idle.
    private const val READ_TIMEOUT_MS = 75_000
    private const val HTTP_TOO_MANY_REQUESTS = 429
    private const val UNLOCK_URL = "https://twitch-gemini-ai-chatbot-sc-2.onrender.com/api/encoder/admin/unlock"
  }
}
