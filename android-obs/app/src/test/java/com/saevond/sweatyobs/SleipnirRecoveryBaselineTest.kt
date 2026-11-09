package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Regression guards for the historical Android PS5 -> one Sleipnir upstream path. */
class SleipnirRecoveryBaselineTest {
  @Test fun usesVerifiedSecureIngestEndpoint() {
    assertEquals("rtmps://ingest.sleipnir.tv:1936/live", SleipnirRelay.DEFAULT_INGEST_URL)
  }

  @Test fun lowLoadAndNormalProfilesStayBelowPlannedFreeTierBudget() {
    for (videoBps in listOf(1_800_000, 3_200_000, SleipnirRelay.MAX_VIDEO_BITRATE_BPS)) {
      assertTrue(
        "Projected ingest exceeds planned relay cap at $videoBps",
        SleipnirRelay.projectedIngestBitrate(videoBps) <= SleipnirRelay.MAX_INGEST_BITRATE_BPS
      )
    }
  }

  @Test fun noSourceUpscalingInCodecFallbackLadder() {
    val sizes = SleipnirRelay.candidateSizes(1280, 720, maxLongSide = 1280)
    assertTrue(sizes.isNotEmpty())
    assertTrue(sizes.all { (w, h) -> w <= 1280 && h <= 720 && w > 0 && h > 0 })
    assertTrue(sizes.all { (w, h) -> w % 2 == 0 && h % 2 == 0 })
  }

  @Test fun transcoderMustNotForwardOriginalAvcHeader() {
    assertFalse(OutputRouteSelector.shouldForwardSourceAvcConfig(true))
    assertTrue(OutputRouteSelector.shouldForwardSourceAvcConfig(false))
  }

  @Test fun sleipnirRateControlNeverFallsBackToVbr() {
    val modes = SleipnirRelay.cappedRateControlRequests(false, false)
    assertEquals(1, modes.size)
    assertEquals(SleipnirRelay.RateControl.CBR, modes.single().mode)
    assertFalse(modes.single().advertised)
  }
}
