package com.saevond.sweatyobs

import com.saevond.sweatyobs.ingest.RtmpDestination

/** Enforces one upstream connection when cloud relay mode is selected. */
internal object OutputRouteSelector {
  fun select(
    sleipnirEnabled: Boolean,
    sleipnirServer: String,
    sleipnirKey: String,
    directDestinations: List<RtmpDestination>
  ): List<RtmpDestination> = if (sleipnirEnabled) {
    listOf(RtmpDestination("sleipnir", "Sleipnir", sleipnirServer, sleipnirKey))
  } else directDestinations
}
}
