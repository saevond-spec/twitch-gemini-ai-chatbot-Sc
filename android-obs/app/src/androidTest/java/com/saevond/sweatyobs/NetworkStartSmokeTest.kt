package com.saevond.sweatyobs

import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import android.os.SystemClock
import org.hamcrest.Matchers.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkStartSmokeTest {
  @get:Rule val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @Test fun invalidAddressTapReportsVisibleFailure() {
    onView(withId(R.id.start_network_test)).perform(scrollTo(), click())
    onView(withId(R.id.connection_status)).check(matches(withText(containsString("Enter the PS5"))))
  }

  @Test fun validAddressTapReportsRealServiceOutcome() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences(Ps5LanService.STATUS_PREFS, 0)
    assertTrue(prefs.edit().remove(Ps5LanService.PREF_STATUS_MESSAGE).commit())
    onView(withId(R.id.ps5_ip_address)).perform(scrollTo(), replaceText("192.168.1.20"), closeSoftKeyboard())
    onView(withId(R.id.start_network_test)).perform(scrollTo(), click())
    onView(withId(R.id.connection_status)).check(matches(not(withText("Ready for test — no broadcast is sent."))))
    var result: String? = null
    val deadline = SystemClock.uptimeMillis() + 9000
    while (SystemClock.uptimeMillis() < deadline && result == null) {
      result = prefs.getString(Ps5LanService.PREF_STATUS_MESSAGE, null)
      if (result == null) SystemClock.sleep(150)
    }
    assertNotNull("Service did not report back; Start button must never silently fail", result)
    assertTrue("No diagnostic result", result!!.isNotEmpty())
    onView(withId(R.id.stop_network_test)).perform(scrollTo(), click())
  }
}
