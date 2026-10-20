package com.saevond.sweatyobs

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.net.Uri
import kotlin.concurrent.thread
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.saevond.sweatyobs.ingest.LanRtmpIngest
import com.saevond.sweatyobs.ingest.MediaRelayGate
import com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher
import java.net.Inet4Address

/**
 * Android 14-compatible, user-started network-connected foreground service.
 *
 * Authorized LAN diagnostic and opt-in experimental Twitch relay with optional licensed music mixing. No recording.
 */
class Ps5LanService : Service() {
  companion object {
    const val ACTION_START = "com.saevond.sweatyobs.START_PS5_INGEST"
    const val ACTION_START_TWITCH = "com.saevond.sweatyobs.START_PUBLIC_TWITCH"
    const val ACTION_MUSIC_PLAY = "com.saevond.sweatyobs.MUSIC_PLAY"
    const val ACTION_MUSIC_PAUSE = "com.saevond.sweatyobs.MUSIC_PAUSE"
    const val ACTION_STOP = "com.saevond.sweatyobs.STOP_PS5_INGEST"
    const val EXTRA_PS5_IPV4 = "ps5_ipv4"
    const val ACTION_STATUS = "com.saevond.sweatyobs.DIAGNOSTIC_STATUS"
    const val EXTRA_STATUS_MESSAGE = "diagnostic_status"
    const val STATUS_PREFS = "diagnostic_status_v1"
    const val PREF_STATUS_MESSAGE = "latest_message"
    private const val CHANNEL = "ps5_lan_ingest"
    private const val NOTIFICATION_ID = 734
    // Shared in-process gain settings are synchronized and visible immediately to audio worker.
    val liveLevels = MixLevels(85, 20)

    /** Accept only literal private IPv4, never DNS names or external addresses. */
    fun privateIpv4(value: String): Boolean {
      val parts = value.split(".")
      if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 || it.any { c -> !c.isDigit() } }) return false
      val n = parts.map { it.toIntOrNull() ?: return false }
      if (n.any { it !in 0..255 }) return false
      return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) ||
        (n[0] == 192 && n[1] == 168)
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var receiver: LanRtmpIngest? = null
  private var wifiAddress: String? = null
  private var report: String? = null
  private var stopping = false
  private var terminalReason = false
  @Volatile private var publicTest = false
  @Volatile private var outputConnected = false
  private var twitchOutput: TwitchRtmpsPublisher? = null
  private var liveGate: MediaRelayGate? = null
  private var audioMixer: LiveAacMusicMixer? = null
  private var musicTrack: MusicTrackLooper? = null
  private var musicBridge: MusicBridgePoller? = null
  private lateinit var phoneSafety: PhoneSafetyMonitor
  private val updateTask = object : Runnable {
    override fun run() {
      if (stopping) return
      val ingest = receiver ?: return
      val safety = phoneSafety.assess()
      if (safety.level == SafetyLevel.STOP) {
        setNotification("Stopped for phone safety: " + safety.message)
        terminalReason = true
        stopSelf()
        return
      }
      if (activeWifiIpv4() != wifiAddress || !ingest.active || (outputConnected && !ingest.connected)) {
        setNotification("Receiver stopped: Wi-Fi changed or port unavailable")
        terminalReason = true
        stopSelf()
        return
      }
      val summary = if (publicTest && outputConnected)
        "Twitch publishing. Video ${ingest.videoPackets} / audio ${ingest.audioPackets} · mixed AAC ${audioMixer?.audioOutputPackets ?: 0L} · ${liveLevels.description()}"
      else if (publicTest && ingest.rtpmPublished)
        "PS5 sending RTMP to phone. Waiting for H.264/AAC keyframe or Twitch publish. Video ${ingest.videoPackets} / audio ${ingest.audioPackets}"
      else if (publicTest && ingest.connected)
        "PS5 TCP connected; waiting for RTMP handshake/publish acknowledgment"
      else if (publicTest)
        "Public Twitch test armed; waiting for actual PS5 RTMP media on ${wifiAddress}:1935"
      else if (ingest.rtpmPublished)
        "PS5 RTMP publishing to phone · video ${ingest.videoPackets} · audio ${ingest.audioPackets}. Diagnostic only."
      else if (ingest.connected)
        "PS5 TCP connected · waiting for RTMP publish. Packets: ${ingest.videoPackets} video / ${ingest.audioPackets} audio"
      else if (ingest.lastFailure != null)
        "PS5 session ended (${ingest.lastFailure}); video ${ingest.videoPackets}, audio ${ingest.audioPackets}. Check DNS and broadcast."
      else "Waiting for PS5 on ${wifiAddress}:1935 · connections ${ingest.tcpConnections}, video ${ingest.videoPackets}, audio ${ingest.audioPackets}"
      val display = if (safety.level == SafetyLevel.WARN) "Warning: " + safety.message else summary
      if (display != report) setNotification(display)
      handler.postDelayed(this, 3000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    val saved = getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
    liveLevels.update(saved.getInt("game",85).coerceIn(0,100), saved.getInt("music",20).coerceIn(0,100))
    phoneSafety = PhoneSafetyMonitor(this)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(NotificationChannel(
        CHANNEL, "SweatyClanker PS5 LAN receiver", NotificationManager.IMPORTANCE_LOW))
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_MUSIC_PLAY || intent?.action == ACTION_MUSIC_PAUSE) {
      val action = if (intent.action == ACTION_MUSIC_PLAY) "play" else "pause"
      musicTrack?.command(action)
      setNotification(if (musicTrack?.ready == true) "Licensed music $action requested; await next AAC frame." else "No music track loaded; choose a rights-cleared file first.")
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    if ((intent?.action != ACTION_START && intent?.action != ACTION_START_TWITCH) || stopping) return START_NOT_STICKY
    if (receiver != null) {
      setNotification("Receiver already active. Stop current test before switching diagnostic/public mode.")
      return START_NOT_STICKY
    }
    val ps5Address = intent.getStringExtra(EXTRA_PS5_IPV4)?.trim().orEmpty()
    publicTest = intent?.action == ACTION_START_TWITCH
    if (publicTest) {
      val saved = SecretStore(this).get("rtmps")
      if (!TwitchRtmpsPublisher.keyValid(saved)) {
        publishUiStatus("No valid Twitch key saved. Open app and save it on your phone.")
        stopSelf()
        return START_NOT_STICKY
      }
      twitchOutput = TwitchRtmpsPublisher(saved)
      liveGate = MediaRelayGate()
      musicTrack = MusicTrackLooper()
    }

    // Promote promptly after a user explicitly starts this diagnostic service.
    val notification = notification("Checking private Wi-Fi connection…")
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: RuntimeException) {
      terminalReason = true
      publishUiStatus("Android rejected receiver start (" + error.javaClass.simpleName + "). Check Android app permissions.")
      stopSelf()
      return START_NOT_STICKY
    }

    val local = activeWifiIpv4()
    if (!privateIpv4(ps5Address) || local == null || local == ps5Address) {
      setNotification("Unavailable: use Wi-Fi and enter the PS5's private IPv4")
      terminalReason = true
      stopSelf()
      return START_NOT_STICKY
    }

    try {
      val safety = phoneSafety.assess()
      if (safety.level == SafetyLevel.STOP) {
        setNotification("Not started: " + safety.message)
        terminalReason = true
        stopSelf()
        return START_NOT_STICKY
      }
      wifiAddress = local
      val uriText = if (publicTest) getSharedPreferences("ps5_music", MODE_PRIVATE).getString("track_uri", null) else null
      if (uriText.isNullOrBlank()) {
        beginReceiver(local, ps5Address)
      } else {
        setNotification("Loading rights-cleared music file. Receiver is not yet listening.")
        thread(name = "SweatyOBS-music-decode") {
          try {
            val decoded = MusicDecoder(this).decode(Uri.parse(uriText))
            handler.post {
              if (!stopping) {
                try {
                  val loop = musicTrack ?: error("Music control unavailable")
                  loop.load(decoded)
                  loop.command("play")
                  audioMixer = LiveAacMusicMixer(loop, liveLevels)
                  beginReceiver(local, ps5Address)
                } catch (error: Exception) { startFailed(error) }
              }
            }
          } catch (error: Exception) {
            handler.post { if (!stopping) startFailed(error) }
          }
        }
      }
    } catch (error: Exception) {
      Log.w("SweatyOBS-PS5", "LAN receiver unavailable: ${error.javaClass.simpleName}")
      startFailed(error)
    }
    return START_NOT_STICKY
  }

  private fun startFailed(error: Exception) {
    terminalReason = true
    setNotification("Receiver/music startup failed (" + error.javaClass.simpleName + "). Stopped; no broadcast.")
    stopSelf()
  }

  private fun beginReceiver(local: String, ps5Address: String) {
    try {
      if (publicTest && audioMixer == null) {
        // Game volume is independently controllable even with no music selected.
        audioMixer = LiveAacMusicMixer(musicTrack ?: error("Music state missing"), liveLevels)
      }
      // Diagnostic mode discards packets; only explicit Twitch test sends media.
      val ingest = LanRtmpIngest(local, ps5Address) { packet ->
        if (publicTest) {
          try {
            val input = if (packet.type == 8 && audioMixer != null) {
              audioMixer!!.onAudio(packet)
            } else listOf(packet)
            input.forEach { item ->
              val frames = liveGate?.process(item).orEmpty()
              if (frames.isNotEmpty()) {
                val output = twitchOutput ?: error("Twitch publisher missing")
                if (!outputConnected) {
                  output.connect()
                  outputConnected = true
                  handler.post { setNotification("Twitch server acknowledged publish; verify actual viewer playback.") }
                }
                frames.forEach { output.publish(it) }
              }
            }
          } catch (error: Exception) {
            Log.w("SweatyOBS-PS5", "Media relay stopped: " + error.javaClass.simpleName)
            terminalReason = true
            handler.post {
              if (!stopping) {
                setNotification("Twitch/music relay failed (" + error.javaClass.simpleName + "). Stopped.")
                stopSelf()
              }
            }
            throw error
          }
        }
      }
      receiver = ingest
      ingest.start()
      val trackReady = musicTrack?.ready == true
      setNotification(if (publicTest) "Public Twitch test armed. Awaiting PS5 RTMP on $local:1935. Music " +
        (if (trackReady) "loaded and set to play" else "not loaded")
        else "Waiting for PS5 at $local:1935 — diagnostic only")
      if (publicTest && trackReady) {
        val bridgeToken = SecretStore(this).get("bridge_token")
        if (bridgeToken.length >= 32) {
          musicBridge = MusicBridgePoller("https://twitch-gemini-ai-chatbot-sc-2.onrender.com", bridgeToken) { action ->
            // The bot controls the audio mixer, not a separate web page.
            val selected = if (action == "station") "skip" else action
            if (selected in setOf("play", "pause", "skip")) musicTrack?.command(selected)
          }.also { it.start() }
        }
      }
      handler.postDelayed(updateTask, 3000)
    } catch (error: Exception) { startFailed(error) }
  }

  private fun activeWifiIpv4(): String? {
    val manager = getSystemService(ConnectivityManager::class.java)
    val network = manager.activeNetwork ?: return null
    val capabilities = manager.getNetworkCapabilities(network) ?: return null
    if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null
    return manager.getLinkProperties(network)?.linkAddresses
      ?.firstOrNull { it.address is Inet4Address && it.address.isSiteLocalAddress }
      ?.address?.hostAddress
  }

  private fun notification(message: String) = Notification.Builder(this, CHANNEL)
    .setSmallIcon(android.R.drawable.stat_sys_upload)
    .setContentTitle("SweatyClanker PS5 ingest test")
    .setContentText(message)
    .setOngoing(true)
    .build()

  private fun publishUiStatus(message: String) {
    getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit().putString(PREF_STATUS_MESSAGE, message).apply()
    sendBroadcast(Intent(ACTION_STATUS).apply {
      setPackage(packageName)
      putExtra(EXTRA_STATUS_MESSAGE, message)
    })
  }

  private fun setNotification(message: String) {
    publishUiStatus(message)
    report = message
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .notify(NOTIFICATION_ID, notification(message))
  }

  override fun onDestroy() {
    stopping = true
    handler.removeCallbacks(updateTask)
    receiver?.stop()
    musicBridge?.stop()
    musicBridge = null
    audioMixer?.close()
    audioMixer = null
    musicTrack?.clear()
    musicTrack = null
    twitchOutput?.close()
    twitchOutput = null
    liveGate = null
    outputConnected = false
    receiver = null
    if (!terminalReason) publishUiStatus("Receiver stopped. No broadcast was sent.")
    super.onDestroy()
  }
}
