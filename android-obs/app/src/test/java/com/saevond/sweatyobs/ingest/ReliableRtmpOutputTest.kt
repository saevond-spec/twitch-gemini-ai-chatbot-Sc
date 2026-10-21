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

  @Test fun outputHealthDistinguishesWaitingConnectingRetryingAndQueueQuality() {
    fun snapshot(state: String, queuedMs: Long = 0L) = OutputSnapshot(
      "youtube", "YouTube", state, 0, queuedMs, 0, 0, 0, 0, null)

    assertEquals("Waiting for keyframe", snapshot("WAITING FOR KEYFRAME").health)
    assertTrue(snapshot("WAITING FOR KEYFRAME").summary().contains("health Waiting for keyframe"))
    assertEquals("Connecting", snapshot("CONNECTING").health)
    assertEquals("Retrying", snapshot("RETRYING").health)
    assertEquals("Offline", snapshot("STOPPED").health)
    assertEquals("Starting", snapshot("UNKNOWN").health)
    assertEquals("Good", snapshot("LIVE", 299).health)
    assertEquals("Fair", snapshot("LIVE", 300).health)
    assertEquals("Fair", snapshot("LIVE", 899).health)
    assertEquals("Poor", snapshot("LIVE", 900).health)
  }

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

  @Test fun senderWakesWhenLiveMediaArrivesAfterItsQueueDrained() {
    val firstBatch = CountDownLatch(3)
    val nextPacket = CountDownLatch(1)
    val sent = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      object : MediaPublisher {
        override fun connect() {}
        override fun publish(media: RtmpMessage) {
          sent += media
          if (sent.size <= 3) firstBatch.countDown() else nextPacket.countDown()
        }
        override fun close() {}
      }
    })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue(firstBatch.await(2, TimeUnit.SECONDS))
      Thread.sleep(50) // allow the sender to block on its now-empty live queue

      output.offer(RtmpMessage(8, 25, 1, byteArrayOf(0xaf.toByte(), 1, 1, 2)))

      assertTrue("new media should wake the sender without waiting for another keyframe",
        nextPacket.await(2, TimeUnit.SECONDS))
      assertEquals(listOf(9, 8, 9, 8), sent.map { it.type })
    } finally { output.close() }
  }

  @Test fun queueOverflowDoesNotCancelAnInFlightDestinationConnect() {
    val connectEntered = CountDownLatch(1)
    val connectReturned = CountDownLatch(1)
    val releaseConnect = CountDownLatch(1)
    val firstBatch = CountDownLatch(3)
    val attempts = AtomicInteger()
    val closeCalls = AtomicInteger()
    val sent = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {
            connectEntered.countDown()
            check(releaseConnect.await(10, TimeUnit.SECONDS)) { "blocked fake connect was not released" }
            connectReturned.countDown()
          }
          override fun publish(media: RtmpMessage) {
            sent += media
            firstBatch.countDown()
          }
          override fun close() { closeCalls.incrementAndGet() }
        }
      },
      maxQueueMediaMs = 100,
      retryDelaysMs = longArrayOf(0),
      waitMs = { Thread.sleep(1) }
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("destination connect should be in progress", connectEntered.await(2, TimeUnit.SECONDS))

      // Force the media-time queue bound while TLS/RTMPS setup is still blocked.
      output.offer(RtmpMessage(9, 101, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      assertEquals("CONNECTING", output.snapshot().state)
      assertEquals("overflow during connect must not close the publisher", 0, closeCalls.get())
      assertEquals("overflow must still clear stale media", 0, output.snapshot().queueBytes)

      // Let connect finish while the queue is unaligned, matching a handshake
      // that completes just after a GOP/queue window has expired.
      releaseConnect.countDown()
      assertTrue("blocked connect should finish", connectReturned.await(3, TimeUnit.SECONDS))
      assertTrue("the connected sender should wait for a new keyframe",
        pollUntil(3_000) { output.snapshot().state == "WAITING FOR KEYFRAME" })
      assertEquals("successful connection should stay open while waiting for media", 0, closeCalls.get())

      output.offer(keyframe(500))
      assertTrue("fresh headers and keyframe should publish after connect finishes",
        firstBatch.await(3, TimeUnit.SECONDS))
      assertEquals("a single slow connect should be preserved", 1, attempts.get())
      assertEquals(listOf(9, 8, 9), sent.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), sent.take(3).map { it.timestamp })
      assertEquals("LIVE", output.snapshot().state)
    } finally {
      releaseConnect.countDown()
      output.close()
    }
  }

  @Test fun sourceSessionResetInvalidatesOldCodecHeadersAndKeyframe() {
    val connectEntered = CountDownLatch(1)
    val connectReturned = CountDownLatch(1)
    val releaseConnect = CountDownLatch(1)
    val firstBatch = CountDownLatch(3)
    val attempts = AtomicInteger()
    val closeCalls = AtomicInteger()
    val sent = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {
            connectEntered.countDown()
            check(releaseConnect.await(10, TimeUnit.SECONDS)) { "blocked fake connect was not released" }
            connectReturned.countDown()
          }
          override fun publish(media: RtmpMessage) {
            sent += media
            firstBatch.countDown()
          }
          override fun close() { closeCalls.incrementAndGet() }
        }
      },
      retryDelaysMs = longArrayOf(0),
      waitMs = { Thread.sleep(1) }
    )
    val newAvcConfig = avcConfig().copy(data = byteArrayOf(0x17, 0, 0, 0, 0, 9, 9, 9))
    val newAacConfig = aacConfig().copy(data = byteArrayOf(0xaf.toByte(), 0, 0x34, 0x12))
    val newKeyframe = keyframe(500).copy(data = byteArrayOf(0x17, 1, 0, 0, 0, 0, 0, 9))
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(100))
      assertTrue("old source should start destination connect", connectEntered.await(3, TimeUnit.SECONDS))

      output.resetForSourceSession()
      assertEquals("CONNECTING", output.snapshot().state)
      assertEquals("source reset must discard the old queued GOP", 0, output.snapshot().queueBytes)
      releaseConnect.countDown()
      assertTrue("destination handshake should finish", connectReturned.await(3, TimeUnit.SECONDS))
      assertTrue("connected destination should await new source media",
        pollUntil(3_000) { output.snapshot().state == "WAITING FOR KEYFRAME" })

      // A keyframe without new codec headers must not reuse prior-session config.
      output.offer(keyframe(400))
      Thread.sleep(40)
      assertTrue("old codec headers must not make a new-session keyframe publishable", sent.isEmpty())
      assertEquals(0, closeCalls.get())

      output.offer(newAvcConfig)
      output.offer(newAacConfig)
      output.offer(newKeyframe)
      assertTrue("new source headers and keyframe should resume the connected output",
        firstBatch.await(3, TimeUnit.SECONDS))
      assertEquals("source reconnect should reuse the already established destination", 1, attempts.get())
      assertArrayEquals(newAvcConfig.data, sent[0].data)
      assertArrayEquals(newAacConfig.data, sent[1].data)
      assertArrayEquals(newKeyframe.data, sent[2].data)
      assertEquals(0, closeCalls.get())
    } finally {
      releaseConnect.countDown()
      output.close()
    }
  }

  @Test fun liveSourceResetPreservesTheNewGopWhenTheOldPublisherFails() {
    val firstBatch = CountDownLatch(3)
    val blockedOldPublish = CountDownLatch(1)
    val releaseOldPublish = CountDownLatch(1)
    val retryReached = CountDownLatch(1)
    val resumedBatch = CountDownLatch(3)
    val attempts = AtomicInteger()
    val sessionOne = CopyOnWriteArrayList<RtmpMessage>()
    val sessionTwo = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {}
          override fun publish(media: RtmpMessage) {
            if (session == 1 && media.type == 8 && media.data.size > 2 &&
              (media.data[1].toInt() and 255) == 1) {
              blockedOldPublish.countDown()
              check(releaseOldPublish.await(10, TimeUnit.SECONDS)) { "old publish was not released" }
              throw IOException("synthetic old-session close")
            }
            if (session == 1) {
              sessionOne += media
              firstBatch.countDown()
            } else {
              sessionTwo += media
              resumedBatch.countDown()
            }
          }
          override fun close() {}
        }
      },
      retryDelaysMs = longArrayOf(0),
      waitMs = { retryReached.countDown() }
    )
    val newAvcConfig = avcConfig().copy(data = byteArrayOf(0x17, 0, 0, 0, 0, 8, 8, 8))
    val newAacConfig = aacConfig().copy(data = byteArrayOf(0xaf.toByte(), 0, 0x56, 0x34))
    val newKeyframe = keyframe(500).copy(data = byteArrayOf(0x17, 1, 0, 0, 0, 0, 0, 8))
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("old output session should publish its start GOP", firstBatch.await(3, TimeUnit.SECONDS))

      output.offer(RtmpMessage(8, 50, 1, byteArrayOf(0xaf.toByte(), 1, 7, 8)))
      assertTrue("old publisher should be in-flight before source reset",
        blockedOldPublish.await(3, TimeUnit.SECONDS))
      output.resetForSourceSession()

      // Queue the new source GOP before the old publisher reports its close.
      output.offer(newAvcConfig)
      output.offer(newAacConfig)
      output.offer(newKeyframe)
      releaseOldPublish.countDown()

      assertTrue("old publisher failure should enter the retry path",
        retryReached.await(3, TimeUnit.SECONDS))
      assertTrue("retry should keep the new source GOP instead of waiting for another keyframe",
        resumedBatch.await(3, TimeUnit.SECONDS))
      assertEquals(2, attempts.get())
      assertArrayEquals(newAvcConfig.data, sessionTwo[0].data)
      assertArrayEquals(newAacConfig.data, sessionTwo[1].data)
      assertArrayEquals(newKeyframe.data, sessionTwo[2].data)
    } finally {
      releaseOldPublish.countDown()
      output.close()
    }
  }

  @Test fun manualReconnectWaitsForAnotherCleanKeyframeAndCreatesANewSession() {
    val publishers = CopyOnWriteArrayList<TestPublisher>()
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      TestPublisher().also { publishers += it }
    }, retryDelaysMs = longArrayOf(10_000))
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(10))
      assertTrue(pollUntil(2_000) { publishers.size == 1 && publishers[0].sent.size >= 3 })
      output.reconnectNow()
      output.offer(keyframe(120))
      assertTrue("manual reconnect should bypass retry delay and resume on a clean GOP",
        pollUntil(2_000) { publishers.size == 2 && publishers[1].sent.size >= 3 })
      assertEquals(1L, output.snapshot().reconnects)
      assertEquals(listOf(9, 8, 9), publishers[1].sent.take(3).map { it.type })
      assertEquals(0L, publishers[1].sent.first().timestamp)
    } finally { output.close() }
  }

  @Test fun manualReconnectWhileWaitingForKeyframeReplacesPublisherBeforeTheNextGop() {
    val firstConnectEntered = CountDownLatch(1)
    val releaseFirstConnect = CountDownLatch(1)
    val firstClosed = CountDownLatch(1)
    val secondConnected = CountDownLatch(1)
    val attempts = AtomicInteger()
    val firstSessionPackets = CopyOnWriteArrayList<RtmpMessage>()
    val resumedPackets = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {
            if (session == 1) {
              firstConnectEntered.countDown()
              check(releaseFirstConnect.await(10, TimeUnit.SECONDS)) { "first fake connect was not released" }
            } else {
              secondConnected.countDown()
            }
          }
          override fun publish(media: RtmpMessage) {
            if (session == 1) firstSessionPackets += media else resumedPackets += media
          }
          override fun close() {
            if (session == 1) firstClosed.countDown()
          }
        }
      },
      retryDelaysMs = longArrayOf(0),
      maxQueueMediaMs = 100,
      waitMs = { Thread.sleep(1) }
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("first destination connect should start", firstConnectEntered.await(2, TimeUnit.SECONDS))

      // Overflow the queued startup GOP while connect is blocked. The handshake
      // succeeds, but the established publisher must now wait for a fresh keyframe.
      output.offer(RtmpMessage(9, 101, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      releaseFirstConnect.countDown()
      assertTrue("connected publisher should wait for a fresh keyframe",
        pollUntil(2_000) { output.snapshot().state == "WAITING FOR KEYFRAME" })

      output.reconnectNow()
      assertTrue("manual reconnect should close the waiting publisher", firstClosed.await(2, TimeUnit.SECONDS))
      output.offer(keyframe(202))

      assertTrue("manual reconnect should create a new publisher", secondConnected.await(1, TimeUnit.SECONDS))
      assertTrue("new publisher should send the first clean GOP", pollUntil(2_000) { resumedPackets.size >= 3 })
      assertTrue("old waiting publisher must not consume media", firstSessionPackets.isEmpty())
      assertEquals(listOf(9, 8, 9), resumedPackets.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), resumedPackets.take(3).map { it.timestamp })
      assertEquals(2, attempts.get())
    } finally {
      releaseFirstConnect.countDown()
      output.close()
    }
  }

  @Test fun manualReconnectDuringPublisherFactorySkipsTheStaleConnect() {
    val factoryEntered = CountDownLatch(1)
    val releaseFactory = CountDownLatch(1)
    val stalePublisherClosed = CountDownLatch(1)
    val secondConnected = CountDownLatch(1)
    val attempts = AtomicInteger()
    val staleConnectCalls = AtomicInteger()
    val resumedPackets = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        if (session == 1) {
          factoryEntered.countDown()
          check(releaseFactory.await(10, TimeUnit.SECONDS)) { "stale factory was not released" }
        }
        object : MediaPublisher {
          override fun connect() {
            if (session == 1) staleConnectCalls.incrementAndGet() else secondConnected.countDown()
          }
          override fun publish(media: RtmpMessage) {
            if (session == 2) resumedPackets += media
          }
          override fun close() {
            if (session == 1) stalePublisherClosed.countDown()
          }
        }
      },
      retryDelaysMs = longArrayOf(0),
      waitMs = { Thread.sleep(1) }
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("publisher factory should start", factoryEntered.await(2, TimeUnit.SECONDS))

      // Reconnect before the first publisher has been assigned. The old factory
      // result must be closed without starting a stale network handshake.
      output.reconnectNow()
      releaseFactory.countDown()
      assertTrue("stale publisher should be retired", stalePublisherClosed.await(2, TimeUnit.SECONDS))
      assertEquals("stale publisher must not connect", 0, staleConnectCalls.get())

      output.offer(keyframe(120))
      assertTrue("fresh publisher should connect", secondConnected.await(2, TimeUnit.SECONDS))
      assertTrue("fresh publisher should receive a complete GOP", pollUntil(2_000) { resumedPackets.size >= 3 })
      assertEquals(listOf(9, 8, 9), resumedPackets.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), resumedPackets.take(3).map { it.timestamp })
      assertEquals(2, attempts.get())
    } finally {
      releaseFactory.countDown()
      output.close()
    }
  }

  @Test fun manualReconnectBetweenLiveSnapshotAndDequeueKeepsTheFreshGopIntact() {
    val liveSnapshotEntered = CountDownLatch(1)
    val releaseLiveSnapshot = CountDownLatch(1)
    val secondConnected = CountDownLatch(1)
    val firstLiveSnapshot = AtomicInteger()
    val attempts = AtomicInteger()
    val stalePackets = CopyOnWriteArrayList<RtmpMessage>()
    val stalePublishCalls = AtomicInteger()
    val resumedPackets = CopyOnWriteArrayList<RtmpMessage>()
    val firstCloseCount = AtomicInteger()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {
            if (session == 2) secondConnected.countDown()
          }
          override fun publish(media: RtmpMessage) {
            if (session == 1) stalePublishCalls.incrementAndGet()
            if (session == 1 && firstCloseCount.get() > 0) throw IOException("stale publisher was closed")
            if (session == 1) stalePackets += media else resumedPackets += media
          }
          override fun close() {
            if (session == 1) firstCloseCount.incrementAndGet()
          }
        }
      },
      retryDelaysMs = longArrayOf(0),
      onSnapshot = { snapshot ->
        if (snapshot.state == "LIVE" && firstLiveSnapshot.compareAndSet(0, 1)) {
          liveSnapshotEntered.countDown()
          check(releaseLiveSnapshot.await(10, TimeUnit.SECONDS)) { "LIVE snapshot was not released" }
        }
      }
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("worker should pause after marking the first publisher LIVE",
        liveSnapshotEntered.await(2, TimeUnit.SECONDS))

      output.reconnectNow()
      output.offer(keyframe(250))
      releaseLiveSnapshot.countDown()

      assertTrue("new publisher should connect", secondConnected.await(2, TimeUnit.SECONDS))
      assertTrue("new publisher should receive the complete fresh GOP",
        pollUntil(2_000) { resumedPackets.size >= 3 })
      assertTrue("stale publisher must not consume any fresh-GOP packets", stalePackets.isEmpty())
      assertEquals("stale publisher must not be called after reconnect", 0, stalePublishCalls.get())
      assertEquals(listOf(9, 8, 9), resumedPackets.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), resumedPackets.take(3).map { it.timestamp })
      assertEquals(2, attempts.get())
    } finally {
      releaseLiveSnapshot.countDown()
      output.close()
    }
  }

  @Test fun connectFailureWithFreshGopSkipsTheProductionRetryBackoff() {
    val firstConnectEntered = CountDownLatch(1)
    val releaseFirstConnect = CountDownLatch(1)
    val secondConnected = CountDownLatch(1)
    val attempts = AtomicInteger()
    val resumedPackets = CopyOnWriteArrayList<RtmpMessage>()
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        val session = attempts.incrementAndGet()
        object : MediaPublisher {
          override fun connect() {
            if (session == 1) {
              firstConnectEntered.countDown()
              check(releaseFirstConnect.await(10, TimeUnit.SECONDS)) { "first fake connect was not released" }
              throw IOException("synthetic connect failure")
            }
            secondConnected.countDown()
          }
          override fun publish(media: RtmpMessage) {
            if (session == 2) resumedPackets += media
          }
          override fun close() {}
        }
      },
      retryDelaysMs = longArrayOf(10_000),
      maxQueueMediaMs = 100,
      maxQueueAgeMs = 15_000
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("first destination handshake should start", firstConnectEntered.await(2, TimeUnit.SECONDS))

      // Overflow the original startup queue while CONNECTING, then give the
      // failing publisher a complete fresh GOP before releasing its failure.
      output.offer(RtmpMessage(9, 101, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      output.offer(keyframe(202))
      releaseFirstConnect.countDown()

      assertTrue("a ready fresh GOP should bypass the long retry delay",
        secondConnected.await(2, TimeUnit.SECONDS))
      assertTrue("the replacement publisher should send the complete fresh GOP",
        pollUntil(2_000) { resumedPackets.size >= 3 })
      assertEquals(listOf(9, 8, 9), resumedPackets.take(3).map { it.type })
      assertEquals(listOf(0L, 0L, 0L), resumedPackets.take(3).map { it.timestamp })
      assertEquals(2, attempts.get())
    } finally {
      releaseFirstConnect.countDown()
      output.close()
    }
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

  @Test fun liveOverflowDoesNotWaitForPublisherClose() {
    val enteredPublish = CountDownLatch(1)
    val closeEntered = CountDownLatch(1)
    val allowCloseToFinish = CountDownLatch(1)
    val releasePublish = CountDownLatch(1)
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      object : MediaPublisher {
        override fun connect() {}
        override fun publish(media: RtmpMessage) {
          enteredPublish.countDown()
          releasePublish.await(2, TimeUnit.SECONDS)
        }
        override fun close() {
          closeEntered.countDown()
          allowCloseToFinish.await(2, TimeUnit.SECONDS)
          releasePublish.countDown()
        }
      }
    }, retryDelaysMs = longArrayOf(1), waitMs = { Thread.sleep(1) })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("publisher should enter live send", enteredPublish.await(2, TimeUnit.SECONDS))
      val started = System.nanoTime()
      repeat(40) { i ->
        output.offer(RtmpMessage(9, i * 100L + 100L, 1, ByteArray(80_000) { 1 }))
      }
      val elapsedMs = (System.nanoTime() - started) / 1_000_000
      assertTrue("overflow handling must not wait for a slow socket close", elapsedMs < 500)
      assertTrue("the destination close should run asynchronously", closeEntered.await(1, TimeUnit.SECONDS))
    } finally {
      allowCloseToFinish.countDown()
      releasePublish.countDown()
      output.close()
    }
  }

  @Test fun blockedPublisherCloseDoesNotPreventItsOutputFromRetrying() {
    val firstFailure = CountDownLatch(1)
    val firstCloseEntered = CountDownLatch(1)
    val releaseFirstClose = CountDownLatch(1)
    val secondConnected = CountDownLatch(1)
    val secondPackets = CopyOnWriteArrayList<RtmpMessage>()
    val attempts = AtomicInteger()
    val output = ReliableRtmpOutput(destination(), publisherFactory = {
      if (attempts.getAndIncrement() == 0) object : MediaPublisher {
        override fun connect() {}
        override fun publish(media: RtmpMessage) {
          firstFailure.countDown()
          throw IOException("synthetic destination failure")
        }
        override fun close() {
          firstCloseEntered.countDown()
          releaseFirstClose.await(5, TimeUnit.SECONDS)
        }
      } else object : MediaPublisher {
        override fun connect() { secondConnected.countDown() }
        override fun publish(media: RtmpMessage) { secondPackets += media }
        override fun close() {}
      }
    }, retryDelaysMs = longArrayOf(1), waitMs = { Thread.sleep(1) })
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue("first publisher should fail synthetically", firstFailure.await(2, TimeUnit.SECONDS))
      assertTrue("first close should enter its blocking section", firstCloseEntered.await(2, TimeUnit.SECONDS))

      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(1_000))
      assertTrue("the same destination should retry while old close is blocked",
        secondConnected.await(2, TimeUnit.SECONDS))
      assertTrue("replacement publisher should receive a clean fresh GOP",
        pollUntil(2_000) { secondPackets.size >= 3 })
      assertEquals(listOf(9, 8, 9), secondPackets.take(3).map { it.type })
    } finally {
      releaseFirstClose.countDown()
      output.close()
    }
  }

  @Test fun retryBackoffIncreasesAndCaps() {
    assertEquals(1_000L, ReliableRtmpOutput.retryDelayMs(1))
    assertEquals(2_000L, ReliableRtmpOutput.retryDelayMs(2))
    assertEquals(30_000L, ReliableRtmpOutput.retryDelayMs(99))
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
      retryDelaysMs = longArrayOf(10_000),
      maxQueueAgeMs = 100,
      clockMs = { nowMs.get() },
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
      assertTrue("stale output should retire its old session and wait for a keyframe",
        pollUntil(2_000) { output.snapshot().state == "WAITING FOR KEYFRAME" })
      assertEquals("overflow must not open another session before a fresh keyframe", 1, attempts.get())

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

  @Test fun mediaDurationLimitDropsBacklogAndWaitsForAKeyframe() {
    val firstPublishEntered = CountDownLatch(1)
    val releaseFirstPublish = CountDownLatch(1)
    val output = ReliableRtmpOutput(
      destination(),
      publisherFactory = {
        object : MediaPublisher {
          override fun connect() {}
          override fun publish(media: RtmpMessage) {
            firstPublishEntered.countDown()
            check(releaseFirstPublish.await(2, TimeUnit.SECONDS)) { "blocked fake publisher was not released" }
          }
          override fun close() { releaseFirstPublish.countDown() }
        }
      },
      maxQueueMediaMs = 100,
      retryDelaysMs = longArrayOf(0),
      waitMs = {}
    )
    try {
      output.start()
      output.offer(avcConfig())
      output.offer(aacConfig())
      output.offer(keyframe(0))
      assertTrue(firstPublishEntered.await(2, TimeUnit.SECONDS))

      output.offer(RtmpMessage(9, 100, 1, byteArrayOf(0x27, 1, 0, 0, 0, 1)))
      output.offer(RtmpMessage(9, 201, 1, byteArrayOf(0x27, 1, 0, 0, 0, 2)))

      val snapshot = output.snapshot()
      assertEquals("media-time overflow should clear the queue", 0, snapshot.queueBytes)
      assertTrue("dropped backlog should be accounted", snapshot.droppedPackets >= 4)
      assertTrue("output should pause while it waits for a clean keyframe",
        snapshot.state == "WAITING FOR KEYFRAME" || snapshot.state == "RETRYING")
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
      Thread.sleep(50) // ensure healthy senders are waiting on empty queues before the next batch

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

  @Test fun publisherCleanupUsesABoundedWorkerPoolUnderConcurrentAborts() {
    val outputCount = 12
    val connected = CountDownLatch(outputCount)
    val firstCloseWorkersStarted = CountDownLatch(3)
    val closeCallsStarted = AtomicInteger()
    val closed = CountDownLatch(outputCount)
    val allowCloseToFinish = CountDownLatch(1)
    val activeCloses = AtomicInteger()
    val maxActiveCloses = AtomicInteger()
    val outputs = (0 until outputCount).map { index ->
      ReliableRtmpOutput(sandboxDestination("youtube$index"), publisherFactory = {
        object : MediaPublisher {
          override fun connect() { connected.countDown() }
          override fun publish(media: RtmpMessage) {}
          override fun close() {
            val active = activeCloses.incrementAndGet()
            maxActiveCloses.updateAndGet { previous -> maxOf(previous, active) }
            closeCallsStarted.incrementAndGet()
            firstCloseWorkersStarted.countDown()
            try {
              check(allowCloseToFinish.await(5, TimeUnit.SECONDS)) { "synthetic close was not released" }
            } finally {
              activeCloses.decrementAndGet()
              closed.countDown()
            }
          }
        }
      })
    }
    try {
      outputs.forEach { output ->
        output.start()
        output.offer(avcConfig())
        output.offer(aacConfig())
        output.offer(keyframe(0))
      }
      assertTrue("every synthetic output should connect", connected.await(3, TimeUnit.SECONDS))
      outputs.forEach { it.reconnectNow() }

      assertTrue("cleanup workers should start closing publishers",
        firstCloseWorkersStarted.await(2, TimeUnit.SECONDS))
      Thread.sleep(150)
      assertEquals("slow closes should be capped at the fixed pool size",
        3, closeCallsStarted.get())
      assertTrue("the maximum active close count must remain bounded",
        maxActiveCloses.get() <= 3)
      val closeThreads = Thread.getAllStackTraces().keys.count {
        it.name == "SweatyOBS-publisher-close" || it.name.endsWith("-abort")
      }
      assertTrue("publisher cleanup must not create one thread per reconnect", closeThreads <= 3)
    } finally {
      allowCloseToFinish.countDown()
      outputs.forEach { it.close() }
    }
    assertTrue("all publishers should eventually close after capacity returns",
      closed.await(5, TimeUnit.SECONDS))
    assertEquals(0, closed.count)
    assertTrue("publisher cleanup remains bounded after draining",
      maxActiveCloses.get() <= 3)
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
