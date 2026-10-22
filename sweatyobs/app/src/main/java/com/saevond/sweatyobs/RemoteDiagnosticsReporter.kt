package com.saevond.sweatyobs

import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadFactory
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

/**
 * Best-effort connection summaries for the configured encoder API. Reports and the
 * short-lived upload credential stay in memory; this class never writes files.
 * The broad bridge secret is used only to mint a diagnostics-scoped credential.
 */
internal class RemoteDiagnosticsReporter(
  private val bridgeSecret: String,
  private val baseUrl: String = DEFAULT_BASE_URL,
) : AutoCloseable {
  companion object {
    private val DEFAULT_BASE_URL = BuildConfig.ENCODER_SERVICE_URL
    private const val SESSION_PATH = "/api/encoder/diagnostics/session"
    private const val REPORT_PATH = "/api/encoder/diagnostics"
    private const val EVENT_PATH = "/api/encoder/diagnostics/events"
    private const val REFRESH_MARGIN_MS = 30_000L
    private const val CONNECT_TIMEOUT_MS = 3_000
    private const val READ_TIMEOUT_MS = 3_000
    private const val MAX_PENDING_EVENTS = 256
    private const val MAX_EVENTS_PER_BATCH = 50
    private const val MAX_REPORTED_DROPPED_EVENTS = 1_000_000
  }

  private val worker = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(1),
    ThreadFactory { task -> Thread(task, "SweatyOBS-remote-diagnostics").apply { isDaemon = true } },
    ThreadPoolExecutor.DiscardOldestPolicy(),
  )
  private val pendingLock = Any()
  private val pendingEvents = ArrayDeque<EncoderDiagnosticEvent>()
  private var pendingSample: EncoderDiagnosticSample? = null
  private var droppedEvents = 0
  private val drainScheduled = AtomicBoolean(false)
  @Volatile private var uploadToken: String? = null
  @Volatile private var tokenExpiresAtElapsedMs = 0L
  @Volatile private var activeConnection: HttpsURLConnection? = null

  /** Safe from the RTMP media callback: only the newest snapshot is retained in memory. */
  fun submit(sample: EncoderDiagnosticSample) {
    try {
      synchronized(pendingLock) { pendingSample = sample }
      scheduleDrain()
    } catch (_: RuntimeException) {
      // Diagnostics must never affect media flow or service shutdown.
    }
  }

  /** Keep an in-memory bounded event queue; no event is written to device storage. */
  fun submitEvent(event: EncoderDiagnosticEvent) {
    try {
      synchronized(pendingLock) {
        if (pendingEvents.size >= MAX_PENDING_EVENTS) {
          pendingEvents.removeFirst()
          droppedEvents = (droppedEvents + 1).coerceAtMost(MAX_REPORTED_DROPPED_EVENTS)
        }
        pendingEvents.addLast(event)
      }
      scheduleDrain()
    } catch (_: RuntimeException) {
      // Diagnostics must never affect UI actions or service shutdown.
    }
  }

  private fun scheduleDrain() {
    if (!drainScheduled.compareAndSet(false, true)) return
    try {
      worker.execute { drain() }
    } catch (_: RuntimeException) {
      drainScheduled.set(false)
    }
  }

  private fun drain() {
    var sendFailed = false
    try {
      val sample = synchronized(pendingLock) { pendingSample.also { pendingSample = null } }
      val eventBatch = synchronized(pendingLock) {
        val queued = pendingEvents.toList().sortedBy { it.sequence }
        val batchMode = queued.firstOrNull()?.mode
        queued.filter { it.mode == batchMode }.take(MAX_EVENTS_PER_BATCH) to droppedEvents
      }
      if (sample != null && !postAuthorized(REPORT_PATH,
          JSONObject().put("samples", JSONArray().put(sample.toJson())))) {
        synchronized(pendingLock) { if (pendingSample == null) pendingSample = sample }
        sendFailed = true
      }
      val events = eventBatch.first
      val dropped = eventBatch.second
      if (events.isNotEmpty() || dropped > 0) {
        val body = JSONObject()
          .put("sessionId", events.firstOrNull()?.sessionId ?: sample?.sessionId.orEmpty())
          .put("appVersion", events.firstOrNull()?.appVersion ?: sample?.appVersion.orEmpty())
          .put("mode", events.firstOrNull()?.mode?.wire ?: sample?.mode ?: "idle")
          .put("events", JSONArray().apply { events.forEach { put(it.toJson()) } })
          .put("droppedEvents", dropped)
        if (postAuthorized(EVENT_PATH, body)) {
          val acceptedSequences = events.mapTo(HashSet()) { it.sequence }
          synchronized(pendingLock) {
            val remaining = pendingEvents.filterNot { it.sequence in acceptedSequences }
            pendingEvents.clear()
            remaining.forEach(pendingEvents::addLast)
            droppedEvents = (droppedEvents - dropped).coerceAtLeast(0)
          }
        } else {
          sendFailed = true
        }
      }
    } catch (_: Exception) {
      // Never copy request bodies, credentials, or exception text into local logs.
    } finally {
      drainScheduled.set(false)
      // If a batch exceeded its size bound, immediately send the next bounded batch.
      // Failures wait for the next 30-second snapshot or app event before retrying.
      val hasPending = synchronized(pendingLock) {
        pendingSample != null || pendingEvents.isNotEmpty() || droppedEvents > 0
      }
      if (!sendFailed && hasPending) scheduleDrain()
    }
  }

  private fun postAuthorized(path: String, body: JSONObject): Boolean {
    return try {
      var token = tokenForUpload() ?: return false
      var response = post(path, token, body)
      if (response.first == 401) {
        uploadToken = null
        tokenExpiresAtElapsedMs = 0L
        token = tokenForUpload() ?: return false
        response = post(path, token, body)
      }
      response.first in 200..299
    } catch (_: Exception) {
      // Do not persist or print the endpoint, request body, bearer, or exception text.
      false
    }
  }

  @Synchronized
  private fun tokenForUpload(): String? {
    val current = uploadToken
    if (!current.isNullOrBlank() && SystemClock.elapsedRealtime() < tokenExpiresAtElapsedMs - REFRESH_MARGIN_MS) {
      return current
    }
    val response = post(SESSION_PATH, bridgeSecret, JSONObject())
    if (response.first !in 200..299) return null
    val body = runCatching { JSONObject(response.second) }.getOrNull() ?: return null
    val token = body.optString("token").takeIf { it.length == 43 } ?: return null
    val expiresSeconds = body.optInt("expiresInSeconds", 0).coerceIn(1, 3600)
    uploadToken = token
    tokenExpiresAtElapsedMs = SystemClock.elapsedRealtime() + expiresSeconds * 1_000L
    return token
  }

  private fun post(path: String, bearer: String, body: JSONObject): Pair<Int, String> {
    val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpsURLConnection
    activeConnection = connection
    try {
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.instanceFollowRedirects = false
      connection.useCaches = false
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty("Authorization", "Bearer $bearer")
      connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      val payload = body.toString().toByteArray(Charsets.UTF_8)
      connection.setFixedLengthStreamingMode(payload.size)
      connection.outputStream.use { it.write(payload) }
      val status = connection.responseCode
      val responseText = if (path == SESSION_PATH && status == 200) {
        connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
          val buffer = CharArray(2_048)
          val count = reader.read(buffer)
          if (count > 0) String(buffer, 0, count) else ""
        }
      } else ""
      return status to responseText
    } finally {
      connection.disconnect()
      if (activeConnection === connection) activeConnection = null
    }
  }

  /** Stop promptly when the user turns remote diagnostics off mid-session. */
  fun disable() {
    worker.shutdownNow()
    activeConnection?.disconnect()
    uploadToken = null
    tokenExpiresAtElapsedMs = 0L
    synchronized(pendingLock) {
      pendingEvents.clear()
      pendingSample = null
      droppedEvents = 0
    }
  }

  override fun close() {
    // Let an in-flight request finish; queued snapshots remain memory-only.
    worker.shutdown()
  }

}

internal data class EncoderDiagnosticSample(
  val sessionId: String,
  val appVersion: String,
  val mode: String,
  val ingestState: String,
  val videoPackets: Long,
  val audioPackets: Long,
  val tcpConnections: Long,
  val internetValidated: Boolean,
  val transport: String,
  val destinations: List<EncoderDestinationSample>,
  val failurePhase: String? = null,
  val failureCategory: String? = null,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("sessionId", sessionId)
    .put("appVersion", appVersion)
    .put("mode", mode)
    .put("ingest", JSONObject()
      .put("state", ingestState)
      .put("videoPackets", videoPackets.coerceIn(0, 1_000_000_000_000L))
      .put("audioPackets", audioPackets.coerceIn(0, 1_000_000_000_000L))
      .put("tcpConnections", tcpConnections.coerceIn(0, 1_000_000_000L)))
    .put("internet", JSONObject().put("validated", internetValidated).put("transport", transport))
    .put("destinations", JSONArray().apply { destinations.forEach { put(it.toJson()) } })
    .put("failure", if (failurePhase == null || failureCategory == null) JSONObject.NULL else JSONObject()
      .put("phase", failurePhase)
      .put("category", failureCategory))
}

internal data class EncoderDestinationSample(
  val id: String,
  val state: String,
  val queueBytes: Int,
  val queueMs: Long,
  val bytesPerSecond: Long,
  val reconnects: Long,
  val droppedPackets: Long,
  val errorCategory: String,
) {
  fun toJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("state", state)
    .put("queueBytes", queueBytes.coerceIn(0, 8_388_608))
    .put("queueMs", queueMs.coerceIn(0, 300_000))
    .put("bytesPerSecond", bytesPerSecond.coerceIn(0, 50_000_000))
    .put("reconnects", reconnects.coerceIn(0, 1_000_000_000))
    .put("droppedPackets", droppedPackets.coerceIn(0, 1_000_000_000_000L))
    .put("errorCategory", errorCategory)
}
