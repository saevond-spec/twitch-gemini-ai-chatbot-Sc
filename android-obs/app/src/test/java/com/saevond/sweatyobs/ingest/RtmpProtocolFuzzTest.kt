package com.saevond.sweatyobs.ingest

import java.io.ByteArrayInputStream
import java.io.EOFException
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
}
