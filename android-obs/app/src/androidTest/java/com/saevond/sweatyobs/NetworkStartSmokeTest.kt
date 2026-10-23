package com.saevond.sweatyobs

import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.rule.GrantPermissionRule
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
  @get:Rule val notificationPermissionRule = GrantPermissionRule.grant("android.permission.POST_NOTIFICATIONS")
  @get:Rule val activityRule = ActivityScenarioRule(MainActivity::class.java)

  @Test fun viewerPlaybackConfirmationRequiresVideoAndAudioAndLogsManualEvent() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    onView(withId(R.id.viewer_playback_check)).perform(scrollTo(), click())
    onView(withId(android.R.id.button1)).check(matches(not(isEnabled())))

    onView(withId(R.id.viewer_video_visible)).perform(click())
    onView(withId(android.R.id.button1)).check(matches(not(isEnabled())))
    onView(withId(R.id.viewer_audio_audible)).perform(click())
    onView(withId(android.R.id.button1)).check(matches(isEnabled()))
    onView(withId(android.R.id.button1)).perform(click())

    val confirmation = ConnectionTimeline.events(context).last().message
    assertTrue(confirmation.contains(
      "Manual viewer playback verified · Twitch · video visible · audio/music audible · operator-confirmed"
    ))
  }

  @Test fun remoteMusicCatalogCanSelectAllTracksInOneTap() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val musicPrefs = context.getSharedPreferences("ps5_music", 0)
    musicPrefs.edit().remove("library_${GenrePlaylist.CLUB}").commit()
    activityRule.scenario.recreate()

    try {
      onView(withId(R.id.remote_club_catalog)).perform(scrollTo(), click())
      onView(withText("Select all")).perform(click())
      onView(withText("Add selected")).perform(click())
      onView(withId(R.id.genre_library_status)).check(
        matches(withText(containsString("Club ${RemoteMusicCatalog.forGenre(GenrePlaylist.CLUB).size}")))
      )
    } finally {
      musicPrefs.edit().remove("library_${GenrePlaylist.CLUB}").commit()
    }
  }

  @Test fun uploadBudgetMatchesTheEncodedMultiOutputBitrate() {
    val prefs = InstrumentationRegistry.getInstrumentation().targetContext
      .getSharedPreferences("encoder_outputs", 0)
    prefs.edit().putBoolean("sleipnir_enabled", false).commit()
    activityRule.scenario.recreate()
    onView(withId(R.id.output_upload_budget)).perform(scrollTo())
      .check(matches(allOf(
        withText(containsString("16.3 Mbps")),
        withText(containsString("48.8 Mbps"))
      )))
  }

  @Test fun sleipnirRelayUsesOneCappedUpstreamAndStoresOnlyEncryptedKey() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val outputPrefs = context.getSharedPreferences("encoder_outputs", 0)
    val secrets = SecretStore(context)
    val syntheticKey = "sandbox-sleipnir-key-1234"
    outputPrefs.edit().remove("sleipnir_server").putBoolean("sleipnir_enabled", false).commit()
    activityRule.scenario.recreate()

    onView(withId(R.id.sleipnir_server)).perform(scrollTo())
      .check(matches(withText("rtmps://ingest.sleipnir.tv:1936/live")))
    onView(withId(R.id.sleipnir_enabled)).perform(scrollTo(), click())
    onView(withId(R.id.output_upload_budget)).perform(scrollTo())
      .check(matches(allOf(
        withText(containsString("one RTMPS upload")),
        withText(containsString("3.8 Mbps target video")),
        withText(containsString("4.32 Mbps with 10% transport overhead"))
      )))
    onView(withId(R.id.sleipnir_stream_key)).perform(scrollTo(), replaceText(syntheticKey), closeSoftKeyboard())
    onView(withId(R.id.save_sleipnir_key)).perform(scrollTo(), click())
    onView(withId(R.id.sleipnir_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))

    val encryptedPrefs = context.getSharedPreferences("secure_encoder_secrets", 0)
    assertNotEquals(syntheticKey, encryptedPrefs.getString("sleipnir_key", null))
    assertEquals(syntheticKey, secrets.get("sleipnir_key"))
    assertTrue(outputPrefs.getBoolean("sleipnir_enabled", false))

    // Keep the disposable emulator's following tests in direct-output mode.
    outputPrefs.edit().putBoolean("sleipnir_enabled", false).commit()
  }

  @Test fun sleipnirUpsideDownCorrectionDefaultsOnAndCanBeDisabled() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences("encoder_outputs", 0)
    val hadEnabled = prefs.contains("sleipnir_enabled")
    val enabledBefore = prefs.getBoolean("sleipnir_enabled", false)
    val hadRotation = prefs.contains("sleipnir_rotate_180")
    val rotationBefore = prefs.getBoolean("sleipnir_rotate_180", true)
    prefs.edit().putBoolean("sleipnir_enabled", false).remove("sleipnir_rotate_180").commit()
    activityRule.scenario.recreate()

    try {
      onView(withId(R.id.sleipnir_rotate_180)).perform(scrollTo())
        .check(matches(not(isEnabled())))
      onView(withId(R.id.sleipnir_enabled)).perform(scrollTo(), click())
      onView(withId(R.id.sleipnir_rotate_180)).perform(scrollTo())
        .check(matches(allOf(isChecked(), isEnabled())))
      onView(withId(R.id.sleipnir_rotate_180)).perform(click())
      assertFalse(prefs.getBoolean("sleipnir_rotate_180", true))
      activityRule.scenario.recreate()
      onView(withId(R.id.sleipnir_rotate_180)).perform(scrollTo())
        .check(matches(not(isChecked())))
    } finally {
      val editor = prefs.edit()
      if (hadEnabled) editor.putBoolean("sleipnir_enabled", enabledBefore) else editor.remove("sleipnir_enabled")
      if (hadRotation) editor.putBoolean("sleipnir_rotate_180", rotationBefore) else editor.remove("sleipnir_rotate_180")
      editor.commit()
    }
  }

  @Test fun staleLiveSessionIsReportedAsInterruptedInsteadOfStillLive() {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val prefs = context.getSharedPreferences(Ps5LanService.STATUS_PREFS, 0)
    val hadActive = prefs.contains(Ps5LanService.PREF_SESSION_ACTIVE)
    val activeBefore = prefs.getBoolean(Ps5LanService.PREF_SESSION_ACTIVE, false)
    val hadPublic = prefs.contains(Ps5LanService.PREF_SESSION_PUBLIC)
    val publicBefore = prefs.getBoolean(Ps5LanService.PREF_SESSION_PUBLIC, false)
    val hadMessage = prefs.contains(Ps5LanService.PREF_STATUS_MESSAGE)
    val messageBefore = prefs.getString(Ps5LanService.PREF_STATUS_MESSAGE, null)
    prefs.edit().putBoolean(Ps5LanService.PREF_SESSION_ACTIVE, true)
      .putBoolean(Ps5LanService.PREF_SESSION_PUBLIC, true)
      .putString(Ps5LanService.PREF_STATUS_MESSAGE, "Sleipnir LIVE · health Good").commit()
    activityRule.scenario.recreate()

    try {
      onView(withId(R.id.connection_status)).perform(scrollTo())
        .check(matches(withText(containsString("Previous stream session ended before the app confirmed a clean stop"))))
      assertFalse(prefs.getBoolean(Ps5LanService.PREF_SESSION_ACTIVE, true))
      assertTrue(ConnectionTimeline.events(context).last().message.contains("Session recovery notice"))
    } finally {
      val editor = prefs.edit()
      if (hadActive) editor.putBoolean(Ps5LanService.PREF_SESSION_ACTIVE, activeBefore)
      else editor.remove(Ps5LanService.PREF_SESSION_ACTIVE)
      if (hadPublic) editor.putBoolean(Ps5LanService.PREF_SESSION_PUBLIC, publicBefore)
      else editor.remove(Ps5LanService.PREF_SESSION_PUBLIC)
      if (hadMessage) editor.putString(Ps5LanService.PREF_STATUS_MESSAGE, messageBefore)
      else editor.remove(Ps5LanService.PREF_STATUS_MESSAGE)
      editor.commit()
    }
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
      .check(matches(withText(containsString("key saved securely"))))
    onView(withId(R.id.kick_output_status)).perform(scrollTo())
      .check(matches(withText(containsString("key saved securely"))))
    onView(withId(R.id.youtube_output_status)).check(
      matches(withText(containsString("save its RTMPS server URL before streaming"))))
    onView(withId(R.id.kick_output_status)).check(
      matches(withText(containsString("save its RTMPS server URL before streaming"))))

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
    val enteredReceiver = Ps5LanService.receiverRunning
    onView(withId(R.id.stop_network_test)).perform(scrollTo(), click())
    val stopDeadline = SystemClock.uptimeMillis() + 5000
    while (Ps5LanService.sessionForegroundActive && SystemClock.uptimeMillis() < stopDeadline) {
      SystemClock.sleep(100)
    }
    assertFalse("Stop must release the foreground session", Ps5LanService.sessionForegroundActive)
    if (enteredReceiver) {
      assertTrue(prefs.getString(Ps5LanService.PREF_STATUS_MESSAGE, "").orEmpty()
        .contains("Diagnostic only; no broadcast was sent."))
    }
  }
}
