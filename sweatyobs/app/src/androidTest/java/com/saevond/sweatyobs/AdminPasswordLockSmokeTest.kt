package com.saevond.sweatyobs

import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.ViewActions.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.replaceText
import androidx.test.espresso.action.ViewActions.scrollTo
import androidx.test.espresso.assertion.ViewAssertions.doesNotExist
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AdminPasswordLockSmokeTest {
  @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

  @Test fun remoteKeyIsRequiredAfterLaunchAndManualLock() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertTrue(context.getSharedPreferences("encoder_admin_lock", 0).all.isEmpty())
    onView(withId(R.id.admin_password_confirm)).check(doesNotExist())
    onView(withId(R.id.brand_header)).check(doesNotExist())

    AdminPasswordUiTestSupport.installFakeVerifier(activity.scenario)
    onView(withId(R.id.admin_password)).perform(replaceText("incorrect synthetic key"), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.admin_password_status, "not accepted")
    onView(withId(R.id.brand_header)).check(doesNotExist())

    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)
    onView(withId(R.id.admin_lock_now)).perform(scrollTo(), click())
    onView(withId(R.id.admin_password)).check(matches(isDisplayed()))
    onView(withId(R.id.admin_lock_now)).check(doesNotExist())
    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)

    activity.scenario.recreate()
    onView(withId(R.id.admin_password)).check(matches(isDisplayed()))
    onView(withId(R.id.brand_header)).check(doesNotExist())
    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)
  }
}
