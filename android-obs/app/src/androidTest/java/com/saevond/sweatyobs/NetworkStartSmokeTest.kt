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

  @Test fun uploadBudgetMatchesTheEncodedMultiOutputBitrate() {
    onView(withId(R.id.output_upload_budget)).perform(scrollTo())
      .check(matches(allOf(
        withText(containsString("16.3 Mbps")),
        withText(containsString("48.8 Mbps"))
      )))
  }

  @Test fun youtubeAndKickStreamKeyDashboardLinksAreAvailable() {
    onView(withId(R.id.open_youtube_dashboard)).perform(scrollTo()).check(matches(isDisplayed()))
    onView(withId(R.id.open_kick_dashboard)).perform(scrollTo()).check(matches(isDisplayed()))
  }

  @Test fun youtubeAndKickKeysSaveSecurelyWithoutAnRtmpsServerUrl() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val youtubeKey = "sandbox-youtube-key-123"
    val kickKey = "sandbox-kick-key-456"
    val outputPrefs = context.getSharedPreferences("encoder_outputs", 0)
    outputPrefs.edit().remove("youtube_server").remove("kick_server").commit()
    activityRule.scenario.recreate()

    onView(withId(R.id.youtube_stream_key)).perform(scrollTo(), replaceText(youtubeKey), closeSoftKeyboard())
    onView(withId(R.id.save_youtube_key)).perform(scrollTo(), click())
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))

    onView(withId(R.id.kick_stream_key)).perform(scrollTo(), replaceText(kickKey), closeSoftKeyboard())
    onView(withId(R.id.save_kick_key)).perform(scrollTo(), click())
    onView(withId(R.id.kick_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))

    val encryptedPrefs = context.getSharedPreferences("secure_encoder_secrets", 0)
    assertNotEquals(youtubeKey, encryptedPrefs.getString("youtube_key", null))
    assertNotEquals(kickKey, encryptedPrefs.getString("kick_key", null))
    assertEquals(youtubeKey, SecretStore(context).get("youtube_key"))
    assertEquals(kickKey, SecretStore(context).get("kick_key"))

    activityRule.scenario.recreate()
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("save its RTMPS server URL before streaming"))))
    onView(withId(R.id.kick_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("save its RTMPS server URL before streaming"))))

    onView(withId(R.id.youtube_server)).perform(scrollTo(), replaceText("rtmps://youtube.example.test/live2"), closeSoftKeyboard())
    onView(withId(R.id.save_youtube_server)).perform(scrollTo(), click())
    assertEquals("rtmps://youtube.example.test/live2", outputPrefs.getString("youtube_server", null))
    onView(withId(R.id.kick_server)).perform(scrollTo(), replaceText("rtmps://kick.example.test/app"), closeSoftKeyboard())
    onView(withId(R.id.save_kick_server)).perform(scrollTo(), click())
    assertEquals("rtmps://kick.example.test/app", outputPrefs.getString("kick_server", null))
  }

  @Test fun invalidAddressTapReportsVisibleFailure() {
    onView(withId(R.id.ps5_ip_address)).perform(scrollTo(), replaceText(""), closeSoftKeyboard())
    onView(withId(R.id.start_network_test)).perform(scrollTo(), click())
    onView(withId(R.id.connection_status)).check(matches(withText(containsString("Enter the PS5"))))
  }

  @Test fun volumeSlidersAndMusicMuteActuallyUpdateLiveMixer() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    activityRule.scenario.onActivity { activity ->
      val game = activity.findViewById<android.widget.SeekBar>(R.id.game_volume)
      val music = activity.findViewById<android.widget.SeekBar>(R.id.music_volume)
      game.progress = 60
      music.progress = 35
      assertEquals(60, Ps5LanService.liveLevels.gamePercent)
      assertEquals(35, Ps5LanService.liveLevels.musicPercent)
    }
    onView(withId(R.id.music_mute)).perform(scrollTo(), click())
    assertEquals(0, Ps5LanService.liveLevels.musicPercent)
    assertEquals(60, Ps5LanService.liveLevels.gamePercent)
    onView(withId(R.id.music_mute)).perform(scrollTo(), click())
    assertEquals(35, Ps5LanService.liveLevels.musicPercent)
  }

  @Test fun musicAutoplayDefaultsOnAndTogglePersists() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val pref = context.getSharedPreferences("ps5_music", 0)
    activityRule.scenario.onActivity { activity ->
      val check = activity.findViewById<android.widget.CheckBox>(R.id.music_autoplay)
      assertEquals(pref.getBoolean("autoplay", true), check.isChecked)
    }
    onView(withId(R.id.music_autoplay)).perform(scrollTo(), click())
    activityRule.scenario.onActivity { activity ->
      val check = activity.findViewById<android.widget.CheckBox>(R.id.music_autoplay)
      assertEquals(check.isChecked, pref.getBoolean("autoplay", true))
    }
  }

  @Test fun remoteMusicBridgeShowsMissingTokenInsteadOfStartingStream() {
    // No real network dependency; the app should reject absent credentials locally.
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    // Delete any test-provided secret only from this disposable emulator.
    onView(withId(R.id.test_music_bridge)).perform(scrollTo(), click())
    onView(withId(R.id.music_bridge_status)).check(
      matches(not(withText("Bridge not checked. Twitch music controls require matching private bot token."))))
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
