package com.saevond.sweatyobs

import android.app.Activity
import android.content.Intent
import android.os.Bundle
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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(24, 20, 24, 20)
    }
    status = TextView(this).apply {
      text = "SweatyClanker Multistream — network-only development build. No live outputs enabled."
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
      hint = "PS5 private LAN IPv4 address"
      inputType = android.text.InputType.TYPE_CLASS_PHONE
    }
    val startLan = Button(this).apply { text = "Start PS5 network connection test" }
    val stopLan = Button(this).apply { text = "Stop PS5 network test" }

    listOf(status, destinations, privacy, checkSafety, safetyReading, ps5Ip, startLan, stopLan)
      .forEach { layout.addView(it) }
    setContentView(ScrollView(this).apply { addView(layout) })

    checkSafety.setOnClickListener {
      val sample = PhoneSafetyMonitor(this).sample()
      val decision = PowerSafetyPolicy.assess(sample)
      val battery = sample.batteryPercent?.let { "$it%" } ?: "unavailable"
      val temp = sample.batteryTempDeciC
        ?.let { String.format(Locale.US, "%.1f°C", it / 10.0) } ?: "unavailable"
      safetyReading.text = "Battery $battery · temperature $temp · " +
        "thermal level ${sample.thermalStatus} · ${decision.level}: ${decision.message}"
    }

    startLan.setOnClickListener {
      val address = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(address)) {
        status.text = "Enter the PS5's private IPv4 address."
        return@setOnClickListener
      }
      try {
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
}
