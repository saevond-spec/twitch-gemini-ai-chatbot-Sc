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
import org.hamcrest.Matchers.containsString
import org.junit.Assert.assertTrue

internal object AdminPasswordUiTestSupport {
  const val TEST_PASSWORD = "synthetic-admin-password-2026"

  fun unlockOrSetPassword() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val setup = !AdminPasswordStore(context).isConfigured()
    onView(withId(R.id.admin_password)).perform(replaceText(TEST_PASSWORD), closeSoftKeyboard())
    if (setup) {
      onView(withId(R.id.admin_password_confirm)).perform(replaceText(TEST_PASSWORD), closeSoftKeyboard())
    }
    onView(withId(R.id.admin_password_submit)).perform(click())
    waitForView(R.id.brand_header)
    assertTrue(AdminPasswordStore(context).verify(TEST_PASSWORD))
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
