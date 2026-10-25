package com.saevond.sweatyobs

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import android.net.Uri
import kotlin.concurrent.thread
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.saevond.sweatyobs.ingest.LanRtmpIngest
import com.saevond.sweatyobs.ingest.MediaRelayGate
import com.saevond.sweatyobs.ingest.ReliableRtmpOutput
import com.saevond.sweatyobs.ingest.OutputSnapshot
import com.saevond.sweatyobs.ingest.RtmpMessage
import com.saevond.sweatyobs.ingest.RtmpDestination
import com.saevond.sweatyobs.ingest.RtmpsPublisher
import java.net.Inet4Address
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tracks an asynchronous receiver startup so a second Start cannot launch a stale decoder callback.
 * Tokens also make callbacks from a cancelled service start harmless.
 */
internal class StartupAttemptGate {
  private var generation = 0L
  private var pending = false

  @Synchronized fun begin(): Long? {
    if (pending) return null
    pending = true
    return ++generation
  }

  @Synchronized fun isPending(): Boolean = pending

  @Synchronized fun isCurrent(token: Long): Boolean = pending && generation == token

  @Synchronized fun finish(token: Long): Boolean {
    if (!isCurrent(token)) return false
    pending = false
    return true
  }

  @Synchronized fun cancel(token: Long? = null): Boolean {
    if (token != null && (generation != token || !pending)) return false
    pending = false
    generation++
    return true
  }
}

/** Keeps the active service mode unchanged when a second start request is rejected. */
internal class AcceptedStartMode(initialPublic: Boolean = false) {
  @Volatile private var publicMode = initialPublic
  val isPublic: Boolean get() = publicMode

  @Synchronized fun tryAccept(
    requestedPublic: Boolean,
    receiverActive: Boolean,
    startupPending: Boolean
  ): Boolean {
    if (receiverActive || startupPending) return false
    publicMode = requestedPublic
    return true
  }
}

/**
 * Android 14-compatible, user-started network-connected foreground service.
 *
 * Authorized LAN diagnostic and opt-in experimental RTMPS multistream with optional licensed music mixing. No recording.
 */
class Ps5LanService : Service() {
  companion object {
    const val ACTION_START = "com.saevond.sweatyobs.START_PS5_INGEST"
    const val ACTION_START_TWITCH = "com.saevond.sweatyobs.START_PUBLIC_TWITCH"
    const val ACTION_DISABLE_TWITCH_CHAT = "com.saevond.sweatyobs.DISABLE_TWITCH_CHAT"
    const val ACTION_RECONNECT_OUTPUTS = "com.saevond.sweatyobs.RECONNECT_OUTPUTS"
    const val ACTION_MUSIC_PLAY = "com.saevond.sweatyobs.MUSIC_PLAY"
    const val ACTION_MUSIC_PAUSE = "com.saevond.sweatyobs.MUSIC_PAUSE"
    const val ACTION_MUSIC_STATION = "com.saevond.sweatyobs.MUSIC_STATION"
    const val ACTION_MUSIC_CONFIG = "com.saevond.sweatyobs.MUSIC_CONFIG"
    const val ACTION_MUSIC_SKIP = "com.saevond.sweatyobs.MUSIC_SKIP"
    const val EXTRA_GENRE = "genre"
    const val ACTION_STOP = "com.saevond.sweatyobs.STOP_PS5_INGEST"
    const val EXTRA_PS5_IPV4 = "ps5_ipv4"
    const val ACTION_STATUS = "com.saevond.sweatyobs.DIAGNOSTIC_STATUS"
    const val EXTRA_STATUS_MESSAGE = "diagnostic_status"
    const val DIAGNOSTICS_PREFS = "encoder_diagnostics"
    const val PREF_REMOTE_DIAGNOSTICS_ENABLED = "remote_enabled"
    private const val CHANNEL = "ps5_lan_ingest"
    private const val NOTIFICATION_ID = 734
    // Shared in-process gain settings are synchronized and visible immediately to audio worker.
    val liveLevels = MixLevels(85, 22)
    @Volatile var twitchChatOverlayActiveOrStarting: Boolean = false
      private set
    @Volatile var receiverRunning: Boolean = false
      private set

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
  private val startupGate = StartupAttemptGate()
  private val acceptedStartMode = AcceptedStartMode()
  private val publicTest: Boolean get() = acceptedStartMode.isPublic
  @Volatile private var outputConnected = false
  private val outputPublishers = CopyOnWriteArrayList<ReliableRtmpOutput>()
  @Volatile private var outputStatus = "No RTMPS outputs configured"
  @Volatile private var reportedOutputStatus = ""
  private val musicStartedOnOutput = AtomicBoolean(false)
  private var liveGate: MediaRelayGate? = null
  @Volatile private var brandOverlay: BrandVideoOverlay? = null
  @Volatile private var brandOverlayRequested = false
  @Volatile private var transcoderActive = false
  @Volatile private var sleipnirRelayRequested = false
  @Volatile private var rotateVideo180 = false
  @Volatile private var selectedEncodingProfile = OverlayEncodingProfile.STABLE_720P
  private var nextMemorySampleAtMs = 0L
  private var lastLowMemoryNoticeAtMs = 0L
  @Volatile private var twitchChatClient: TwitchChatClient? = null
  @Volatile private var twitchChatGeneration = 0
  @Volatile private var sourceVideoConfig: RtmpMessage? = null
  @Volatile private var audioMixer: LiveAacMusicMixer? = null
  private var musicTrack: MusicTrackLooper? = null
  private var musicBridge: MusicBridgePoller? = null
  private var nextDiagnosticReportAtMs = 0L
  private var lastDiagnosticIngestState: String? = null
  private val lastDiagnosticOutputStates = mutableMapOf<String, String>()
  private val lastDiagnosticDroppedPackets = mutableMapOf<String, Long>()
  private var lastDiagnosticSafetyLevel: SafetyLevel? = null
  private var genrePlaylist: GenrePlaylist? = null
  private var musicDecodeGeneration = 0
  private var decodingTrack = false
  private lateinit var phoneSafety: PhoneSafetyMonitor
  private val updateTask = object : Runnable {
    override fun run() {
      if (stopping) return
      val ingest = receiver ?: return
      val safety = phoneSafety.assess()
      val lowSystemMemory = sampleMemoryPressure()
      if (safety.level != lastDiagnosticSafetyLevel) {
        lastDiagnosticSafetyLevel = safety.level
        when (safety.level) {
          SafetyLevel.WARN -> EncoderDiagnostics.record(this@Ps5LanService,
            EncoderDiagnosticEventName.SAFETY_WARNING, EncoderDiagnosticResult.WARNING,
            EncoderDiagnosticTarget.APP, EncoderDiagnosticError.PHONE_SAFETY)
          SafetyLevel.STOP -> EncoderDiagnostics.record(this@Ps5LanService,
            EncoderDiagnosticEventName.SAFETY_STOP, EncoderDiagnosticResult.STOPPED,
            EncoderDiagnosticTarget.APP, EncoderDiagnosticError.PHONE_SAFETY)
          else -> Unit
        }
      }
      if (safety.level == SafetyLevel.STOP) {
        setNotification("Stopped for phone safety: " + safety.message)
        terminalReason = true
        stopSelf()
        return
      }
      if (activeWifiIpv4() != wifiAddress || !ingest.active) {
        EncoderDiagnostics.record(this@Ps5LanService, EncoderDiagnosticEventName.SERVICE_START_FAILED,
          EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.NETWORK,
          if (!ingest.active) EncoderDiagnosticError.SOURCE_LOST else EncoderDiagnosticError.NETWORK_CHANGED)
        setNotification("Receiver stopped: Wi-Fi changed or port unavailable")
        terminalReason = true
        stopSelf()
        return
      }
      if (publicTest) {
        val snapshots = outputPublishers.map { it.snapshot() }
        outputConnected = snapshots.any { it.state == "LIVE" }
        outputStatus = snapshots.joinToString(" | ") { it.summary() }
      }
      val summary = if (publicTest && !ingest.connected && ingest.tcpConnections > 0)
        "Waiting for PS5 source reconnect · ${ingest.videoPackets} video / ${ingest.audioPackets} audio · $outputStatus"
      else if (publicTest && outputConnected)
        "Outputs live · PS5 video ${ingest.videoPackets} / audio ${ingest.audioPackets} · mixed AAC ${audioMixer?.audioOutputPackets ?: 0L} · ${liveLevels.description()} · $outputStatus"
      else if (publicTest && ingest.rtpmPublished)
        "PS5 sending RTMP to phone. Waiting for H.264/AAC keyframe or output reconnect. Video ${ingest.videoPackets} / audio ${ingest.audioPackets} · $outputStatus"
      else if (publicTest && ingest.connected)
        "PS5 TCP connected; waiting for RTMP handshake/publish acknowledgment"
      else if (publicTest)
        "Multistream armed; waiting for actual PS5 RTMP media on ${wifiAddress}:1935 · $outputStatus"
      else if (ingest.rtpmPublished)
        "PS5 RTMP publishing to phone · video ${ingest.videoPackets} · audio ${ingest.audioPackets}. Diagnostic only."
      else if (ingest.connected)
        "PS5 TCP connected · waiting for RTMP publish. Packets: ${ingest.videoPackets} video / ${ingest.audioPackets} audio"
      else if (ingest.lastFailure != null)
        "PS5 session ended (${ingest.lastFailure}); video ${ingest.videoPackets}, audio ${ingest.audioPackets}. Check DNS and broadcast."
      else "Waiting for PS5 on ${wifiAddress}:1935 · connections ${ingest.tcpConnections}, video ${ingest.videoPackets}, audio ${ingest.audioPackets}"
      val display = when {
        safety.level == SafetyLevel.WARN -> "Warning: " + safety.message
        lowSystemMemory && sleipnirRelayRequested && selectedEncodingProfile != OverlayEncodingProfile.LOW_LOAD_540P ->
          "Android reports low system memory. Current Sleipnir encode may be interrupted; stop and restart with Low-load 540p. · $summary"
        else -> summary
      }
      if (display != report) setNotification(display)
      reportStateTransitions(ingest)
      maybeSubmitRemoteDiagnostics(ingest)
      handler.postDelayed(this, 3000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    val saved = getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
    liveLevels.update(saved.getInt("game",85).coerceIn(0,100), saved.getInt("music",22).coerceIn(0,100))
    phoneSafety = PhoneSafetyMonitor(this)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(NotificationChannel(
        CHANNEL, "SweatyClanker PS5 LAN receiver", NotificationManager.IMPORTANCE_LOW))
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISABLE_TWITCH_CHAT) {
      if (twitchChatOverlayActiveOrStarting) {
        stopTwitchChatOverlay()
        brandOverlay?.setLiveChatEnabled(false)
        setNotification("Twitch overlay chat stopped. Stream outputs remain live.")
      } else if (!publicTest && !receiverRunning) {
        // Avoid leaving a short-lived service instance behind after a stop raced with shutdown.
        stopSelf(startId)
      }
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_RECONNECT_OUTPUTS) {
      if (!receiverRunning || !publicTest || outputPublishers.isEmpty()) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MANUAL_RECONNECT_REJECTED,
          EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.MULTIPLE,
          EncoderDiagnosticError.MISSING_CONFIG)
        setNotification("Start an enabled stream first; output reconnect is unavailable.")
      } else {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MANUAL_RECONNECT_REQUESTED,
          EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MULTIPLE)
        outputPublishers.forEach { it.reconnectNow() }
        setNotification("Reconnecting selected stream outputs. Automatic retries remain on; waiting for a clean video keyframe.")
      }
      return START_NOT_STICKY
    }
    if (intent?.action in setOf(ACTION_MUSIC_STATION, ACTION_MUSIC_CONFIG, ACTION_MUSIC_SKIP)) {
      val store = MusicGenreSettings(this)
      if (intent?.action == ACTION_MUSIC_STATION) {
        val genre = intent.getStringExtra(EXTRA_GENRE).orEmpty()
        if (genre !in GenrePlaylist.STATIONS) return START_NOT_STICKY
        store.select(genre)
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_STATION_SELECTED,
          EncoderDiagnosticResult.SELECTED, EncoderDiagnosticTarget.MUSIC)
      }
      if (receiverRunning && publicTest) {
        if (intent?.action != ACTION_MUSIC_SKIP) genrePlaylist = store.playlist()
        playNextLicensedTrack(manual = true)
      }
      if (intent?.action == ACTION_MUSIC_SKIP) EncoderDiagnostics.record(this,
        EncoderDiagnosticEventName.MUSIC_SKIP, EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MUSIC)
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_MUSIC_PLAY || intent?.action == ACTION_MUSIC_PAUSE) {
      if (!receiverRunning) {
        // A music control must never start an unpromoted background service.
        stopSelf()
        return START_NOT_STICKY
      }
      val action = if (intent.action == ACTION_MUSIC_PLAY) "play" else "pause"
      EncoderDiagnostics.record(this,
        if (action == "play") EncoderDiagnosticEventName.MUSIC_PLAY else EncoderDiagnosticEventName.MUSIC_PAUSE,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.MUSIC)
      musicTrack?.command(action)
      setNotification(if (musicTrack?.ready == true) "Licensed music $action requested; await next AAC frame." else "No music track loaded; choose a rights-cleared file first.")
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STOP_REQUESTED,
        EncoderDiagnosticResult.REQUESTED, EncoderDiagnosticTarget.NETWORK)
      stopping = true
      startupGate.cancel()
      stopSelf()
      return START_NOT_STICKY
    }
    if ((intent?.action != ACTION_START && intent?.action != ACTION_START_TWITCH) || stopping) return START_NOT_STICKY
    val requestedPublicTest = intent.action == ACTION_START_TWITCH
    EncoderDiagnostics.record(this,
      if (requestedPublicTest) EncoderDiagnosticEventName.STREAM_START_REQUESTED else EncoderDiagnosticEventName.DIAGNOSTIC_START_REQUESTED,
      EncoderDiagnosticResult.REQUESTED,
      if (requestedPublicTest) EncoderDiagnosticTarget.MULTIPLE else EncoderDiagnosticTarget.NETWORK)
    if (!acceptedStartMode.tryAccept(requestedPublicTest, receiver != null, startupGate.isPending())) {
      EncoderDiagnostics.record(this,
        if (requestedPublicTest) EncoderDiagnosticEventName.STREAM_START_REJECTED else EncoderDiagnosticEventName.DIAGNOSTIC_START_REJECTED,
        EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.NETWORK, EncoderDiagnosticError.ILLEGAL_STATE)
      setNotification("Receiver is already starting or active. Stop it before switching modes.")
      return START_NOT_STICKY
    }
    EncoderDiagnostics.setMode(if (requestedPublicTest) EncoderDiagnosticMode.PUBLIC else EncoderDiagnosticMode.DIAGNOSTIC)
    val ps5Address = intent.getStringExtra(EXTRA_PS5_IPV4)?.trim().orEmpty()
    if (publicTest) {
      val destinations = selectedDestinations()
      val invalid = destinations.firstOrNull { !it.isValid() }
      if (destinations.isEmpty() || invalid != null) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.STREAM_START_REJECTED,
          EncoderDiagnosticResult.REJECTED,
          invalid?.let { diagnosticTarget(it.id) } ?: EncoderDiagnosticTarget.MULTIPLE,
          EncoderDiagnosticError.MISSING_CONFIG)
        val message = if (destinations.isEmpty()) "Select at least one output and save its RTMPS server URL and key."
          else "${invalid!!.label} needs a valid RTMPS server URL and stream key."
        publishUiStatus(message)
        stopSelf()
        return START_NOT_STICKY
      }
      // A previous start can fail before the receiver exists. Close its outputs before
      // dropping references so their destination leases cannot block this new start.
      outputPublishers.toList().forEach { it.close() }
      outputPublishers.clear()
      outputPublishers += destinations.map { destination ->
        ReliableRtmpOutput(destination, onSnapshot = { onOutputSnapshot() }).also { it.start() }
      }
      outputConnected = false
      musicStartedOnOutput.set(false)
      outputStatus = outputPublishers.joinToString(" | ") { it.snapshot().summary() }
      liveGate = MediaRelayGate()
      sourceVideoConfig = null
      val outputPrefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
      brandOverlayRequested = outputPrefs.getBoolean("brand_overlay", true)
      sleipnirRelayRequested = outputPrefs.getBoolean("sleipnir_enabled", false)
      rotateVideo180 = sleipnirRelayRequested && outputPrefs.getBoolean("sleipnir_rotate_180", false)
      selectedEncodingProfile = OverlayEncodingProfile.fromPreference(outputPrefs.getString("overlay_profile", "stable_720"))
      val overlayProfile = if (sleipnirRelayRequested) selectedEncodingProfile.forSleipnir() else selectedEncodingProfile
      transcoderActive = brandOverlayRequested || sleipnirRelayRequested
      brandOverlay?.close()
      brandOverlay = if (transcoderActive) {
        runCatching {
          BrandVideoOverlay(
            onOutput = { message -> outputPublishers.forEach { it.offer(message) } },
            onStatus = { message ->
              if (message.startsWith("@saevond overlay active · ") || message.startsWith("Sleipnir encoder ready · ")) EncoderDiagnostics.record(this,
                EncoderDiagnosticEventName.OVERLAY_READY, EncoderDiagnosticResult.COMPLETED,
                EncoderDiagnosticTarget.OVERLAY)
              handler.post { if (!stopping) setNotification(message) }
            },
            onFailure = { message ->
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.OVERLAY_FALLBACK,
                EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.OVERLAY, EncoderDiagnosticError.MEDIA_CODEC)
              handler.post { if (!stopping) disableBrandOverlay(message) }
            },
            encodingProfile = overlayProfile,
            showBrandOverlay = brandOverlayRequested,
            rotateVideo180 = rotateVideo180)
        }.onFailure { error ->
          brandOverlayRequested = false
          EncoderDiagnostics.record(this, EncoderDiagnosticEventName.OVERLAY_FALLBACK,
            EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.OVERLAY,
            EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
          handler.post { if (!stopping) setNotification("@saevond overlay unavailable (${error.javaClass.simpleName}); using original PS5 video.") }
        }.getOrNull()
      } else null
      if (sleipnirRelayRequested && brandOverlay == null) {
        outputPublishers.forEach { it.close() }
        outputPublishers.clear()
        publishUiStatus("Sleipnir needs a capped H.264 re-encode, but the encoder could not start. Select Low-load 540p or use a direct RTMPS route.")
        stopSelf()
        return START_NOT_STICKY
      }
      startTwitchChatOverlay(outputPrefs)
      musicTrack = MusicTrackLooper()
      genrePlaylist = MusicGenreSettings(this).playlist()
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
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SERVICE_START_FAILED,
        EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.PERMISSIONS,
        EncoderDiagnosticError.SERVICE_START_DENIED)
      publishUiStatus("Android rejected receiver start (" + error.javaClass.simpleName + "). Check Android app permissions.")
      stopSelf()
      return START_NOT_STICKY
    }

    val local = activeWifiIpv4()
    if (!privateIpv4(ps5Address) || local == null || local == ps5Address) {
      EncoderDiagnostics.record(this,
        if (publicTest) EncoderDiagnosticEventName.STREAM_START_REJECTED else EncoderDiagnosticEventName.DIAGNOSTIC_START_REJECTED,
        EncoderDiagnosticResult.REJECTED, EncoderDiagnosticTarget.NETWORK, EncoderDiagnosticError.INVALID_INPUT)
      setNotification("Unavailable: use Wi-Fi and enter the PS5's private IPv4")
      terminalReason = true
      stopSelf()
      return START_NOT_STICKY
    }

    try {
      val safety = phoneSafety.assess()
      if (safety.level == SafetyLevel.STOP) {
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SAFETY_STOP,
          EncoderDiagnosticResult.STOPPED, EncoderDiagnosticTarget.APP, EncoderDiagnosticError.PHONE_SAFETY)
        setNotification("Not started: " + safety.message)
        terminalReason = true
        stopSelf()
        return START_NOT_STICKY
      }
      wifiAddress = local
      val startupToken = startupGate.begin()
      if (startupToken == null) {
        setNotification("Receiver startup is already in progress.")
        return START_NOT_STICKY
      }
      val uriText = if (requestedPublicTest && genrePlaylist?.hasTracks() != true)
        getSharedPreferences("ps5_music", MODE_PRIVATE).getString("track_uri", null) else null
      if (uriText.isNullOrBlank()) {
        beginReceiver(local, ps5Address, startupToken, requestedPublicTest)
      } else {
        setNotification("Loading rights-cleared music file. Receiver is not yet listening.")
        thread(name = "SweatyOBS-music-decode") {
          try {
            val decoded = MusicDecoder(this).decode(Uri.parse(uriText))
            handler.post {
              if (!stopping && startupGate.isCurrent(startupToken)) {
                try {
                  val loop = musicTrack ?: error("Music control unavailable")
                  // Loading only arms autoplay. No music plays during DNS/receiver
                  // diagnostics or while waiting for a PS5 broadcast.
                  val autoStart = getSharedPreferences("ps5_music", MODE_PRIVATE)
                    .getBoolean("autoplay", true)
                  loop.load(decoded, autoStart = autoStart)
                  audioMixer = LiveAacMusicMixer(loop, liveLevels)
                  beginReceiver(local, ps5Address, startupToken, requestedPublicTest)
                } catch (error: Exception) { startFailed(error, startupToken) }
              }
            }
          } catch (error: Exception) {
            handler.post {
              if (!stopping && startupGate.isCurrent(startupToken)) startFailed(error, startupToken)
            }
          }
        }
      }
    } catch (error: Exception) {
      startFailed(error)
    }
    return START_NOT_STICKY
  }

  private fun startFailed(error: Exception, startupToken: Long? = null) {
    if (startupToken != null) {
      if (!startupGate.cancel(startupToken)) return
    } else {
      startupGate.cancel()
    }
    stopping = true
    terminalReason = true
    EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SERVICE_START_FAILED,
      EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.NETWORK,
      EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
    setNotification("Receiver/music startup failed (" + error.javaClass.simpleName + "). Stopped; no broadcast.")
    stopSelf()
  }

  private fun beginReceiver(local: String, ps5Address: String, startupToken: Long, isPublic: Boolean) {
    if (stopping || !startupGate.isCurrent(startupToken)) return
    try {
      if (isPublic && audioMixer == null) {
        // Game volume is independently controllable even with no music selected.
        audioMixer = LiveAacMusicMixer(musicTrack ?: error("Music state missing"), liveLevels)
      }
      musicTrack?.onTrackEnd = {
        handler.post {
          if (!stopping && genrePlaylist?.autoNext == true) playNextLicensedTrack(manual = false)
        }
      }
      val ingest = LanRtmpIngest(local, ps5Address, onMedia = { packet ->
        if (isPublic) {
          var mediaPhase = "audio_mix"
          try {
            val input = if (packet.type == 8 && audioMixer != null) {
              audioMixer!!.onAudio(packet)
            } else listOf(packet)
            input.forEach { item ->
              mediaPhase = "relay_gate"
              val frames = liveGate?.process(item).orEmpty()
              if (liveGate?.consumeOutputReconnectRequest() == true) {
                // A real codec change needs a clean RTMPS session. Each output
                // is reset independently and will resume from the next keyframe.
                outputPublishers.forEach { it.reconnectNow() }
                handler.post {
                  if (!stopping) setNotification(
                    "PS5 codec changed. Refreshing destinations; waiting for the next clean keyframe."
                  )
                }
              }
              if (frames.isNotEmpty()) {
                frames.forEach { media ->
                  when {
                    ReliableRtmpOutput.isAvcConfig(media) -> {
                      sourceVideoConfig = media.copy(data = media.data.copyOf())
                      if (transcoderActive) {
                        mediaPhase = "overlay_config"
                        brandOverlay?.setConfiguration(media)
                      }
                      if (OutputRouteSelector.shouldForwardSourceAvcConfig(transcoderActive)) {
                        mediaPhase = "output_queue"
                        outputPublishers.forEach { it.offer(media) }
                      }
                    }
                    media.type == 9 && transcoderActive && brandOverlay != null -> {
                      mediaPhase = "overlay_frame"
                      brandOverlay?.offer(media)
                    }
                    else -> {
                      mediaPhase = "output_queue"
                      outputPublishers.forEach { it.offer(media) }
                    }
                  }
                }
              }
            }
          } catch (error: Exception) {
            terminalReason = true
            handler.post {
              if (!stopping) {
                submitRemoteFailure(ingest = receiver, phase = mediaPhase, category = safeErrorCategory(error.javaClass.simpleName))
                EncoderDiagnostics.record(this, EncoderDiagnosticEventName.INGEST_STATE_CHANGED,
                  EncoderDiagnosticResult.FAILED, when (mediaPhase) {
                    "audio_mix" -> EncoderDiagnosticTarget.MUSIC
                    "overlay_config", "overlay_frame" -> EncoderDiagnosticTarget.OVERLAY
                    else -> EncoderDiagnosticTarget.NETWORK
                  }, EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
                setNotification("PS5 media processing failed during $mediaPhase (" +
                  error.javaClass.simpleName + "). Stopped. Check the PS5 audio format, then reconnect.")
                stopSelf()
              }
            }
            throw error
          }
        }
      }, onSourceSessionStart = {
        if (isPublic) {
          outputPublishers.forEach { it.resetForSourceSession() }
          liveGate?.resetForSourceReconnect()
          audioMixer?.close()
          audioMixer = LiveAacMusicMixer(musicTrack ?: error("Music state missing"), liveLevels)
        }
      }, onSourceSessionEnd = {
        if (isPublic) {
          outputPublishers.forEach { it.resetForSourceSession() }
          audioMixer?.close()
          audioMixer = null
        }
      })
      receiver = ingest
      ingest.start()
      receiverRunning = true
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SERVICE_STARTED,
        EncoderDiagnosticResult.STARTED, EncoderDiagnosticTarget.NETWORK)
      EncoderDiagnostics.record(this, EncoderDiagnosticEventName.RECEIVER_LISTENING,
        EncoderDiagnosticResult.WAITING, EncoderDiagnosticTarget.NETWORK)
      maybeSubmitRemoteDiagnostics(ingest, force = true)
      if (isPublic && genrePlaylist?.hasTracks() == true) playNextLicensedTrack(manual = true)
      val trackReady = musicTrack?.ready == true
      val selectedPlatforms = outputPublishers.joinToString(" + ") { it.snapshot().label }
      val overlayStatus = when {
        !isPublic -> "diagnostic only; no overlay"
        !transcoderActive -> "original-video pass-through"
        brandOverlay == null && sleipnirRelayRequested -> "Sleipnir capped re-encode unavailable"
        brandOverlay == null -> "overlay unavailable; original-video pass-through"
        !brandOverlayRequested && sleipnirRelayRequested -> "Sleipnir capped re-encode (HUD off)"
        else -> "@saevond overlay starting"
      }
      setNotification(if (isPublic) "Public stream armed · $selectedPlatforms · $overlayStatus · waiting for PS5 RTMP on $local:1935. Music " +
        (if (trackReady) "ready after a platform accepts publish" else "not loaded")
        else "Waiting for PS5 at $local:1935 — diagnostic only")
      if (isPublic) {
        val bridgeToken = SecretStore(this).get("bridge_token")
        if (bridgeToken.length >= 32) {
          musicBridge = MusicBridgePoller("https://twitch-gemini-ai-chatbot-sc-2.onrender.com",
            bridgeToken, statusSink = { message ->
              handler.post { if (!stopping) setNotification(message) }
            }, onConnectionState = { connected, error ->
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_BRIDGE_STATE,
                if (connected) EncoderDiagnosticResult.CONNECTED else EncoderDiagnosticResult.DISCONNECTED,
                EncoderDiagnosticTarget.MUSIC, error)
            }) { action, level, station ->
            // Bot sends authenticated controls only; volume affects music gain,
            // never the game gain and never the Android system speaker volume.
            if (action == "volume" && level != null && level in 0..100) {
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_COMMAND_APPLIED,
                EncoderDiagnosticResult.APPLIED, EncoderDiagnosticTarget.MUSIC)
              liveLevels.update(liveLevels.gamePercent, level)
              getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
                .edit().putInt("music", level).apply()
              handler.post {
                if (!stopping) setNotification("Bot !volume applied: music $level% · game ${liveLevels.gamePercent}%.")
              }
            } else if (action == "station" && station in GenrePlaylist.STATIONS) {
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_COMMAND_APPLIED,
                EncoderDiagnosticResult.APPLIED, EncoderDiagnosticTarget.MUSIC)
              handler.post {
                if (!stopping) {
                  val genre = station!!
                  MusicGenreSettings(this).select(genre)
                  genrePlaylist = MusicGenreSettings(this).playlist()
                  playNextLicensedTrack(manual = true)
                }
              }
            } else if (action == "skip") {
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_COMMAND_APPLIED,
                EncoderDiagnosticResult.APPLIED, EncoderDiagnosticTarget.MUSIC)
              handler.post { if (!stopping) playNextLicensedTrack(manual = true) }
            } else if (action == "play" || action == "pause") {
              EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_COMMAND_APPLIED,
                EncoderDiagnosticResult.APPLIED, EncoderDiagnosticTarget.MUSIC)
              musicTrack?.command(action)
            }
          }.also { it.start() }
        }
      }
      if (!startupGate.finish(startupToken)) {
        ingest.stop()
        receiver = null
        receiverRunning = false
        return
      }
      handler.postDelayed(updateTask, 3000)
    } catch (error: Exception) { startFailed(error, startupToken) }
  }

  /**
   * Load next licensed song asynchronously. Until the replacement is ready, keep
   * the current PCM available so a slow decoder does not stall PS5 game audio.
   */
  private fun playNextLicensedTrack(manual: Boolean) {
    val program = genrePlaylist ?: return
    if (decodingTrack) {
      if (!manual) return
      // Supersede a pending decode on user-initiated station/skip change.
      musicDecodeGeneration++
    }
    val uriText = program.next(manual) ?: run {
      musicTrack?.command("pause")
      setNotification("No licensed tracks in " + program.station + ". Music paused; game audio continues.")
      return
    }
    val generation = ++musicDecodeGeneration
    decodingTrack = true
    thread(name = "SweatyOBS-genre-decode") {
      try {
        val pcm = MusicDecoder(this).decode(Uri.parse(uriText))
        handler.post {
          if (generation == musicDecodeGeneration) {
            decodingTrack = false
            if (!stopping) {
              val loop = musicTrack
              if (loop != null) {
                if (loop.ready) loop.replace(pcm)
                else {
                  val autoplay = getSharedPreferences("ps5_music", MODE_PRIVATE)
                    .getBoolean("autoplay", true)
                  loop.load(pcm, autoStart = autoplay)
                }
                if (outputConnected) loop.onBroadcastStarted()
                val remoteTrack = RemoteMusicCatalog.trackForAudioUrl(uriText)
                val trackName = remoteTrack?.let { it.title + " — " + it.artist } ?: "licensed track"
                setNotification("Loaded " + trackName + ". " + program.summary() +
                  ". Viewer playback is not yet verified.")
              }
            }
          }
        }
      } catch (error: Exception) {
        handler.post {
          if (generation == musicDecodeGeneration) {
            decodingTrack = false
            EncoderDiagnostics.record(this, EncoderDiagnosticEventName.MUSIC_DECODE_FAILED,
              EncoderDiagnosticResult.FAILED, EncoderDiagnosticTarget.MUSIC,
              EncoderDiagnosticError.fromThrowableName(error.javaClass.simpleName))
            if (!stopping) setNotification("Song decode failed (" + error.javaClass.simpleName +
              "). Previous game audio continues.")
          }
        }
      }
    }
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
    .setContentTitle(if (publicTest) "SweatyClanker multistream" else "SweatyClanker PS5 ingest diagnostic")
    .setContentText(message)
    .setOngoing(true)
    .build()

  private fun publishUiStatus(message: String) {
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
    receiverRunning = false
    stopping = true
    startupGate.cancel()
    musicDecodeGeneration++
    decodingTrack = false
    genrePlaylist = null
    handler.removeCallbacks(updateTask)
    receiver?.stop()
    musicBridge?.stop()
    musicBridge = null
    EncoderDiagnostics.record(this, EncoderDiagnosticEventName.SERVICE_STOPPED,
      EncoderDiagnosticResult.STOPPED, EncoderDiagnosticTarget.NETWORK)
    EncoderDiagnostics.setMode(EncoderDiagnosticMode.IDLE)
    audioMixer?.close()
    audioMixer = null
    musicTrack?.clear()
    musicTrack = null
    stopTwitchChatOverlay()
    brandOverlay?.close()
    brandOverlay = null
    outputPublishers.toList().forEach { it.close() }
    outputPublishers.clear()
    liveGate = null
    outputConnected = false
    receiver = null
    twitchChatOverlayActiveOrStarting = false
    if (!terminalReason) publishUiStatus("Receiver stopped. No broadcast was sent.")
    super.onDestroy()
  }

  private fun selectedDestinations(): List<RtmpDestination> {
    val prefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
    val secrets = SecretStore(this)
    val direct = buildList {
      if (prefs.getBoolean("twitch_enabled", false)) {
        add(RtmpDestination("twitch", "Twitch", "rtmps://live.twitch.tv:443/app", secrets.get("rtmps")))
      }
      if (prefs.getBoolean("youtube_enabled", false)) {
        add(RtmpDestination("youtube", "YouTube", prefs.getString("youtube_server", "").orEmpty(), secrets.get("youtube_key")))
      }
      if (prefs.getBoolean("kick_enabled", false)) {
        add(RtmpDestination("kick", "Kick", prefs.getString("kick_server", "").orEmpty(), secrets.get("kick_key")))
      }
    }
    return OutputRouteSelector.select(
      prefs.getBoolean("sleipnir_enabled", false),
      prefs.getString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL).orEmpty(),
      secrets.get("sleipnir_key"),
      direct
    )
  }

  private fun onOutputSnapshot() {
    val current = outputPublishers.map { it.snapshot() }
    reportOutputTransitions(current)
    outputConnected = current.any { it.state == "LIVE" }
    outputStatus = current.joinToString(" | ") { it.summary() }
    if (outputConnected && musicStartedOnOutput.compareAndSet(false, true)) {
      val musicStarted = musicTrack?.onBroadcastStarted() == true
      handler.post {
        if (!stopping) setNotification(if (musicStarted)
          "At least one platform accepted publishing; music started. Viewer playback is unverified. $outputStatus"
        else "At least one platform accepted publishing; music is paused or unset. Viewer playback is unverified. $outputStatus")
      }
    } else {
      if (reportedOutputStatus != outputStatus) {
        reportedOutputStatus = outputStatus
        handler.post { if (!stopping) setNotification(outputStatus) }
      }
    }
  }

  private fun disableBrandOverlay(reason: String) {
    if (sleipnirRelayRequested) {
      stopTwitchChatOverlay()
      brandOverlay?.close()
      brandOverlay = null
      outputPublishers.forEach { it.close() }
      outputPublishers.clear()
      terminalReason = true
      setNotification("$reason · Sleipnir relay stopped because its capped re-encode failed. Select Low-load 540p and restart.")
      stopSelf()
      return
    }
    brandOverlayRequested = false
    transcoderActive = false
    stopTwitchChatOverlay()
    brandOverlay?.close()
    brandOverlay = null
    outputPublishers.forEach { it.reconnectNow() }
    sourceVideoConfig?.let { config -> outputPublishers.forEach { it.offer(config) } }
    setNotification("$reason · reconnecting with original PS5 video")
  }

  /** Chat is a separate read-only channel and is started only for public streams with the overlay enabled. */
  private fun startTwitchChatOverlay(outputPrefs: android.content.SharedPreferences) {
    stopTwitchChatOverlay()
    val overlay = brandOverlay
    val canRunInPublicOverlay = publicTest && brandOverlayRequested && overlay != null
    if (canRunInPublicOverlay) twitchChatOverlayActiveOrStarting = true
    val enabled = canRunInPublicOverlay && outputPrefs.getBoolean("twitch_chat_enabled", false)
    overlay?.setLiveChatEnabled(enabled)
    if (!enabled) twitchChatOverlayActiveOrStarting = false
    if (!enabled || overlay == null) return

    val token = SecretStore(this).get("twitch_chat_token")
    if (token.isBlank()) {
      overlay.setLiveChatStatus("TOKEN REQUIRED")
      return
    }
    val login = outputPrefs.getString("twitch_chat_login", "saevond").orEmpty()
    val channel = outputPrefs.getString("twitch_chat_channel", "saevond").orEmpty()
    val generation = twitchChatGeneration
    val client = runCatching {
      TwitchChatClient(
        loginInput = login,
        channelInput = channel,
        tokenInput = token,
        onState = { state ->
          if (generation == twitchChatGeneration) {
            overlay.setLiveChatStatus(state.overlayLabel)
            handler.post {
              if (!stopping && generation == twitchChatGeneration)
                setNotification("Twitch overlay chat ${state.overlayLabel} · $outputStatus")
            }
          }
        },
        onMessage = { message ->
          if (generation == twitchChatGeneration) overlay.offerLiveChatMessage(message)
        }
      )
    }.getOrElse {
      overlay.setLiveChatStatus("SETTINGS ERROR")
      return
    }
    twitchChatClient = client
    client.start()
  }

  private fun stopTwitchChatOverlay() {
    twitchChatOverlayActiveOrStarting = false
    twitchChatGeneration++
    twitchChatClient?.close()
    twitchChatClient = null
  }

  private fun maybeSubmitRemoteDiagnostics(ingest: LanRtmpIngest, force: Boolean = false) {
    val preferences = getSharedPreferences(DIAGNOSTICS_PREFS, MODE_PRIVATE)
    if (!preferences.getBoolean(PREF_REMOTE_DIAGNOSTICS_ENABLED, true)) {
      EncoderDiagnostics.disable()
      nextDiagnosticReportAtMs = 0L
      return
    }
    val now = SystemClock.elapsedRealtime()
    if (!force && now < nextDiagnosticReportAtMs) return
    nextDiagnosticReportAtMs = now + 30_000L
    EncoderDiagnostics.submitSample(this, createDiagnosticSample(ingest))
  }

  private fun submitRemoteFailure(ingest: LanRtmpIngest?, phase: String, category: String) {
    val current = ingest ?: return
    EncoderDiagnostics.submitSample(this, createDiagnosticSample(current, phase, category))
  }

  private fun createDiagnosticSample(
    ingest: LanRtmpIngest,
    failurePhase: String? = null,
    failureCategory: String? = null,
  ): EncoderDiagnosticSample {
    val connectivity = getSystemService(ConnectivityManager::class.java)
    val activeNetwork = connectivity.activeNetwork
    val capabilities = activeNetwork?.let { connectivity.getNetworkCapabilities(it) }
    val transport = when {
      capabilities == null -> "none"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
      capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
      else -> "other"
    }
    val state = when {
      ingest.lastFailure != null -> "FAILED"
      !ingest.active -> "STOPPED"
      !ingest.connected -> "LISTENING"
      !ingest.rtpmPublished -> "CONNECTED"
      else -> "PUBLISHING"
    }
    val outputs = outputPublishers.map { it.snapshot() }.map { snapshot ->
      EncoderDestinationSample(
        id = snapshot.id,
        state = snapshot.state,
        queueBytes = snapshot.queueBytes,
        queueMs = snapshot.queueMediaMs,
        bytesPerSecond = snapshot.bytesPerSecond,
        reconnects = snapshot.reconnects,
        droppedPackets = snapshot.droppedPackets,
        errorCategory = snapshot.lastError?.let(::safeErrorCategory) ?: "NONE",
      )
    }
    return EncoderDiagnosticSample(
      sessionId = EncoderDiagnostics.sessionId,
      appVersion = BuildConfig.VERSION_NAME,
      mode = if (publicTest) "public" else "diagnostic",
      ingestState = state,
      videoPackets = ingest.videoPackets,
      audioPackets = ingest.audioPackets,
      tcpConnections = ingest.tcpConnections,
      internetValidated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
      transport = transport,
      destinations = outputs,
      failurePhase = failurePhase,
      failureCategory = failureCategory,
    )
  }

  private fun safeErrorCategory(value: String): String = when (value) {
    "IOException", "IllegalStateException", "IllegalArgumentException", "SocketTimeoutException",
    "UnknownHostException", "SocketException", "SSLException", "MediaCodec" -> value
    "CodecException" -> "MediaCodec"
    else -> "OTHER"
  }

  private fun reportStateTransitions(ingest: LanRtmpIngest) {
    val state = when {
      ingest.lastFailure != null -> "FAILED"
      !ingest.active -> "STOPPED"
      !ingest.connected -> "LISTENING"
      !ingest.rtpmPublished -> "CONNECTED"
      else -> "PUBLISHING"
    }
    if (state != lastDiagnosticIngestState) {
      lastDiagnosticIngestState = state
      val (event, result) = when (state) {
        "CONNECTED" -> EncoderDiagnosticEventName.SOURCE_CONNECTED to EncoderDiagnosticResult.CONNECTED
        "PUBLISHING" -> EncoderDiagnosticEventName.SOURCE_PUBLISHING to EncoderDiagnosticResult.PUBLISHING
        "FAILED" -> EncoderDiagnosticEventName.INGEST_STATE_CHANGED to EncoderDiagnosticResult.FAILED
        "STOPPED" -> EncoderDiagnosticEventName.INGEST_STATE_CHANGED to EncoderDiagnosticResult.STOPPED
        else -> EncoderDiagnosticEventName.INGEST_STATE_CHANGED to EncoderDiagnosticResult.WAITING
      }
      EncoderDiagnostics.record(this, event, result, EncoderDiagnosticTarget.NETWORK,
        if (state == "FAILED") EncoderDiagnosticError.SOURCE_LOST else EncoderDiagnosticError.NONE)
    }
    reportOutputTransitions(outputPublishers.map { it.snapshot() })
  }

  @Synchronized
  private fun reportOutputTransitions(snapshots: List<OutputSnapshot>) {
    snapshots.forEach { snapshot ->
      val oldState = lastDiagnosticOutputStates.put(snapshot.id, snapshot.state)
      if (oldState != snapshot.state) {
        val result = when (snapshot.state) {
          "LIVE" -> EncoderDiagnosticResult.LIVE
          "RETRYING" -> EncoderDiagnosticResult.RETRYING
          "CONNECTING" -> EncoderDiagnosticResult.CONNECTING
          "WAITING FOR KEYFRAME" -> EncoderDiagnosticResult.WAITING
          "STOPPED" -> EncoderDiagnosticResult.STOPPED
          else -> EncoderDiagnosticResult.NONE
        }
        EncoderDiagnostics.record(this, EncoderDiagnosticEventName.OUTPUT_STATE_CHANGED,
          result, diagnosticTarget(snapshot.id), snapshot.lastError?.let {
            EncoderDiagnosticError.fromThrowableName(it)
          } ?: EncoderDiagnosticError.NONE)
        if (snapshot.state == "RETRYING") EncoderDiagnostics.record(this,
          EncoderDiagnosticEventName.OUTPUT_RETRY, EncoderDiagnosticResult.RETRYING,
          diagnosticTarget(snapshot.id), snapshot.lastError?.let {
            EncoderDiagnosticError.fromThrowableName(it)
          } ?: EncoderDiagnosticError.NONE)
        if (snapshot.state == "WAITING FOR KEYFRAME") EncoderDiagnostics.record(this,
          EncoderDiagnosticEventName.KEYFRAME_WAIT, EncoderDiagnosticResult.WAITING, diagnosticTarget(snapshot.id))
      }
      val oldDrops = lastDiagnosticDroppedPackets.put(snapshot.id, snapshot.droppedPackets) ?: 0L
      if (snapshot.droppedPackets > oldDrops) EncoderDiagnostics.record(this,
        EncoderDiagnosticEventName.STALE_PACKETS_DROPPED, EncoderDiagnosticResult.DROPPED,
        diagnosticTarget(snapshot.id))
    }
  }

  private fun diagnosticTarget(id: String): EncoderDiagnosticTarget = when (id.lowercase()) {
    "twitch" -> EncoderDiagnosticTarget.TWITCH
    "youtube" -> EncoderDiagnosticTarget.YOUTUBE
    "kick" -> EncoderDiagnosticTarget.KICK
    "sleipnir" -> EncoderDiagnosticTarget.MULTIPLE
    else -> EncoderDiagnosticTarget.MULTIPLE
  }

  private fun sampleMemoryPressure(): Boolean {
    if (!publicTest) return false
    val now = SystemClock.elapsedRealtime()
    val manager = getSystemService(ActivityManager::class.java) ?: return false
    val memory = ActivityManager.MemoryInfo()
    manager.getMemoryInfo(memory)
    if (now >= nextMemorySampleAtMs) {
      nextMemorySampleAtMs = now + 10_000L
      val pssMb = Debug.getPss() / 1_024L
      val availableMb = memory.availMem / (1_024L * 1_024L)
      val thresholdMb = memory.threshold / (1_024L * 1_024L)
      val encoder = brandOverlay?.diagnosticsSummary() ?: "encoder=inactive"
      Log.i("SweatyOBS-Memory", "lowMemory=${memory.lowMemory} available=${availableMb}MB threshold=${thresholdMb}MB appPss=${pssMb}MB relay=$sleipnirRelayRequested $encoder")
    }
    if (memory.lowMemory && sleipnirRelayRequested && selectedEncodingProfile != OverlayEncodingProfile.LOW_LOAD_540P &&
      now - lastLowMemoryNoticeAtMs >= 30_000L) {
      lastLowMemoryNoticeAtMs = now
      Log.w("SweatyOBS-Memory", "System reports low memory during the Sleipnir stream; suggest restarting at the 540p low-load profile.")
    }
    return memory.lowMemory
  }
}
