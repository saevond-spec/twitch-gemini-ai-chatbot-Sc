package com.saevond.sweatyobs

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConnectionTimelineSmokeTest {
  @Test
  fun eventsArePersistedAndReturnedInOrder() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val suffix = System.currentTimeMillis().toString()
    val first = "timeline-smoke-first-$suffix"
    val second = "timeline-smoke-second-$suffix"

    ConnectionTimeline.append(context, first)
    ConnectionTimeline.append(context, second)

    val saved = ConnectionTimeline.events(context).filter {
      it.message == first || it.message == second
    }
    assertEquals(listOf(first, second), saved.map { it.message })
    assertTrue(saved[0].timestampMs <= saved[1].timestampMs)
  }
}
