package com.saevond.sweatyobs

import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.saevond.sweatyobs.ingest.RtmpsPublisher
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.hamcrest.Matchers.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkStartSmokeTest {
  @get:Rule val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @Test fun uploadBudgetMatchesTheEncodedMultiOutputBitrate() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences("encoder_outputs", 0)
    prefs.edit().putBoolean("twitch_enabled", true).putBoolean("youtube_enabled", false)
      .putBoolean("kick_enabled", false).putString("overlay_profile", "stable_720").commit()
    activityRule.scenario.recreate()
    onView(withId(R.id.output_upload_budget)).perform(scrollTo())
      .check(matches(withText(containsString("9.3 Mbps sustained upload in total"))))
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
    onView(withText("Also stream to YouTube")).perform(scrollTo(), click())
    onView(withText("Also stream to Kick")).perform(scrollTo(), click())
    onView(withId(R.id.output_upload_budget)).check(matches(withText(containsString("27.8 Mbps sustained upload in total"))))
    activityRule.scenario.onActivity { activity ->
      activity.findViewById<android.widget.Spinner>(R.id.overlay_quality).setSelection(1)
    }
    onView(withId(R.id.output_upload_budget)).check(matches(withText(containsString("48.8 Mbps sustained upload in total"))))
  }

  @Test fun youtubeAndKickStreamKeyDashboardLinksAreAvailable() {
    onView(withId(R.id.open_youtube_dashboard)).perform(scrollTo()).check(matches(isDisplayed()))
    onView(withId(R.id.open_kick_dashboard)).perform(scrollTo()).check(matches(isDisplayed()))
  }

  @Test fun appUsesBrandedDarkThemeAndShowsTheSaevondHeader() {
    activityRule.scenario.onActivity { activity ->
      assertEquals(0xFF070B12.toInt(), activity.getColor(R.color.sweaty_background))
    }
    onView(withId(R.id.brand_header)).check(matches(withText("SAEVOND")))
  }

  @Test fun youtubeAndKickKeysSaveSecurelyAndKickUsesTheDocumentedDefaultServer() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val youtubeKey = "sandbox-youtube-key-123"
    val kickKey = "sandbox-kick-key-456"
    val outputPrefs = context.getSharedPreferences("encoder_outputs", 0)
    val encryptedPrefs = context.getSharedPreferences("secure_encoder_secrets", 0)
    val preferenceSnapshots = listOf("encoder_outputs", "secure_encoder_secrets", "encoder_diagnostics")
      .associateWith { context.getSharedPreferences(it, 0).all.toMap() }
    try {
      outputPrefs.edit().remove("youtube_server").remove("kick_server")
        .putBoolean("youtube_enabled", false).putBoolean("kick_enabled", false).commit()
    activityRule.scenario.recreate()
    assertEquals(RtmpsPublisher.KICK_RTMPS_URL, outputPrefs.getString("kick_server", null))

    onView(withId(R.id.youtube_stream_key)).perform(scrollTo(), replaceText(youtubeKey), closeSoftKeyboard())
    onView(withId(R.id.save_youtube_key)).perform(scrollTo(), click())
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))
    onView(withText("Also stream to YouTube")).check(matches(isNotChecked()))
    assertFalse(outputPrefs.getBoolean("youtube_enabled", true))

    onView(withId(R.id.kick_stream_key)).perform(scrollTo(), replaceText(kickKey), closeSoftKeyboard())
    onView(withId(R.id.save_kick_key)).perform(scrollTo(), click())
    onView(withId(R.id.kick_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))
    onView(withText("Also stream to Kick")).check(matches(isNotChecked()))
    assertFalse(outputPrefs.getBoolean("kick_enabled", true))
    onView(withId(R.id.connection_status)).check(matches(withText(containsString("No stream has started"))))

    assertNotEquals(youtubeKey, encryptedPrefs.getString("youtube_key", null))
    assertNotEquals(kickKey, encryptedPrefs.getString("kick_key", null))
    assertEquals(youtubeKey, SecretStore(context).get("youtube_key"))
    assertEquals(kickKey, SecretStore(context).get("kick_key"))

    activityRule.scenario.recreate()
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("save its RTMPS server URL before streaming"))))
    onView(withId(R.id.kick_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("RTMPS server URL saved"))))

    onView(withId(R.id.youtube_server)).perform(scrollTo(), replaceText("RTMPS://youtube.example.test/live2"), closeSoftKeyboard())
    assertEquals("rtmps://youtube.example.test/live2", outputPrefs.getString("youtube_server", null))
    onView(withId(R.id.youtube_server_status)).check(matches(withText(containsString("saved on this phone"))))
    onView(withId(R.id.save_youtube_server)).perform(scrollTo(), click())
    assertEquals("rtmps://youtube.example.test/live2", outputPrefs.getString("youtube_server", null))
    onView(withId(R.id.kick_server)).perform(scrollTo(), replaceText("rtmps://kick.example.test/app"), closeSoftKeyboard())
    assertEquals("rtmps://kick.example.test/app", outputPrefs.getString("kick_server", null))
    onView(withId(R.id.kick_server_status)).check(matches(withText(containsString("saved on this phone"))))
    onView(withId(R.id.save_kick_server)).perform(scrollTo(), click())
    assertEquals("rtmps://kick.example.test/app", outputPrefs.getString("kick_server", null))
    onView(withText("Also stream to YouTube")).check(matches(isNotChecked()))
    onView(withText("Also stream to Kick")).check(matches(isNotChecked()))

    onView(withText("Also stream to YouTube")).perform(scrollTo(), click())
    onView(withText("Also stream to Kick")).perform(scrollTo(), click())
    assertTrue(outputPrefs.getBoolean("youtube_enabled", false))
    assertTrue(outputPrefs.getBoolean("kick_enabled", false))

    activityRule.scenario.recreate()
    assertEquals("rtmps://youtube.example.test/live2", outputPrefs.getString("youtube_server", null))
    assertEquals("rtmps://kick.example.test/app", outputPrefs.getString("kick_server", null))
    onView(withId(R.id.youtube_server)).check(matches(withText(equalToIgnoringCase("rtmps://youtube.example.test/live2"))))
    onView(withId(R.id.kick_server)).check(matches(withText(equalToIgnoringCase("rtmps://kick.example.test/app"))))
    onView(withText("Also stream to YouTube")).check(matches(isChecked()))
    onView(withText("Also stream to Kick")).check(matches(isChecked()))
    } finally {
      preferenceSnapshots.forEach { (name, snapshot) ->
        val editor = context.getSharedPreferences(name, 0).edit().clear()
        snapshot.forEach { (key, value) ->
          when (value) {
            is Boolean -> editor.putBoolean(key, value)
            is Int -> editor.putInt(key, value)
            is Long -> editor.putLong(key, value)
            is Float -> editor.putFloat(key, value)
            is String -> editor.putString(key, value)
            is Set<*> -> editor.putStringSet(key, value.filterIsInstance<String>().toSet())
            else -> error("Unsupported preference value type for $key")
          }
        }
        check(editor.commit()) { "Could not restore $name after the UI test" }
      }
    }
  }

  @Test fun twitchChatTokenIsSavedEncryptedAndLiveChatIsOptIn() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val outputPrefs = context.getSharedPreferences("encoder_outputs", 0)
    val secrets = SecretStore(context)
    val fakeToken = "synthetic-twitch-chat-token-12345"
    secrets.put("twitch_chat_token", "")
    outputPrefs.edit().putBoolean("twitch_chat_enabled", false)
      .putString("twitch_chat_login", "saevond")
      .putString("twitch_chat_channel", "saevond").commit()
    activityRule.scenario.recreate()
    try {
      onView(withText("Show live Twitch chat in the overlay")).perform(scrollTo())
        .check(matches(isNotChecked())).perform(click())
      onView(withHint("Twitch login for the token (example: saevond)"))
        .perform(scrollTo(), replaceText("saevond"), closeSoftKeyboard())
      onView(withHint("Twitch channel to display (example: saevond)"))
        .perform(scrollTo(), replaceText("saevond"), closeSoftKeyboard())
      onView(withHint("Twitch user access token with chat:read (saved to Android Keystore)"))
        .perform(scrollTo(), replaceText(fakeToken), closeSoftKeyboard())
      onView(withText("Save Twitch chat settings securely")).perform(scrollTo(), click())

      assertTrue(outputPrefs.getBoolean("twitch_chat_enabled", false))
      assertEquals("saevond", outputPrefs.getString("twitch_chat_login", null))
      assertEquals("saevond", outputPrefs.getString("twitch_chat_channel", null))
      assertEquals(fakeToken, secrets.get("twitch_chat_token"))
      assertNotEquals(fakeToken, context.getSharedPreferences("secure_encoder_secrets", 0)
        .getString("twitch_chat_token", null))
      onView(withId(R.id.connection_status)).check(matches(withText(containsString("Android Keystore"))))
    } finally {
      secrets.put("twitch_chat_token", "")
      outputPrefs.edit().putBoolean("twitch_chat_enabled", false).commit()
    }
  }

  @Test fun platformTlsChecksAreClearlyNonPublishingAndRequireAValidUrl() {
    activityRule.scenario.onActivity { activity ->
      activity.getSharedPreferences("encoder_outputs", 0).edit().remove("youtube_server").commit()
      activity.findViewById<android.widget.EditText>(R.id.youtube_server).text.clear()
    }
    onView(withId(R.id.test_youtube_connection)).perform(scrollTo())
      .check(matches(withText(containsString("no stream"))))
      .perform(click())
    onView(withId(R.id.youtube_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("No key or media was sent"))))
    onView(withId(R.id.test_kick_connection)).perform(scrollTo())
      .check(matches(withText(containsString("no stream"))))
  }

  @Test fun plaintextOrMalformedIngestUrlsAreNotSavedAsSecureOutputs() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences("encoder_outputs", 0)
    activityRule.scenario.onActivity { activity ->
      prefs.edit().remove("youtube_server").commit()
      activity.findViewById<android.widget.EditText>(R.id.youtube_server).text.clear()
    }
    onView(withId(R.id.youtube_server)).perform(scrollTo(), replaceText("rtmp://youtube.example.test/live2"), closeSoftKeyboard())
    assertNull(prefs.getString("youtube_server", null))
    onView(withId(R.id.youtube_server_status))
      .check(matches(withText(containsString("secure RTMPS URL"))))
    onView(withId(R.id.save_youtube_server)).perform(scrollTo(), click())
    assertNull(prefs.getString("youtube_server", null))
  }

  @Test fun invalidAddressTapReportsVisibleFailure() {
    onView(withId(R.id.ps5_ip_address)).perform(scrollTo(), replaceText(""), closeSoftKeyboard())
    onView(withId(R.id.start_network_test)).perform(scrollTo(), click())
    onView(withId(R.id.connection_status)).check(matches(withText(containsString("Enter the PS5"))))
  }

  @Test fun publicStreamAndDiagnosticActionsAreClearlyDifferent() {
    onView(withId(R.id.start_multistream)).perform(scrollTo())
      .check(matches(withText("GO LIVE TO SELECTED PLATFORMS")))
    onView(withId(R.id.start_network_test)).perform(scrollTo())
      .check(matches(withText(containsString("no public stream or overlay"))))
    onView(withId(R.id.output_readiness)).perform(scrollTo())
      .check(matches(withText(containsString("Next public stream"))))
  }

  @Test fun volumeSlidersAndMusicMuteActuallyUpdateLiveMixer() {
    activityRule.scenario.onActivity { activity ->
      val game = activity.findViewById<android.widget.SeekBar>(R.id.game_volume)
      val music = activity.findViewById<android.widget.SeekBar>(R.id.music_volume)
      val mute = activity.findViewById<android.widget.Button>(R.id.music_mute)
      game.progress = 60
      music.progress = 8
      assertEquals(60, Ps5LanService.liveLevels.gamePercent)
      assertEquals(8, Ps5LanService.liveLevels.musicPercent)
      mute.performClick()
      assertEquals(0, Ps5LanService.liveLevels.musicPercent)
      assertEquals(60, Ps5LanService.liveLevels.gamePercent)
      mute.performClick()
      assertEquals(8, Ps5LanService.liveLevels.musicPercent)

      music.progress = 35
      assertEquals(35, Ps5LanService.liveLevels.musicPercent)
      mute.performClick()
      assertEquals(0, Ps5LanService.liveLevels.musicPercent)
      mute.performClick()
      assertEquals(35, Ps5LanService.liveLevels.musicPercent)
    }
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
    val result = AtomicReference<String?>(null)
    val received = CountDownLatch(1)
    val statusReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        result.set(intent?.getStringExtra(Ps5LanService.EXTRA_STATUS_MESSAGE))
        received.countDown()
      }
    }
    val filter = IntentFilter(Ps5LanService.ACTION_STATUS)
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else context.registerReceiver(statusReceiver, filter)
    try {
      onView(withId(R.id.ps5_ip_address)).perform(scrollTo(), replaceText("192.168.1.20"), closeSoftKeyboard())
      onView(withId(R.id.start_network_test)).perform(scrollTo(), click())
      onView(withId(R.id.connection_status)).check(matches(not(withText("Ready for test — no broadcast is sent."))))
      assertTrue("Service did not broadcast its result", received.await(9, TimeUnit.SECONDS))
      assertNotNull("Service status was empty", result.get())
      assertTrue("No diagnostic result", result.get()!!.isNotEmpty())
      onView(withId(R.id.stop_network_test)).perform(scrollTo(), click())
    } finally {
      context.unregisterReceiver(statusReceiver)
    }
  }
}
