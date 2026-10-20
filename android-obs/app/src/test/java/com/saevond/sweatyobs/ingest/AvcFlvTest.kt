package com.saevond.sweatyobs.ingest

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
