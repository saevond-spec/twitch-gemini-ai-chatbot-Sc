package com.saevond.sweatyobs.ingest

import java.io.IOException
import java.util.ArrayDeque
import kotlin.concurrent.thread
import kotlin.math.max

interface MediaPublisher : AutoCloseable {
  fun connect()
  fun publish(media: RtmpMessage)
}

data class OutputSnapshot(
  val id: String,
  val label: String,
  val state: String,
  val queueBytes: Int,
  val queueMediaMs: Long,
  val packetsSent: Long,
  val bytesPerSecond: Long,
  val reconnects: Long,
  val droppedPackets: Long,
  val lastError: String?
) {
  val health: String get() = when (state) {
    "WAITING FOR KEYFRAME" -> "Waiting"
    "CONNECTING" -> "Connecting"
    "RETRYING" -> "Retrying"
    "STOPPED" -> "Stopped"
    "LIVE" -> when {
      queueMediaMs >= 900 -> "Poor"
      queueMediaMs >= 300 -> "Fair"
      else -> "Good"
    }
    else -> "Unavailable"
  }

  fun summary(): String {
    val speed = if (bytesPerSecond > 0) " · ${(bytesPerSecond * 8 / 1000)} kb/s" else ""
    val queue = if (queueMediaMs > 0) " · queued ${queueMediaMs} ms" else ""
    val retry = if (reconnects > 0) " · reconnects $reconnects" else ""
    val dropped = if (droppedPackets > 0) " · skipped $droppedPackets stale packets" else ""
    val error = lastError?.let { " · last error $it" }.orEmpty()
    return "$label $state · health $health$speed$queue$retry$dropped$error"
  }
}

/**
 * Keeps the LAN ingest callback free of internet I/O. Each destination owns one
 * bounded queue and retry loop, so a slow RTMPS server cannot stall other outputs.
 */
class ReliableRtmpOutput(
  private val destination: RtmpDestination,
  private val publisherFactory: (RtmpDestination) -> MediaPublisher = { RtmpsPublisher(it.serverUrl, it.key) },
  private val retryDelaysMs: LongArray = DEFAULT_RETRY_DELAYS_MS,
  private val queueLimitBytes: Int = DEFAULT_QUEUE_LIMIT_BYTES,
  private val maxQueueMediaMs: Long = DEFAULT_QUEUE_MEDIA_MS,
  private val maxQueueAgeMs: Long = DEFAULT_QUEUE_AGE_MS,
  private val clockMs: () -> Long = { System.nanoTime() / 1_000_000L },
  private val waitMs: ((Long) -> Unit)? = null,
  private val onSnapshot: (OutputSnapshot) -> Unit = {}
) : AutoCloseable {
  companion object {
    const val DEFAULT_QUEUE_LIMIT_BYTES = 2_500_000
    const val DEFAULT_QUEUE_MEDIA_MS = 1_500L
    const val DEFAULT_QUEUE_AGE_MS = 2_000L
    val DEFAULT_RETRY_DELAYS_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000)

    fun retryDelayMs(failures: Int): Long {
      val n = failures.coerceAtLeast(1)
      return DEFAULT_RETRY_DELAYS_MS[(n - 1).coerceAtMost(DEFAULT_RETRY_DELAYS_MS.lastIndex)]
    }

    fun isAvcConfig(media: RtmpMessage): Boolean = media.type == 9 && media.data.size >= 3 &&
      (media.data[0].toInt() and 15) == 7 && (media.data[1].toInt() and 255) == 0

    fun isAacConfig(media: RtmpMessage): Boolean = media.type == 8 && media.data.size >= 3 &&
      (media.data[0].toInt() and 240) == 0xa0 && (media.data[1].toInt() and 255) == 0

    fun isAvcKeyframe(media: RtmpMessage): Boolean = media.type == 9 && media.data.size >= 3 &&
      (media.data[0].toInt() and 15) == 7 && (media.data[1].toInt() and 255) == 1 &&
      (media.data[0].toInt() and 240) == 0x10
  }

  private data class Pending(val message: RtmpMessage, val enqueuedAtMs: Long)
  private val lock = Object()
  private val queue = ArrayDeque<Pending>()
  private var queueBytes = 0
  private var avcConfig: RtmpMessage? = null
  private var aacConfig: RtmpMessage? = null
  private var aligned = false
  private var running = false
  @Volatile private var publisher: MediaPublisher? = null
  @Volatile private var worker: Thread? = null
  @Volatile private var state = "STOPPED"
  @Volatile private var packetsSent = 0L
  @Volatile private var reconnects = 0L
  @Volatile private var droppedPackets = 0L
  @Volatile private var lastError: String? = null
  private var rateWindowAt = 0L
  private var rateWindowBytes = 0L
  @Volatile private var bytesPerSecond = 0L

  init {
    require(destination.isValid()) { "Invalid streaming destination" }
    require(retryDelaysMs.isNotEmpty() && retryDelaysMs.all { it >= 0 })
    require(queueLimitBytes in 32_768..8_388_608)
    require(maxQueueMediaMs >= 100 && maxQueueAgeMs >= 100)
  }

  fun start() {
    synchronized(lock) {
      if (running) return
      running = true
      state = "WAITING FOR KEYFRAME"
      worker = thread(name = "SweatyOBS-${destination.id}-output") { runWorker() }
    }
    notifySnapshot()
  }

  /** Nonblocking; called by the PS5 input worker. */
  fun offer(message: RtmpMessage) {
    if (message.type !in listOf(8, 9) || message.data.size !in 3..2_097_152) return
    var shouldAbort = false
    synchronized(lock) {
      if (!running) return
      if (isAvcConfig(message)) avcConfig = copyMessage(message)
      if (isAacConfig(message)) aacConfig = copyMessage(message)
      if (!aligned) {
        enqueueStartupGopLocked(message)
        return@synchronized
      }
      enqueueLocked(copyMessage(message))
      if (queueExceedsLimitsLocked()) {
        droppedPackets += queue.size.toLong()
        clearQueueLocked()
        aligned = false
        state = "WAITING FOR KEYFRAME"
        shouldAbort = true
        enqueueStartupGopLocked(message)
        lock.notifyAll()
      }
      // The sender sleeps on an empty aligned queue; wake it for the next live packet.
      lock.notifyAll()
    }
    if (shouldAbort) {
      publisher?.close()
      notifySnapshot()
    }
  }

  /** Force a fresh RTMPS session; the sender waits for a clean AVC keyframe. */
  fun reconnectNow() {
    synchronized(lock) {
      if (!running) return
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      aligned = false
      state = "WAITING FOR KEYFRAME"
      lock.notifyAll()
    }
    publisher?.close()
    notifySnapshot()
  }

  fun snapshot(): OutputSnapshot = synchronized(lock) {
    val duration = queueMediaDurationLocked()
    OutputSnapshot(destination.id, destination.label, state, queueBytes, duration,
      packetsSent, bytesPerSecond, reconnects, droppedPackets, lastError)
  }

  override fun close() {
    synchronized(lock) {
      running = false
      clearQueueLocked()
      aligned = false
      state = "STOPPED"
      lock.notifyAll()
    }
    publisher?.close()
    worker?.takeIf { it !== Thread.currentThread() }?.let { runCatching { it.join(1_000) } }
    publisher = null
    worker = null
    notifySnapshot()
  }

  private fun runWorker() {
    var failures = 0
    var everConnected = false
    while (isRunning()) {
      var active: MediaPublisher? = null
      try {
        if (!waitUntilAligned()) break
        if (!isRunning()) break
        state = "CONNECTING"
        notifySnapshot()
        active = publisherFactory(destination)
        publisher = active
        active.connect()
        if (!isRunning()) break
        if (everConnected) reconnects++
        everConnected = true
        synchronized(lock) { if (running) state = "LIVE" }
        failures = 0
        notifySnapshot()
        var sessionBaseTimestamp: Long? = null
        while (isRunning()) {
          val pending = takeNext() ?: throw IOException("Output buffer reset")
          val base = sessionBaseTimestamp ?: pending.message.timestamp.also { sessionBaseTimestamp = it }
          active.publish(pending.message.copy(timestamp = (pending.message.timestamp - base).coerceAtLeast(0L)))
          recordSent(pending.message)
        }
      } catch (error: Exception) {
        if (!isRunning()) break
        lastError = error.javaClass.simpleName
        failures++
        synchronized(lock) {
          droppedPackets += queue.size.toLong()
          clearQueueLocked()
          aligned = false
          state = "RETRYING"
          lock.notifyAll()
        }
        notifySnapshot()
        val base = retryDelaysMs[(failures - 1).coerceAtMost(retryDelaysMs.lastIndex)]
        val wait = (base * (0.9 + Math.random() * 0.1)).toLong()
        try {
          if (waitMs != null) waitMs.invoke(wait)
          else synchronized(lock) { if (running) lock.wait(wait) }
        } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
      } finally {
        active?.close()
        if (publisher === active) publisher = null
      }
    }
    synchronized(lock) { if (!running) state = "STOPPED" }
    notifySnapshot()
  }

  private fun waitUntilAligned(): Boolean = synchronized(lock) {
    while (running && !aligned) {
      state = "WAITING FOR KEYFRAME"
      lock.wait()
    }
    running
  }

  private fun takeNext(): Pending? = synchronized(lock) {
    while (running && aligned && queue.isEmpty()) lock.wait()
    if (!running) return@synchronized null
    val first = queue.peekFirst() ?: return@synchronized null
    if (clockMs() - first.enqueuedAtMs > maxQueueAgeMs) {
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      aligned = false
      state = "WAITING FOR KEYFRAME"
      lock.notifyAll()
      return@synchronized null
    }
    queue.removeFirst().also { queueBytes -= it.message.data.size }
  }

  private fun enqueueLocked(message: RtmpMessage) {
    queue.addLast(Pending(message, clockMs()))
    queueBytes += message.data.size
  }

  /** Queue a clean codec-header + keyframe start only when it fits the same limits as live media. */
  private fun enqueueStartupGopLocked(message: RtmpMessage) {
    if (!isAvcKeyframe(message) || avcConfig == null || aacConfig == null) return
    clearQueueLocked()
    val timestamp = message.timestamp
    enqueueLocked(copyMessage(avcConfig!!, timestamp))
    enqueueLocked(copyMessage(aacConfig!!, timestamp))
    enqueueLocked(copyMessage(message))
    if (queueExceedsLimitsLocked()) {
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      aligned = false
      state = "WAITING FOR KEYFRAME"
    } else {
      aligned = true
    }
    lock.notifyAll()
  }

  private fun queueExceedsLimitsLocked(): Boolean =
    queueBytes > queueLimitBytes ||
      queueMediaDurationLocked() > maxQueueMediaMs ||
      queue.peekFirst()?.let { clockMs() - it.enqueuedAtMs > maxQueueAgeMs } == true

  private fun queueMediaDurationLocked(): Long {
    if (queue.size < 2) return 0L
    val first = queue.peekFirst()?.message?.timestamp ?: return 0L
    val last = queue.peekLast()?.message?.timestamp ?: return 0L
    return (last - first).coerceAtLeast(0L)
  }

  private fun clearQueueLocked() {
    queue.clear()
    queueBytes = 0
  }

  private fun copyMessage(message: RtmpMessage, timestamp: Long = message.timestamp) =
    message.copy(timestamp = timestamp, streamId = 1, data = message.data.copyOf())

  private fun isRunning() = synchronized(lock) { running }

  private fun recordSent(message: RtmpMessage) {
    val now = clockMs()
    packetsSent++
    synchronized(lock) {
      if (rateWindowAt == 0L) rateWindowAt = now
      rateWindowBytes += message.data.size
      val elapsed = now - rateWindowAt
      if (elapsed >= 2_000) {
        bytesPerSecond = rateWindowBytes * 1000 / max(1L, elapsed)
        rateWindowAt = now
        rateWindowBytes = 0
      }
    }
  }

  private fun notifySnapshot() = runCatching { onSnapshot(snapshot()) }
}
