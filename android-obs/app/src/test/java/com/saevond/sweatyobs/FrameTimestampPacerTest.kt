package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FrameTimestampPacerTest {
  @Test fun thirtyFpsPacerDropsExcessAndNonMonotonicFrames() {
    val pacer = FrameTimestampPacer(30)
    assertEquals(1L, pacer.nextTimestampNs(0L))
    assertNull(pacer.nextTimestampNs(16_666_667L))
    assertEquals(33_333_334L, pacer.nextTimestampNs(33_333_334L))
    assertNull(pacer.nextTimestampNs(33_333_334L))
    assertNull(pacer.nextTimestampNs(30_000_000L))
    assertEquals(66_666_667L, pacer.nextTimestampNs(66_666_667L))
  }

  @Test fun sixtyFpsPacerAcceptsFramesAtSelectedCadence() {
    val pacer = FrameTimestampPacer(60)
    assertEquals(10_000_000L, pacer.nextTimestampNs(10_000_000L))
    assertEquals(26_666_667L, pacer.nextTimestampNs(26_666_667L))
  }
}
