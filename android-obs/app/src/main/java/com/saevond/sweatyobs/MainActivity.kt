package com.saevond.sweatyobs

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

class MainActivity : Activity() {
  private val requestCode = 7192
  private val musicRequestCode = 7193
  private var musicUri = ""
  private lateinit var status: TextView
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }
    status = TextView(this).apply { text = "SweatyClanker OBS Lite — diagnostics only. No stream starts automatically." }
    val safetyReading = TextView(this).apply { text = "Safety not checked" }
    val checkSafety = Button(this).apply { text = "CHECK PHONE SAFETY (no streaming)" }
    val endpoint = EditText(this).apply { hint = "RTMPS Twitch ingest URL (private)"; inputType = 129 }
    val botOrigin = EditText(this).apply { hint = "Bot HTTPS URL"; inputType = 17 }
    val bridgeToken = EditText(this).apply { hint = "Bridge secret"; inputType = 129 }
    val chooseMusic = Button(this).apply { text = "Select licensed track" }
    val start = Button(this).apply { text = "Request screen capture and start" }
    val chatSafe = Button(this).apply { text = "Chat Safe Mode (hide screen)" }
    val ps5Ip = EditText(this).apply { hint = "PS5 local IPv4 (e.g. 192.168.1.50)"; inputType = 3 }
    val startLan = Button(this).apply { text = "Test PS5 LAN receiver (no broadcast)" }
    val stopLan = Button(this).apply { text = "Stop PS5 LAN receiver" }
    val stop = Button(this).apply { text = "Stop stream" }
    layout.addView(status); layout.addView(checkSafety); layout.addView(safetyReading)
    layout.addView(endpoint); layout.addView(botOrigin)
    layout.addView(bridgeToken); layout.addView(chooseMusic); layout.addView(start); layout.addView(chatSafe); layout.addView(stop)
    layout.addView(ps5Ip); layout.addView(startLan); layout.addView(stopLan)
    chooseMusic.setOnClickListener {
      startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = "audio/*"
      }, musicRequestCode)
    }
    setContentView(android.widget.ScrollView(this).apply { addView(layout) })
    checkSafety.setOnClickListener {
      val monitor = PhoneSafetyMonitor(this)
      val sample = monitor.sample()
      val decision = PowerSafetyPolicy.assess(sample)
      val temperature = sample.batteryTempDeciC?.let { "%.1f".format(java.util.Locale.US, it / 10.0) + "°C" } ?: "unavailable"
      val battery = sample.batteryPercent?.let { "$it%" } ?: "unavailable"
      safetyReading.text = "Battery: $battery | Battery temperature: $temperature | Charging: ${sample.charging} | Android thermal status: ${sample.thermalStatus} | Safety: ${decision.level} — ${decision.message}"
    }
    start.setOnClickListener {
      val target = endpoint.text.toString()
      if (!target.startsWith("rtmps://")) { status.text = "Enter an RTMPS URL."; return@setOnClickListener }
      SecretStore(this).put("rtmps", target)
      SecretStore(this).put("bridge_token", bridgeToken.text.toString())
      getPreferences(MODE_PRIVATE).edit().putString("botOrigin", botOrigin.text.toString().trim()).apply()
      val projection = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      startActivityForResult(projection.createScreenCaptureIntent(), requestCode)
    }
    chatSafe.setOnClickListener {
      startService(Intent(this, StreamService::class.java).setAction("CHAT_SAFE"))
      status.text = "Chat Safe Mode requested: screen hidden; music remains available."
    }
    startLan.setOnClickListener {
      val address = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(address)) { status.text = "Enter a private PS5 IPv4 address."; return@setOnClickListener }
      startForegroundService(Intent(this, Ps5LanService::class.java).apply {
        action = Ps5LanService.ACTION_START
        putExtra(Ps5LanService.EXTRA_PS5_IPV4, address)
      })
      status.text = "PS5 receiver test requested; check the foreground notification. No stream sent."
    }
    stopLan.setOnClickListener {
      startService(Intent(this, Ps5LanService::class.java).setAction(Ps5LanService.ACTION_STOP))
      status.text = "PS5 LAN test stop requested"
    }
    stop.setOnClickListener { startService(Intent(this, StreamService::class.java).setAction("STOP")); status.text = "Stop requested" }
  }
  @Deprecated("Android activity result callback; migrate to Activity Result API after device tests")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (resultCode != RESULT_OK || data == null) return
    if (requestCode == musicRequestCode) {
      val selected = data.data ?: return
      contentResolver.takePersistableUriPermission(selected, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      musicUri = selected.toString()
      status.text = "Licensed audio selected"
      return
    }
    if (requestCode != this.requestCode) return
    val target = SecretStore(this).get("rtmps")
    val intent = Intent(this, StreamService::class.java).apply {
      action = "START"; putExtra("resultCode", resultCode); putExtra("projectionData", data)
      putExtra("target", target); putExtra("musicUri", musicUri)
      putExtra("botOrigin", getPreferences(MODE_PRIVATE).getString("botOrigin", ""))
    }
    startForegroundService(intent)
    status.text = "Capture permission granted; validating stream in background"
  }
}
