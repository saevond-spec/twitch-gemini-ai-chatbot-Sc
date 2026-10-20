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
    status = TextView(this).apply { text = "Dev prototype: consent to screen capture. PS Remote Play may block capture." }
    val endpoint = EditText(this).apply { hint = "RTMPS Twitch ingest URL (private)"; inputType = 129 }
    val botOrigin = EditText(this).apply { hint = "Bot HTTPS URL"; inputType = 17 }
    val bridgeToken = EditText(this).apply { hint = "Bridge secret"; inputType = 129 }
    val chooseMusic = Button(this).apply { text = "Select licensed track" }
    val start = Button(this).apply { text = "Request screen capture and start" }
    val stop = Button(this).apply { text = "Stop stream" }
    layout.addView(status); layout.addView(endpoint); layout.addView(botOrigin)
    layout.addView(bridgeToken); layout.addView(chooseMusic); layout.addView(start); layout.addView(stop)
    chooseMusic.setOnClickListener {
      startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE); type = "audio/*"
      }, musicRequestCode)
    }
    setContentView(layout)
    start.setOnClickListener {
      val target = endpoint.text.toString()
      if (!target.startsWith("rtmps://")) { status.text = "Enter an RTMPS URL."; return@setOnClickListener }
      SecretStore(this).put("rtmps", target)
      SecretStore(this).put("bridge_token", bridgeToken.text.toString())
      getPreferences(MODE_PRIVATE).edit().putString("botOrigin", botOrigin.text.toString().trim()).apply()
      val projection = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      startActivityForResult(projection.createScreenCaptureIntent(), requestCode)
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
