package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameTimestampPacerTest {
  @Test fun thirtyFpsPacerToleratesTimestampRoundingAndDropsExcessFrames() {
    val pacer = FrameTimestampPacer(30)
    assertEquals(0L, pacer.nextTimestampNs(0L))
    assertNull(pacer.nextTimestampNs(16_000_000L))
    assertEquals(33_000_000L, pacer.nextTimestampNs(33_000_000L))
    assertNull(pacer.nextTimestampNs(50_000_000L))
    assertEquals(67_000_000L, pacer.nextTimestampNs(67_000_000L))
    assertNull(pacer.nextTimestampNs(67_000_000L))
    assertNull(pacer.nextTimestampNs(60_000_000L))
    assertEquals(100_000_000L, pacer.nextTimestampNs(100_000_000L))
  }

  @Test fun sixtyFpsPacerAcceptsMillisecondQuantizedSourceCadence() {
    val pacer = FrameTimestampPacer(60)
    assertEquals(10_000_000L, pacer.nextTimestampNs(10_000_000L))
    assertEquals(26_000_000L, pacer.nextTimestampNs(26_000_000L))
    assertEquals(43_000_000L, pacer.nextTimestampNs(43_000_000L))
  }

  @Test fun sixtyToThirtyFpsRunsNearTargetOverTwentySeconds() {
    assertEquals(600, pacedCount(sourceFps = 60, targetFps = 30, seconds = 20))
  }

  @Test fun sixtyToTwentyFourFpsRunsNearTargetOverTwentySeconds() {
    assertEquals(480, pacedCount(sourceFps = 60, targetFps = 24, seconds = 20))
  }

  @Test fun thirtyToThirtyFpsDoesNotLoseFramesToRounding() {
    assertEquals(600, pacedCount(sourceFps = 30, targetFps = 30, seconds = 20))
  }

  @Test fun thirtyToTwentyFourFpsUsesFractionalFrameSelection() {
    assertEquals(480, pacedCount(sourceFps = 30, targetFps = 24, seconds = 20))
  }

  private fun pacedCount(sourceFps: Int, targetFps: Int, seconds: Int): Int {
    val pacer = FrameTimestampPacer(targetFps)
    val sourceFrames = sourceFps * seconds
    return (0 until sourceFrames).count { frame ->
      val millisecondTimestamp = frame.toLong() * 1_000L / sourceFps
      pacer.nextTimestampNs(millisecondTimestamp * 1_000_000L) != null
    }
  }
}
