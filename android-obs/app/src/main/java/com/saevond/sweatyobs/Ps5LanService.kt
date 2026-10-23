package com.saevond.sweatyobs

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
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
import android.os.PowerManager
import android.util.Log
import com.saevond.sweatyobs.ingest.LanRtmpIngest
import com.saevond.sweatyobs.ingest.MediaRelayGate
import com.saevond.sweatyobs.ingest.ReliableRtmpOutput
import com.saevond.sweatyobs.ingest.RtmpMessage
import com.saevond.sweatyobs.ingest.RtmpDestination
import com.saevond.sweatyobs.ingest.RtmpsPublisher
import java.net.Inet4Address
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android 14-compatible, user-started network-connected foreground service.
 *
 * Authorized LAN diagnostic and opt-in experimental RTMPS multistream with optional licensed music mixing. No recording.
 */
class Ps5LanService : Service() {
  companion object {
    const val ACTION_START = "com.saevond.sweatyobs.START_PS5_INGEST"
    const val ACTION_START_TWITCH = "com.saevond.sweatyobs.START_PUBLIC_TWITCH"
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
    const val STATUS_PREFS = "diagnostic_status_v1"
    const val PREF_STATUS_MESSAGE = "latest_message"
    const val PREF_SESSION_ACTIVE = "session_active"
    const val PREF_SESSION_PUBLIC = "session_public"
    const val PREF_SESSION_PHASE = "session_phase"
    const val SESSION_PHASE_STARTING = "STARTING"
    const val SESSION_PHASE_ARMED = "ARMED"
    const val SESSION_PHASE_PUBLISH_ACCEPTED = "PUBLISH_ACCEPTED"
    private const val WIFI_CHANGE_GRACE_MS = 15_000L
    private const val CHANNEL = "ps5_lan_ingest"
    private const val NOTIFICATION_ID = 734
    // Shared in-process gain settings are synchronized and visible immediately to audio worker.
    val liveLevels = MixLevels(85, 22)
    @Volatile var receiverRunning: Boolean = false
      private set
    @Volatile var sessionForegroundActive: Boolean = false
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
  private var startupInProgress = false
  private var streamWakeLock: PowerManager.WakeLock? = null
  private var pendingWifiMismatchSinceMs: Long? = null
  private var terminalReason = false
  @Volatile private var publicTest = false
  @Volatile private var outputConnected = false
  private val outputPublishers = CopyOnWriteArrayList<ReliableRtmpOutput>()
  @Volatile private var outputStatus = "No RTMPS outputs configured"
  @Volatile private var reportedOutputStatus = ""
  private val musicStartedOnOutput = AtomicBoolean(false)
  private var liveGate: MediaRelayGate? = null
  @Volatile private var brandOverlay: BrandVideoOverlay? = null
  @Volatile private var brandOverlayRequested = false
  @Volatile private var sleipnirRelayRequested = false
  @Volatile private var sourceVideoConfig: RtmpMessage? = null
  @Volatile private var audioMixer: LiveAacMusicMixer? = null
  private var musicTrack: MusicTrackLooper? = null
  private var musicBridge: MusicBridgePoller? = null
  private var genrePlaylist: GenrePlaylist? = null
  private var musicDecodeGeneration = 0
  private var decodingTrack = false
  private lateinit var phoneSafety: PhoneSafetyMonitor
  private val updateTask = object : Runnable {
    override fun run() {
      if (stopping) return
      val ingest = receiver ?: return
      val safety = phoneSafety.assess()
      if (safety.level == SafetyLevel.STOP) {
        stopWithTerminalStatus("Stopped for phone safety: " + safety.message)
        return
      }
      val currentWifi = activeWifiIpv4()
      if (currentWifi != wifiAddress) {
        val now = android.os.SystemClock.elapsedRealtime()
        val since = pendingWifiMismatchSinceMs ?: now.also { pendingWifiMismatchSinceMs = it }
        val elapsed = now - since
        if (elapsed >= WIFI_CHANGE_GRACE_MS) {
          val newAddress = currentWifi ?: "unavailable"
          stopWithTerminalStatus("Stopped: phone Wi-Fi address changed ($wifiAddress → $newAddress). Update the PS5 RTMP target and restart.")
        } else {
          if (elapsed == 0L) {
            setNotification("Wi-Fi changed or is settling. Holding the stream for up to 15 seconds; if the phone gets a new address, update the PS5 RTMP target.")
          }
          handler.postDelayed(this, minOf(3000L, WIFI_CHANGE_GRACE_MS - elapsed))
        }
        return
      }
      pendingWifiMismatchSinceMs = null
      if (!ingest.active) {
        stopWithTerminalStatus("Stopped: PS5 receiver socket is unavailable on $wifiAddress:1935. Check Wi-Fi and restart the test.")
        return
      }
      if (publicTest) {
        val snapshots = outputPublishers.map { it.snapshot() }
        outputConnected = snapshots.any { it.state == "LIVE" }
        outputStatus = withRouteStatus(snapshots.joinToString(" | ") { it.summary() })
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
      val display = if (safety.level == SafetyLevel.WARN) "Warning: " + safety.message else summary
      if (display != report) setNotification(display)
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
    if (intent?.action == ACTION_RECONNECT_OUTPUTS) {
      if (!sessionForegroundActive) {
        publishUiStatus("Live session is no longer active. It was not auto-restarted; open the app to start a new session.")
        stopSelf()
      } else if (!receiverRunning || !publicTest || outputPublishers.isEmpty()) {
        setNotification("Output reconnect is unavailable until the PS5 receiver and stream are active.")
      } else {
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
      }
      if (receiverRunning && publicTest) {
        if (intent?.action != ACTION_MUSIC_SKIP) genrePlaylist = store.playlist()
        playNextLicensedTrack(manual = true)
      }
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_MUSIC_PLAY || intent?.action == ACTION_MUSIC_PAUSE) {
      if (!receiverRunning) {
        // A music control must never start an unpromoted background service.
        stopSelf()
        return START_NOT_STICKY
      }
      val action = if (intent.action == ACTION_MUSIC_PLAY) "play" else "pause"
      musicTrack?.command(action)
      setNotification(if (musicTrack?.ready == true) "Licensed music $action requested; await next AAC frame." else "No music track loaded; choose a rights-cleared file first.")
      return START_NOT_STICKY
    }
    if (intent?.action == ACTION_STOP) {
      if (sessionForegroundActive) setNotification("Stop requested from notification or app controls.")
      stopSelf()
      return START_NOT_STICKY
    }
    if ((intent?.action != ACTION_START && intent?.action != ACTION_START_TWITCH) || stopping) return START_NOT_STICKY
    if (receiver != null || sessionForegroundActive || startupInProgress) {
      setNotification("Receiver already active or starting. Stop the current session before switching diagnostic/public mode.")
      return START_NOT_STICKY
    }
    startupInProgress = true
    publicTest = intent?.action == ACTION_START_TWITCH

    // Enter foreground immediately after the explicit user start, before codec or
    // network setup can consume Android's foreground-start deadline.
    try {
      val startingText = if (publicTest) "Starting live stream…" else "Checking private Wi-Fi connection…"
      val startingNotification = notification(startingText)
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, startingNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, startingNotification)
      }
      sessionForegroundActive = true
      getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit()
        .putBoolean(PREF_SESSION_ACTIVE, true)
        .putBoolean(PREF_SESSION_PUBLIC, publicTest)
        .putString(PREF_SESSION_PHASE, SESSION_PHASE_STARTING)
        .commit()
    } catch (error: RuntimeException) {
      stopWithTerminalStatus("Android rejected receiver start (" + error.javaClass.simpleName + "). Check Android app permissions.")
      return START_NOT_STICKY
    }

    val ps5Address = intent.getStringExtra(EXTRA_PS5_IPV4)?.trim().orEmpty()
    if (publicTest) {
      val outputPrefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
      brandOverlayRequested = outputPrefs.getBoolean("brand_overlay", true)
      sleipnirRelayRequested = outputPrefs.getBoolean("sleipnir_enabled", false)
      val rotateSleipnir180 = sleipnirRelayRequested && outputPrefs.getBoolean("sleipnir_rotate_180", true)
      val destinations = selectedDestinations()
      val invalid = destinations.firstOrNull { !it.isValid() }
      if (destinations.isEmpty() || invalid != null) {
        val message = if (destinations.isEmpty()) "Select at least one output and save its RTMPS server URL and key."
          else "${invalid!!.label} needs a valid RTMPS server URL and stream key."
        stopWithTerminalStatus(message)
        return START_NOT_STICKY
      }
      outputPublishers.clear()
      outputPublishers += destinations.map { destination ->
        ReliableRtmpOutput(destination, onSnapshot = { onOutputSnapshot() }).also { it.start() }
      }
      outputConnected = false
      musicStartedOnOutput.set(false)
      outputStatus = withRouteStatus(outputPublishers.joinToString(" | ") { it.snapshot().summary() })
      liveGate = MediaRelayGate()
      sourceVideoConfig = null
      brandOverlay?.close()
      brandOverlay = if (brandOverlayRequested || sleipnirRelayRequested) {
        runCatching {
          BrandVideoOverlay(
            onOutput = { message -> outputPublishers.forEach { it.offer(message) } },
            onStatus = { message -> handler.post { if (!stopping) setNotification(message) } },
            onFailure = { message -> handler.post { if (!stopping) disableBrandOverlay(message) } },
            showBrandOverlay = brandOverlayRequested,
            maxVideoBitrate = if (sleipnirRelayRequested) SleipnirRelay.MAX_VIDEO_BITRATE_BPS else Int.MAX_VALUE,
            rotateWholeFrame180 = rotateSleipnir180)
        }.onFailure { error ->
          if (!sleipnirRelayRequested) brandOverlayRequested = false
          handler.post {
            if (!stopping) {
              if (sleipnirRelayRequested) {
                stopWithTerminalStatus("Could not initialize the Sleipnir bitrate-limited encoder (${error.javaClass.simpleName}); stream stopped before publishing.")
              } else setNotification("@saevond overlay unavailable (${error.javaClass.simpleName}); using original PS5 video.")
            }
          }
        }.getOrNull()
      } else null
      if (sleipnirRelayRequested && brandOverlay == null) {
        stopWithTerminalStatus("Sleipnir needs the capped hardware video encoder. Startup failed before the PS5 receiver opened; no broadcast was sent.")
        return START_NOT_STICKY
      }
      musicTrack = MusicTrackLooper()
      genrePlaylist = MusicGenreSettings(this).playlist()
    }

    val local = activeWifiIpv4()
    if (!privateIpv4(ps5Address) || local == null || local == ps5Address) {
      stopWithTerminalStatus("Unavailable: use Wi-Fi and enter the PS5's private IPv4")
      return START_NOT_STICKY
    }

    try {
      val safety = phoneSafety.assess()
      if (safety.level == SafetyLevel.STOP) {
        stopWithTerminalStatus("Not started: " + safety.message)
        return START_NOT_STICKY
      }
      wifiAddress = local
      val uriText = if (publicTest && genrePlaylist?.hasTracks() != true)
        getSharedPreferences("ps5_music", MODE_PRIVATE).getString("track_uri", null) else null
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
                  // Loading only arms autoplay. No music plays during DNS/receiver
                  // diagnostics or while waiting for a PS5 broadcast.
                  val autoStart = getSharedPreferences("ps5_music", MODE_PRIVATE)
                    .getBoolean("autoplay", true)
                  loop.load(decoded, autoStart = autoStart)
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
    stopWithTerminalStatus("Receiver/music startup failed (" + error.javaClass.simpleName + "). Stopped; no broadcast.")
  }

  private fun beginReceiver(local: String, ps5Address: String) {
    try {
      if (publicTest && audioMixer == null) {
        // Game volume is independently controllable even with no music selected.
        audioMixer = LiveAacMusicMixer(musicTrack ?: error("Music state missing"), liveLevels)
      }
      musicTrack?.onTrackEnd = {
        handler.post {
          if (!stopping && genrePlaylist?.autoNext == true) playNextLicensedTrack(manual = false)
        }
      }
      val ingest = LanRtmpIngest(local, ps5Address, onMedia = { packet ->
        if (publicTest) {
          try {
            val input = if (packet.type == 8 && audioMixer != null) {
              audioMixer!!.onAudio(packet)
            } else listOf(packet)
            input.forEach { item ->
              val frames = liveGate?.process(item).orEmpty()
              if (frames.isNotEmpty()) {
                frames.forEach { media ->
                  when {
                    ReliableRtmpOutput.isAvcConfig(media) -> {
                      sourceVideoConfig = media.copy(data = media.data.copyOf())
                      val transcoder = brandOverlay
                      transcoder?.setConfiguration(media)
                      if (OutputRouteSelector.shouldForwardSourceAvcConfig(transcoderActive = transcoder != null)) {
                        outputPublishers.forEach { it.offer(media) }
                      }
                    }
                    media.type == 9 && (brandOverlayRequested || sleipnirRelayRequested) && brandOverlay != null -> brandOverlay?.offer(media)
                    else -> outputPublishers.forEach { it.offer(media) }
                  }
                }
              }
            }
          } catch (error: Exception) {
            Log.w("SweatyOBS-PS5", "Media processing stopped: " + error.javaClass.simpleName)
            handler.post {
              if (!stopping) {
                stopWithTerminalStatus("PS5 media processing failed (" + error.javaClass.simpleName + "). Stopped.")
              }
            }
            throw error
          }
        }
      }, onSourceSessionStart = {
        if (publicTest) {
          liveGate?.resetForSourceReconnect()
          outputPublishers.forEach { it.reconnectNow(forgetCodecHeaders = true) }
          audioMixer?.close()
          audioMixer = LiveAacMusicMixer(musicTrack ?: error("Music state missing"), liveLevels)
        }
      }, onSourceSessionEnd = {
        if (publicTest) {
          audioMixer?.close()
          audioMixer = null
        }
      })
      if (publicTest) acquireStreamWakeLock()
      receiver = ingest
      ingest.start()
      receiverRunning = true
      startupInProgress = false
      getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit()
        .putBoolean(PREF_SESSION_ACTIVE, true)
        .putBoolean(PREF_SESSION_PUBLIC, publicTest)
        .putString(PREF_SESSION_PHASE, SESSION_PHASE_ARMED)
        .commit()
      if (publicTest && genrePlaylist?.hasTracks() == true) playNextLicensedTrack(manual = true)
      val trackReady = musicTrack?.ready == true
      val powerNote = if (!publicTest) "" else if (streamWakeLock?.isHeld == true)
        " Screen-off CPU hold is active; battery use and heat may increase."
      else " Keep the screen awake for reliable streaming; CPU wake lock is unavailable."
      setNotification(if (publicTest) "Public stream armed. Awaiting PS5 RTMP on $local:1935. Music " +
        (if (trackReady) "ready to auto-start on RTMPS publish" else "not loaded") + powerNote
        else "Waiting for PS5 at $local:1935 — diagnostic only")
      if (publicTest) {
        val bridgeToken = SecretStore(this).get("bridge_token")
        if (bridgeToken.length >= 32) {
          musicBridge = MusicBridgePoller("https://twitch-gemini-ai-chatbot-sc-2.onrender.com",
            bridgeToken, statusSink = { message ->
              handler.post { if (!stopping) setNotification(message) }
            }) { action, level, station ->
            // Bot sends authenticated controls only; volume affects music gain,
            // never the game gain and never the Android system speaker volume.
            if (action == "volume" && level != null && level in 0..100) {
              liveLevels.update(liveLevels.gamePercent, level)
              getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
                .edit().putInt("music", level).apply()
              handler.post {
                if (!stopping) setNotification("Bot !volume applied: music $level% · game ${liveLevels.gamePercent}%.")
              }
            } else if (action == "station" && station in GenrePlaylist.STATIONS) {
              handler.post {
                if (!stopping) {
                  val genre = station!!
                  MusicGenreSettings(this).select(genre)
                  genrePlaylist = MusicGenreSettings(this).playlist()
                  playNextLicensedTrack(manual = true)
                }
              }
            } else if (action == "skip") {
              handler.post { if (!stopping) playNextLicensedTrack(manual = true) }
            } else if (action == "play" || action == "pause") musicTrack?.command(action)
          }.also { it.start() }
        }
      }
      handler.postDelayed(updateTask, 3000)
    } catch (error: Exception) { startFailed(error) }
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

  private fun notification(message: String, ongoing: Boolean = true): Notification {
    val immutable = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val openApp = PendingIntent.getActivity(
      this, NOTIFICATION_ID + 1,
      Intent(this, MainActivity::class.java).addFlags(
        Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
      immutable)
    val stopService = PendingIntent.getService(
      this, NOTIFICATION_ID + 2,
      Intent(this, Ps5LanService::class.java).setAction(ACTION_STOP),
      immutable)
    val builder = Notification.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle(if (!ongoing) "SweatyClanker · session stopped"
        else if (publicTest) "SweatyClanker · live session" else "SweatyClanker · PS5 receiver")
      .setContentText(message)
      .setContentIntent(openApp)
      .setCategory(if (ongoing) Notification.CATEGORY_SERVICE else Notification.CATEGORY_STATUS)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setOnlyAlertOnce(true)
      .setOngoing(ongoing)
      .setAutoCancel(!ongoing)
    if (ongoing) builder.addAction(Notification.Action.Builder(
      android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopService).build())
    if (ongoing && publicTest) {
      val reconnect = PendingIntent.getService(
        this, NOTIFICATION_ID + 3,
        Intent(this, Ps5LanService::class.java).setAction(ACTION_RECONNECT_OUTPUTS),
        immutable)
      builder.addAction(Notification.Action.Builder(
        android.R.drawable.ic_popup_sync, "Reconnect", reconnect).build())
    }
    return builder.build()
  }

  private fun publishUiStatus(message: String) {
    ConnectionTimeline.append(this, message)
    getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit().putString(PREF_STATUS_MESSAGE, message).apply()
    sendBroadcast(Intent(ACTION_STATUS).apply {
      setPackage(packageName)
      putExtra(EXTRA_STATUS_MESSAGE, message)
    })
  }

  private fun setNotification(message: String) {
    report = message
    publishUiStatus(message)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .notify(NOTIFICATION_ID, notification(message))
  }

  private fun stopWithTerminalStatus(message: String) {
    terminalReason = true
    stopping = true
    setNotification(message)
    stopSelf()
  }

  override fun onDestroy() {
    receiverRunning = false
    sessionForegroundActive = false
    startupInProgress = false
    stopping = true
    musicDecodeGeneration++
    decodingTrack = false
    genrePlaylist = null
    handler.removeCallbacks(updateTask)
    receiver?.stop()
    musicBridge?.stop()
    musicBridge = null
    audioMixer?.close()
    audioMixer = null
    musicTrack?.clear()
    musicTrack = null
    brandOverlay?.close()
    brandOverlay = null
    brandOverlayRequested = false
    sleipnirRelayRequested = false
    outputPublishers.toList().forEach { it.close() }
    outputPublishers.clear()
    releaseStreamWakeLock()
    liveGate = null
    outputConnected = false
    receiver = null
    getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit()
      .putBoolean(PREF_SESSION_ACTIVE, false)
      .remove(PREF_SESSION_PHASE)
      .commit()
    if (!terminalReason) {
      val stoppedMessage = when {
        !publicTest -> "Receiver stopped. Diagnostic only; no broadcast was sent."
        musicStartedOnOutput.get() -> "Receiver and output senders stopped. At least one RTMPS destination accepted publishing; viewer playback was not independently verified."
        else -> "Receiver stopped before any RTMPS destination accepted publishing."
      }
      publishUiStatus(stoppedMessage)
    }
    if (terminalReason) {
      val finalMessage = report ?: getSharedPreferences(STATUS_PREFS, MODE_PRIVATE)
        .getString(PREF_STATUS_MESSAGE, "Session stopped. Open the app for details.")
        .orEmpty()
      stopForeground(STOP_FOREGROUND_DETACH)
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
        .notify(NOTIFICATION_ID, notification(finalMessage, ongoing = false))
    } else {
      stopForeground(STOP_FOREGROUND_REMOVE)
    }
    super.onDestroy()
  }

  private fun acquireStreamWakeLock(): Boolean {
    if (!publicTest) return false
    if (streamWakeLock?.isHeld == true) return true
    return try {
      val powerManager = getSystemService(PowerManager::class.java)
      val wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:PS5LiveStream")
        .apply { setReferenceCounted(false) }
      wakeLock.acquire()
      streamWakeLock = wakeLock
      true
    } catch (error: RuntimeException) {
      Log.w("SweatyOBS-PS5", "Could not acquire stream CPU wake lock: ${error.javaClass.simpleName}")
      streamWakeLock = null
      false
    }
  }

  private fun releaseStreamWakeLock() {
    val wakeLock = streamWakeLock
    streamWakeLock = null
    if (wakeLock?.isHeld == true) {
      runCatching { wakeLock.release() }
        .onFailure { Log.w("SweatyOBS-PS5", "Could not release stream CPU wake lock", it) }
    }
  }

  private fun selectedDestinations(): List<RtmpDestination> {
    val prefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
    val secrets = SecretStore(this)
    val direct = buildList {
      if (prefs.getBoolean("twitch_enabled", true)) {
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
      direct)
  }

  private fun withRouteStatus(status: String): String = if (sleipnirRelayRequested)
    "$status · Sleipnir LIVE here means phone-to-relay publishing only; Twitch/YouTube/Kick status is in Sleipnir dashboard"
  else status

  private fun onOutputSnapshot() {
    val current = outputPublishers.map { it.snapshot() }
    outputConnected = current.any { it.state == "LIVE" }
    outputStatus = withRouteStatus(current.joinToString(" | ") { it.summary() })
    if (outputConnected && musicStartedOnOutput.compareAndSet(false, true)) {
      getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit()
        .putString(PREF_SESSION_PHASE, SESSION_PHASE_PUBLISH_ACCEPTED)
        .commit()
      val musicStarted = musicTrack?.onBroadcastStarted() == true
      handler.post {
        if (!stopping) {
          val accepted = if (sleipnirRelayRequested)
            "Sleipnir accepted the phone's RTMPS publish; downstream Twitch/YouTube/Kick status is in Sleipnir's dashboard."
          else "An RTMPS destination accepted publishing."
          setNotification(if (musicStarted)
            "$accepted Music started. Viewer playback is unverified. $outputStatus"
          else "$accepted Music is paused or unset. Viewer playback is unverified. $outputStatus")
        }
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
      stopWithTerminalStatus("$reason · stopped because Sleipnir mode requires the bitrate-limited hardware encoder")
      return
    }
    brandOverlayRequested = false
    brandOverlay?.close()
    brandOverlay = null
    outputPublishers.forEach { it.reconnectNow() }
    sourceVideoConfig?.let { config -> outputPublishers.forEach { it.offer(config) } }
    setNotification("$reason · reconnecting with original PS5 video")
  }
}
