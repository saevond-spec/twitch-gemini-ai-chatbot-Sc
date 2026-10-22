package com.saevond.sweatyobs

import android.widget.Spinner
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GenreUiSmokeTest {
  @get:Rule val scenario = ActivityScenarioRule(MainActivity::class.java)

  @Before fun unlockEncoderForUiTest() = AdminPasswordUiTestSupport.unlockOrSetPassword(scenario.scenario)

  @Test fun remoteStationPickerSendsOnlyAStationCommand() {
    scenario.scenario.onActivity { activity ->
      val station = activity.findViewById<Spinner>(R.id.music_genre)
      assertEquals(2, station.adapter.count)
      station.setSelection(1) // Club / House
    }
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val deadline = System.currentTimeMillis() + 8_000L
    while (System.currentTimeMillis() < deadline &&
      AdminPasswordUiTestSupport.actions.none { it == ("station" to "club") }) {
      instrumentation.waitForIdleSync()
      Thread.sleep(40)
    }
    assertEquals(true, AdminPasswordUiTestSupport.actions.contains("station" to "club"))
    assertFalse(Ps5LanService.receiverRunning)
  }
}
