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
  private lateinit var status: TextView
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 20, 24, 20) }
    status = TextView(this).apply { text = "Dev prototype: consent to screen capture. PS Remote Play may block capture." }
    val endpoint = EditText(this).apply { hint = "RTMPS Twitch ingest URL (private)"; inputType = 129 }
    val start = Button(this).apply { text = "Request screen capture and start" }
    val stop = Button(this).apply { text = "Stop stream" }
    layout.addView(status); layout.addView(endpoint); layout.addView(start); layout.addView(stop)
    setContentView(layout)
    start.setOnClickListener {
      val target = endpoint.text.toString()
      if (!target.startsWith("rtmps://")) { status.text = "Enter an RTMPS URL."; return@setOnClickListener }
      getPreferences(MODE_PRIVATE).edit().putString("target", target).apply()
      val projection = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      startActivityForResult(projection.createScreenCaptureIntent(), requestCode)
    }
    stop.setOnClickListener { startService(Intent(this, StreamService::class.java).setAction("STOP")); status.text = "Stop requested" }
  }
  @Deprecated("Android activity result callback; migrate to Activity Result API after device tests")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != this.requestCode || resultCode != RESULT_OK || data == null) return
    val target = getPreferences(MODE_PRIVATE).getString("target", "") ?: ""
    val intent = Intent(this, StreamService::class.java).apply {
      action = "START"; putExtra("resultCode", resultCode); putExtra("projectionData", data); putExtra("target", target)
    }
    startForegroundService(intent)
    status.text = "Capture permission granted; validating stream in background"
  }
}
