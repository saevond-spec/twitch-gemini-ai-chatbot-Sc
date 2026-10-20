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
import android.net.NetworkCapabilities
import java.net.Inet4Address
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

/**
 * Controls a background *network receiver*, never a display or audio recorder.
 * Streaming outputs remain disabled until PS5 media ingest/mux/multi-RTMPS are proven.
 */
class MainActivity : Activity() {
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
    val twitchKey = EditText(this).apply {
      hint = "Twitch stream key (stored securely on this phone)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val saveTwitchKey = Button(this).apply { text = "Save Twitch key securely" }
    val goLive = Button(this).apply { text = "TEST PUBLIC TWITCH BROADCAST (requires actual PS5 media)" }
    val startLan = Button(this).apply { id = R.id.start_network_test; text = "Start PS5 network connection test" }
    val stopLan = Button(this).apply { id = R.id.stop_network_test; text = "Stop PS5 network test" }

    listOf(phoneIp, destinations, privacy, checkSafety, safetyReading, ps5Ip, twitchKey, saveTwitchKey, startLan, goLive, stopLan, status)
      .forEach { layout.addView(it) }
    setContentView(ScrollView(this).apply { addView(layout) })

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

    saveTwitchKey.setOnClickListener {
      val value = twitchKey.text.toString().trim()
      if (!com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(value)) {
        status.text = "Invalid Twitch key format. Obtain the full stream key from Twitch Creator Dashboard; never send it in chat."
      } else try {
        SecretStore(this).put("rtmps", value)
        twitchKey.text.clear()
        status.text = "Twitch key stored with Android Keystore. Nothing is broadcasting."
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
