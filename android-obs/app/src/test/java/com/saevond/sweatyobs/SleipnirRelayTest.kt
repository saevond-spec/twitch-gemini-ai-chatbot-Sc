package com.saevond.sweatyobs

import com.saevond.sweatyobs.ingest.RtmpDestination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SleipnirRelayTest {
  @Test fun configuredSleipnirIngestDefaultUsesPort1936() {
    assertEquals("rtmps://ingest.sleipnir.tv:1936/live", SleipnirRelay.DEFAULT_INGEST_URL)
    assertTrue(RtmpDestination(
      "sleipnir", "Sleipnir", SleipnirRelay.DEFAULT_INGEST_URL, "sandbox-sleipnir-key-1234"
    ).isValid())
  }

  @Test fun encoderVideoRateFitsAdvertisedFreeTierWithAudioHeadroom() {
    assertEquals(4_700_000, SleipnirRelay.videoBitrate(1920, 1080, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(4_700_000, SleipnirRelay.videoBitrate(1280, 720, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(4_000_000, SleipnirRelay.videoBitrate(854, 480, SleipnirRelay.MAX_VIDEO_BITRATE_BPS))
    assertEquals(8_000_000, SleipnirRelay.videoBitrate(1920, 1080))
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
