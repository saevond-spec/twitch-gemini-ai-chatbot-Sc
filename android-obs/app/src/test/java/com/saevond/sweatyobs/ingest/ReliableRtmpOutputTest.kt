package com.saevond.sweatyobs.ingest

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class ReliableRtmpOutputTest {
  private fun destination() = RtmpDestination(
    "youtube", "YouTube", "rtmps://ingest.example.com/live", "example_stream_key-12345")

  private fun avcConfig() = RtmpMessage(9, 0, 1, byteArrayOf(0x17, 0, 0, 0, 0, 1, 2, 3))
  private fun aacConfig() = RtmpMessage(8, 0, 1, byteArrayOf(0xaf.toByte(), 0, 0x12, 0x10))
  private fun keyframe(timestamp: Long) =
    RtmpMessage(9, timestamp, 1, byteArrayOf(0x17, 1, 0, 0, 0, 0, 0, 1))

  private fun sandboxDestination(id: String) = RtmpDestination(
    id, id.replaceFirstChar { it.uppercase() }, "rtmps://$id.example.test/app", "sandbox-key-12345")

  @Test fun outputWaitsForBothCodecHeadersAndAKeyframeThenSendsARebasedStart() {
    val connected = CountDownLatch(1)
    val firstPackets = CountDownLatch(3)
    val sent = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      object : MediaPublisher {
        override fun connect() { connected.countDown() }
        override fun publish(media: RtmpMessage) { sent += media; firstPackets.countDown() }
        override fun close() {}
      }
    }, retryDelaysMs = longArrayOf(1), waitMs = { Thread.sleep(1) })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(RtmpMessage(9, 30, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      assertFalse("interframes must not start an incomplete output", connected.await(100, TimeUnit.MILLISECONDS))
      output.offer(keyframe(80_000))
      assertTrue("a valid GOP should start publishing", connected.await(2, TimeUnit.SECONDS))
      assertTrue(firstPackets.await(2, TimeUnit.SECONDS))
      assertEquals(listOf(9, 8, 9), sent.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), sent.take(3).map { it.timestamp })
    } finally { output.close() }
  }

  @Test fun manualReconnectWaitsForAnotherCleanKeyframeAndCreatesANewSession() {
    val publishers = CopyOnWriteArrayList<TestPublisher>()
    val retryStarted = CountDownLatch(1)
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      TestPublisher().also { publishers += it }
    }, retryDelaysMs = longArrayOf(200), waitMs = { delay ->
      retryStarted.countDown()
      Thread.sleep(delay)
    })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(10))
      assertTrue(pollUntil(2_000) { publishers.size == 1 && publishers[0].sent.size >= 3 })
      output.reconnectNow()
      assertTrue("the publisher should leave LIVE state and begin retry", retryStarted.await(2, TimeUnit.SECONDS))
      output.offer(keyframe(120))
      assertTrue(pollUntil(2_000) { publishers.size == 2 && publishers[1].sent.size >= 3 })
      assertEquals(1L, output.snapshot().reconnects)
      assertEquals(listOf(9, 8, 9), publishers[1].sent.take(3).map { it.type })
      assertEquals(0L, publishers[1].sent.first().timestamp)
    } finally { output.close() }
  }

  @Test fun sourceRestartForgetsOldCodecHeadersUntilNewHeadersAndKeyframeArrive() {
    val sessions = CopyOnWriteArrayList<CopyOnWriteArrayList<RtmpMessage>>()
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      val sent = CopyOnWriteArrayList<RtmpMessage>()
      sessions += sent
      object : MediaPublisher {
        override fun connect() {}
        override fun publish(media: RtmpMessage) { sent += media }
        override fun close() {}
      }
    }, retryDelaysMs = longArrayOf(0), waitMs = {})
    val oldVideoConfig = avcConfig()
    val newVideoConfig = avcConfig().copy(data = byteArrayOf(0x17, 0, 0, 0, 0, 1, 2, 9))
    try {
      output.start()
      output.offer(oldVideoConfig)
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue(pollUntil(2_000) { sessions.size == 1 && sessions[0].size >= 3 })

      output.reconnectNow(forgetCodecHeaders = true)
      output.offer(keyframe(200))
      Thread.sleep(50)
      assertEquals("stale headers cannot start the new source session", 1, sessions.size)

      output.offer(newVideoConfig)
      output.offer(aacConfig())
      output.offer(keyframe(300))
      assertTrue(pollUntil(2_000) { sessions.size >= 2 && sessions[1].size >= 3 })
      assertEquals(newVideoConfig.data.toList(), sessions[1][0].data.toList())
      assertEquals(listOf(9, 8, 9), sessions[1].take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), sessions[1].take(3).map { it.timestamp })
    } finally { output.close() }
  }

  @Test fun slowServerCannotGrowTheQueueWithoutLimitOrBlockLanInput() {
    val enteredPublish = CountDownLatch(1)
    val closeWrite = CountDownLatch(1)
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      object : MediaPublisher {
        override fun connect() {}
        override fun publish(media: RtmpMessage) {
          enteredPublish.countDown()
          closeWrite.await(2, TimeUnit.SECONDS)
        }
        override fun close() { closeWrite.countDown() }
      }
    }, retryDelaysMs = longArrayOf(1), waitMs = { Thread.sleep(1) })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue(enteredPublish.await(2, TimeUnit.SECONDS))
      val started = System.nanoTime()
      repeat(40) { i ->
        output.offer(RtmpMessage(9, i * 100L + 100L, 1, ByteArray(80_000) { 1 }))
      }
      val elapsedMs = (System.nanoTime() - started) / 1_000_000
      assertTrue("offer() must not wait for the slow destination", elapsedMs < 500)
      assertTrue("the stale queue should be counted and discarded", output.snapshot().droppedPackets > 0)
      assertTrue("buffer stays below its configured bound", output.snapshot().queueBytes <= ReliableRtmpOutput.DEFAULT_QUEUE_LIMIT_BYTES)
    } finally { output.close() }
  }

  @Test fun initialHeadersAndKeyframeCannotExceedConfiguredQueueLimit() {
    val connected = CountDownLatch(1)
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      object : MediaPublisher {
        override fun connect() { connected.countDown() }
        override fun publish(media: RtmpMessage) {}
        override fun close() {}
      }
    }, queueLimitBytes = 32_768)
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      val largeKeyframe = ByteArray(40_000).also {
        it[0] = 0x17
        it[1] = 1
      }
      output.offer(keyframe(100).copy(data = largeKeyframe))

      val snapshot = output.snapshot()
      assertEquals("startup GOP should be discarded when it exceeds the queue budget", 0, snapshot.queueBytes)
      assertEquals(3L, snapshot.droppedPackets)
      assertEquals("WAITING FOR KEYFRAME", snapshot.state)
      assertFalse("oversized startup GOP must not connect", connected.await(100, TimeUnit.MILLISECONDS))
    } finally { output.close() }
  }

  @Test fun staleQueuedMediaIsDroppedAndAKeyframeStartsTheNextSession() {
    val nowMs = AtomicLong(0)
    val attempts = AtomicInteger()
    val firstPublishEntered = CountDownLatch(1)
    val releaseFirstPublish = CountDownLatch(1)
    val retryDelayReached = CountDownLatch(1)
    val resumedPackets = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {}
          override fun publish(media: RtmpMessage) {
            if (session == 1) {
              firstPublishEntered.countDown()
              check(releaseFirstPublish.await(2, TimeUnit.SECONDS)) { "blocked fake publisher was not released" }
            } else resumedPackets.add(media)
          }
          override fun close() { releaseFirstPublish.countDown() }
        }
      },
      retryDelaysMs = longArrayOf(0),
      maxQueueAgeMs = 100,
      clockMs = { nowMs.get() },
      waitMs = { retryDelayReached.countDown() }
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue(firstPublishEntered.await(2, TimeUnit.SECONDS))

      nowMs.set(101)
      output.offer(RtmpMessage(9, 100, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      assertTrue("stale media should be counted as dropped", output.snapshot().droppedPackets >= 3)
      assertEquals(0, output.snapshot().queueBytes)
      assertTrue("stale output should enter its retry path", retryDelayReached.await(2, TimeUnit.SECONDS))

      output.offer(keyframe(500))
      assertTrue("a fresh keyframe should restart publishing", pollUntil(2_000) {
        attempts.get() >= 2 && resumedPackets.size >= 3
      })
      assertEquals(listOf(9, 8, 9), resumedPackets.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), resumedPackets.take(3).map { it.timestamp })
    } finally {
      releaseFirstPublish.countDown()
      output.close()
    }
  }

  @Test fun oneFailedDestinationDoesNotStallOtherOutputsAndRetriesFromAKeyframe() {
    val ids = listOf("twitch", "youtube", "kick")
    val sent = ids.associateWith { CopyOnWriteArrayList<RtmpMessage>() }
    val attempts = ids.associateWith { AtomicInteger() }
    val blockedPublisher = CountDownLatch(1)
    val releaseFailure = CountDownLatch(1)
    val retryDelayReached = CountDownLatch(1)
    val outputs = ids.map { id ->
      ReliableRtmpOutput(
        sandboxDestination(id),
        publisherFactory = {
          val session = attempts.getValue(id).incrementAndGet()
          object : MediaPublisher {
            override fun connect() {}
            override fun publish(media: RtmpMessage) {
              if (id == "youtube" && session == 1) {
                blockedPublisher.countDown()
                check(releaseFailure.await(2, TimeUnit.SECONDS)) { "sandbox failure was not released" }
                throw IOException("synthetic destination failure")
              }
              sent.getValue(id).add(media)
            }
            override fun close() {}
          }
        },
        retryDelaysMs = longArrayOf(0),
        waitMs = { retryDelayReached.countDown() }
      )
    }
    fun fanOut(media: RtmpMessage) = outputs.forEach { it.offer(media) }

    try {
      outputs.forEach { it.start() }
      fanOut(avcConfig())
      fanOut(aacConfig())
      fanOut(keyframe(0))
      assertTrue("fake YouTube publisher should enter its injected failure", blockedPublisher.await(2, TimeUnit.SECONDS))
      assertTrue("Twitch should send while YouTube is blocked", pollUntil(2_000) { sent.getValue("twitch").size >= 3 })
      assertTrue("Kick should send while YouTube is blocked", pollUntil(2_000) { sent.getValue("kick").size >= 3 })

      fanOut(RtmpMessage(9, 100, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      fanOut(RtmpMessage(8, 125, 1, byteArrayOf(0xaf.toByte(), 1, 1, 2)))
      assertTrue("healthy destinations should continue receiving media", pollUntil(2_000) {
        sent.getValue("twitch").size >= 5 && sent.getValue("kick").size >= 5
      })

      releaseFailure.countDown()
      assertTrue("failed output should enter its automatic retry path", retryDelayReached.await(2, TimeUnit.SECONDS))
      fanOut(keyframe(400))
      assertTrue("failed output should reconnect and resume at a clean keyframe", pollUntil(2_000) {
        attempts.getValue("youtube").get() >= 2 && sent.getValue("youtube").size >= 3
      })
      assertEquals(listOf(9, 8, 9), sent.getValue("youtube").take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), sent.getValue("youtube").take(3).map { it.timestamp })
      assertTrue("other destinations should keep receiving after the third output recovers", pollUntil(2_000) {
        sent.getValue("twitch").size >= 6 && sent.getValue("kick").size >= 6
      })
      assertEquals(1L, outputs[1].snapshot().reconnects)
    } finally {
      releaseFailure.countDown()
      outputs.forEach { it.close() }
    }
  }

  @Test fun retryBackoffIncreasesAndCaps() {
    assertEquals(1_000L, ReliableRtmpOutput.retryDelayMs(1))
    assertEquals(2_000L, ReliableRtmpOutput.retryDelayMs(2))
    assertEquals(30_000L, ReliableRtmpOutput.retryDelayMs(99))
  }

  private fun pollUntil(timeoutMs: Long, predicate: () -> Boolean): Boolean {
    val end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (System.nanoTime() < end) {
      if (predicate()) return true
      Thread.sleep(5)
    }
    return predicate()
  }

  private class TestPublisher : MediaPublisher {
    val sent = CopyOnWriteArrayList<RtmpMessage>()
    override fun connect() {}
    override fun publish(media: RtmpMessage) { sent += media }
    override fun close() {}
  }
}
