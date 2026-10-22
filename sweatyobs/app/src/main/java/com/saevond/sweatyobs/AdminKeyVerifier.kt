package com.saevond.sweatyobs

import javax.net.ssl.HttpsURLConnection
import org.json.JSONObject
import java.net.URL

internal enum class AdminKeyUnlockResult { ACCEPTED, REJECTED, RATE_LIMITED, UNAVAILABLE }

internal fun interface AdminKeyVerifier {
  fun verify(key: String): AdminKeyUnlockResult
  fun takeSessionToken(): String? = null
}

/** Checks the owner-provided key over verified HTTPS and never persists or logs it. */
internal class RemoteAdminKeyVerifier : AdminKeyVerifier {
  @Volatile private var issuedSessionToken: String? = null

  override fun takeSessionToken(): String? = issuedSessionToken.also { issuedSessionToken = null }

  override fun verify(key: String): AdminKeyUnlockResult {
    issuedSessionToken = null
    if (key.isEmpty() || key.length > MAX_KEY_LENGTH) return AdminKeyUnlockResult.REJECTED
    var connection: HttpsURLConnection? = null
    return try {
      val body = JSONObject().put("key", key).toString().toByteArray(Charsets.UTF_8)
      connection = URL(BuildConfig.ENCODER_SERVICE_URL + UNLOCK_PATH).openConnection() as HttpsURLConnection
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
          val json = JSONObject(response)
          if (!json.optBoolean("unlocked", false)) return AdminKeyUnlockResult.UNAVAILABLE
          val token = json.optString("sessionToken", "")
          val validToken = token.length in 40..128 && token.all { it.isLetterOrDigit() || it == '-' || it == '_' }
          if (!validToken) return AdminKeyUnlockResult.UNAVAILABLE
          issuedSessionToken = token
          AdminKeyUnlockResult.ACCEPTED
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
    // A hosted encoder API can take a while to wake after idle.
    private const val READ_TIMEOUT_MS = 75_000
    private const val HTTP_TOO_MANY_REQUESTS = 429
    private const val UNLOCK_PATH = "/api/encoder/admin/unlock"
  }
}
