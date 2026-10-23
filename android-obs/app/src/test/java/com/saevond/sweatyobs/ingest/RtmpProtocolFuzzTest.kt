package com.saevond.sweatyobs.ingest

import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.ByteArrayOutputStream
import java.io.SocketTimeoutException
import java.util.Random
import org.junit.Assert.assertTrue
import org.junit.Test

class RtmpProtocolFuzzTest {
  @Test fun malformedChunkHeadersFailClosedWithoutUnboundedPayloads() {
    val random = Random(0x48a11L)
    repeat(5_000) {
      val bytes = ByteArray(random.nextInt(512)).also(random::nextBytes)
      try {
        val message = RtmpChunkReader(ByteArrayInputStream(bytes)).nextMessage()
        assertTrue("RTMP payload must respect the parser limit", message.data.size <= 2_097_152)
      } catch (_: EOFException) {
        // A truncated synthetic peer is expected to disconnect.
      } catch (_: IllegalArgumentException) {
        // A malformed header or size field is rejected.
      }
    }
  }
  @Test fun aggregateInFlightPayloadBudgetStopsInterleavedChunks() {
    val bytes = ByteArray(128) { 0x55 }
    val stream = ByteArrayOutputStream()
    fun start(csid: Int, length: Int) {
      stream.write(byteArrayOf(
        csid.toByte(), 0, 0, 0,
        (length ushr 16).toByte(), (length ushr 8).toByte(), length.toByte(),
        9, 1, 0, 0, 0
      ))
      stream.write(bytes)
    }
    fun continuation(csid: Int) {
      stream.write(0xc0 or csid)
      stream.write(bytes)
    }
    start(6, 640)
    start(4, 640)
    continuation(6)
    continuation(4)
    continuation(6)

    try {
      RtmpChunkReader(ByteArrayInputStream(stream.toByteArray()), maxAggregateBufferedBytes = 512)
        .nextMessage()
      org.junit.Assert.fail("interleaved partial messages must respect the aggregate budget")
    } catch (error: IllegalArgumentException) {
      assertTrue(error.message.orEmpty().contains("aggregate"))
    }
  }

  @Test fun slowTrickleCannotExtendOneMessagePastItsDeadline() {
    val encoded = ByteArrayOutputStream().also {
      sendRtmpMedia(it, RtmpMessage(9, 0, 1, ByteArray(512) { 0x33 }))
    }.toByteArray()
    val source = ByteArrayInputStream(encoded)
    var now = 0L
    val slow = object : InputStream() {
      override fun read(): Int = source.read().also { if (it >= 0) now += 5_000L }
      override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        source.read(buffer, offset, length).also { if (it > 0) now += 5_000L }
    }
    try {
      RtmpChunkReader(slow, messageDeadlineMs = 15_000L, nowMs = { now }).nextMessage()
      org.junit.Assert.fail("slow trickle should be closed at the absolute message deadline")
    } catch (_: SocketTimeoutException) {
      // Expected: the synthetic input advances five seconds per read call.
    }
  }

  @Test fun completedLargeMessagesReleaseTheirBackingBuffers() {
    val encoded = ByteArrayOutputStream().also { output ->
      sendRtmpMedia(output, RtmpMessage(9, 0, 1, ByteArray(1_048_576) { 0x11 }))
      sendRtmpMedia(output, RtmpMessage(8, 23, 1, ByteArray(1_048_576) { 0x22 }))
    }.toByteArray()
    val reader = RtmpChunkReader(ByteArrayInputStream(encoded))
    assertEquals(1_048_576, reader.nextMessage().data.size)
    assertEquals(1_048_576, reader.nextMessage().data.size)
    assertTrue("completed buffers should return to small defaults",
      reader.retainedBufferCapacityBytesForTest() <= 2_048L)
  }

}
