package com.saevond.sweatyobs

import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.core.app.ActivityScenario
import org.hamcrest.Matchers.containsString

internal object AdminPasswordUiTestSupport {
  const val TEST_PASSWORD = "synthetic-admin-key-for-emulator-tests-2026"

  fun installFakeVerifier(scenario: ActivityScenario<MainActivity>) {
    scenario.onActivity { activity ->
      activity.adminKeyVerifier = AdminKeyVerifier { key ->
        if (key == TEST_PASSWORD) AdminKeyUnlockResult.ACCEPTED else AdminKeyUnlockResult.REJECTED
      }
    }
  }

  fun unlockOrSetPassword(scenario: ActivityScenario<MainActivity>) {
    installFakeVerifier(scenario)
    onView(withId(R.id.admin_password)).perform(replaceText(TEST_PASSWORD), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    waitForView(R.id.brand_header)
  }

  fun waitForView(viewId: Int) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val deadline = System.currentTimeMillis() + 8_000L
    while (System.currentTimeMillis() < deadline) {
      instrumentation.waitForIdleSync()
      val visible = runCatching { onView(withId(viewId)).check(matches(isDisplayed())) }.isSuccess
      if (visible) return
      Thread.sleep(50)
    }
    throw AssertionError("Timed out waiting for view $viewId")
  }

  fun waitForText(viewId: Int, text: String) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val deadline = System.currentTimeMillis() + 8_000L
    while (System.currentTimeMillis() < deadline) {
      instrumentation.waitForIdleSync()
      val visible = runCatching {
        onView(withId(viewId)).check(matches(withText(containsString(text))))
      }.isSuccess
      if (visible) return
      Thread.sleep(50)
    }
    throw AssertionError("Timed out waiting for status text")
  }
}
