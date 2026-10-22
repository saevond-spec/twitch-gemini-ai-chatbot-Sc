package com.saevond.sweatyobs.ingest

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

class AvcFlvTest {
  @Test fun sampleConvertsLengthPrefixedNalsToAnnexB() {
    val config = AvcFlvConfig(2, byteArrayOf(0x67), byteArrayOf(0x68), 1280, 720)
    val message = RtmpMessage(9, 500, 1, byteArrayOf(
      0x17, 1, 0, 0, 0,
      0, 3, 0x65, 0x11, 0x22,
      0, 2, 0x06, 0x33
    ))

    assertArrayEquals(byteArrayOf(
      0, 0, 0, 1, 0x65, 0x11, 0x22,
      0, 0, 0, 1, 0x06, 0x33
    ), AvcFlv.sample(message, config))
  }

  @Test fun sampleRejectsTruncatedNalLengths() {
    val config = AvcFlvConfig(4, byteArrayOf(0x67), byteArrayOf(0x68), 1280, 720)
    val message = RtmpMessage(9, 0, 1, byteArrayOf(0x17, 1, 0, 0, 0, 0, 0, 0))

    try {
      AvcFlv.sample(message, config)
      throw AssertionError("Expected an invalid AVC access unit to be rejected")
    } catch (_: IllegalArgumentException) {
      // Expected: malformed source data must not be handed to MediaCodec.
    }
  }

  @Test fun encoderFrameUsesFlvAvcPacketAndPreservesNals() {
    val message = AvcFlv.toFlvFrame(byteArrayOf(0, 0, 0, 1, 0x65, 0x44), true, 1_234)
    assertEquals(9, message.type)
    assertEquals(1_234L, message.timestamp)
    assertEquals(0x17, message.data[0].toInt() and 255)
    assertEquals(1, message.data[1].toInt())
    assertTrue(message.data.copyOfRange(5, message.data.size).contentEquals(
      byteArrayOf(0, 0, 0, 2, 0x65, 0x44)))
  }

  @Test fun malformedAvcSamplesStayInsideParserBounds() {
    val random = Random(0x5ae70L)
    repeat(5_000) {
      val length = 6 + random.nextInt(2_043)
      val data = ByteArray(length).also(random::nextBytes)
      data[0] = 0x17
      data[1] = 1
      val config = AvcFlvConfig(1 + random.nextInt(4), byteArrayOf(0x67), byteArrayOf(0x68), 1280, 720)
      try {
        AvcFlv.sample(RtmpMessage(9, 0, 1, data), config)?.let { output ->
          assertTrue("converted AVC sample must remain bounded", output.size <= length + 4 * 256)
        }
      } catch (_: IllegalArgumentException) {
        // Reject malformed NAL lengths before handing input to MediaCodec.
      }
    }
  }
}
