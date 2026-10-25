package com.saevond.sweatyobs

import com.saevond.sweatyobs.ingest.RtmpDestination

/** Enforces one upstream connection when cloud relay mode is selected. */
internal object OutputRouteSelector {
  /** The transcoder emits its own output codec headers; never leak input SPS/PPS downstream. */
  fun shouldForwardSourceAvcConfig(transcoderActive: Boolean): Boolean = !transcoderActive

  fun select(
    sleipnirEnabled: Boolean,
    sleipnirServer: String,
    sleipnirKey: String,
    directDestinations: List<RtmpDestination>
  ): List<RtmpDestination> = if (sleipnirEnabled) {
    listOf(RtmpDestination("sleipnir", "Sleipnir", sleipnirServer, sleipnirKey))
  } else directDestinations
}
