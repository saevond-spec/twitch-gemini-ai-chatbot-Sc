package com.saevond.sweatyobs

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.graphics.Typeface
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.view.View
import android.text.InputType
import android.text.Editable
import android.text.TextWatcher
import android.net.ConnectivityManager
import android.net.Uri
import android.net.NetworkCapabilities
import java.net.Inet4Address
import java.security.SecureRandom
import android.util.Base64
import android.content.ClipboardManager
import android.content.ClipData
import android.content.ClipDescription
import android.os.PersistableBundle
import kotlin.concurrent.thread
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.SeekBar
import android.widget.CheckBox
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.AdapterView
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import com.saevond.sweatyobs.ingest.RtmpsPublisher

/**
 * Controls a background *network receiver*, never a display or audio recorder.
 * Starts an explicit private-LAN ingest and user-selected RTMPS outputs.
 */
class MainActivity : Activity() {
  companion object {
    private const val LEGACY_STATUS_PREFS = "diagnostic_status_v1"
    private const val PICK_MUSIC = 31416
    private const val PICK_CLUB = 31417
    private const val PICK_DUBSTEP = 31418
    private const val PICK_POP_TRAP = 31419
    private const val YOUTUBE_DASHBOARD_URL = "https://studio.youtube.com/"
    private const val KICK_DASHBOARD_URL = "https://dashboard.kick.com/channel/stream"
  }

  private fun formatMbps(value: Double): String = String.format(Locale.US, "%.1f", value)

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density + .5f).toInt()

  private fun diagnosticTarget(platform: String): EncoderDiagnosticTarget = when (platform.lowercase(Locale.US)) {
    "twitch" -> EncoderDiagnosticTarget.TWITCH
    "youtube" -> EncoderDiagnosticTarget.YOUTUBE
    "kick" -> EncoderDiagnosticTarget.KICK
    "sleipnir" -> EncoderDiagnosticTarget.MULTIPLE
    else -> EncoderDiagnosticTarget.NONE
  }

  private fun sectionHeader(label: String): TextView = TextView(this).apply {
    text = label.uppercase(Locale.US)
    textSize = 13f
    letterSpacing = .12f
    setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
    setTextColor(getColor(R.color.sweaty_cyan))
    setPadding(dp(4), dp(17), dp(4), dp(6))
  }

  private fun normalizeRtmpsUrl(value: CharSequence?): String {
    val trimmed = value?.toString()?.trim()?.removeSurrounding("\"")?.removeSurrounding("'").orEmpty()
    return if (trimmed.startsWith("RTMPS://", ignoreCase = true)) "rtmps://${trimmed.substring(8)}" else trimmed
  }

  private fun saveOutputServerUrl(
    platform: String,
    serverInput: EditText,
    serverPreference: String,
    secretPreference: String,
    enabledPreference: String,
    urlStatus: TextView,
    outputStatus: TextView,
    onSaved: () -> Unit
  ): Boolean {
    val server = normalizeRtmpsUrl(serverInput.text)
    if (!RtmpsPublisher.endpointValid(server)) {
      urlStatus.text = "Paste a complete secure RTMPS URL, starting with rtmps://."
      urlStatus.setTextColor(getColor(R.color.sweaty_red))
      status.text = "$platform URL not saved. Use its secure RTMPS server URL."
      return false
    }
    val prefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
    if (!prefs.edit().putString(serverPreference, server).commit()) {
      urlStatus.text = "Could not save the $platform URL. Try again."
      urlStatus.setTextColor(getColor(R.color.sweaty_red))
      status.text = "$platform URL could not be saved on this phone."
      return false
    }
    EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SERVER_URL_SAVED,
      EncoderDiagnosticResult.SAVED, diagnosticTarget(platform))
    urlStatus.text = "$platform RTMPS URL saved on this phone ✓"
    urlStatus.setTextColor(getColor(R.color.sweaty_cyan))
    val hasKey = RtmpsPublisher.keyValid(SecretStore(this).get(secretPreference))
    val selected = prefs.getBoolean(enabledPreference, false)
    outputStatus.text = outputCredentialStatus(platform, secretPreference, serverPreference)
    status.text = when {
      !hasKey -> "$platform URL saved. Add its stream key to finish setup."
      selected -> "$platform URL saved; destination is ready for the next public stream."
      else -> "$platform URL saved. Turn on its checkbox to include it in your next public stream."
    }
    onSaved()
    return true
  }

  private fun watchRtmpsUrl(
    platform: String,
    serverInput: EditText,
    serverPreference: String,
    secretPreference: String,
    enabledPreference: String,
    urlStatus: TextView,
    outputStatus: TextView,
    onSaved: () -> Unit
  ) {
    var lastSaved = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
      .getString(serverPreference, "").orEmpty()
    serverInput.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable?) {
        val candidate = normalizeRtmpsUrl(s)
        if (!RtmpsPublisher.endpointValid(candidate)) {
          urlStatus.text = "Paste a complete secure RTMPS URL; it saves when valid."
          urlStatus.setTextColor(getColor(R.color.sweaty_muted))
          return
        }
        if (candidate == lastSaved) {
          urlStatus.text = "$platform RTMPS URL saved on this phone ✓"
          urlStatus.setTextColor(getColor(R.color.sweaty_cyan))
          return
        }
        if (saveOutputServerUrl(platform, serverInput, serverPreference, secretPreference,
            enabledPreference, urlStatus, outputStatus, onSaved)) {
          lastSaved = candidate
        }
      }
    })
  }

  private fun checkRtmpsEndpoint(platform: String, serverInput: EditText, outputStatus: TextView,
                                 button: Button) {
    val server = normalizeRtmpsUrl(serverInput.text)
    if (!RtmpsPublisher.endpointValid(server)) {
      outputStatus.text = "$platform needs a valid rtmps:// server URL first. No key or media was sent."
      return
    }
    button.isEnabled = false
    outputStatus.text = "Checking $platform DNS and TLS only… No key or media is sent."
    thread(name = "SweatyOBS-$platform-endpoint-check") {
      val result = RtmpsPublisher.testTlsEndpoint(server)
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        button.isEnabled = true
        outputStatus.text = when (result) {
          "TLS_OK" -> "$platform RTMPS endpoint reachable over verified TLS ✓ Key and stream were not tested."
          "INVALID_URL" -> "$platform URL is invalid. Use its secure RTMPS server URL."
          "DNS_FAILED" -> "$platform server name did not resolve. Check the URL or phone internet."
          "BLOCKED_ADDRESS" -> "$platform server resolved to a private address and was blocked."
          "CONNECT_TIMEOUT" -> "$platform secure connection timed out. Check internet, firewall, or try another network."
          "TLS_FAILED" -> "$platform TLS verification failed. Copy the RTMPS URL from the platform dashboard."
          "CONNECTION_REFUSED" -> "$platform server refused the connection. Check the RTMPS URL and port 443."
          else -> "$platform could not be reached. Check the RTMPS URL and phone internet, then retry."
        }
      }
    }
  }

  private lateinit var status: TextView
  private lateinit var encoderContentView: View
  private var encoderUiVisible = false
  private var lockOnResume = false
  private var adminUnlockAttempt = 0
  private var adminUnlockInFlight = false
  private var adminUnlockWasBackgrounded = false
  internal var adminKeyVerifier: AdminKeyVerifier = RemoteAdminKeyVerifier()
  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val text = intent?.getStringExtra(Ps5LanService.EXTRA_STATUS_MESSAGE) ?: return
      status.text = text
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // Older builds cached one diagnostic status line on-device. Remove it and
    // keep live status in memory/broadcasts only from this version onward.
    getSharedPreferences(LEGACY_STATUS_PREFS, MODE_PRIVATE).edit().clear().apply()
    // Remove the local-password hash from earlier builds. Streaming keys and
    // other encoder settings live in separate preferences and are untouched.
    getSharedPreferences("encoder_admin_lock", MODE_PRIVATE).edit().clear().apply()
    EncoderDiagnostics.setMode(EncoderDiagnosticMode.IDLE)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(18), dp(14), dp(18), dp(28))
      setBackgroundColor(getColor(R.color.sweaty_background))
    }
    val brandHeader = TextView(this).apply {
      id = R.id.brand_header
      text = "SAEVOND"
      textSize = 28f
      letterSpacing = .16f
      setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_red))
      setPadding(dp(4), dp(4), dp(4), 0)
    }
    val brandSubtitle = TextView(this).apply {
      text = "SWEATYCLANKER  //  STREAM CONTROL"
      textSize = 12f
      letterSpacing = .12f
      setTextColor(getColor(R.color.sweaty_cyan))
      setPadding(dp(4), 0, dp(4), dp(12))
    }
    status = TextView(this).apply {
      id = R.id.connection_status
      text = "Ready. The PS5 network test is diagnostic only; GO LIVE is required to publish or burn in the overlay."
      textSize = 18f
      setPadding(dp(14), dp(14), dp(14), dp(14))
      setBackgroundResource(R.drawable.sweaty_info_card)
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val phoneIp = TextView(this).apply {
      val ip = wifiIpv4()
      text = "PHONE Wi-Fi IP (NextDNS rewrite destination): " + (ip ?: "Not on home Wi-Fi") + "\nPS5 IPv4 is entered separately below."
    }
    val destinations = TextView(this).apply {
      id = R.id.output_upload_budget
      text = "Upload budget is calculated from the selected quality and platform count. It is a planning estimate, not a speed test."
    }
    val outputPrefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
    if (outputPrefs.getString("sleipnir_server", "").orEmpty().isBlank()) {
      outputPrefs.edit().putString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL).apply()
    }
    val savedKickServer = outputPrefs.getString("kick_server", "").orEmpty()
    val repairedKickServer = RtmpsPublisher.normalizeKnownKickEndpoint(savedKickServer)
    if (savedKickServer.isBlank() || repairedKickServer != savedKickServer) {
      outputPrefs.edit().putString("kick_server", repairedKickServer.ifBlank {
        RtmpsPublisher.KICK_RTMPS_URL
      }).apply()
    }
    val savedYouTubeServer = outputPrefs.getString("youtube_server", "").orEmpty()
    val repairedYouTubeServer = RtmpsPublisher.normalizeKnownYouTubeEndpoint(savedYouTubeServer)
    if (savedYouTubeServer.isBlank() || repairedYouTubeServer != savedYouTubeServer) {
      outputPrefs.edit().putString("youtube_server", repairedYouTubeServer.ifBlank {
        RtmpsPublisher.YOUTUBE_RTMPS_URL
      }).apply()
    }
    val secretStore = SecretStore(this)
    val enableSleipnir = CheckBox(this).apply {
      id = R.id.sleipnir_enabled
      text = "Send one upstream feed to Sleipnir (platform destinations are managed in Sleipnir)"
      isChecked = outputPrefs.getBoolean("sleipnir_enabled", false)
    }
    val rotateSleipnirVideo180 = CheckBox(this).apply {
      id = R.id.sleipnir_rotate_180
      text = "Rotate PS5 gameplay 180° for Sleipnir (HUD stays upright; next stream)"
      isChecked = outputPrefs.getBoolean("sleipnir_rotate_180", false)
    }
    val sleipnirServer = EditText(this).apply {
      id = R.id.sleipnir_server
      hint = "Sleipnir RTMPS ingest URL"
      setSingleLine(true)
      setText(outputPrefs.getString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    }
    val sleipnirServerStatus = TextView(this).apply {
      text = if (RtmpsPublisher.endpointValid(outputPrefs.getString("sleipnir_server", "").orEmpty()))
        "Sleipnir RTMPS URL saved on this phone ✓" else "Enter a secure Sleipnir RTMPS URL."
      textSize = 13f
    }
    val saveSleipnirServer = Button(this).apply {
      id = R.id.save_sleipnir_server
      text = "Confirm / save Sleipnir URL"
    }
    val sleipnirKey = EditText(this).apply {
      id = R.id.sleipnir_stream_key
      hint = "Sleipnir ingest key from its dashboard (kept in Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val sleipnirOutputStatus = TextView(this).apply {
      id = R.id.sleipnir_output_status
      text = outputCredentialStatus("Sleipnir", "sleipnir_key", "sleipnir_server")
      textSize = 13f
    }
    val saveSleipnirKey = Button(this).apply {
      id = R.id.save_sleipnir_key
      text = "Save Sleipnir key securely"
    }
    val sleipnirNote = TextView(this).apply {
      text = "Sleipnir Free currently advertises 1080p / 5 Mbps. This route sends one 720p30 H.264 feed at a 3.2 Mbps video target plus 128 kb/s AAC; assuming 10% transport overhead, the estimated total is 3.66 Mbps. YouTube's H.264 720p30 floor is 3 Mbps and its recommendation is 8 Mbps. Actual encoder peak and downstream viewer playback are unverified. Choose Low-load 540p for a 1.8 Mbps target if Android reports low memory."
    }
    val initialTwitchEnabled = initializeDestinationSelection(
      savedSelection = if (outputPrefs.contains("twitch_enabled")) outputPrefs.getBoolean("twitch_enabled", false) else null,
      configuredDefault = RtmpsPublisher.keyValid(secretStore.get("rtmps"))
    ) { outputPrefs.edit().putBoolean("twitch_enabled", it).apply() }
    val initialYouTubeEnabled = initializeDestinationSelection(
      savedSelection = if (outputPrefs.contains("youtube_enabled")) outputPrefs.getBoolean("youtube_enabled", false) else null,
      configuredDefault = RtmpsPublisher.keyValid(secretStore.get("youtube_key")) &&
        RtmpsPublisher.endpointValid(outputPrefs.getString("youtube_server", "").orEmpty())
    ) { outputPrefs.edit().putBoolean("youtube_enabled", it).apply() }
    val initialKickEnabled = initializeDestinationSelection(
      savedSelection = if (outputPrefs.contains("kick_enabled")) outputPrefs.getBoolean("kick_enabled", false) else null,
      configuredDefault = RtmpsPublisher.keyValid(secretStore.get("kick_key")) &&
        RtmpsPublisher.endpointValid(outputPrefs.getString("kick_server", "").orEmpty())
    ) { outputPrefs.edit().putBoolean("kick_enabled", it).apply() }
    val enableTwitch = CheckBox(this).apply {
      text = "Stream to Twitch"
      isChecked = initialTwitchEnabled
    }
    val enableYouTube = CheckBox(this).apply {
      text = "Also stream to YouTube"
      isChecked = initialYouTubeEnabled
    }
    val youtubeServer = EditText(this).apply {
      id = R.id.youtube_server
      hint = "YouTube RTMPS URL · prefilled · auto-saves (confirm in Studio)"
      setSingleLine(true)
      setText(outputPrefs.getString("youtube_server", ""))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    }
    val youtubeServerStatus = TextView(this).apply {
      id = R.id.youtube_server_status
      text = if (RtmpsPublisher.endpointValid(outputPrefs.getString("youtube_server", "").orEmpty()))
        "YouTube RTMPS URL saved on this phone ✓" else "Paste a complete secure RTMPS URL; it saves when valid."
      setTextColor(getColor(if (RtmpsPublisher.endpointValid(outputPrefs.getString("youtube_server", "").orEmpty()))
        R.color.sweaty_cyan else R.color.sweaty_muted))
      textSize = 13f
    }
    val saveYouTubeServer = Button(this).apply {
      id = R.id.save_youtube_server
      text = "Confirm / save YouTube URL"
    }
    val testYouTubeConnection = Button(this).apply {
      id = R.id.test_youtube_connection
      text = "Test YouTube secure connection · no stream"
    }
    val youtubeKey = EditText(this).apply {
      id = R.id.youtube_stream_key
      hint = "YouTube stream key (kept in Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val youtubeOutputStatus = TextView(this).apply {
      id = R.id.youtube_output_status
      text = outputCredentialStatus("YouTube", "youtube_key", "youtube_server")
    }
    val saveYouTube = Button(this).apply {
      id = R.id.save_youtube_key
      text = "Save YouTube key securely"
    }
    val openYouTubeDashboard = Button(this).apply {
      id = R.id.open_youtube_dashboard
      text = "Open YouTube Studio — Go Live / stream key"
    }
    val enableKick = CheckBox(this).apply {
      text = "Also stream to Kick"
      isChecked = initialKickEnabled
    }
    val kickServer = EditText(this).apply {
      id = R.id.kick_server
      hint = "Kick RTMPS URL · prefilled · auto-saves"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      setSingleLine(true)
      setText(outputPrefs.getString("kick_server", ""))
    }
    val kickServerStatus = TextView(this).apply {
      id = R.id.kick_server_status
      text = if (RtmpsPublisher.endpointValid(outputPrefs.getString("kick_server", "").orEmpty()))
        "Kick RTMPS URL saved on this phone ✓" else "Paste a complete secure RTMPS URL; it saves when valid."
      setTextColor(getColor(if (RtmpsPublisher.endpointValid(outputPrefs.getString("kick_server", "").orEmpty()))
        R.color.sweaty_cyan else R.color.sweaty_muted))
      textSize = 13f
    }
    val saveKickServer = Button(this).apply {
      id = R.id.save_kick_server
      text = "Confirm / save Kick URL"
    }
    val testKickConnection = Button(this).apply {
      id = R.id.test_kick_connection
      text = "Test Kick secure connection · no stream"
    }
    val kickKey = EditText(this).apply {
      id = R.id.kick_stream_key
      hint = "Kick stream key (kept in Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val kickOutputStatus = TextView(this).apply {
      id = R.id.kick_output_status
      text = outputCredentialStatus("Kick", "kick_key", "kick_server")
    }
    val saveKick = Button(this).apply {
      id = R.id.save_kick_key
      text = "Save Kick key securely"
    }
    val openKickDashboard = Button(this).apply {
      id = R.id.open_kick_dashboard
      text = "Open Kick Creator Dashboard — Stream URL & key"
    }
    val enableBrandOverlay = CheckBox(this).apply {
      text = "Add the @saevond live overlay to the stream"
      isChecked = outputPrefs.getBoolean("brand_overlay", true)
    }
    val enableLiveTwitchChat = CheckBox(this).apply {
      text = "Show live Twitch chat in the overlay"
      isChecked = outputPrefs.getBoolean("twitch_chat_enabled", false)
    }
    val twitchChatLogin = EditText(this).apply {
      hint = "Twitch login for the token (example: saevond)"
      setSingleLine(true)
      setText(outputPrefs.getString("twitch_chat_login", "saevond"))
    }
    val twitchChatChannel = EditText(this).apply {
      hint = "Twitch channel to display (example: saevond)"
      setSingleLine(true)
      setText(outputPrefs.getString("twitch_chat_channel", "saevond"))
    }
    val twitchChatToken = EditText(this).apply {
      hint = "Twitch user access token with chat:read (saved to Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val twitchChatCredentialStatus = TextView(this).apply {
      text = if (SecretStore(this@MainActivity).get("twitch_chat_token").isNotBlank())
        "Twitch chat token saved securely on this phone ✓" else "No Twitch chat token saved. Chat stays off until configured."
      setTextColor(getColor(if (SecretStore(this@MainActivity).get("twitch_chat_token").isNotBlank())
        R.color.sweaty_cyan else R.color.sweaty_muted))
      textSize = 13f
    }
    val saveTwitchChatSettings = Button(this).apply { text = "Save Twitch chat settings securely" }
    val verifyTwitchChat = Button(this).apply { text = "Check Twitch chat connection · no stream" }
    val removeTwitchChatToken = Button(this).apply { text = "Remove saved Twitch chat token" }
    val twitchChatGuide = Button(this).apply { text = "Open Twitch token and chat permissions guide" }
    val qualityLabels = listOf(
      "Stable multi-stream · up to 720p · 4.5 Mbps",
      "High quality · up to 1080p · 8 Mbps",
      "Low-load diagnostic · up to 540p · 1.8 Mbps"
    )
    val overlayQuality = Spinner(this).apply {
      id = R.id.overlay_quality
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_item, qualityLabels).also {
        it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
      }
      setSelection(when (outputPrefs.getString("overlay_profile", "stable_720")) {
        "high_1080" -> 1
        "low_load_540" -> 2
        else -> 0
      })
    }
    val reconnectOutputs = Button(this).apply { text = "Reconnect stream outputs" }
    val videoModeNote = TextView(this).apply {
      text = "The overlay is burned into public-stream video; the PS5 connection test never publishes or opens Twitch chat. Stats, AI reactions, and event labels stay simulated. Optional live Twitch IRC chat is read-only and keeps at most 8 recent messages in memory; it sends no chat messages and writes none of the chat text to logs or disk. Overlay mode hardware-encodes up to the chosen size; it is not 4K. Pass-through leaves the PS5 bitrate/resolution unchanged. Choices apply next time you start streaming."
    }
    val metadataTitle = EditText(this).apply {
      hint = "Stream title (example: PS5 live gameplay and ranked matches)"
      setSingleLine(true)
      setText(outputPrefs.getString("metadata_title", ""))
    }
    val metadataGame = EditText(this).apply {
      hint = "Game name"
      setSingleLine(true)
      setText(outputPrefs.getString("metadata_game", ""))
    }
    val metadataKeywords = EditText(this).apply {
      hint = "Search phrases / tags, comma separated"
      setText(outputPrefs.getString("metadata_keywords", ""))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    }
    val copyMetadata = Button(this).apply { text = "Generate and copy stream description" }
    val privacy = TextView(this).apply {
      text = "No screen or microphone capture. No gameplay recording. " +
        "You can leave this screen while the user-started PS5 LAN diagnostic runs."
    }
    val safetyReading = TextView(this).apply { text = "Phone safety: not checked" }
    val checkSafety = Button(this).apply { text = "Check phone safety" }
    val ps5Ip = EditText(this).apply {
      id = R.id.ps5_ip_address
      hint = "PS5 private LAN IPv4 address"
      inputType = android.text.InputType.TYPE_CLASS_PHONE
      setSingleLine(true)
      setText(getSharedPreferences("ps5_setup", MODE_PRIVATE).getString("ps5_ipv4", ""))
    }
    val genreSettings = MusicGenreSettings(this)
    val stationNames = listOf("Mixed", "Club", "Dubstep / Bass", "Pop / Trap")
    val stationCodes = listOf(GenrePlaylist.MIXED, GenrePlaylist.CLUB, GenrePlaylist.DUBSTEP, GenrePlaylist.POP_TRAP)
    val stationPicker = Spinner(this).apply {
      id = R.id.music_genre
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, stationNames)
      setSelection(stationCodes.indexOf(genreSettings.selected()).coerceAtLeast(0))
      contentDescription = "Music genre: Mixed, Club, Dubstep and Bass, or Pop and Trap"
    }
    val genreStatus = TextView(this).apply {
      id = R.id.genre_library_status
      text = musicLibrarySummary(genreSettings)
    }
    val remoteCatalogStatus = TextView(this).apply {
      id = R.id.remote_catalog_status
      val savedRemote = allSavedMusicTracks(genreSettings)
        .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
      text = "Remote NCS catalog: ${RemoteMusicCatalog.tracks.size} creator tracks · " +
        "${RemoteMusicCatalog.forGenre("club").size} Club / House · " +
        "${RemoteMusicCatalog.forGenre("dubstep").size} Dubstep / Bass · " +
        "${RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).size} Pop / Trap · " +
        "$savedRemote saved. Use required song credits and check current platform terms."
    }
    val browseRemoteClub = Button(this).apply {
      id = R.id.remote_club_catalog
      text = "Browse remote NCS Club / House catalog"
    }
    val browseRemoteDubstep = Button(this).apply {
      id = R.id.remote_dubstep_catalog
      text = "Browse remote NCS Dubstep / Bass catalog"
    }
    val browseRemotePopTrap = Button(this).apply {
      text = "Browse remote NCS Pop / Trap catalog"
    }
    val copyStreamCredit = Button(this).apply {
      id = R.id.copy_ncs_stream_credit
      text = "Copy NCS live-stream credit"
    }
    val copyTrackCredits = Button(this).apply {
      id = R.id.copy_ncs_track_credits
      text = "Copy selected NCS track credits for VODs"
    }
    val addClub = Button(this).apply { text = "Add local licensed Club / House songs" }
    val addDubstep = Button(this).apply { text = "Add local licensed Dubstep songs" }
    val addPopTrap = Button(this).apply { text = "Add local licensed Pop / Trap songs" }
    val shuffleSongs = CheckBox(this).apply {
      id = R.id.music_shuffle
      text = "Shuffle songs"
      isChecked = genreSettings.shuffle()
    }
    val autoNextSong = CheckBox(this).apply {
      id = R.id.music_auto_next
      text = "Automatically play next song"
      isChecked = genreSettings.autoNext()
    }
    val skipSong = Button(this).apply { id = R.id.music_skip; text = "Skip to next song" }
    val savedLevels = getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
    val gameVolume = SeekBar(this).apply {
      id = R.id.game_volume
      max = 100
      progress = savedLevels.getInt("game", 85).coerceIn(0,100)
      contentDescription = "Game audio volume"
    }
    val musicVolume = SeekBar(this).apply {
      id = R.id.music_volume
      max = 100
      progress = savedLevels.getInt("music", 22).coerceIn(0,100)
      contentDescription = "Music volume"
    }
    val gameLabel = TextView(this).apply { text = "Game volume: ${gameVolume.progress}%" }
    val musicLabel = TextView(this).apply { text = "Music volume: ${musicVolume.progress}%" }
    val volumeHint = TextView(this).apply {
      text = "Live audio mix is peak-safe. Lower music to hear more game audio."
    }
    val muteMusic = Button(this).apply { id = R.id.music_mute; text = "Mute music" }
    val resetMix = Button(this).apply { text = "Reset volumes: game 85% · music 22%" }
    val musicNote = TextView(this).apply {
      val ready = getSharedPreferences("ps5_music", MODE_PRIVATE).contains("track_uri")
      val remoteCount = allSavedMusicTracks(genreSettings)
        .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
      text = when {
        remoteCount > 0 -> "$remoteCount remote NCS songs saved. Tracks load online when selected; audio is not saved as a music file. Shuffle avoids repeats until the selected list has played through."
        ready -> "Local licensed music selected. Autoplay begins after a platform accepts publishing."
        else -> "No music selected. Browse the 100-track remote NCS catalog or choose a local rights-cleared audio file."
      }
    }
    val chooseMusic = Button(this).apply { text = "Choose local licensed music file (MP3 / AAC / WAV)" }
    val autoplayMusic = CheckBox(this).apply {
      id = R.id.music_autoplay
      text = "Automatically play selected local or remote music when a stream output starts"
      isChecked = getSharedPreferences("ps5_music", MODE_PRIVATE)
        .getBoolean("autoplay", true)
    }
    val playMusic = Button(this).apply { text = "Play music on active stream" }
    val pauseMusic = Button(this).apply { text = "Pause music (leave game audio playing)" }
    val botToken = EditText(this).apply {
      hint = "Optional private bot music bridge token (32+ characters)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val saveBotToken = Button(this).apply { text = "Save private !play bridge token" }
    val generateBotToken = Button(this).apply {
      text = "Generate and copy secure bridge token for Render"
    }
    val testMusicBridge = Button(this).apply {
      id = R.id.test_music_bridge
      text = "Check remote music bridge connection"
    }
    val bridgeStatus = TextView(this).apply {
      id = R.id.music_bridge_status
      text = "Bridge not checked. Twitch music controls require matching private bot token."
    }
    val twitchStatus = TextView(this).apply {
      text = if (com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(SecretStore(this@MainActivity).get("rtmps")))
        "Twitch key saved securely (not verified by Twitch yet)."
      else "Twitch needs your channel's stream key."
    }
    val openTwitchDashboard = Button(this).apply {
      text = "Open Twitch Creator Dashboard — stream key"
    }
    val twitchKey = EditText(this).apply {
      hint = "Twitch stream key (stored securely on this phone)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val saveTwitchKey = Button(this).apply { text = "Save Twitch key securely" }
    val outputReadiness = TextView(this).apply {
      id = R.id.output_readiness
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val goLive = Button(this).apply {
      id = R.id.start_multistream
      text = "GO LIVE TO SELECTED PLATFORMS"
      textSize = 18f
      setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD))
      setTextColor(getColor(R.color.sweaty_text))
      setBackgroundResource(R.drawable.sweaty_button_live)
      setPadding(dp(12), dp(18), dp(12), dp(18))
    }
    val startLan = Button(this).apply {
      id = R.id.start_network_test
      text = "PS5 ingest test only — no public stream or overlay"
    }
    val remoteDiagnostics = CheckBox(this).apply {
      text = "Send privacy-safe connection diagnostics to Render"
      isChecked = getSharedPreferences(Ps5LanService.DIAGNOSTICS_PREFS, MODE_PRIVATE)
        .getBoolean(Ps5LanService.PREF_REMOTE_DIAGNOSTICS_ENABLED, true)
      setOnCheckedChangeListener { _, checked ->
        getSharedPreferences(Ps5LanService.DIAGNOSTICS_PREFS, MODE_PRIVATE).edit()
          .putBoolean(Ps5LanService.PREF_REMOTE_DIAGNOSTICS_ENABLED, checked).apply()
        if (checked) {
          EncoderDiagnostics.reset(this@MainActivity)
          EncoderDiagnostics.record(this@MainActivity, EncoderDiagnosticEventName.DIAGNOSTICS_ENABLED,
            EncoderDiagnosticResult.ENABLED, EncoderDiagnosticTarget.DIAGNOSTICS)
        } else {
          EncoderDiagnostics.disable()
        }
        status.text = if (checked) "Remote connection summaries are enabled for the active or next session."
          else "Remote connection summaries are disabled."
      }
    }
    val remoteDiagnosticsNote = TextView(this).apply {
      text = "Every 30 seconds, sends a connection summary plus fixed event/result/destination/error codes. Reports include a random app-session ID, app version, coarse connection counters, and server receipt times. No arbitrary text, raw logs, exception messages, video/audio, chat, viewer data, track/file names, stream keys, RTMPS URLs, PS5/local IP, or Wi-Fi name are included. Render may see standard HTTPS request metadata such as the phone's public IP and request time. Reports stay in phone memory until upload and go to Render runtime logs; delivery is best effort if a free service is asleep. Set the same ENCODER_BRIDGE_TOKEN on Render and under the !play bridge setting below."
      textSize = 13f
      setTextColor(getColor(R.color.sweaty_muted))
    }
    val stopLan = Button(this).apply { id = R.id.stop_network_test; text = "Stop receiver and all outputs" }
    val lockAdmin = Button(this).apply {
      id = R.id.admin_lock_now
      text = "LOCK ADMIN CONTROLS"
      setOnClickListener { showAdminPasswordGate() }
    }

    fun refreshOutputSummary() {
      val secretStore = SecretStore(this)
      val relayMode = enableSleipnir.isChecked
      enableTwitch.isEnabled = !relayMode
      enableYouTube.isEnabled = !relayMode
      enableKick.isEnabled = !relayMode
      rotateSleipnirVideo180.isEnabled = relayMode
      val direct = listOf(
        Triple("Twitch", enableTwitch.isChecked, RtmpsPublisher.keyValid(secretStore.get("rtmps"))),
        Triple("YouTube", enableYouTube.isChecked,
          RtmpsPublisher.keyValid(secretStore.get("youtube_key")) &&
            RtmpsPublisher.endpointValid(outputPrefs.getString("youtube_server", "").orEmpty())),
        Triple("Kick", enableKick.isChecked,
          RtmpsPublisher.keyValid(secretStore.get("kick_key")) &&
            RtmpsPublisher.endpointValid(outputPrefs.getString("kick_server", "").orEmpty()))
      )
      val relayReady = RtmpsPublisher.keyValid(secretStore.get("sleipnir_key")) &&
        RtmpsPublisher.endpointValid(outputPrefs.getString("sleipnir_server", "").orEmpty())
      val selected = if (relayMode) listOf(Triple("Sleipnir", true, relayReady)) else direct
      val selectedCount = selected.count { it.second }
      val states = selected.joinToString("   ·   ") { (label, enabled, ready) ->
        when {
          !enabled -> "$label off"
          ready -> "$label configured · platform not tested yet"
          else -> "$label selected · missing key or RTMPS URL"
        }
      }
      val quality = when (overlayQuality.selectedItemPosition) {
        1 -> OverlayEncodingProfile.HIGH_1080P
        2 -> OverlayEncodingProfile.LOW_LOAD_540P
        else -> OverlayEncodingProfile.STABLE_720P
      }
      val twitchNotice = if (quality == OverlayEncodingProfile.HIGH_1080P && enableTwitch.isChecked)
        "\nTwitch lists 6 Mbps for 1080p60; the shared 8 Mbps profile is above that guide."
        else ""
      outputReadiness.text = "Next public stream · local setup only: $states$twitchNotice"
      outputReadiness.setPadding(dp(14), dp(12), dp(14), dp(12))
      outputReadiness.setBackgroundResource(R.drawable.sweaty_info_card)
      if (relayMode) {
        val videoTargetBps = if (quality == OverlayEncodingProfile.LOW_LOAD_540P) 1_800_000 else 3_200_000
        val estimatedTotalMbps = SleipnirRelay.projectedIngestBitrate(videoTargetBps) / 1_000_000.0
        val profileLabel = if (quality == OverlayEncodingProfile.LOW_LOAD_540P) "540p / 1.8 Mbps" else "720p30 / 3.2 Mbps"
        destinations.text = "Sleipnir single-upload estimate ($profileLabel): ${formatMbps(estimatedTotalMbps)} Mbps including AAC and assumed 10% transport overhead. Sleipnir Free advertises a 5 Mbps budget; the 720p target clears YouTube's 3 Mbps H.264 floor but is below its 8 Mbps recommendation. This is a planning estimate, not a packet-level cap or route test."
      } else {
        val perDestination = quality.videoBitrateMbps + 0.128
        val aggregate = perDestination * selectedCount
        val capacityTarget = aggregate * 2.0
        val qualityLabel = when (quality) {
          OverlayEncodingProfile.HIGH_1080P -> "1080p / 8 Mbps"
          OverlayEncodingProfile.LOW_LOAD_540P -> "up to 540p / 1.8 Mbps"
          else -> "720p / 4.5 Mbps"
        }
        destinations.text = "Overlay budget ($qualityLabel): ${formatMbps(perDestination)} Mbps per selected destination; " +
          "${formatMbps(aggregate)} Mbps aggregate payload for $selectedCount selected. For a conservative 50% upload-utilization ceiling, target more than " +
          "${formatMbps(capacityTarget)} Mbps sustained upload in total. This is a planning estimate, not a speed test."
      }
      destinations.setPadding(dp(14), dp(12), dp(14), dp(12))
      destinations.setBackgroundResource(R.drawable.sweaty_info_card)
    }
    refreshOutputSummary()

    watchRtmpsUrl("Sleipnir", sleipnirServer, "sleipnir_server", "sleipnir_key", "sleipnir_enabled",
      sleipnirServerStatus, sleipnirOutputStatus) { refreshOutputSummary() }
    watchRtmpsUrl("YouTube", youtubeServer, "youtube_server", "youtube_key", "youtube_enabled",
      youtubeServerStatus, youtubeOutputStatus) { refreshOutputSummary() }
    watchRtmpsUrl("Kick", kickServer, "kick_server", "kick_key", "kick_enabled",
      kickServerStatus, kickOutputStatus) { refreshOutputSummary() }

    listOf(brandHeader, brandSubtitle, status,
      sectionHeader("PS5 input"), phoneIp, ps5Ip,
      sectionHeader("Stream destinations"), outputReadiness, destinations,
      enableSleipnir, sleipnirServer, sleipnirServerStatus, saveSleipnirServer, sleipnirKey,
      saveSleipnirKey, sleipnirOutputStatus, rotateSleipnirVideo180, sleipnirNote,
      enableTwitch, twitchStatus, openTwitchDashboard, twitchKey, saveTwitchKey,
      enableYouTube, openYouTubeDashboard, youtubeServer, youtubeServerStatus, saveYouTubeServer, testYouTubeConnection,
      youtubeKey, saveYouTube, youtubeOutputStatus,
      enableKick, openKickDashboard, kickServer, kickServerStatus, saveKickServer, testKickConnection,
      kickKey, saveKick, kickOutputStatus,
      sectionHeader("@saevond overlay and quality"), enableBrandOverlay, overlayQuality, videoModeNote,
      sectionHeader("Optional live Twitch chat in overlay"), enableLiveTwitchChat,
      twitchChatLogin, twitchChatChannel, twitchChatToken, twitchChatCredentialStatus,
      saveTwitchChatSettings, verifyTwitchChat, removeTwitchChatToken, twitchChatGuide,
      goLive, reconnectOutputs,
      sectionHeader("Connection check"), startLan, remoteDiagnostics, remoteDiagnosticsNote, stopLan,
      sectionHeader("Stream description and search"), metadataTitle, metadataGame, metadataKeywords, copyMetadata,
      sectionHeader("Music and audio"), genreStatus, stationPicker, remoteCatalogStatus, browseRemoteClub, browseRemoteDubstep,
      browseRemotePopTrap, copyStreamCredit, copyTrackCredits, addClub, addDubstep, addPopTrap,
      shuffleSongs, autoNextSong, skipSong,
      chooseMusic, musicNote, autoplayMusic, gameLabel, gameVolume, musicLabel, musicVolume,
      volumeHint, muteMusic, resetMix, playMusic, pauseMusic, botToken, saveBotToken, generateBotToken,
      testMusicBridge, bridgeStatus,
      sectionHeader("Device safety"), privacy, checkSafety, safetyReading, lockAdmin)
      .forEach { layout.addView(it) }
    encoderContentView = ScrollView(this).apply { addView(layout) }
    showAdminPasswordGate()

    stationPicker.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
      override fun onNothingSelected(parent: AdapterView<*>?) {}
      override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
        val genre = stationCodes[position.coerceIn(0, stationCodes.lastIndex)]
        if (genre == genreSettings.selected()) return
        genreSettings.select(genre)
        EncoderDiagnostics.record(this@MainActivity, EncoderDiagnosticEventName.MUSIC_STATION_SELECTED,
          EncoderDiagnosticResult.SELECTED, EncoderDiagnosticTarget.MUSIC)
        if (Ps5LanService.receiverRunning) {
          startService(Intent(this@MainActivity, Ps5LanService::class.java).apply {
            action = Ps5LanService.ACTION_MUSIC_STATION
            putExtra(Ps5LanService.EXTRA_GENRE, genre)
          })
        }
      }
    }
    addClub.setOnClickListener { pickGenreTracks(PICK_CLUB) }
    addDubstep.setOnClickListener { pickGenreTracks(PICK_DUBSTEP) }
    addPopTrap.setOnClickListener { pickGenreTracks(PICK_POP_TRAP) }
    browseRemoteClub.setOnClickListener { browseRemoteCatalog(GenrePlaylist.CLUB) }
    browseRemoteDubstep.setOnClickListener { browseRemoteCatalog(GenrePlaylist.DUBSTEP) }
    browseRemotePopTrap.setOnClickListener { browseRemoteCatalog(GenrePlaylist.POP_TRAP) }
    copyStreamCredit.setOnClickListener {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.MUSIC)
      (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
        ClipData.newPlainText("NCS live-stream credit", RemoteMusicCatalog.LIVE_STREAM_CREDIT)
      )
      status.text = "Copied the NCS live-stream credit. Paste it into the description on each platform where you stream."
    }
    copyTrackCredits.setOnClickListener {
      val savedTracks = allSavedMusicTracks(MusicGenreSettings(this))
      val credits = RemoteMusicCatalog.creditsForAudioUrls(savedTracks)
      if (credits.isBlank()) {
        status.text = "Add remote NCS tracks first. Their artist and song credits will be copied here for VOD descriptions."
      } else {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
          EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.MUSIC)
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
          ClipData.newPlainText("NCS track credits", credits)
        )
        status.text = "Copied selected NCS song credits. Paste them into the matching VOD description."
      }
    }
    shuffleSongs.setOnCheckedChangeListener { _, on ->
      genreSettings.setShuffle(on)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.MUSIC)
      if (Ps5LanService.receiverRunning) refreshGenreService()
    }
    autoNextSong.setOnCheckedChangeListener { _, on ->
      genreSettings.setAutoNext(on)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.MUSIC)
      if (Ps5LanService.receiverRunning) refreshGenreService()
    }
    skipSong.setOnClickListener {
      if (Ps5LanService.receiverRunning) {
        startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_SKIP })
        status.text = "Requested the next selected song. Game audio continues."
      } else {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_SKIP,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "Start a public stream before skipping music."
      }
    }

    // Preserve quiet user-selected levels when toggling mute. Use the default
    // mix only when music is currently muted and there is no prior level.
    var previousMusic = musicVolume.progress.takeIf { it > 0 } ?: 22
    val volumeChange = object : SeekBar.OnSeekBarChangeListener {
      override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
        gameLabel.text = "Game volume: ${gameVolume.progress}%"
        musicLabel.text = "Music volume: ${musicVolume.progress}%"
        Ps5LanService.liveLevels.update(gameVolume.progress, musicVolume.progress)
        if (musicVolume.progress > 0) previousMusic = musicVolume.progress
        muteMusic.text = if (musicVolume.progress == 0) "Unmute music" else "Mute music"
      }
      override fun onStartTrackingTouch(seekBar: SeekBar?) {}
      override fun onStopTrackingTouch(seekBar: SeekBar?) {
        savedLevels.edit().putInt("game", gameVolume.progress)
          .putInt("music", musicVolume.progress).apply()
        EncoderDiagnostics.record(this@MainActivity, EncoderDiagnosticEventName.SETTING_CHANGED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
      }
    }
    gameVolume.setOnSeekBarChangeListener(volumeChange)
    musicVolume.setOnSeekBarChangeListener(volumeChange)
    Ps5LanService.liveLevels.update(gameVolume.progress, musicVolume.progress)
    muteMusic.setOnClickListener {
      musicVolume.progress = if (musicVolume.progress > 0) 0 else previousMusic.coerceIn(1,100)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
      savedLevels.edit().putInt("game", gameVolume.progress)
        .putInt("music", musicVolume.progress).apply()
    }
    resetMix.setOnClickListener {
      gameVolume.progress = 85
      musicVolume.progress = 22
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
      savedLevels.edit().putInt("game",85).putInt("music",22).apply()
    }
    openTwitchDashboard.setOnClickListener {
      openCreatorDashboard("Twitch", "https://dashboard.twitch.tv/settings/stream",
        "Copy your Twitch stream key into this app and save it securely.")
    }
    openYouTubeDashboard.setOnClickListener {
      openCreatorDashboard("YouTube", YOUTUBE_DASHBOARD_URL,
        "In Live Control Room, copy the RTMPS URL shown after tapping the lock icon. Paste it here; save the stream key separately.")
    }
    openKickDashboard.setOnClickListener {
      openCreatorDashboard("Kick", KICK_DASHBOARD_URL,
        "The recommended RTMPS server URL is prefilled. Copy only your stream key into the separate Kick key field.")
    }
    enableSleipnir.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("sleipnir_enabled", checked).apply()
      refreshOutputSummary()
    }
    rotateSleipnirVideo180.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("sleipnir_rotate_180", checked).apply()
    }
    saveSleipnirServer.setOnClickListener {
      saveOutputServerUrl("Sleipnir", sleipnirServer, "sleipnir_server", "sleipnir_key",
        "sleipnir_enabled", sleipnirServerStatus, sleipnirOutputStatus) { refreshOutputSummary() }
    }
    saveSleipnirKey.setOnClickListener {
      val key = sleipnirKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter a valid Sleipnir ingest key. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("sleipnir_key", key)
        sleipnirKey.text.clear()
        sleipnirOutputStatus.text = outputCredentialStatus("Sleipnir", "sleipnir_key", "sleipnir_server")
        status.text = if (enableSleipnir.isChecked)
          "Sleipnir key saved securely. Its relay is selected for the next public stream. No stream has started."
        else "Sleipnir key saved securely. Turn on its relay checkbox before streaming."
        refreshOutputSummary()
      } catch (error: Exception) {
        status.text = "Could not securely save Sleipnir key (${error.javaClass.simpleName})."
      }
    }
    enableTwitch.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("twitch_enabled", checked).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DESTINATION_TOGGLED,
        if (checked) EncoderDiagnosticResult.ENABLED else EncoderDiagnosticResult.DISABLED,
        EncoderDiagnosticTarget.TWITCH)
      refreshOutputSummary()
    }
    enableYouTube.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("youtube_enabled", checked).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DESTINATION_TOGGLED,
        if (checked) EncoderDiagnosticResult.ENABLED else EncoderDiagnosticResult.DISABLED,
        EncoderDiagnosticTarget.YOUTUBE)
      refreshOutputSummary()
    }
    enableKick.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("kick_enabled", checked).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DESTINATION_TOGGLED,
        if (checked) EncoderDiagnosticResult.ENABLED else EncoderDiagnosticResult.DISABLED,
        EncoderDiagnosticTarget.KICK)
      refreshOutputSummary()
    }
    enableBrandOverlay.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("brand_overlay", checked).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.OVERLAY_TOGGLED,
        if (checked) EncoderDiagnosticResult.ENABLED else EncoderDiagnosticResult.DISABLED,
        EncoderDiagnosticTarget.OVERLAY)
    }
    enableLiveTwitchChat.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("twitch_chat_enabled", checked).apply()
      val stopRequested = checked || requestLiveTwitchChatStop()
      status.text = if (checked)
        "Live Twitch chat is selected for the next public stream. The connection check below does not start a stream."
      else if (stopRequested)
        "Live Twitch chat is off. A stop request was sent for any active chat connection; stream outputs continue and the overlay returns to its labeled simulation."
      else "Live Twitch chat is off, but Android could not stop the active chat connection. Stop the stream service to close it."
    }
    overlayQuality.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
      override fun onNothingSelected(parent: AdapterView<*>?) {}
      override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
        val profile = when (position) {
          1 -> "high_1080"
          2 -> "low_load_540"
          else -> "stable_720"
        }
        val previousProfile = outputPrefs.getString("overlay_profile", "stable_720")
        outputPrefs.edit().putString("overlay_profile", profile).apply()
        if (profile != previousProfile) EncoderDiagnostics.record(this@MainActivity,
          EncoderDiagnosticEventName.PROFILE_SELECTED, EncoderDiagnosticResult.SELECTED,
          EncoderDiagnosticTarget.OVERLAY)
        refreshOutputSummary()
      }
    }
    saveYouTubeServer.setOnClickListener {
      saveOutputServerUrl("YouTube", youtubeServer, "youtube_server", "youtube_key", "youtube_enabled",
        youtubeServerStatus, youtubeOutputStatus) { refreshOutputSummary() }
    }
    testYouTubeConnection.setOnClickListener {
      checkRtmpsEndpoint("YouTube", youtubeServer, youtubeOutputStatus, testYouTubeConnection)
    }
    saveTwitchChatSettings.setOnClickListener {
      val login = TwitchChatProtocol.normalizeLogin(twitchChatLogin.text.toString())
      val channel = TwitchChatProtocol.normalizeLogin(twitchChatChannel.text.toString())
      val enteredToken = twitchChatToken.text.toString()
      val token = if (enteredToken.isBlank()) "" else TwitchChatProtocol.normalizeAccessToken(enteredToken)
      if (login == null || channel == null || (enteredToken.isNotBlank() && token == null)) {
        status.text = "Enter valid Twitch login and channel names plus a valid access token, if changing it."
        return@setOnClickListener
      }
      try {
        outputPrefs.edit()
          .putString("twitch_chat_login", login)
          .putString("twitch_chat_channel", channel)
          .putBoolean("twitch_chat_enabled", enableLiveTwitchChat.isChecked)
          .apply()
        token?.takeIf { it.isNotBlank() }?.let { SecretStore(this).put("twitch_chat_token", it) }
        twitchChatToken.text.clear()
        val saved = SecretStore(this).get("twitch_chat_token").isNotBlank()
        twitchChatCredentialStatus.text = if (saved)
          "Twitch chat token saved securely on this phone ✓" else "No Twitch chat token saved. Chat stays off until configured."
        twitchChatCredentialStatus.setTextColor(getColor(if (saved) R.color.sweaty_cyan else R.color.sweaty_muted))
        val chatStopRequested = enableLiveTwitchChat.isChecked || requestLiveTwitchChatStop()
        status.text = if (saved)
          if (chatStopRequested)
            "Twitch chat settings saved. The token is stored in Android Keystore; chat connects only during a user-started public stream."
          else "Settings saved, but Android could not stop the active chat connection. Stop the stream service to close it."
        else "Channel settings saved. Add a Twitch user access token with the chat:read scope to enable live chat."
      } catch (error: Exception) {
        status.text = "Could not securely save Twitch chat settings (${error.javaClass.simpleName})."
      }
    }
    verifyTwitchChat.setOnClickListener {
      val login = TwitchChatProtocol.normalizeLogin(twitchChatLogin.text.toString())
      val channel = TwitchChatProtocol.normalizeLogin(twitchChatChannel.text.toString())
      val enteredToken = twitchChatToken.text.toString()
      val token = if (enteredToken.isBlank()) SecretStore(this).get("twitch_chat_token")
        else TwitchChatProtocol.normalizeAccessToken(enteredToken).orEmpty()
      if (login == null || channel == null || token.isBlank()) {
        status.text = "Enter a valid login and channel, then add or save a Twitch token with chat:read. No stream was started."
        return@setOnClickListener
      }
      verifyTwitchChat.isEnabled = false
      status.text = "Checking Twitch TLS chat access in read-only mode. This joins the channel to verify access but does not display or store chat messages, and starts no stream."
      thread(name = "SweatyOBS-twitch-chat-check") {
        var result: TwitchChatState? = null
        var client: TwitchChatClient? = null
        try {
          val joined = CountDownLatch(1)
          val connection = TwitchChatClient(login, channel, token, verifyOnly = true,
            onState = { state ->
              if (state == TwitchChatState.CONNECTED || state == TwitchChatState.AUTH_FAILED) {
                result = state
                joined.countDown()
              }
            }, onMessage = {})
          client = connection
          connection.start()
          val completed = joined.await(15, TimeUnit.SECONDS)
          connection.close()
          runOnUiThread {
            verifyTwitchChat.isEnabled = true
            status.text = when {
              !completed -> "Twitch chat check timed out. Check phone internet, channel, token, and chat:read permission. No stream was started."
              result == TwitchChatState.CONNECTED -> "Twitch chat connected securely and joined #$channel in read-only mode. The token was not saved by this check; use Save to retain it."
              else -> "Twitch rejected chat authentication. Check that the token is valid, has chat:read, and belongs to $login. No stream was started."
            }
          }
        } catch (_: Exception) {
          client?.close()
          runOnUiThread {
            verifyTwitchChat.isEnabled = true
            status.text = "Could not check Twitch chat. Confirm the login, channel, token format, and network. No stream was started."
          }
        }
      }
    }
    removeTwitchChatToken.setOnClickListener {
      try {
        SecretStore(this).put("twitch_chat_token", "")
        enableLiveTwitchChat.isChecked = false
        val chatStopRequested = requestLiveTwitchChatStop()
        twitchChatToken.text.clear()
        twitchChatCredentialStatus.text = "No Twitch chat token saved. Chat stays off until configured."
        twitchChatCredentialStatus.setTextColor(getColor(R.color.sweaty_muted))
        status.text = if (chatStopRequested)
          "Saved Twitch chat token removed from this phone. A stop request was sent for any active chat connection; stream outputs remain live."
        else "Token removed, but Android could not stop the active chat connection. Stop the stream service to close it."
      } catch (error: Exception) {
        status.text = "Could not remove Twitch chat token (${error.javaClass.simpleName})."
      }
    }
    twitchChatGuide.setOnClickListener {
      try {
        startActivity(Intent(Intent.ACTION_VIEW,
          Uri.parse("https://dev.twitch.tv/docs/authentication/getting-tokens-oauth")))
      } catch (_: ActivityNotFoundException) {
        status.text = "No browser is available to open Twitch's official token guide."
      }
    }
    saveYouTube.setOnClickListener {
      val key = youtubeKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter a valid YouTube stream key. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("youtube_key", key)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_KEY_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.YOUTUBE)
        youtubeKey.text.clear()
        youtubeOutputStatus.text = outputCredentialStatus("YouTube", "youtube_key", "youtube_server")
        status.text = if (outputPrefs.getBoolean("youtube_enabled", false))
          "YouTube key saved securely. YouTube remains selected for the next public stream. No stream has started."
        else "YouTube key saved securely. YouTube stays off until you turn on its checkbox. No stream has started."
        refreshOutputSummary()
      } catch (error: Exception) {
        status.text = "Could not securely save YouTube key (" + error.javaClass.simpleName + ")."
      }
    }
    saveKickServer.setOnClickListener {
      saveOutputServerUrl("Kick", kickServer, "kick_server", "kick_key", "kick_enabled",
        kickServerStatus, kickOutputStatus) { refreshOutputSummary() }
    }
    testKickConnection.setOnClickListener {
      checkRtmpsEndpoint("Kick", kickServer, kickOutputStatus, testKickConnection)
    }
    saveKick.setOnClickListener {
      val key = kickKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter a valid Kick stream key. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("kick_key", key)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_KEY_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.KICK)
        kickKey.text.clear()
        kickOutputStatus.text = outputCredentialStatus("Kick", "kick_key", "kick_server")
        status.text = if (outputPrefs.getBoolean("kick_enabled", false))
          "Kick key saved securely. Kick remains selected for the next public stream. No stream has started."
        else "Kick key saved securely. Kick stays off until you turn on its checkbox. No stream has started."
        refreshOutputSummary()
      } catch (error: Exception) {
        status.text = "Could not securely save Kick key (" + error.javaClass.simpleName + ")."
      }
    }
    reconnectOutputs.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MANUAL_RECONNECT_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MULTIPLE,
          EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "Start a stream first. Outputs will reconnect automatically after a network interruption."
      } else {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MANUAL_RECONNECT_REQUESTED,
          EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MULTIPLE)
        startService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_RECONNECT_OUTPUTS
        })
        status.text = "Manual reconnect requested. Waiting for a clean video keyframe; automatic retry stays enabled."
      }
    }
    copyMetadata.setOnClickListener {
      outputPrefs.edit()
        .putString("metadata_title", metadataTitle.text.toString())
        .putString("metadata_game", metadataGame.text.toString())
        .putString("metadata_keywords", metadataKeywords.text.toString())
        .apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.METADATA_COPIED,
        EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.SETTINGS)
      val activePlatforms = buildList {
        if (enableTwitch.isChecked) add("Twitch")
        if (enableYouTube.isChecked) add("YouTube")
        if (enableKick.isChecked) add("Kick")
      }
      val savedTracks = allSavedMusicTracks(MusicGenreSettings(this))
      val trackCredits = RemoteMusicCatalog.creditsForAudioUrls(savedTracks)
      val musicCredits = if (trackCredits.isBlank()) "" else
        RemoteMusicCatalog.LIVE_STREAM_CREDIT + "\n" + trackCredits
      val description = StreamMetadataBuilder.build(
        metadataTitle.text.toString(), metadataGame.text.toString(),
        metadataKeywords.text.toString(), activePlatforms, musicCredits)
      (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
        ClipData.newPlainText("Stream title and searchable description", description)
      )
      status.text = "Copied your stream description. Paste it into the title/description fields in each selected platform dashboard."
    }

    checkSafety.setOnClickListener {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SAFETY_CHECK_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.APP)
      safetyReading.text = "Reading battery and temperature…"
      val sample = PhoneSafetyMonitor(this).sample()
      val decision = PowerSafetyPolicy.assess(sample)
      val battery = sample.batteryPercent?.let { "$it%" } ?: "unavailable"
      val temp = sample.batteryTempDeciC
        ?.let { String.format(Locale.US, "%.1f°C", it / 10.0) } ?: "unavailable"
      safetyReading.text = "Battery $battery · temperature $temp · " +
        "thermal level ${sample.thermalStatus} · ${decision.level}: ${decision.message}"
    }

    autoplayMusic.setOnCheckedChangeListener { _, checked ->
      getSharedPreferences("ps5_music", MODE_PRIVATE).edit()
        .putBoolean("autoplay", checked).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SETTING_CHANGED,
        EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
      status.text = if (checked) "Music will start when a platform accepts publishing, if a licensed local or remote track is selected."
        else "Music autoplay disabled; use Play when your stream is active."
    }

    chooseMusic.setOnClickListener {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "audio/*"
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      try {
        startActivityForResult(intent, PICK_MUSIC)
      } catch (_: ActivityNotFoundException) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.FILE_PICKER_FAILED,
          EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.NO_FILE_PICKER)
        status.text = "No audio file picker is available on this phone."
      }
    }
    playMusic.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_PLAY,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "Start the PS5 connection test or public stream before playing music."
        return@setOnClickListener
      }
      startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_PLAY })
      status.text = "Music play requested for active stream; select a local file or remote NCS song first."
    }
    pauseMusic.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_PAUSE,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "No active PS5 receiver. Music is not playing."
        return@setOnClickListener
      }
      startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_PAUSE })
      status.text = "Music pause requested; game audio continues."
    }
    generateBotToken.setOnClickListener {
      try {
        val data = ByteArray(32)
        SecureRandom().nextBytes(data)
        val token = Base64.encodeToString(data, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
        SecretStore(this).put("bridge_token", token)
        EncoderDiagnostics.reset(this)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.BOT_TOKEN_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.SETTINGS)
        val clip = ClipData.newPlainText("SweatyClanker music bridge token", token)
        if (Build.VERSION.SDK_INT >= 33) {
          clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
          }
        }
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        status.text = "Secure bridge token created and copied. Paste it into Render environment variable ENCODER_BRIDGE_TOKEN. Do not share it in chat. Replacing it invalidates the old token."
        bridgeStatus.text = "Bridge token saved locally; set matching Render server secret, then tap Check."
      } catch (error: Exception) {
        status.text = "Could not generate secure bridge token (" + error.javaClass.simpleName + ")."
      }
    }

    saveBotToken.setOnClickListener {
      val token = botToken.text.toString().trim()
      if (token.length < 32 || token.length > 256) status.text = "Bridge token must be 32 to 256 characters."
      else try {
        SecretStore(this).put("bridge_token", token)
        EncoderDiagnostics.reset(this)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.BOT_TOKEN_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.SETTINGS)
        botToken.text.clear()
        status.text = "Bot !play token saved locally. SweatyClanker server must also have the same ENCODER_BRIDGE_TOKEN configured."
      } catch (error: Exception) { status.text = "Music bridge token storage failed (" + error.javaClass.simpleName + ")." }
    }

    testMusicBridge.setOnClickListener {
      val token = SecretStore(this).get("bridge_token")
      if (token.length !in 32..256) {
        bridgeStatus.text = "Save a private bridge token in this app first."
        return@setOnClickListener
      }
      bridgeStatus.text = "Checking SweatyClanker bot bridge over HTTPS…"
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.BRIDGE_CHECK_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MUSIC)
      testMusicBridge.isEnabled = false
      thread(name = "SweatyOBS-bridge-check") {
        val outcome = MusicBridgePoller.verify(
          "https://twitch-gemini-ai-chatbot-sc-2.onrender.com", token)
        runOnUiThread {
          if (!isFinishing && !isDestroyed) {
            bridgeStatus.text = outcome
            testMusicBridge.isEnabled = true
          }
        }
      }
    }

    saveTwitchKey.setOnClickListener {
      val value = twitchKey.text.toString().trim()
      if (!com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(value)) {
        status.text = "Invalid Twitch key format. Obtain the full stream key from Twitch Creator Dashboard; never send it in chat."
      } else try {
        SecretStore(this).put("rtmps", value)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_KEY_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.TWITCH)
        twitchKey.text.clear()
        status.text = "Twitch key stored with Android Keystore. Nothing is broadcasting."
        twitchStatus.text = "Twitch key saved locally; Twitch will check it when a stream starts."
        refreshOutputSummary()
      } catch (error: Exception) {
        status.text = "Could not securely save Twitch key (" + error.javaClass.simpleName + ")."
      }
    }

    goLive.setOnClickListener {
      status.text = "Checking selected public destinations and PS5 source…"
      val ip = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(ip)) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.NETWORK, EncoderDiagnosticError.INVALID_INPUT)
        status.text = "Enter the PS5 local IPv4 address first."
        return@setOnClickListener
      }
      val secrets = SecretStore(this)
      val directDestinations = buildList {
        if (enableTwitch.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "twitch", "Twitch", "rtmps://live.twitch.tv:443/app", secrets.get("rtmps")))
        if (enableYouTube.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "youtube", "YouTube", outputPrefs.getString("youtube_server", "").orEmpty(), secrets.get("youtube_key")))
        if (enableKick.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "kick", "Kick", outputPrefs.getString("kick_server", "").orEmpty(), secrets.get("kick_key")))
      }
      val destinations = OutputRouteSelector.select(
        enableSleipnir.isChecked,
        outputPrefs.getString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL).orEmpty(),
        secrets.get("sleipnir_key"),
        directDestinations
      )
      val missing = destinations.firstOrNull { !it.isValid() }
      if (destinations.isEmpty()) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MULTIPLE, EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "Choose at least one direct platform output or select the Sleipnir relay."
        return@setOnClickListener
      }
      if (missing != null) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, diagnosticTarget(missing.id), EncoderDiagnosticError.MISSING_CONFIG)
        status.text = "Save a valid ${missing.label} RTMPS server URL and stream key before going live."
        return@setOnClickListener
      }
      val overlayLabel = if (enableBrandOverlay.isChecked) "@saevond overlay enabled" else "HUD off"
      val routeLabel = if (enableSleipnir.isChecked) "Sleipnir single upstream" else destinations.joinToString(" + ") { it.label }
      getSharedPreferences("ps5_setup", MODE_PRIVATE).edit().putString("ps5_ipv4", ip).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.PS5_ADDRESS_SAVED,
        EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.NETWORK)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MULTIPLE)
      try {
        startForegroundService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_START_TWITCH
          putExtra(Ps5LanService.EXTRA_PS5_IPV4, ip)
        })
        status.text = "Armed for $routeLabel · $overlayLabel. Waiting for PS5 H.264/AAC RTMP media. Each destination reconnects independently."
      } catch (error: RuntimeException) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.NETWORK,
          EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
        status.text = "Android could not start public test: " + error.javaClass.simpleName
      }
    }

    startLan.setOnClickListener {
      status.text = "Checking the diagnostic-only PS5 ingest. No platform stream or overlay will start."
      val address = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(address)) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DIAGNOSTIC_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.NETWORK, EncoderDiagnosticError.INVALID_INPUT)
        status.text = "Enter the PS5's private IPv4 address."
        return@setOnClickListener
      }
      getSharedPreferences("ps5_setup", MODE_PRIVATE).edit().putString("ps5_ipv4", address).apply()
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.PS5_ADDRESS_SAVED,
        EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.NETWORK)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DIAGNOSTIC_TEST_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.NETWORK)
      try {
        status.text = "Valid PS5 IP. Asking Android to start receiver…"
        startForegroundService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_START
          putExtra(Ps5LanService.EXTRA_PS5_IPV4, address)
        })
        status.text = "Network-only diagnostic requested. No broadcast is sent."
      } catch (error: RuntimeException) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DIAGNOSTIC_START_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.PERMISSIONS,
          EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
        status.text = "Unable to start network diagnostic: check app permissions and Android service restrictions."
      }
    }

    stopLan.setOnClickListener {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STOP_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.NETWORK)
      stopService(Intent(this, Ps5LanService::class.java))
      status.text = "PS5 receiver and all streaming outputs stopped."
    }
  }

  private fun requestLiveTwitchChatStop(): Boolean {
    if (!Ps5LanService.twitchChatOverlayActiveOrStarting) return true
    return runCatching {
      startService(Intent(this, Ps5LanService::class.java).apply {
        action = Ps5LanService.ACTION_DISABLE_TWITCH_CHAT
      })
      true
    }.getOrDefault(false)
  }

  private fun browseRemoteCatalog(genre: String) {
    val tracks = RemoteMusicCatalog.forGenre(genre)
    if (tracks.isEmpty()) {
      status.text = "No remote NCS songs are listed for this genre."
      return
    }
    val label = when (genre) {
      GenrePlaylist.CLUB -> "Club / House"
      GenrePlaylist.DUBSTEP -> "Dubstep / Bass"
      GenrePlaylist.POP_TRAP -> "Pop / Trap"
      else -> "Music"
    }
    EncoderDiagnostics.record(this, EncoderDiagnosticEventName.CATALOG_OPENED,
      EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.MUSIC)
    val selected = linkedSetOf<Int>()
    val options = tracks.map { it.title + " — " + it.artist }.toTypedArray()
    AlertDialog.Builder(this)
      .setTitle("Remote NCS $label catalog")
      .setMultiChoiceItems(options, BooleanArray(options.size)) { _, which, checked ->
        if (checked) selected.add(which) else selected.remove(which)
      }
      .setNegativeButton("Cancel", null)
      .setPositiveButton("Add selected") { _, _ ->
        if (selected.isEmpty()) {
          status.text = "No remote songs selected."
          return@setPositiveButton
        }
        val settings = MusicGenreSettings(this)
        val before = settings.tracks(genre).size
        settings.add(genre, selected.map { tracks[it].audioUrl })
        val after = settings.tracks(genre).size
        val added = after - before
        if (added > 0) EncoderDiagnostics.record(this, EncoderDiagnosticEventName.TRACK_SELECTION_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
        findViewById<TextView>(R.id.genre_library_status)?.text = musicLibrarySummary(settings)
        val savedRemote = allSavedMusicTracks(settings)
          .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
        findViewById<TextView>(R.id.remote_catalog_status)?.text =
          "Remote NCS catalog: ${RemoteMusicCatalog.tracks.size} creator tracks · " +
            "${RemoteMusicCatalog.forGenre("club").size} Club / House · " +
            "${RemoteMusicCatalog.forGenre("dubstep").size} Dubstep / Bass · " +
            "${RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).size} Pop / Trap · " +
            "$savedRemote saved. Use required song credits and check current platform terms."
        status.text = if (added > 0)
          "Added $added remote NCS songs to $label. Copy the NCS live-stream credit into each stream description."
        else
          "No new songs added. The tracks may already be saved or this genre has reached its 100-song limit."
        if (added > 0 && Ps5LanService.receiverRunning) refreshGenreService()
      }
      .show()
  }

  private fun pickGenreTracks(requestCode: Int) {
    val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "audio/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    try {
      startActivityForResult(picker, requestCode)
    } catch (_: ActivityNotFoundException) {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.FILE_PICKER_FAILED,
        EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.NO_FILE_PICKER)
      status.text = "No file picker is available for adding local music on this phone."
    }
  }

  private fun refreshGenreService() {
    startService(Intent(this, Ps5LanService::class.java).apply {
      action = Ps5LanService.ACTION_MUSIC_CONFIG
    })
  }

  private fun allSavedMusicTracks(settings: MusicGenreSettings): List<String> =
    GenrePlaylist.GENRES.flatMap { settings.tracks(it) }

  private fun musicLibrarySummary(settings: MusicGenreSettings): String =
    "Music library: Club ${settings.tracks(GenrePlaylist.CLUB).size} · " +
      "Dubstep / Bass ${settings.tracks(GenrePlaylist.DUBSTEP).size} · " +
      "Pop / Trap ${settings.tracks(GenrePlaylist.POP_TRAP).size}"

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    val pickedGenre = when (requestCode) {
      PICK_CLUB -> GenrePlaylist.CLUB
      PICK_DUBSTEP -> GenrePlaylist.DUBSTEP
      PICK_POP_TRAP -> GenrePlaylist.POP_TRAP
      else -> null
    }
    if (pickedGenre != null && resultCode == RESULT_OK) {
      val genre = pickedGenre
      val uris = mutableListOf<Uri>()
      data?.data?.let { uris.add(it) }
      data?.clipData?.let { clip ->
        for (i in 0 until minOf(clip.itemCount, GenrePlaylist.MAX_TRACKS_PER_GENRE)) {
          clip.getItemAt(i).uri?.let { uris.add(it) }
        }
      }
      val granted = uris.distinct().mapNotNull { uri ->
        try {
          contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
          uri.toString().takeIf { it.startsWith("content://") && it.length <= 2048 }
        } catch (_: SecurityException) { null }
      }
      if (granted.isNotEmpty()) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.TRACK_SELECTION_SAVED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
        val store = MusicGenreSettings(this)
        store.add(genre, granted)
        findViewById<TextView>(R.id.genre_library_status)?.text = musicLibrarySummary(store)
        status.text = "Saved ${granted.size} local licensed $genre tracks. ${musicLibrarySummary(store)}"
        if (Ps5LanService.receiverRunning) refreshGenreService()
      } else {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.TRACK_SELECTION_SAVED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MUSIC, EncoderDiagnosticError.USER_CANCELLED)
        status.text = "No accessible local songs were selected."
      }
      return
    }
    if (requestCode == PICK_MUSIC && resultCode == RESULT_OK) {
      val uri = data?.data ?: return
      try {
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        getSharedPreferences("ps5_music", MODE_PRIVATE).edit().putString("track_uri", uri.toString()).apply()
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_FILE_SELECTED,
          EncoderDiagnosticResult.SAVED, EncoderDiagnosticTarget.MUSIC)
        status.text = "Music file saved for next public test. Only use tracks licensed for live streams and VODs."
      } catch (error: Exception) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_FILE_SELECTED,
          EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.MUSIC,
          EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
        status.text = "Cannot access music file (" + error.javaClass.simpleName + "). Select a local audio file instead."
      }
    }
  }

  private fun outputCredentialStatus(platform: String, secretName: String, serverPreference: String): String {
    val keySaved = RtmpsPublisher.keyValid(SecretStore(this).get(secretName))
    val serverSaved = RtmpsPublisher.endpointValid(
      getSharedPreferences("encoder_outputs", MODE_PRIVATE).getString(serverPreference, "").orEmpty())
    return when {
      keySaved && serverSaved -> "$platform key saved securely; RTMPS server URL saved."
      keySaved -> "$platform key saved securely; save its RTMPS server URL before streaming."
      serverSaved -> "$platform server URL saved; save a stream key before streaming."
      else -> "$platform stream key and RTMPS server URL are not saved yet."
    }
  }

  private fun openCreatorDashboard(
    platform: String,
    url: String,
    nextStep: String = "Copy its RTMPS server URL and stream key into this app, then save them securely."
  ) {
    try {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DASHBOARD_OPENED,
        EncoderDiagnosticResult.COMPLETED, diagnosticTarget(platform))
      status.text = "Opened $platform. $nextStep"
    } catch (_: ActivityNotFoundException) {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.DASHBOARD_OPENED,
        EncoderDiagnosticResult.FAILED, diagnosticTarget(platform), EncoderDiagnosticError.APP_RESTRICTION)
      status.text = "No browser is available to open the $platform dashboard."
    }
  }

  private fun wifiIpv4(): String? {
    val manager = getSystemService(ConnectivityManager::class.java)
    val network = manager.activeNetwork ?: return null
    val cap = manager.getNetworkCapabilities(network) ?: return null
    if (!cap.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
    return manager.getLinkProperties(network)?.linkAddresses
      ?.firstOrNull { it.address is Inet4Address && it.address.isSiteLocalAddress }
      ?.address?.hostAddress
  }

  private fun showAdminPasswordGate() {
    encoderUiVisible = false
    adminUnlockAttempt += 1
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
      text = "Enter the current admin key to open the encoder controls. It is checked over HTTPS and is not saved on this phone."
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
      text = "The key is checked by the SweatyClanker encoder service."
      textSize = 13f
      setTextColor(getColor(R.color.sweaty_muted))
      setPadding(0, dp(10), 0, dp(12))
    }
    val submit = Button(this).apply {
      id = R.id.admin_password_submit
      text = "UNLOCK ENCODER"
      setBackgroundResource(R.drawable.sweaty_button_live)
      setTextColor(getColor(R.color.sweaty_text))
      setPadding(dp(12), dp(12), dp(12), dp(12))
    }
    val recovery = TextView(this).apply {
      text = "If Render has been idle, its first response may take about a minute. Keep this screen open. If the check times out, retry when the service is awake. The key is not saved on this phone."
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
        runOnUiThread {
          if (attempt != adminUnlockAttempt || isFinishing || isDestroyed) return@runOnUiThread
          adminUnlockInFlight = false
          val backgrounded = adminUnlockWasBackgrounded
          adminUnlockWasBackgrounded = false
          if (result == AdminKeyUnlockResult.ACCEPTED && !backgrounded && !lockOnResume && hasWindowFocus()) {
            lockOnResume = false
            showEncoderControls()
          } else {
            keyInput.isEnabled = true
            submit.isEnabled = true
            message.text = when (result) {
              AdminKeyUnlockResult.ACCEPTED -> "Unlock was interrupted when the app left the foreground. Enter the key again."
              AdminKeyUnlockResult.REJECTED -> "Key not accepted. Check it and try again."
              AdminKeyUnlockResult.RATE_LIMITED -> "Too many attempts. Wait a little, then try again."
              AdminKeyUnlockResult.UNAVAILABLE -> "Unlock service unavailable. Check internet and try again."
            }
            message.setTextColor(if (result == AdminKeyUnlockResult.ACCEPTED) getColor(R.color.sweaty_muted) else getColor(R.color.sweaty_red))
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
    // Authentication replaces the view tree. Restore the landing position so
    // a prior focus or scroll offset never leaves the user on a blank-looking
    // lower section after unlocking.
    (encoderContentView as? ScrollView)?.post {
      if (encoderUiVisible && !isFinishing) (encoderContentView as? ScrollView)?.scrollTo(0, 0)
    }
    EncoderDiagnostics.setMode(EncoderDiagnosticMode.IDLE)
    EncoderDiagnostics.record(this, EncoderDiagnosticEventName.APP_OPENED,
      EncoderDiagnosticResult.COMPLETED, EncoderDiagnosticTarget.APP)
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
      // An unlock request that was pending while backgrounded cannot reveal
      // the controls on return; the owner must enter the key again.
      lockOnResume = false
    }
  }

  override fun onStart() {
    super.onStart()
    val filter = IntentFilter(Ps5LanService.ACTION_STATUS)
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else { @Suppress("DEPRECATION") registerReceiver(statusReceiver, filter) }
    // IRC !volume commands may have changed the persisted slider while this
    // screen was backgrounded in Twitch. Refresh when returning to OBS Lite.
    val remoteMusic = getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
      .getInt("music", 22).coerceIn(0,100)
    findViewById<SeekBar>(R.id.music_volume)?.let {
      if (it.progress != remoteMusic) it.progress = remoteMusic
    }
  }

  override fun onStop() {
    unregisterReceiver(statusReceiver)
    super.onStop()
  }
}
