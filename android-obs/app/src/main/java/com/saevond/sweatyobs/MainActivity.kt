package com.saevond.sweatyobs

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.view.View
import android.text.InputType
import android.net.ConnectivityManager
import android.net.Uri
import android.net.NetworkCapabilities
import java.net.Inet4Address
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.SeekBar
import java.util.Locale

/**
 * Controls a background *network receiver*, never a display or audio recorder.
 * Streaming outputs remain disabled until PS5 media ingest/mux/multi-RTMPS are proven.
 */
class MainActivity : Activity() {
  companion object { private const val PICK_MUSIC = 31416 }
  private lateinit var status: TextView
  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val text = intent?.getStringExtra(Ps5LanService.EXTRA_STATUS_MESSAGE) ?: return
      status.text = text
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(24, 20, 24, 20)
    }
    status = TextView(this).apply {
      id = R.id.connection_status
      text = "Ready for test — no broadcast is sent."
      textSize = 18f
      setPadding(12, 16, 12, 24)
      accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val phoneIp = TextView(this).apply {
      val ip = wifiIpv4()
      text = "PHONE Wi-Fi IP (NextDNS rewrite destination): " + (ip ?: "Not on home Wi-Fi") + "\nPS5 IPv4 is entered separately below."
    }
    val destinations = TextView(this).apply {
      text = "Twitch · YouTube · Kick: planned simultaneous outputs, NOT operational yet."
    }
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
      progress = savedLevels.getInt("music", 20).coerceIn(0,100)
      contentDescription = "Music volume"
    }
    val gameLabel = TextView(this).apply { text = "Game volume: ${gameVolume.progress}%" }
    val musicLabel = TextView(this).apply { text = "Music volume: ${musicVolume.progress}%" }
    val volumeHint = TextView(this).apply {
      text = "Live audio mix is peak-safe. Lower music to hear more game audio."
    }
    val muteMusic = Button(this).apply { id = R.id.music_mute; text = "Mute music" }
    val resetMix = Button(this).apply { text = "Reset volumes: game 85% · music 20%" }
    val musicNote = TextView(this).apply {
      val ready = getSharedPreferences("ps5_music", MODE_PRIVATE).contains("track_uri")
      text = if (ready) "Local licensed music selected for next public stream."
        else "No music selected. Choose your own rights-cleared audio file to make music audible on Twitch."
    }
    val chooseMusic = Button(this).apply { text = "Choose licensed music file (MP3 / AAC / WAV)" }
    val playMusic = Button(this).apply { text = "Play music on Twitch (when stream active)" }
    val pauseMusic = Button(this).apply { text = "Pause music (leave game audio playing)" }
    val botToken = EditText(this).apply {
      hint = "Optional private bot music bridge token (32+ characters)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val saveBotToken = Button(this).apply { text = "Save private !play bridge token" }
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
    val goLive = Button(this).apply { text = "TEST PUBLIC TWITCH BROADCAST (requires actual PS5 media)" }
    val startLan = Button(this).apply { id = R.id.start_network_test; text = "Start PS5 network connection test" }
    val stopLan = Button(this).apply { id = R.id.stop_network_test; text = "Stop PS5 network test" }

    listOf(phoneIp, destinations, privacy, checkSafety, safetyReading, ps5Ip,
      chooseMusic, musicNote, gameLabel, gameVolume, musicLabel, musicVolume,
      volumeHint, muteMusic, resetMix, playMusic, pauseMusic, botToken, saveBotToken,
      openTwitchDashboard, twitchStatus, twitchKey, saveTwitchKey,
      startLan, goLive, stopLan, status)
      .forEach { layout.addView(it) }
    setContentView(ScrollView(this).apply { addView(layout) })

    var previousMusic = musicVolume.progress.coerceAtLeast(20)
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
      }
    }
    gameVolume.setOnSeekBarChangeListener(volumeChange)
    musicVolume.setOnSeekBarChangeListener(volumeChange)
    Ps5LanService.liveLevels.update(gameVolume.progress, musicVolume.progress)
    muteMusic.setOnClickListener {
      musicVolume.progress = if (musicVolume.progress > 0) 0 else previousMusic.coerceIn(1,100)
      savedLevels.edit().putInt("game", gameVolume.progress)
        .putInt("music", musicVolume.progress).apply()
    }
    resetMix.setOnClickListener {
      gameVolume.progress = 85
      musicVolume.progress = 20
      savedLevels.edit().putInt("game",85).putInt("music",20).apply()
    }
    openTwitchDashboard.setOnClickListener {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dashboard.twitch.tv/settings/stream")))
    }

    checkSafety.setOnClickListener {
      safetyReading.text = "Reading battery and temperature…"
      val sample = PhoneSafetyMonitor(this).sample()
      val decision = PowerSafetyPolicy.assess(sample)
      val battery = sample.batteryPercent?.let { "$it%" } ?: "unavailable"
      val temp = sample.batteryTempDeciC
        ?.let { String.format(Locale.US, "%.1f°C", it / 10.0) } ?: "unavailable"
      safetyReading.text = "Battery $battery · temperature $temp · " +
        "thermal level ${sample.thermalStatus} · ${decision.level}: ${decision.message}"
    }

    chooseMusic.setOnClickListener {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "audio/*"
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
      }
      startActivityForResult(intent, PICK_MUSIC)
    }
    playMusic.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        status.text = "Start the PS5 connection test or public stream before playing music."
        return@setOnClickListener
      }
      startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_PLAY })
      status.text = "Music play requested for active stream; local file required."
    }
    pauseMusic.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        status.text = "No active PS5 receiver. Music is not playing."
        return@setOnClickListener
      }
      startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_PAUSE })
      status.text = "Music pause requested; game audio continues."
    }
    saveBotToken.setOnClickListener {
      val token = botToken.text.toString().trim()
      if (token.length < 32 || token.length > 256) status.text = "Bridge token must be 32 to 256 characters."
      else try {
        SecretStore(this).put("bridge_token", token)
        botToken.text.clear()
        status.text = "Bot !play token saved locally. SweatyClanker server must also have the same ENCODER_BRIDGE_TOKEN configured."
      } catch (error: Exception) { status.text = "Music bridge token storage failed (" + error.javaClass.simpleName + ")." }
    }

    saveTwitchKey.setOnClickListener {
      val value = twitchKey.text.toString().trim()
      if (!com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(value)) {
        status.text = "Invalid Twitch key format. Obtain the full stream key from Twitch Creator Dashboard; never send it in chat."
      } else try {
        SecretStore(this).put("rtmps", value)
        twitchKey.text.clear()
        status.text = "Twitch key stored with Android Keystore. Nothing is broadcasting."
        twitchStatus.text = "Twitch key saved locally; authorization verified during public test."
      } catch (error: Exception) {
        status.text = "Could not securely save Twitch key (" + error.javaClass.simpleName + ")."
      }
    }

    goLive.setOnClickListener {
      status.text = "Public Twitch test requested. Checking phone, PS5 address, and saved key…"
      val ip = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(ip)) {
        status.text = "Enter the PS5 local IPv4 address first."
        return@setOnClickListener
      }
      if (!com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(SecretStore(this).get("rtmps"))) {
        status.text = "Save your Twitch stream key on this phone first."
        return@setOnClickListener
      }
      getSharedPreferences("ps5_setup", MODE_PRIVATE).edit().putString("ps5_ipv4", ip).apply()
      try {
        startForegroundService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_START_TWITCH
          putExtra(Ps5LanService.EXTRA_PS5_IPV4, ip)
        })
        status.text = "Waiting for PS5 H.264/AAC RTMP feed; Twitch publishing begins only if valid media arrives."
      } catch (error: RuntimeException) {
        status.text = "Android could not start public test: " + error.javaClass.simpleName
      }
    }

    startLan.setOnClickListener {
      status.text = "Start button tapped — checking PS5 address…"
      val address = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(address)) {
        status.text = "Enter the PS5's private IPv4 address."
        return@setOnClickListener
      }
      getSharedPreferences("ps5_setup", MODE_PRIVATE).edit().putString("ps5_ipv4", address).apply()
      try {
        status.text = "Valid PS5 IP. Asking Android to start receiver…"
        startForegroundService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_START
          putExtra(Ps5LanService.EXTRA_PS5_IPV4, address)
        })
        status.text = "Network-only diagnostic requested. You can switch to Twitch chat; no broadcast is sent."
      } catch (error: RuntimeException) {
        status.text = "Unable to start network diagnostic: check app permissions and Android service restrictions."
      }
    }

    stopLan.setOnClickListener {
      stopService(Intent(this, Ps5LanService::class.java))
      status.text = "PS5 network diagnostic stopped. No broadcasting was started."
    }
  }

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == PICK_MUSIC && resultCode == RESULT_OK) {
      val uri = data?.data ?: return
      try {
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        getSharedPreferences("ps5_music", MODE_PRIVATE).edit().putString("track_uri", uri.toString()).apply()
        status.text = "Music file saved for next public test. Only use tracks licensed for live streams and VODs."
      } catch (error: Exception) {
        status.text = "Cannot access music file (" + error.javaClass.simpleName + "). Select a local audio file instead."
      }
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

  override fun onStart() {
    super.onStart()
    val filter = IntentFilter(Ps5LanService.ACTION_STATUS)
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else { @Suppress("DEPRECATION") registerReceiver(statusReceiver, filter) }
    val saved = getSharedPreferences(Ps5LanService.STATUS_PREFS, MODE_PRIVATE)
      .getString(Ps5LanService.PREF_STATUS_MESSAGE, null)
    if (!saved.isNullOrBlank()) status.text = saved
  }

  override fun onStop() {
    unregisterReceiver(statusReceiver)
    super.onStop()
  }
}
