package com.saevond.sweatyobs

import android.content.pm.PackageManager
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.withId
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Matchers.containsString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkStartSmokeTest {
  @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

  @Test fun streamControlsSendRemoteCommandsAndNeverStartPhoneMediaService() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)

    onView(withId(R.id.start_remote_encoder)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.connection_status, "Synthetic remote start request accepted")
    onView(withId(R.id.reconnect_remote_encoder)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.connection_status, "Synthetic remote reconnect request accepted")
    onView(withId(R.id.stop_remote_encoder)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.connection_status, "Synthetic remote stop request accepted")

    assertEquals(listOf("start", "reconnect", "stop"),
      AdminPasswordUiTestSupport.actions.map { it.first })
    assertFalse(Ps5LanService.receiverRunning)
    val declaredServices = context.packageManager
      .getPackageInfo(context.packageName, PackageManager.GET_SERVICES).services.orEmpty()
    assertFalse(declaredServices.any { it.name == Ps5LanService::class.java.name })
  }

  @Test fun oldPhoneKeysAndDestinationUrlsAreRemovedOnRemoteOnlyMigration() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertEquals("", SecretStore(context).get("rtmps"))
    assertEquals("", SecretStore(context).get("youtube_key"))
    assertEquals("", SecretStore(context).get("kick_key"))
    val outputs = context.getSharedPreferences("encoder_outputs", 0)
    assertFalse(outputs.contains("youtube_server"))
    assertFalse(outputs.contains("kick_server"))
    assertFalse(context.getSharedPreferences("ps5_music", 0).contains("library_club"))
  }

  @Test fun refreshUsesRemoteStatusOnly() {
    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)
    onView(withId(R.id.refresh_remote_encoder)).perform(click())
    AdminPasswordUiTestSupport.waitForText(R.id.remote_encoder_status, "Synthetic remote host offline")
    onView(withId(R.id.remote_encoder_status))
      .check(matches(withText(containsString("Synthetic remote host offline"))))
  }

  @Test fun rapidStartThenStopActionsArriveAtTheRemoteApiInTapOrder() {
    AdminPasswordUiTestSupport.unlockOrSetPassword(activity.scenario)
    val actions = CopyOnWriteArrayList<String>()
    activity.scenario.onActivity { screen ->
      screen.remoteEncoderApi = object : RemoteEncoderApi {
        override fun status(serviceUrl: String, sessionToken: String) = "Synthetic remote host offline"
        override fun action(serviceUrl: String, sessionToken: String, action: String, station: String?): String {
          if (action == "start") Thread.sleep(250)
          actions += action
          return "Synthetic remote $action request accepted. No video was sent."
        }
        override fun revokeSession(serviceUrl: String, sessionToken: String) = Unit
      }
    }

    onView(withId(R.id.start_remote_encoder)).perform(click())
    onView(withId(R.id.stop_remote_encoder)).perform(androidx.test.espresso.action.ViewActions.scrollTo(), click())
    val deadline = System.currentTimeMillis() + 8_000L
    while (System.currentTimeMillis() < deadline && actions.size < 2) Thread.sleep(40)
    assertEquals(listOf("start", "stop"), actions.toList())
  }
}
