package com.saevond.sweatyobs

import android.app.Activity
import android.os.Bundle
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.text.InputType
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/** Remote control only. Gameplay media and platform credentials stay on the encoder host. */
class MainActivity : Activity() {
  private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()

  private lateinit var status: TextView
  private lateinit var encoderContentView: View
  private var remoteStatusView: TextView? = null
  private var remoteControlSessionToken = ""
  private var encoderUiVisible = false
  private var lockOnResume = false
  private var adminUnlockAttempt = 0
  private var adminUnlockInFlight = false
  private var adminUnlockWasBackgrounded = false
  private val remoteActionExecutor = Executors.newSingleThreadExecutor { task ->
    Thread(task, "SweatyOBS-remote-action")
  }
  internal var adminKeyVerifier: AdminKeyVerifier = RemoteAdminKeyVerifier()
  internal var remoteEncoderApi: RemoteEncoderApi = HttpsRemoteEncoderClient()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Stop any phone encoder left running by an older build, then remove its
    // saved destinations, keys, PS5 address, and music-file access grants.
    stopService(Intent(this, Ps5LanService::class.java))
    val legacySecretsCleared = SecretStore(this).clearAll()
    val legacyOutputSettingsCleared = clearPreferences("encoder_outputs")
    val legacyPreferencesCleared = listOf(
      "ps5_setup", "ps5_music", "ps5_audio_levels", "diagnostic_status_v1",
      "encoder_admin_lock", "encoder_diagnostics"
    ).map(::clearPreferences).all { it }
    val legacyMusicPermissionsCleared = clearPersistedMusicPermissions()
    buildRemoteControls()
    if (!legacySecretsCleared || !legacyOutputSettingsCleared || !legacyPreferencesCleared || !legacyMusicPermissionsCleared) {
      status.text = "Remote controls are ready, but some old phone key or music access data could not be cleared. Remove this app's data and rotate any keys previously saved on this phone."
    } else {
      status.text = "Remote-only mode is active. Old stream keys, destination URLs, PS5 address, and local music access were removed from this phone."
    }
    showAdminPasswordGate()
  }

  private fun clearPreferences(name: String): Boolean =
    getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()

  private fun clearPersistedMusicPermissions(): Boolean = runCatching {
    var allReleased = true
    contentResolver.persistedUriPermissions.forEach { permission ->
      val flags = (if (permission.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or
        (if (permission.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
      if (flags != 0 && runCatching {
          contentResolver.releasePersistableUriPermission(permission.uri, flags)
        }.isFailure) allReleased = false
    }
    allReleased
  }.getOrDefault(false)

  private fun sectionHeader(label: String): TextView = TextView(this).apply {
    text = label.uppercase(Locale.US)
    textSize = 13f
    letterSpacing = .12f
    setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
    setTextColor(getColor(R.color.sweaty_cyan))
    setPadding(dp(4), dp(17), dp(4), dp(6))
  }

  private fun buildRemoteControls() {
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(14), dp(18), dp(28))
      setBackgroundColor(getColor(R.color.sweaty_background))
    }
    val brand = TextView(this).apply {
      id = R.id.brand_header
      text = "SAEVOND"
      textSize = 28f
      letterSpacing = .16f
      setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_red))
      setPadding(dp(4), dp(4), dp(4), 0)
    }
    val subtitle = TextView(this).apply {
      text = "SWEATYOBS  //  STREAM CONTROL"
      textSize = 12f
      letterSpacing = .12f
      setTextColor(getColor(R.color.sweaty_cyan))
      setPadding(dp(4), 0, dp(4), dp(12))
    }
    status = TextView(this).apply {
      id = R.id.connection_status
      text = "This phone controls the remote encoder. Gameplay video stays off the phone."
      textSize = 16f
      setPadding(dp(14), dp(14), dp(14), dp(14))
      setBackgroundResource(R.drawable.sweaty_info_card)
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val remoteNote = TextView(this).apply {
      text = "This app sends small HTTPS control requests only. Configure the PS5 ingest and Twitch / YouTube / Kick destinations on an always-on encoder host. Stream keys never enter this phone. Render carries commands only; it is not a video relay."
      textSize = 13f
      setTextColor(getColor(R.color.sweaty_muted))
      setPadding(dp(10), dp(8), dp(10), dp(10))
    }
    remoteStatusView = TextView(this).apply {
      id = R.id.remote_encoder_status
      text = "Remote encoder status has not been checked."
      setPadding(dp(14), dp(12), dp(14), dp(12))
      setBackgroundResource(R.drawable.sweaty_info_card)
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val refresh = Button(this).apply {
      id = R.id.refresh_remote_encoder
      text = "CHECK REMOTE ENCODER"
      setOnClickListener { refreshRemoteEncoderStatus() }
    }
    val start = Button(this).apply {
      id = R.id.start_remote_encoder
      text = "START REMOTE STREAM"
      textSize = 18f
      setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_text))
      setBackgroundResource(R.drawable.sweaty_button_live)
      setPadding(dp(12), dp(18), dp(12), dp(18))
      setOnClickListener { requestRemoteEncoderAction("start") }
    }
    val reconnect = Button(this).apply {
      id = R.id.reconnect_remote_encoder
      text = "RECONNECT REMOTE OUTPUTS"
      setOnClickListener { requestRemoteEncoderAction("reconnect") }
    }
    val stop = Button(this).apply {
      id = R.id.stop_remote_encoder
      text = "STOP REMOTE STREAM"
      setOnClickListener { requestRemoteEncoderAction("stop") }
    }
    val stations = listOf("Dubstep / Bass", "Club / House")
    val stationCodes = listOf("dubstep", "club")
    val stationPicker = Spinner(this).apply {
      id = R.id.music_genre
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, stations)
      setSelection(0)
      contentDescription = "Remote music station: Dubstep and Bass or Club and House"
    }
    var currentStation = stationCodes[0]
    stationPicker.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
      override fun onNothingSelected(parent: AdapterView<*>?) = Unit
      override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
        val station = stationCodes[position.coerceIn(0, stationCodes.lastIndex)]
        if (station == currentStation) return
        currentStation = station
        requestRemoteEncoderAction("station", station)
      }
    }
    val skip = Button(this).apply {
      id = R.id.music_skip
      text = "SKIP MUSIC"
      setOnClickListener { requestRemoteEncoderAction("skip") }
    }
    val play = Button(this).apply {
      id = R.id.music_play
      text = "PLAY MUSIC"
      setOnClickListener { requestRemoteEncoderAction("play") }
    }
    val pause = Button(this).apply {
      id = R.id.music_pause
      text = "PAUSE MUSIC"
      setOnClickListener { requestRemoteEncoderAction("pause") }
    }
    val lock = Button(this).apply {
      id = R.id.admin_lock_now
      text = "LOCK ADMIN CONTROLS"
      setOnClickListener { showAdminPasswordGate() }
    }

    listOf(brand, subtitle, status, sectionHeader("Remote encoder"), remoteNote,
      remoteStatusView!!, refresh, start, reconnect, stop,
      sectionHeader("Remote music controls"), stationPicker, play, pause, skip,
      sectionHeader("Security"), lock).forEach { root.addView(it) }
    encoderContentView = ScrollView(this).apply { addView(root) }
  }

  private fun requestRemoteEncoderAction(action: String, station: String? = null) {
    val session = remoteControlSessionToken
    if (session.isBlank()) {
      status.text = "Unlock the encoder controls to send a remote command. No gameplay video was sent from this phone."
      remoteStatusView?.text = "Remote control session is unavailable. Unlock again."
      return
    }
    status.text = "Sending a small $action control request over HTTPS. Gameplay video stays on the encoder host."
    // A single FIFO worker preserves tap order. Otherwise fast Start → Stop
    // taps can race on separate threads and arrive at the API in reverse order.
    remoteActionExecutor.execute {
      val outcome = runCatching {
        remoteEncoderApi.action(BuildConfig.ENCODER_SERVICE_URL, session, action, station)
      }.fold(
        onSuccess = { it },
        onFailure = { error ->
          when {
            error.message?.contains("session expired", ignoreCase = true) == true ->
              "Remote control session expired. Lock and unlock the controls again."
            error.message?.contains("host is offline", ignoreCase = true) == true ->
              "Remote encoder host is offline. Connect it before starting or reconnecting; the stream was not queued."
            error.message?.contains("no remote stream is marked running", ignoreCase = true) == true ->
              "No remote stream is running. Start the remote stream before reconnecting."
            else -> "Remote encoder control request failed. Check the remote status and host connection."
          }
        }
      )
      runOnUiThread {
        if (isFinishing || isDestroyed || !encoderUiVisible || session != remoteControlSessionToken) return@runOnUiThread
        status.text = outcome
        remoteStatusView?.text = outcome
      }
    }
  }

  private fun refreshRemoteEncoderStatus() {
    val session = remoteControlSessionToken
    if (session.isBlank()) {
      remoteStatusView?.text = "Unlock the encoder controls to check remote status. No gameplay video is sent from this phone."
      return
    }
    remoteStatusView?.text = "Checking remote encoder over HTTPS…"
    thread(name = "SweatyOBS-remote-status") {
      val outcome = runCatching {
        remoteEncoderApi.status(BuildConfig.ENCODER_SERVICE_URL, session)
      }.getOrElse { error ->
        if (error.message?.contains("session expired", ignoreCase = true) == true)
          "Remote control session expired. Lock and unlock the controls again."
        else "Remote status check failed. The phone did not send gameplay video."
      }
      runOnUiThread {
        if (isFinishing || isDestroyed || !encoderUiVisible || session != remoteControlSessionToken) return@runOnUiThread
        remoteStatusView?.text = outcome
      }
    }
  }

  private fun showAdminPasswordGate() {
    encoderUiVisible = false
    val sessionToRevoke = remoteControlSessionToken
    remoteControlSessionToken = ""
    if (sessionToRevoke.isNotBlank()) revokeRemoteControlSession(sessionToRevoke)
    adminUnlockAttempt++
    adminUnlockInFlight = false
    adminUnlockWasBackgrounded = false
    val attempt = adminUnlockAttempt
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(22), dp(34), dp(22), dp(28))
      setBackgroundColor(getColor(R.color.sweaty_background))
    }
    val brand = TextView(this).apply {
      text = "SAEVOND"
      textSize = 30f
      letterSpacing = .16f
      setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_red))
      setPadding(0, 0, 0, dp(8))
    }
    val title = TextView(this).apply {
      text = "ADMIN ACCESS"
      textSize = 20f
      letterSpacing = .08f
      setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_cyan))
      setPadding(0, dp(8), 0, dp(8))
    }
    val explanation = TextView(this).apply {
      text = "Enter the current admin key to open remote controls. It is checked over HTTPS and is not saved on this phone."
      textSize = 15f
      setTextColor(getColor(R.color.sweaty_text))
      setPadding(0, 0, 0, dp(14))
    }
    val keyInput = EditText(this).apply {
      id = R.id.admin_password
      hint = "Admin key"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
      filters = arrayOf(android.text.InputFilter.LengthFilter(RemoteAdminKeyVerifier.MAX_KEY_LENGTH))
      importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
      isSaveEnabled = false
    }
    val message = TextView(this).apply {
      id = R.id.admin_password_status
      text = "The key is checked by the configured encoder service."
      textSize = 13f
      setTextColor(getColor(R.color.sweaty_muted))
      setPadding(0, dp(10), 0, dp(12))
    }
    val submit = Button(this).apply {
      id = R.id.admin_password_submit
      text = "UNLOCK REMOTE CONTROLS"
      setBackgroundResource(R.drawable.sweaty_button_live)
      setTextColor(getColor(R.color.sweaty_text))
      setPadding(dp(12), dp(12), dp(12), dp(12))
    }
    val recovery = TextView(this).apply {
      text = "The service may take a while to wake. If the check times out, retry after it is awake."
      textSize = 12f
      setTextColor(getColor(R.color.sweaty_muted))
      setPadding(0, dp(20), 0, 0)
    }
    submit.setOnClickListener {
      val entered = keyInput.text.toString()
      if (entered.isEmpty()) {
        message.text = "Enter the admin key to continue."
        message.setTextColor(getColor(R.color.sweaty_red))
        return@setOnClickListener
      }
      keyInput.text.clear()
      (getSystemService(INPUT_METHOD_SERVICE) as? android.view.inputmethod.InputMethodManager)
        ?.hideSoftInputFromWindow(keyInput.windowToken, 0)
      keyInput.isEnabled = false
      submit.isEnabled = false
      adminUnlockInFlight = true
      message.text = "Checking key securely…"
      message.setTextColor(getColor(R.color.sweaty_muted))
      thread(name = "SweatyOBS-admin-unlock") {
        val result = runCatching { adminKeyVerifier.verify(entered) }
          .getOrDefault(AdminKeyUnlockResult.UNAVAILABLE)
        val issuedSession = if (result == AdminKeyUnlockResult.ACCEPTED)
          adminKeyVerifier.takeSessionToken().orEmpty() else ""
        runOnUiThread {
          if (attempt != adminUnlockAttempt || isFinishing || isDestroyed) {
            if (result == AdminKeyUnlockResult.ACCEPTED && issuedSession.isNotBlank()) {
              revokeRemoteControlSession(issuedSession)
            }
            return@runOnUiThread
          }
          adminUnlockInFlight = false
          val backgrounded = adminUnlockWasBackgrounded
          adminUnlockWasBackgrounded = false
          if (result == AdminKeyUnlockResult.ACCEPTED && issuedSession.isNotBlank() &&
              !backgrounded && !lockOnResume && hasWindowFocus()) {
            lockOnResume = false
            remoteControlSessionToken = issuedSession
            showEncoderControls()
          } else {
            if (result == AdminKeyUnlockResult.ACCEPTED && issuedSession.isNotBlank()) {
              revokeRemoteControlSession(issuedSession)
            }
            keyInput.isEnabled = true
            submit.isEnabled = true
            message.text = when (result) {
              AdminKeyUnlockResult.ACCEPTED -> if (issuedSession.isBlank())
                "The service did not issue a remote session. Check that the control bridge is deployed, then retry."
              else "Unlock was interrupted when the app left the foreground. Enter the key again."
              AdminKeyUnlockResult.REJECTED -> "Key not accepted. Check it and try again."
              AdminKeyUnlockResult.RATE_LIMITED -> "Too many attempts. Wait a little, then try again."
              AdminKeyUnlockResult.UNAVAILABLE -> "Unlock service unavailable. Check internet and try again."
            }
            message.setTextColor(if (result == AdminKeyUnlockResult.ACCEPTED)
              getColor(R.color.sweaty_muted) else getColor(R.color.sweaty_red))
            keyInput.requestFocus()
          }
        }
      }
    }
    root.addView(brand)
    root.addView(title)
    root.addView(explanation)
    root.addView(keyInput)
    root.addView(message)
    root.addView(submit)
    root.addView(recovery)
    setContentView(ScrollView(this).apply { addView(root) })
  }

  private fun showEncoderControls() {
    encoderUiVisible = true
    setContentView(encoderContentView)
    (encoderContentView as? ScrollView)?.post {
      if (encoderUiVisible && !isFinishing) (encoderContentView as? ScrollView)?.scrollTo(0, 0)
    }
    refreshRemoteEncoderStatus()
  }

  private fun revokeRemoteControlSession(sessionToken: String) {
    thread(name = "SweatyOBS-session-revoke") {
      runCatching { remoteEncoderApi.revokeSession(BuildConfig.ENCODER_SERVICE_URL, sessionToken) }
    }
  }

  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (encoderUiVisible || adminUnlockInFlight) lockOnResume = true
    if (adminUnlockInFlight) adminUnlockWasBackgrounded = true
  }

  override fun onPause() {
    if (lockOnResume && encoderUiVisible) {
      lockOnResume = false
      showAdminPasswordGate()
    }
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    if (lockOnResume && encoderUiVisible) {
      lockOnResume = false
      showAdminPasswordGate()
    } else if (lockOnResume) {
      lockOnResume = false
    }
  }
}
