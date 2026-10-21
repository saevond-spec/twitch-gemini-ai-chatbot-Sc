package com.saevond.sweatyobs.ingest

import java.io.IOException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.ArrayDeque
import kotlin.concurrent.thread
import kotlin.math.max

interface MediaPublisher : AutoCloseable {
  fun connect()
  fun publish(media: RtmpMessage)

  /**
   * Optional, idempotent cancellation hook invoked on the destination's cleanup lane
   * immediately before close. It is never called by the PS5 ingest callback.
   */
  fun requestAbort() {}
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
    "LIVE" -> when {
      queueMediaMs >= 900 -> "Poor"
      queueMediaMs >= 300 -> "Fair"
      else -> "Good"
    }
    "WAITING FOR KEYFRAME" -> "Waiting for keyframe"
    "CONNECTING" -> "Connecting"
    "RETRYING" -> "Retrying"
    "STOPPED" -> "Offline"
    else -> "Starting"
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

    /**
     * One permit and one cleanup lane per supported platform. A session keeps its permit until
     * its close completes, so only one publisher per destination can exist at a time. Cleanup is
     * coalesced per session; each lane therefore needs at most one pending close and cannot be
     * filled by another destination's stalled socket.
     */
    private val DESTINATION_LEASES = listOf("twitch", "youtube", "kick")
      .associateWith { Semaphore(1, true) }

    private val CLOSE_EXECUTORS = listOf("twitch", "youtube", "kick").associateWith { id ->
      ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(1),
        { task -> Thread(task, "SweatyOBS-$id-publisher-close").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy()
      )
    }

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
  private data class StartGeneration(val media: Long, val connection: Long)
  private class PublisherSession(val publisher: MediaPublisher, val lease: Semaphore) {
    private val cleanupScheduled = AtomicBoolean(false)
    fun markCleanupScheduled(): Boolean = cleanupScheduled.compareAndSet(false, true)
  }

  private val lock = Object()
  private val destinationLease = DESTINATION_LEASES[destination.id]
    ?: throw IllegalArgumentException("Unsupported RTMP destination: ${destination.id}")
  private val closeExecutor = CLOSE_EXECUTORS[destination.id]
    ?: throw IllegalArgumentException("Unsupported RTMP destination: ${destination.id}")
  private val queue = ArrayDeque<Pending>()
  private var queueBytes = 0
  private var avcConfig: RtmpMessage? = null
  private var aacConfig: RtmpMessage? = null
  private var aligned = false
  /** Changes whenever a reset makes a previous sender failure stale. */
  private var mediaGeneration = 0L
  /** Changes when the current destination connection must be abandoned. */
  private var connectionGeneration = 0L
  private var running = false
  /** close() is terminal; a stale worker must never be restarted alongside a new one. */
  private var closed = false
  @Volatile private var publisher: PublisherSession? = null
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
      if (running || closed) return
      running = true
      state = "WAITING FOR KEYFRAME"
      worker = thread(name = "SweatyOBS-${destination.id}-output") { runWorker() }
    }
    notifySnapshot()
  }

  /** Nonblocking; called by the PS5 input worker. */
  fun offer(message: RtmpMessage) {
    if (message.type !in listOf(8, 9) || message.data.size !in 3..2_097_152) return
    var queueReset = false
    var publisherToAbort: PublisherSession? = null
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
        val wasLive = state == "LIVE"
        val wasConnecting = state == "CONNECTING"
        droppedPackets += queue.size.toLong()
        clearQueueLocked()
        aligned = false
        mediaGeneration++
        // Keep the visible state accurate until the in-flight handshake finishes.
        state = if (wasConnecting) "CONNECTING" else "WAITING FOR KEYFRAME"
        queueReset = true
        if (wasLive) {
          connectionGeneration++
          publisherToAbort = publisher
        }
        enqueueStartupGopLocked(message)
        if (wasConnecting) state = "CONNECTING"
        lock.notifyAll()
      }
      // The sender sleeps on an empty aligned queue; wake it for the next live packet.
      lock.notifyAll()
    }
    // Overflow while CONNECTING must not cancel RTMPS/TLS setup. Once LIVE,
    // abort that session off the PS5 ingest callback so a slow socket close cannot delay other outputs.
    abortPublisherAsync(publisherToAbort)
    if (queueReset) notifySnapshot()
  }

  /**
   * Invalidate queued media and codec headers at a PS5 source-session boundary.
   * This prevents a keyframe from a previous source session being sent after reconnect.
   */
  fun resetForSourceSession() {
    var publisherToAbort: PublisherSession? = null
    synchronized(lock) {
      if (!running) return
      mediaGeneration++
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      avcConfig = null
      aacConfig = null
      aligned = false
      if (state == "LIVE") {
        connectionGeneration++
        publisherToAbort = publisher
      }
      if (state != "CONNECTING") state = "WAITING FOR KEYFRAME"
      lock.notifyAll()
    }
    // Stop the live publisher off the ingest callback; a handshake in progress can finish,
    // then waits for this source session's codec headers and keyframe.
    abortPublisherAsync(publisherToAbort)
    notifySnapshot()
  }

  /** Force a fresh RTMPS session; the sender waits for a clean AVC keyframe. */
  fun reconnectNow() {
    var publisherToAbort: PublisherSession? = null
    synchronized(lock) {
      if (!running) return
      mediaGeneration++
      connectionGeneration++
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      aligned = false
      state = "WAITING FOR KEYFRAME"
      publisherToAbort = publisher
      lock.notifyAll()
    }
    abortPublisherAsync(publisherToAbort)
    notifySnapshot()
  }

  fun snapshot(): OutputSnapshot = synchronized(lock) {
    val duration = queueMediaDurationLocked()
    OutputSnapshot(destination.id, destination.label, state, queueBytes, duration,
      packetsSent, bytesPerSecond, reconnects, droppedPackets, lastError)
  }

  override fun close() {
    var publisherToAbort: PublisherSession? = null
    val workerToJoin = synchronized(lock) {
      if (closed) return
      closed = true
      running = false
      mediaGeneration++
      connectionGeneration++
      clearQueueLocked()
      avcConfig = null
      aacConfig = null
      aligned = false
      state = "STOPPED"
      publisherToAbort = publisher
      lock.notifyAll()
      worker
    }
    abortPublisherAsync(publisherToAbort)
    workerToJoin?.takeIf { it !== Thread.currentThread() }?.let { runCatching { it.join(250) } }
    publisher = null
    worker = null
    notifySnapshot()
  }

  private fun runWorker() {
    var failures = 0
    var everConnected = false
    while (isRunning()) {
      var active: PublisherSession? = null
      var leaseAcquired = false
      var activeMediaGeneration = -1L
      var activeConnectionGeneration = -1L
      try {
        val startGeneration = awaitFreshStartAndMarkConnecting() ?: break
        activeMediaGeneration = startGeneration.media
        activeConnectionGeneration = startGeneration.connection
        notifySnapshot()

        if (!acquireDestinationLease(activeConnectionGeneration)) {
          if (!isRunning() || Thread.currentThread().isInterrupted) break
          continue
        }
        leaseAcquired = true
        if (!isConnectionCurrent(activeConnectionGeneration)) continue

        val candidate = publisherFactory(destination)
        active = PublisherSession(candidate, destinationLease)
        leaseAcquired = false // the session now owns the destination permit
        val startIsCurrent = synchronized(lock) {
          if (running && connectionGeneration == activeConnectionGeneration) {
            publisher = active
            true
          } else false
        }
        if (!startIsCurrent) {
          if (!isRunning()) break
          continue
        }
        candidate.connect()
        if (!isRunning()) break
        // A queue overflow during connect may invalidate the original start GOP.
        // Keep the successful publisher open and wait here for a fresh keyframe.
        val liveGeneration = awaitFreshStartAndMarkLive(activeConnectionGeneration)
        if (liveGeneration == null) {
          if (!isRunning()) break
          // A manual reconnect or source reset invalidated this publisher while
          // it was waiting for a keyframe. Retire it and wait for a new start.
          continue
        }
        activeMediaGeneration = liveGeneration.media
        if (everConnected) reconnects++
        everConnected = true
        failures = 0
        notifySnapshot()
        var sessionBaseTimestamp: Long? = null
        while (isRunning()) {
          val pending = takeNext(activeConnectionGeneration)
          if (pending == null) {
            if (!isConnectionCurrent(activeConnectionGeneration)) break
            throw IOException("Output buffer reset")
          }
          val base = sessionBaseTimestamp ?: pending.message.timestamp.also { sessionBaseTimestamp = it }
          active.publisher.publish(
            pending.message.copy(timestamp = (pending.message.timestamp - base).coerceAtLeast(0L))
          )
          recordSent(pending.message)
        }
      } catch (error: Exception) {
        if (!isRunning()) break
        lastError = error.javaClass.simpleName
        failures++
        synchronized(lock) {
          // A reset may have queued a clean GOP for a newer source/session while
          // this publisher was failing. Discard only the generation that failed.
          if (activeMediaGeneration == mediaGeneration) {
            droppedPackets += queue.size.toLong()
            clearQueueLocked()
            aligned = false
            mediaGeneration++
          }
          state = if (connectionGeneration != activeConnectionGeneration) "WAITING FOR KEYFRAME" else "RETRYING"
          lock.notifyAll()
        }
        notifySnapshot()
        val base = retryDelaysMs[(failures - 1).coerceAtMost(retryDelaysMs.lastIndex)]
        val wait = (base * (0.9 + Math.random() * 0.1)).toLong()
        try {
          if (waitMs != null) waitMs.invoke(wait)
          else synchronized(lock) {
            val reconnectWasRequested = connectionGeneration != activeConnectionGeneration
            val freshGopAlreadyQueued = activeMediaGeneration != mediaGeneration && aligned &&
              queue.isNotEmpty() && !queueExceedsLimitsLocked()
            if (running && !reconnectWasRequested && !freshGopAlreadyQueued) lock.wait(wait)
          }
        } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
      } finally {
        if (active != null) {
          abortPublisherAsync(active)
          synchronized(lock) { if (publisher === active) publisher = null }
        }
        if (leaseAcquired) destinationLease.release()
      }
    }
    synchronized(lock) { if (!running) state = "STOPPED" }
    notifySnapshot()
  }

  /** Wait for the prior session on this destination to finish closing without blocking ingest. */
  private fun acquireDestinationLease(expectedConnectionGeneration: Long): Boolean {
    while (isConnectionCurrent(expectedConnectionGeneration)) {
      try {
        if (destinationLease.tryAcquire(100, TimeUnit.MILLISECONDS)) {
          if (isConnectionCurrent(expectedConnectionGeneration)) return true
          destinationLease.release()
          return false
        }
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return false
      }
    }
    return false
  }

  private fun awaitFreshStartAndMarkConnecting(): StartGeneration? = synchronized(lock) {
    while (running) {
      if (aligned && queue.isNotEmpty() && !queueExceedsLimitsLocked()) {
        state = "CONNECTING"
        return@synchronized StartGeneration(mediaGeneration, connectionGeneration)
      }
      if (aligned && queue.isNotEmpty()) {
        droppedPackets += queue.size.toLong()
        clearQueueLocked()
        aligned = false
        mediaGeneration++
      }
      state = "WAITING FOR KEYFRAME"
      lock.wait()
    }
    null
  }

  private fun awaitFreshStartAndMarkLive(expectedConnectionGeneration: Long): StartGeneration? = synchronized(lock) {
    while (running && connectionGeneration == expectedConnectionGeneration) {
      if (aligned && queue.isNotEmpty() && !queueExceedsLimitsLocked()) {
        state = "LIVE"
        return@synchronized StartGeneration(mediaGeneration, connectionGeneration)
      }
      if (aligned && queue.isNotEmpty()) {
        droppedPackets += queue.size.toLong()
        clearQueueLocked()
        aligned = false
        mediaGeneration++
      }
      state = "WAITING FOR KEYFRAME"
      lock.wait()
    }
    null
  }

  private fun takeNext(expectedConnectionGeneration: Long): Pending? = synchronized(lock) {
    while (running && connectionGeneration == expectedConnectionGeneration && aligned && queue.isEmpty()) lock.wait()
    if (!running || connectionGeneration != expectedConnectionGeneration) return@synchronized null
    val first = queue.peekFirst() ?: return@synchronized null
    if (clockMs() - first.enqueuedAtMs > maxQueueAgeMs) {
      droppedPackets += queue.size.toLong()
      clearQueueLocked()
      aligned = false
      mediaGeneration++
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
      mediaGeneration++
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

  private fun isConnectionCurrent(expected: Long) = synchronized(lock) {
    running && connectionGeneration == expected
  }

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

  /**
   * Retire one publisher on its destination-specific lane. Cancellation and close can block
   * inside platform socket code, so neither is run by the PS5 ingest callback or another output.
   * The session's one-shot flag coalesces a reconnect request with the worker's finalizer.
   */
  private fun abortPublisherAsync(session: PublisherSession?) {
    if (session == null || !session.markCleanupScheduled()) return
    closeExecutor.execute(Runnable {
      try {
        runCatching { session.publisher.requestAbort() }
        runCatching { session.publisher.close() }
      } finally {
        synchronized(lock) { if (publisher === session) publisher = null }
        session.lease.release()
      }
    })
  }

  private fun notifySnapshot() = runCatching { onSnapshot(snapshot()) }
}
