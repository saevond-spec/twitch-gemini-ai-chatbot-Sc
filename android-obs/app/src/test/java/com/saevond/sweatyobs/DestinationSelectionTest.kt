package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DestinationSelectionTest {
  @Test fun anUncheckedDestinationStaysOffWhenItsKeyIsAddedLater() {
    var persisted: Boolean? = null
    val initial = initializeDestinationSelection(null, configuredDefault = false) { persisted = it }

    assertFalse(initial)
    assertEquals(false, persisted)

    val afterKeySaved = initializeDestinationSelection(persisted, configuredDefault = true) {
      persisted = it
    }
    assertFalse(afterKeySaved)
    assertEquals(false, persisted)
  }

  @Test fun configuredKeyIsPersistedAsTheInitialDefaultButExplicitChoiceWins() {
    var persisted: Boolean? = null
    val initial = initializeDestinationSelection(null, configuredDefault = true) { persisted = it }

    assertTrue(initial)
    assertEquals(true, persisted)

    persisted = false
    val explicitOff = initializeDestinationSelection(persisted, configuredDefault = true) { persisted = it }
    assertFalse(explicitOff)
    assertEquals(false, persisted)
  }
}
