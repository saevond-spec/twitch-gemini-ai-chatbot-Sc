package com.saevond.sweatyobs

import android.content.Context
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
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.Description
import org.junit.runners.model.Statement

@RunWith(AndroidJUnit4::class)
class AdminPasswordLockSmokeTest {
  private val activity = ActivityScenarioRule(MainActivity::class.java)
  @get:Rule val stateRule: TestRule = RuleChain.outerRule(EmptyAdminLockRule()).around(activity)

  private class EmptyAdminLockRule : TestRule {
    override fun apply(base: Statement, description: Description): Statement = object : Statement() {
      override fun evaluate() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = context.getSharedPreferences("encoder_admin_lock", Context.MODE_PRIVATE)
        val before = prefs.all.toMap()
        prefs.edit().clear().commit()
        try {
          base.evaluate()
        } finally {
          val editor = prefs.edit().clear()
          before.forEach { (key, value) ->
            when (value) {
              is String -> editor.putString(key, value)
              is Boolean -> editor.putBoolean(key, value)
              is Int -> editor.putInt(key, value)
              is Long -> editor.putLong(key, value)
              else -> error("Unexpected admin lock preference type")
            }
          }
          check(editor.commit()) { "Could not restore admin lock preferences" }
        }
      }
    }
  }

  @Test fun firstUseSetsPasswordAndLaterRequiresItToUnlock() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences("encoder_admin_lock", Context.MODE_PRIVATE)
    assertFalse(AdminPasswordStore(context).isConfigured())
    onView(withId(R.id.admin_password_confirm)).check(matches(isDisplayed()))

    onView(withId(R.id.admin_password)).perform(replaceText(AdminPasswordUiTestSupport.TEST_PASSWORD), closeSoftKeyboard())
    onView(withId(R.id.admin_password_confirm)).perform(replaceText(AdminPasswordUiTestSupport.TEST_PASSWORD), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    AdminPasswordUiTestSupport.waitForView(R.id.brand_header)
    assertFalse(prefs.all.values.any { it.toString().contains(AdminPasswordUiTestSupport.TEST_PASSWORD) })

    activity.scenario.recreate()
    onView(withId(R.id.admin_password_confirm)).check(doesNotExist())
    onView(withId(R.id.brand_header)).check(doesNotExist())
    onView(withId(R.id.admin_password)).perform(replaceText("incorrect-password"), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.admin_password_status, "not accepted")
    onView(withId(R.id.brand_header)).check(doesNotExist())

    onView(withId(R.id.admin_password)).perform(replaceText(AdminPasswordUiTestSupport.TEST_PASSWORD), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    AdminPasswordUiTestSupport.waitForView(R.id.brand_header)
    onView(withId(R.id.admin_lock_now)).perform(scrollTo(), click())
    onView(withId(R.id.admin_password)).check(matches(isDisplayed()))
    onView(withId(R.id.admin_lock_now)).check(doesNotExist())
    onView(withId(R.id.admin_password)).perform(replaceText(AdminPasswordUiTestSupport.TEST_PASSWORD), closeSoftKeyboard())
    onView(withId(R.id.admin_password_submit)).perform(click())
    AdminPasswordUiTestSupport.waitForView(R.id.brand_header)
  }
}
