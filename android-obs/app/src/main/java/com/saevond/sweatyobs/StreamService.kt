package com.saevond.sweatyobs

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.pedro.common.ConnectChecker
import android.net.Uri
import kotlin.concurrent.thread
import com.pedro.encoder.input.gl.render.filters.BlackFilterRender
import com.pedro.encoder.input.gl.render.filters.NoFilterRender
import com.pedro.encoder.input.sources.video.NoVideoSource
import com.pedro.encoder.input.sources.video.ScreenSource
import com.pedro.library.generic.GenericStream

/**
 * Experimental Android RTMPS output. The foreground service can remain active while
 * the user opens Twitch chat. Chat Safe Mode replaces screen video with black frames
 * and silences captured device audio; music is retained. Gameplay does NOT continue
 * in the background without an independent authorized video source.
 */
class StreamService : Service(), ConnectChecker {
  private var stream: GenericStream? = null
  private var projection: MediaProjection? = null
  private var audioMixer: StreamAudioMixer? = null
  private var started = false
  private val channel = "stream_capture"
  private var manualChatSafe = false
  private var selectedAppHidden = false

  private fun applyPrivacyMode() {
    val hidden = manualChatSafe || selectedAppHidden
    stream?.getGlInterface()?.setFilter(if (hidden) BlackFilterRender() else NoFilterRender())
    audioMixer?.setCaptureMuted(hidden)
    val label = if (hidden) "Chat mode: video hidden; licensed music can continue" else "Screen capture active"
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(733,
      Notification.Builder(this, channel)
        .setSmallIcon(android.R.drawable.ic_media_play)
        .setContentTitle("SweatyClanker OBS")
        .setContentText(label)
        .setOngoing(true).build())
  }

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() {
    super.onCreate()
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(NotificationChannel(channel, "SweatyClanker capture", NotificationManager.IMPORTANCE_LOW))
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == "STOP") { stopSelf(); return START_NOT_STICKY }
    if (intent?.action == "CHAT_SAFE") {
      if (started) { manualChatSafe = true; applyPrivacyMode() }
      return START_NOT_STICKY
    }
    if (intent?.action != "START" || started) return START_NOT_STICKY
    val notification = Notification.Builder(this, channel)
      .setSmallIcon(android.R.drawable.ic_media_play).setContentTitle("SweatyClanker screen capture")
      .setContentText("Streaming screen with permission").build()
    // Foreground notification must be active before MediaProjection acquisition.
    startForeground(733, notification)
    try {
      val data = if (Build.VERSION.SDK_INT >= 33)
        intent.getParcelableExtra("projectionData", Intent::class.java)
      else @Suppress("DEPRECATION") intent.getParcelableExtra("projectionData")
      val target = intent.getStringExtra("target").orEmpty()
      require(data != null && target.startsWith("rtmps://"))
      val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      val mp = manager.getMediaProjection(intent.getIntExtra("resultCode", 0), data)
        ?: throw IllegalStateException("Screen capture permission unavailable")
      projection = mp
      mp.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() { stopSelf() }
        override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
          // On Android 14+, single-app projection can be hidden when Twitch chat covers it.
          selectedAppHidden = !isVisible
          if (started) applyPrivacyMode()
        }
      }, android.os.Handler(mainLooper))
      // Do not activate a microphone without an explicit user choice.
      val mixer = StreamAudioMixer(mp)
      audioMixer = mixer
      val stream = GenericStream(this, this, NoVideoSource(), mixer.source)
      this.stream = stream
      stream.getGlInterface().setForceRender(true, 30)
      check(stream.prepareVideo(1280, 720, 3500000, 30, 2, 0) &&
        stream.prepareAudio(48000, true, 160000)) { "Codec initialization failed" }
      stream.changeVideoSource(ScreenSource(this, mp))
      started = true
      stream.startStream(target)
      mixer.start()
      applyPrivacyMode()
      val musicUri = intent.getStringExtra("musicUri").orEmpty()
      if (musicUri.isNotBlank()) thread(name = "SweatyOBS-track") {
        runCatching { MusicDecoder(this).decode(Uri.parse(musicUri)) }
          .onSuccess { mixer.replaceTrack(it) }
          .onFailure { Log.w("SweatyClankerOBS", "Local audio file could not be decoded", it) }
      }
      val botOrigin = intent.getStringExtra("botOrigin").orEmpty()
      val botToken = SecretStore(this).get("bridge_token")
      if (botOrigin.startsWith("https://") && botToken.length >= 32) {
        MusicBridgePoller(botOrigin, botToken, mixer).start()
      }
    } catch (e: Exception) {
      Log.e("SweatyClankerOBS", "Stream unavailable; source audio permission or codec may have failed", e)
      stopSelf()
    }
    return START_NOT_STICKY
  }
  override fun onDestroy() {
    MusicBridgePoller.stopActive()
    runCatching { audioMixer?.stop() }
    runCatching { stream?.release() }
    runCatching { projection?.stop() }
    stream = null; projection = null; audioMixer = null; started = false
    super.onDestroy()
  }
  override fun onConnectionStarted(url: String) { Log.i("SweatyClankerOBS", "Connecting to RTMPS") }
  override fun onConnectionSuccess() { Log.i("SweatyClankerOBS", "RTMPS connected; viewer audio not verified") }
  override fun onNewBitrate(bitrate: Long) {}
  override fun onConnectionFailed(reason: String) { Log.w("SweatyClankerOBS", "RTMPS failure: $reason"); stopSelf() }
  override fun onDisconnect() {}
  override fun onAuthError() { stopSelf() }
  override fun onAuthSuccess() {}
}
