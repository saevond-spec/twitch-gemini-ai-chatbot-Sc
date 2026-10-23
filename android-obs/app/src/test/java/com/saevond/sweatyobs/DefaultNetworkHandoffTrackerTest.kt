package com.saevond.sweatyobs

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultNetworkHandoffTrackerTest {
  @Test fun ignoresInitialRouteAndReconnectsOnIdentityLossOrChange() {
    val tracker = DefaultNetworkHandoffTracker<String>()
    assertFalse(tracker.onAvailable("wifi-a"))
    assertFalse(tracker.onAvailable("wifi-a"))
    assertTrue(tracker.onAvailable("cellular"))
    assertFalse(tracker.onLost("wifi-a"))
    assertTrue(tracker.onLost("cellular"))
    assertTrue(tracker.onAvailable("wifi-b"))
    assertFalse(tracker.onLost("cellular"))
  }

  @Test fun resetMakesNextCallbackInitialAgain() {
    val tracker = DefaultNetworkHandoffTracker<String>()
    assertFalse(tracker.onAvailable("wifi-a"))
    tracker.reset()
    assertFalse(tracker.onAvailable("cellular"))
  }
}
