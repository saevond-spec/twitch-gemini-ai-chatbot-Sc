package com.saevond.sweatyobs.ingest

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ReliableRtmpOutputTest {
  private fun destination() = RtmpDestination(
    "youtube", "YouTube", "rtmps://ingest.example.com/live", "example_stream_key-12345")

  private fun avcConfig() = RtmpMessage(9, 0, 1, byteArrayOf(0x17, 0, 0, 0, 0, 1, 2, 3))
  private fun aacConfig() = RtmpMessage(8, 0, 1, byteArrayOf(0xaf.toByte(), 0, 0x12, 0x10))
  private fun keyframe(timestamp: Long) =
    RtmpMessage(9, timestamp, 1, byteArrayOf(0x17, 1, 0, 0, 0, 0, 0, 1))

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
