package com.saevond.sweatyobs

import com.saevond.sweatyobs.ingest.RtmpDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SleipnirRelayTest {
  @Test fun configuredSleipnirIngestDefaultUsesPort1936() {
    assertEquals("rtmps://ingest.sleipnir.tv:1936/live", SleipnirRelay.DEFAULT_INGEST_URL)
    assertTrue(RtmpDestination(
      "sleipnir", "Sleipnir", SleipnirRelay.DEFAULT_INGEST_URL, "sandbox-sleipnir-key-1234"
    ).isValid())
  }

  @Test fun encoderVideoRateLadderLeavesAudioAndNetworkHeadroom() {
    assertEquals(4_200_000, SleipnirRelay.videoBitrate(1920, 1080, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(2_800_000, SleipnirRelay.videoBitrate(1280, 720, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(1_800_000, SleipnirRelay.videoBitrate(960, 540, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(1_400_000, SleipnirRelay.videoBitrate(854, 480, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(900_000, SleipnirRelay.videoBitrate(640, 360, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(500_000, SleipnirRelay.videoBitrate(426, 240, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(8_000_000, SleipnirRelay.videoBitrate(1920, 1080))
    assertEquals(4_760_800L, SleipnirRelay.projectedIngestBitrate(4_200_000))
    assertTrue(SleipnirRelay.projectedIngestBitrate(4_200_000) < SleipnirRelay.MAX_INGEST_BITRATE_BPS)
  }

  @Test fun sizeCandidatesFollowAspectRatioAndNeverUpscale() {
    assertEquals(
      listOf(1920 to 1080, 1280 to 720, 960 to 540, 854 to 480, 640 to 360, 426 to 240),
      SleipnirRelay.candidateSizes(1920, 1080)
    )
    val smallerSource = SleipnirRelay.candidateSizes(1280, 720)
    assertEquals(1280 to 720, smallerSource.first())
    assertTrue(smallerSource.all { (width, height) -> width <= 1280 && height <= 720 })
    assertEquals(1080 to 1920, SleipnirRelay.candidateSizes(1080, 1920).first())
  }

  @Test fun codecBitrateFittingHonorsCodecAndRouteBounds() {
    assertEquals(
      4_000_000,
      SleipnirRelay.fitCodecBitrate(4_500_000, 100_000, 4_000_000, 4_500_000)
    )
    assertEquals(
      800_000,
      SleipnirRelay.fitCodecBitrate(500_000, 800_000, 2_000_000, 4_500_000)
    )
    assertNull(SleipnirRelay.fitCodecBitrate(4_500_000, 4_600_000, 8_000_000, 4_500_000))
  }

  @Test fun sleipnirOutputRequiresSecureIngestAndAValidSyntheticKey() {
    val valid = RtmpDestination(
      "sleipnir", "Sleipnir", SleipnirRelay.DEFAULT_INGEST_URL, "sandbox-sleipnir-key-1234")
    assertTrue(valid.isValid())
    assertFalse(valid.copy(serverUrl = "rtmp://ingest.sleipnir.tv/live").isValid())
    assertFalse(valid.copy(key = "").isValid())
  }

  @Test fun relayModeReplacesDirectOutputsWithExactlyOneSleipnirUpstream() {
    val direct = listOf(
      RtmpDestination("twitch", "Twitch", "rtmps://live.twitch.tv/app", "sandbox-twitch-key-1234"),
      RtmpDestination("youtube", "YouTube", "rtmps://youtube.example.test/live", "sandbox-youtube-key-1234"),
      RtmpDestination("kick", "Kick", "rtmps://kick.example.test/app", "sandbox-kick-key-1234"))
    val relay = OutputRouteSelector.select(
      true, SleipnirRelay.DEFAULT_INGEST_URL, "sandbox-sleipnir-key-1234", direct)
    assertEquals(1, relay.size)
    assertEquals("sleipnir", relay.single().id)
    assertEquals(direct, OutputRouteSelector.select(false, "", "", direct))
  }

  @Test fun transcodedRelayForwardsOnlyEncoderGeneratedCodecHeaders() {
    assertFalse(OutputRouteSelector.shouldForwardSourceAvcConfig(transcoderActive = true))
    assertTrue(OutputRouteSelector.shouldForwardSourceAvcConfig(transcoderActive = false))
  }
}
