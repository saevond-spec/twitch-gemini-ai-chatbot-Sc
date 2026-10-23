package com.saevond.sweatyobs

import android.app.Activity
import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
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
import java.security.SecureRandom
import android.util.Base64
import android.content.ClipboardManager
import android.content.ClipData
import android.content.ClipDescription
import android.os.PersistableBundle
import kotlin.concurrent.thread
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.SeekBar
import android.widget.CheckBox
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.AdapterView
import java.util.Locale
import com.saevond.sweatyobs.ingest.RtmpsPublisher

/**
 * Controls a background *network receiver*, never a display or audio recorder.
 * Starts an explicit private-LAN ingest and user-selected RTMPS outputs.
 */
class MainActivity : Activity() {
  companion object {
    private const val PICK_MUSIC = 31416
    private const val PICK_CLUB = 31417
    private const val PICK_DUBSTEP = 31418
    private const val PICK_POP_TRAP = 31419
    private const val REQUEST_POST_NOTIFICATIONS = 31420
  }
  private lateinit var status: TextView
  private lateinit var timelineButton: Button
  private lateinit var viewerPlaybackButton: Button
  private var pendingNotificationStartButton: Button? = null
  private var skipNotificationPermissionGateOnce = false
  private val statusReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val text = intent?.getStringExtra(Ps5LanService.EXTRA_STATUS_MESSAGE) ?: return
      status.text = text
      refreshTimelineButton()
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
    val backgroundNote = TextView(this).apply {
      text = "Background streaming: allow notifications for live status and Stop/Reconnect controls; denied notifications may hide stop alerts from the drawer. Go Live holds a partial CPU wake lock so media processing can continue with the screen off, but Android Doze or phone-maker power saving can still interrupt networking. Test a screen-off stream on this phone before relying on it; battery use and heat may increase. If Android stops the app or Wi-Fi changes, open the app and start again; live sessions are never auto-restarted."
      setPadding(12, 0, 12, 20)
    }
    val appSettingsButton = Button(this).apply {
      id = R.id.open_app_settings
      text = "Open app settings for background access"
      setOnClickListener {
        startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:$packageName")
        })
      }
    }
    val phoneIp = TextView(this).apply {
      val ip = wifiIpv4()
      text = "PHONE Wi-Fi IP (NextDNS rewrite destination): " + (ip ?: "Not on home Wi-Fi") + "\nPS5 IPv4 is entered separately below."
    }
    val destinations = TextView(this).apply {
      id = R.id.output_upload_budget
      text = "Direct RTMPS outputs each use their own retry loop. At 1080p, this encoder targets 8 Mbps video + 128 kbps AAC per destination."
    }
    val outputPrefs = getSharedPreferences("encoder_outputs", MODE_PRIVATE)
    val enableSleipnirRelay = CheckBox(this).apply {
      id = R.id.sleipnir_enabled
      text = "Use Sleipnir cloud relay (configure Twitch / YouTube / Kick in Sleipnir)"
      isChecked = outputPrefs.getBoolean("sleipnir_enabled", false)
    }
    val rotateSleipnir180 = CheckBox(this).apply {
      id = R.id.sleipnir_rotate_180
      text = "Rotate the whole Sleipnir picture 180° (takes effect next stream)"
      isChecked = outputPrefs.getBoolean("sleipnir_rotate_180", true)
    }
    val sleipnirServer = EditText(this).apply {
      id = R.id.sleipnir_server
      hint = "Sleipnir RTMPS ingest URL"
      setSingleLine(true)
      setText(outputPrefs.getString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    }
    val saveSleipnirServer = Button(this).apply {
      id = R.id.save_sleipnir_server
      text = "Save Sleipnir RTMPS ingest URL"
    }
    val sleipnirKey = EditText(this).apply {
      id = R.id.sleipnir_stream_key
      hint = "Sleipnir ingest key from your Sleipnir dashboard"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val sleipnirOutputStatus = TextView(this).apply {
      id = R.id.sleipnir_output_status
      text = outputCredentialStatus("Sleipnir", "sleipnir_key", "sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL)
    }
    val saveSleipnirKey = Button(this).apply {
      id = R.id.save_sleipnir_key
      text = "Save Sleipnir key securely"
    }
    val sleipnirNote = TextView(this).apply {
      text = "Relay mode sends one RTMPS feed from this phone to Sleipnir; configure destination accounts in its dashboard. The PS5 feed still passes through the phone. Sleipnir Free currently lists a 5 Mbps ingest budget. The nominal H.264 video target is 3.2 Mbps plus 128 kb/s AAC; a phone codec may raise the configured video rate to its supported minimum, up to the 3.8 Mbps cap. With an assumed 10% transport allowance, estimated total is 3.66–4.32 Mbps, leaving at least 0.68 Mbps below that budget. These are estimates; the output peak is unverified. Sleipnir LIVE in this app confirms the phone-to-relay link only; downstream platform status is in Sleipnir's dashboard."
    }
    val enableTwitch = CheckBox(this).apply {
      text = "Stream to Twitch"
      isChecked = outputPrefs.getBoolean("twitch_enabled", true)
    }
    val enableYouTube = CheckBox(this).apply {
      text = "Also stream to YouTube"
      isChecked = outputPrefs.getBoolean("youtube_enabled", false)
    }
    val youtubeServer = EditText(this).apply {
      id = R.id.youtube_server
      hint = "YouTube RTMPS server URL from Live Control Room"
      setSingleLine(true)
      setText(outputPrefs.getString("youtube_server", ""))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
    }
    val saveYouTubeServer = Button(this).apply {
      id = R.id.save_youtube_server
      text = "Save YouTube RTMPS server URL"
    }
    val youtubeKey = EditText(this).apply {
      id = R.id.youtube_stream_key
      hint = "YouTube stream key (kept in Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val youtubeOutputStatus = TextView(this).apply {
      id = R.id.youtube_output_status
      text = outputCredentialStatus("YouTube", "youtube_key", "youtube_server")
    }
    val saveYouTube = Button(this).apply {
      id = R.id.save_youtube_key
      text = "Save YouTube key securely"
    }
    val enableKick = CheckBox(this).apply {
      text = "Also stream to Kick"
      isChecked = outputPrefs.getBoolean("kick_enabled", false)
    }
    val kickServer = EditText(this).apply {
      id = R.id.kick_server
      hint = "Kick RTMPS server URL from Creator Dashboard"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      setSingleLine(true)
      setText(outputPrefs.getString("kick_server", ""))
    }
    val saveKickServer = Button(this).apply {
      id = R.id.save_kick_server
      text = "Save Kick RTMPS server URL"
    }
    val kickKey = EditText(this).apply {
      id = R.id.kick_stream_key
      hint = "Kick stream key (kept in Android Keystore)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val kickOutputStatus = TextView(this).apply {
      id = R.id.kick_output_status
      text = outputCredentialStatus("Kick", "kick_key", "kick_server")
    }
    val saveKick = Button(this).apply {
      id = R.id.save_kick_key
      text = "Save Kick key securely"
    }
    val enableBrandOverlay = CheckBox(this).apply {
      text = "Add the @saevond live overlay to the stream"
      isChecked = outputPrefs.getBoolean("brand_overlay", true)
    }
    val reconnectOutputs = Button(this).apply { text = "Reconnect stream outputs" }
    val videoModeNote = TextView(this).apply {
      text = "The overlay includes simulated stats, chat, and alerts; it does not read real Twitch chat or viewer activity. Hardware video processing re-encodes up to 1080p (not 4K). Turn it off for original-video pass-through. If processing fails, outputs reconnect with the original PS5 video. This setting applies the next time you start streaming."
    }
    val metadataTitle = EditText(this).apply {
      hint = "Stream title (example: PS5 live gameplay and ranked matches)"
      setSingleLine(true)
      setText(outputPrefs.getString("metadata_title", ""))
    }
    val metadataGame = EditText(this).apply {
      hint = "Game name"
      setSingleLine(true)
      setText(outputPrefs.getString("metadata_game", ""))
    }
    val metadataKeywords = EditText(this).apply {
      hint = "Search phrases / tags, comma separated"
      setText(outputPrefs.getString("metadata_keywords", ""))
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    }
    val copyMetadata = Button(this).apply { text = "Generate and copy stream description" }
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
    val genreSettings = MusicGenreSettings(this)
    val stationNames = listOf("Mixed", "Club", "Dubstep / Bass", "Pop / Trap")
    val stationCodes = listOf(GenrePlaylist.MIXED, GenrePlaylist.CLUB, GenrePlaylist.DUBSTEP, GenrePlaylist.POP_TRAP)
    val stationPicker = Spinner(this).apply {
      id = R.id.music_genre
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, stationNames)
      setSelection(stationCodes.indexOf(genreSettings.selected()).coerceAtLeast(0))
      contentDescription = "Music genre: Mixed, Club, Dubstep and Bass, or Pop and Trap"
    }
    val genreStatus = TextView(this).apply {
      id = R.id.genre_library_status
      text = musicLibrarySummary(genreSettings)
    }
    val remoteCatalogStatus = TextView(this).apply {
      id = R.id.remote_catalog_status
      val savedRemote = allSavedMusicTracks(genreSettings)
        .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
      text = "Remote NCS catalog: ${RemoteMusicCatalog.tracks.size} creator tracks · " +
        "${RemoteMusicCatalog.forGenre("club").size} Club / House · " +
        "${RemoteMusicCatalog.forGenre("dubstep").size} Dubstep / Bass · " +
        "${RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).size} Pop / Trap · " +
        "$savedRemote saved. Use required song credits and check current platform terms."
    }
    val browseRemoteClub = Button(this).apply {
      id = R.id.remote_club_catalog
      text = "Browse remote NCS Club / House catalog"
    }
    val browseRemoteDubstep = Button(this).apply {
      id = R.id.remote_dubstep_catalog
      text = "Browse remote NCS Dubstep / Bass catalog"
    }
    val browseRemotePopTrap = Button(this).apply {
      text = "Browse remote NCS Pop / Trap catalog"
    }
    val copyStreamCredit = Button(this).apply {
      id = R.id.copy_ncs_stream_credit
      text = "Copy NCS live-stream credit"
    }
    val copyTrackCredits = Button(this).apply {
      id = R.id.copy_ncs_track_credits
      text = "Copy selected NCS track credits for VODs"
    }
    val addClub = Button(this).apply { text = "Add local licensed Club / House songs" }
    val addDubstep = Button(this).apply { text = "Add local licensed Dubstep songs" }
    val addPopTrap = Button(this).apply { text = "Add local licensed Pop / Trap songs" }
    val shuffleSongs = CheckBox(this).apply {
      id = R.id.music_shuffle
      text = "Shuffle songs"
      isChecked = genreSettings.shuffle()
    }
    val autoNextSong = CheckBox(this).apply {
      id = R.id.music_auto_next
      text = "Automatically play next song"
      isChecked = genreSettings.autoNext()
    }
    val skipSong = Button(this).apply { id = R.id.music_skip; text = "Skip to next song" }
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
      progress = savedLevels.getInt("music", 22).coerceIn(0,100)
      contentDescription = "Music volume"
    }
    val gameLabel = TextView(this).apply { text = "Game volume: ${gameVolume.progress}%" }
    val musicLabel = TextView(this).apply { text = "Music volume: ${musicVolume.progress}%" }
    val volumeHint = TextView(this).apply {
      text = "Live audio mix is peak-safe. Lower music to hear more game audio."
    }
    val muteMusic = Button(this).apply { id = R.id.music_mute; text = "Mute music" }
    val resetMix = Button(this).apply { text = "Reset volumes: game 85% · music 22%" }
    val musicNote = TextView(this).apply {
      val ready = getSharedPreferences("ps5_music", MODE_PRIVATE).contains("track_uri")
      val remoteCount = allSavedMusicTracks(genreSettings)
        .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
      text = when {
        remoteCount > 0 -> "$remoteCount remote NCS songs saved. Tracks load online when selected; audio is not saved as a music file. Shuffle avoids repeats until the selected list has played through."
        ready -> "Local licensed music selected. Autoplay begins after a platform accepts publishing."
        else -> "No music selected. Browse the 100-track remote NCS catalog or choose a local rights-cleared audio file."
      }
    }
    val chooseMusic = Button(this).apply { text = "Choose local licensed music file (MP3 / AAC / WAV)" }
    val autoplayMusic = CheckBox(this).apply {
      id = R.id.music_autoplay
      text = "Automatically play selected local or remote music when a stream output starts"
      isChecked = getSharedPreferences("ps5_music", MODE_PRIVATE)
        .getBoolean("autoplay", true)
    }
    val playMusic = Button(this).apply { text = "Play music on active stream" }
    val pauseMusic = Button(this).apply { text = "Pause music (leave game audio playing)" }
    val botToken = EditText(this).apply {
      hint = "Optional private bot music bridge token (32+ characters)"
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
      setSingleLine(true)
    }
    val saveBotToken = Button(this).apply { text = "Save private !play bridge token" }
    val generateBotToken = Button(this).apply {
      text = "Generate and copy secure bridge token for Render"
    }
    val testMusicBridge = Button(this).apply {
      id = R.id.test_music_bridge
      text = "Check remote music bridge connection"
    }
    val bridgeStatus = TextView(this).apply {
      id = R.id.music_bridge_status
      text = "Bridge not checked. Twitch music controls require matching private bot token."
    }
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
    val goLive = Button(this).apply { text = "START MULTISTREAM (public broadcast)" }
    val startLan = Button(this).apply { id = R.id.start_network_test; text = "Start PS5 network connection test" }
    val stopLan = Button(this).apply { id = R.id.stop_network_test; text = "Stop receiver and all outputs" }
    timelineButton = Button(this).apply {
      id = R.id.connection_timeline
      text = "View full connection timeline"
      setOnClickListener { showConnectionTimeline() }
    }
    viewerPlaybackButton = Button(this).apply {
      id = R.id.viewer_playback_check
      text = "Log viewer playback confirmation"
      setOnClickListener { showViewerPlaybackConfirmation() }
    }

    listOf(status, backgroundNote, appSettingsButton, phoneIp, timelineButton, viewerPlaybackButton, destinations, enableSleipnirRelay, rotateSleipnir180, sleipnirServer, saveSleipnirServer,
      sleipnirKey, saveSleipnirKey, sleipnirOutputStatus, sleipnirNote,
      enableTwitch, twitchStatus, twitchKey, saveTwitchKey,
      enableYouTube, youtubeServer, saveYouTubeServer, youtubeKey, saveYouTube, youtubeOutputStatus,
      enableKick, kickServer, saveKickServer, kickKey, saveKick, kickOutputStatus,
      enableBrandOverlay, reconnectOutputs, videoModeNote,
      metadataTitle, metadataGame, metadataKeywords, copyMetadata,
      privacy, checkSafety, safetyReading, ps5Ip,
      genreStatus, stationPicker, remoteCatalogStatus, browseRemoteClub, browseRemoteDubstep,
      browseRemotePopTrap, copyStreamCredit, copyTrackCredits, addClub, addDubstep, addPopTrap,
      shuffleSongs, autoNextSong, skipSong,
      chooseMusic, musicNote, autoplayMusic, gameLabel, gameVolume, musicLabel, musicVolume,
      volumeHint, muteMusic, resetMix, playMusic, pauseMusic, botToken, saveBotToken, generateBotToken,
      testMusicBridge, bridgeStatus, openTwitchDashboard,
      startLan, goLive, stopLan)
      .forEach { layout.addView(it) }
    setContentView(ScrollView(this).apply { addView(layout) })
    recordTimelineEvent("App opened · SweatyClanker OBS Lite ${BuildConfig.VERSION_NAME}")
    refreshTimelineButton()

    stationPicker.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
      override fun onNothingSelected(parent: AdapterView<*>?) {}
      override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
        val genre = stationCodes[position.coerceIn(0, stationCodes.lastIndex)]
        if (genre == genreSettings.selected()) return
        genreSettings.select(genre)
        if (Ps5LanService.receiverRunning) {
          startService(Intent(this@MainActivity, Ps5LanService::class.java).apply {
            action = Ps5LanService.ACTION_MUSIC_STATION
            putExtra(Ps5LanService.EXTRA_GENRE, genre)
          })
        }
      }
    }
    addClub.setOnClickListener { pickGenreTracks(PICK_CLUB) }
    addDubstep.setOnClickListener { pickGenreTracks(PICK_DUBSTEP) }
    addPopTrap.setOnClickListener { pickGenreTracks(PICK_POP_TRAP) }
    browseRemoteClub.setOnClickListener { browseRemoteCatalog(GenrePlaylist.CLUB) }
    browseRemoteDubstep.setOnClickListener { browseRemoteCatalog(GenrePlaylist.DUBSTEP) }
    browseRemotePopTrap.setOnClickListener { browseRemoteCatalog(GenrePlaylist.POP_TRAP) }
    copyStreamCredit.setOnClickListener {
      (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
        ClipData.newPlainText("NCS live-stream credit", RemoteMusicCatalog.LIVE_STREAM_CREDIT)
      )
      status.text = "Copied the NCS live-stream credit. Paste it into the description on each platform where you stream."
    }
    copyTrackCredits.setOnClickListener {
      val savedTracks = allSavedMusicTracks(MusicGenreSettings(this))
      val credits = RemoteMusicCatalog.creditsForAudioUrls(savedTracks)
      if (credits.isBlank()) {
        status.text = "Add remote NCS tracks first. Their artist and song credits will be copied here for VOD descriptions."
      } else {
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
          ClipData.newPlainText("NCS track credits", credits)
        )
        status.text = "Copied selected NCS song credits. Paste them into the matching VOD description."
      }
    }
    shuffleSongs.setOnCheckedChangeListener { _, on ->
      genreSettings.setShuffle(on)
      if (Ps5LanService.receiverRunning) refreshGenreService()
    }
    autoNextSong.setOnCheckedChangeListener { _, on ->
      genreSettings.setAutoNext(on)
      if (Ps5LanService.receiverRunning) refreshGenreService()
    }
    skipSong.setOnClickListener {
      if (Ps5LanService.receiverRunning) {
        startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_SKIP })
        status.text = "Requested the next selected song. Game audio continues."
      } else status.text = "Start a public stream before skipping music."
    }

    var previousMusic = musicVolume.progress.coerceAtLeast(22)
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
      musicVolume.progress = 22
      savedLevels.edit().putInt("game",85).putInt("music",22).apply()
    }
    openTwitchDashboard.setOnClickListener {
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dashboard.twitch.tv/settings/stream")))
    }
    fun refreshOutputRoute() {
      val relay = enableSleipnirRelay.isChecked
      enableTwitch.isEnabled = !relay
      enableYouTube.isEnabled = !relay
      enableKick.isEnabled = !relay
      rotateSleipnir180.isEnabled = relay
      destinations.text = if (relay) {
        "Sleipnir sends one 720p30 RTMPS upload from the phone at a nominal 3.2 Mbps H.264 video target + 128 kb/s AAC. A device codec may raise the configured video rate to its supported minimum, up to the 3.8 Mbps cap. With an assumed 10% transport allowance, estimated total is 3.66–4.32 Mbps, leaving at least 0.68 Mbps below the app's 5 Mbps relay budget. These are estimates; actual output peak is unverified. YouTube's H.264 720p30 bitrate floor is 3 Mbps and its recommendation is 8 Mbps, so the nominal target clears the floor but is below the recommendation. Android's target is not a packet-level cap. Sleipnir fans out to the destinations enabled in its dashboard. LIVE here confirms only phone-to-relay; check downstream status in that dashboard."
      } else {
        "Direct RTMPS outputs each use their own retry loop. At 1080p, this encoder targets 8 Mbps video + 128 kbps AAC per destination. Aim for more than 16.3 Mbps sustained upload per destination (more than 48.8 Mbps for three), using Kick's less-than-half-upload guidance as a conservative planning rule."
      }
      videoModeNote.text = if (relay) {
        "Sleipnir prefers a whole-frame 1280×720@30 H.264 encode with a 3.2 Mbps nominal video target plus 128 kb/s AAC. A device codec may raise the configured target to its supported minimum, up to the 3.8 Mbps cap; with an assumed 10% transport allowance the estimated total is 3.66–4.32 Mbps, leaving at least 0.68 Mbps below the listed 5 Mbps relay budget. These are estimates; actual output peaks remain unverified. YouTube's documented 720p30 H.264 minimum is 3 Mbps and its recommendation is 8 Mbps, so the nominal target clears the minimum but is below the recommendation. 1080p30 would require at least 5 Mbps video before audio and overhead, above this route budget. The encoder prefers phone-advertised CBR/CBR-FD and probes CBR only when unadvertised. The full picture, gameplay and overlay together, rotates 180° by default. Lower hardware fallbacks may not meet YouTube's 720p minimum. Turning off @saevond removes graphics only; video is still re-encoded."
      } else {
        "The overlay includes simulated stats, chat, and alerts; it does not read real Twitch chat or viewer activity. Hardware video processing re-encodes up to 1080p (not 4K). Turn it off for original-video pass-through. If processing fails, outputs reconnect with the original PS5 video. This setting applies the next time you start streaming."
      }
    }
    enableTwitch.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("twitch_enabled", checked).apply()
    }
    enableYouTube.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("youtube_enabled", checked).apply()
    }
    enableKick.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("kick_enabled", checked).apply()
    }
    enableBrandOverlay.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("brand_overlay", checked).apply()
      refreshOutputRoute()
    }
    enableSleipnirRelay.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("sleipnir_enabled", checked).apply()
      refreshOutputRoute()
    }
    rotateSleipnir180.setOnCheckedChangeListener { _, checked ->
      outputPrefs.edit().putBoolean("sleipnir_rotate_180", checked).apply()
    }
    refreshOutputRoute()
    saveSleipnirServer.setOnClickListener {
      val server = sleipnirServer.text.toString().trim()
      if (!RtmpsPublisher.endpointValid(server)) {
        status.text = "Enter a valid secure Sleipnir RTMPS ingest URL."
      } else {
        outputPrefs.edit().putString("sleipnir_server", server).apply()
        sleipnirOutputStatus.text = outputCredentialStatus("Sleipnir", "sleipnir_key", "sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL)
        status.text = "Sleipnir RTMPS ingest URL saved on this phone. It has not been tested with Sleipnir."
      }
    }
    saveSleipnirKey.setOnClickListener {
      val key = sleipnirKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter the Sleipnir ingest key from your dashboard. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("sleipnir_key", key)
        sleipnirKey.text.clear()
        sleipnirOutputStatus.text = outputCredentialStatus("Sleipnir", "sleipnir_key", "sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL)
        status.text = "Sleipnir ingest key encrypted and saved on this phone. No stream has started."
      } catch (error: Exception) {
        status.text = "Could not securely save Sleipnir key (" + error.javaClass.simpleName + ")."
      }
    }
    saveYouTubeServer.setOnClickListener {
      val server = youtubeServer.text.toString().trim()
      if (!RtmpsPublisher.endpointValid(server)) {
        status.text = "Enter a valid secure YouTube RTMPS server URL from Live Control Room."
      } else {
        outputPrefs.edit().putString("youtube_server", server).apply()
        youtubeOutputStatus.text = outputCredentialStatus("YouTube", "youtube_key", "youtube_server")
        status.text = "YouTube RTMPS server URL saved on this phone. It has not been tested with YouTube."
      }
    }
    saveYouTube.setOnClickListener {
      val key = youtubeKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter a valid YouTube stream key. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("youtube_key", key)
        youtubeKey.text.clear()
        youtubeOutputStatus.text = outputCredentialStatus("YouTube", "youtube_key", "youtube_server")
        status.text = "YouTube key encrypted and saved on this phone. No stream has started."
      } catch (error: Exception) {
        status.text = "Could not securely save YouTube key (" + error.javaClass.simpleName + ")."
      }
    }
    saveKickServer.setOnClickListener {
      val server = kickServer.text.toString().trim()
      if (!RtmpsPublisher.endpointValid(server)) {
        status.text = "Enter a valid secure Kick RTMPS server URL from Creator Dashboard."
      } else {
        outputPrefs.edit().putString("kick_server", server).apply()
        kickOutputStatus.text = outputCredentialStatus("Kick", "kick_key", "kick_server")
        status.text = "Kick RTMPS server URL saved on this phone. It has not been tested with Kick."
      }
    }
    saveKick.setOnClickListener {
      val key = kickKey.text.toString().trim()
      if (!RtmpsPublisher.keyValid(key)) {
        status.text = "Enter a valid Kick stream key. It is saved only to this phone's Android Keystore."
      } else try {
        SecretStore(this).put("kick_key", key)
        kickKey.text.clear()
        kickOutputStatus.text = outputCredentialStatus("Kick", "kick_key", "kick_server")
        status.text = "Kick key encrypted and saved on this phone. No stream has started."
      } catch (error: Exception) {
        status.text = "Could not securely save Kick key (" + error.javaClass.simpleName + ")."
      }
    }
    reconnectOutputs.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        status.text = "Start a stream first. Outputs will reconnect automatically after a network interruption."
      } else {
        startService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_RECONNECT_OUTPUTS
        })
        status.text = "Manual reconnect requested. Waiting for a clean video keyframe; automatic retry stays enabled."
      }
    }
    copyMetadata.setOnClickListener {
      outputPrefs.edit()
        .putString("metadata_title", metadataTitle.text.toString())
        .putString("metadata_game", metadataGame.text.toString())
        .putString("metadata_keywords", metadataKeywords.text.toString())
        .apply()
      val activePlatforms = buildList {
        if (enableSleipnirRelay.isChecked) add("Sleipnir relay destinations") else {
          if (enableTwitch.isChecked) add("Twitch")
          if (enableYouTube.isChecked) add("YouTube")
          if (enableKick.isChecked) add("Kick")
        }
      }
      val savedTracks = allSavedMusicTracks(MusicGenreSettings(this))
      val trackCredits = RemoteMusicCatalog.creditsForAudioUrls(savedTracks)
      val musicCredits = if (trackCredits.isBlank()) "" else
        RemoteMusicCatalog.LIVE_STREAM_CREDIT + "\n" + trackCredits
      val description = StreamMetadataBuilder.build(
        metadataTitle.text.toString(), metadataGame.text.toString(),
        metadataKeywords.text.toString(), activePlatforms, musicCredits)
      (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
        ClipData.newPlainText("Stream title and searchable description", description)
      )
      status.text = "Copied your stream description. Paste it into the title/description fields in each selected platform dashboard."
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

    autoplayMusic.setOnCheckedChangeListener { _, checked ->
      getSharedPreferences("ps5_music", MODE_PRIVATE).edit()
        .putBoolean("autoplay", checked).apply()
      status.text = if (checked) "Music will start when a platform accepts publishing, if a licensed local or remote track is selected."
        else "Music autoplay disabled; use Play when your stream is active."
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
      status.text = "Music play requested for active stream; select a local file or remote NCS song first."
    }
    pauseMusic.setOnClickListener {
      if (!Ps5LanService.receiverRunning) {
        status.text = "No active PS5 receiver. Music is not playing."
        return@setOnClickListener
      }
      startService(Intent(this, Ps5LanService::class.java).apply { action = Ps5LanService.ACTION_MUSIC_PAUSE })
      status.text = "Music pause requested; game audio continues."
    }
    generateBotToken.setOnClickListener {
      try {
        val data = ByteArray(32)
        SecureRandom().nextBytes(data)
        val token = Base64.encodeToString(data, Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE)
        SecretStore(this).put("bridge_token", token)
        val clip = ClipData.newPlainText("SweatyClanker music bridge token", token)
        if (Build.VERSION.SDK_INT >= 33) {
          clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
          }
        }
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        status.text = "Secure bridge token created and copied. Paste it into Render environment variable ENCODER_BRIDGE_TOKEN. Do not share it in chat. Replacing it invalidates the old token."
        bridgeStatus.text = "Bridge token saved locally; set matching Render server secret, then tap Check."
      } catch (error: Exception) {
        status.text = "Could not generate secure bridge token (" + error.javaClass.simpleName + ")."
      }
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

    testMusicBridge.setOnClickListener {
      val token = SecretStore(this).get("bridge_token")
      if (token.length !in 32..256) {
        bridgeStatus.text = "Save a private bridge token in this app first."
        return@setOnClickListener
      }
      bridgeStatus.text = "Checking SweatyClanker bot bridge over HTTPS…"
      testMusicBridge.isEnabled = false
      thread(name = "SweatyOBS-bridge-check") {
        val outcome = MusicBridgePoller.verify(
          "https://twitch-gemini-ai-chatbot-sc-2.onrender.com", token)
        runOnUiThread {
          if (!isFinishing && !isDestroyed) {
            bridgeStatus.text = outcome
            testMusicBridge.isEnabled = true
          }
        }
      }
    }

    saveTwitchKey.setOnClickListener {
      val value = twitchKey.text.toString().trim()
      if (!com.saevond.sweatyobs.ingest.TwitchRtmpsPublisher.keyValid(value)) {
        status.text = "Invalid Twitch key format. Obtain the full stream key from Twitch Creator Dashboard; never send it in chat."
      } else try {
        SecretStore(this).put("rtmps", value)
        twitchKey.text.clear()
        status.text = "Twitch key stored with Android Keystore. Nothing is broadcasting."
        twitchStatus.text = "Twitch key saved locally; Twitch will check it when a stream starts."
      } catch (error: Exception) {
        status.text = "Could not securely save Twitch key (" + error.javaClass.simpleName + ")."
      }
    }

    goLive.setOnClickListener {
      if (!ensureNotificationPermission(goLive)) return@setOnClickListener
      recordTimelineEvent("Public multistream requested")
      status.text = "Public multistream requested. Checking selected platforms, phone, and PS5 address…"
      val ip = ps5Ip.text.toString().trim()
      if (!Ps5LanService.privateIpv4(ip)) {
        status.text = "Enter the PS5 local IPv4 address first."
        return@setOnClickListener
      }
      val secrets = SecretStore(this)
      val directDestinations = buildList {
        if (enableTwitch.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "twitch", "Twitch", "rtmps://live.twitch.tv:443/app", secrets.get("rtmps")))
        if (enableYouTube.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "youtube", "YouTube", outputPrefs.getString("youtube_server", "").orEmpty(), secrets.get("youtube_key")))
        if (enableKick.isChecked) add(com.saevond.sweatyobs.ingest.RtmpDestination(
          "kick", "Kick", outputPrefs.getString("kick_server", "").orEmpty(), secrets.get("kick_key")))
      }
      val destinations = OutputRouteSelector.select(
        enableSleipnirRelay.isChecked,
        outputPrefs.getString("sleipnir_server", SleipnirRelay.DEFAULT_INGEST_URL).orEmpty(),
        secrets.get("sleipnir_key"),
        directDestinations)
      val missing = destinations.firstOrNull { !it.isValid() }
      if (destinations.isEmpty()) {
        status.text = "Choose at least one platform output above."
        return@setOnClickListener
      }
      if (missing != null) {
        status.text = "Save a valid ${missing.label} RTMPS ingest URL and stream key before going live."
        return@setOnClickListener
      }
      getSharedPreferences("ps5_setup", MODE_PRIVATE).edit().putString("ps5_ipv4", ip).apply()
      try {
        startForegroundService(Intent(this, Ps5LanService::class.java).apply {
          action = Ps5LanService.ACTION_START_TWITCH
          putExtra(Ps5LanService.EXTRA_PS5_IPV4, ip)
        })
        status.text = if (enableSleipnirRelay.isChecked)
          "Waiting for PS5 H.264/AAC RTMP feed. Sleipnir receives one RTMPS feed using the app's CBR target; its enabled dashboard destinations fan out from there."
        else "Waiting for PS5 H.264/AAC RTMP feed. Selected outputs publish independently and retry if a connection drops."
      } catch (error: RuntimeException) {
        status.text = "Android could not start public test: " + error.javaClass.simpleName
      }
    }

    startLan.setOnClickListener {
      if (!ensureNotificationPermission(startLan)) return@setOnClickListener
      recordTimelineEvent("PS5 receiver start requested")
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
        status.text = "Network-only diagnostic requested. No broadcast is sent."
      } catch (error: RuntimeException) {
        status.text = "Unable to start network diagnostic: check app permissions and Android service restrictions."
      }
    }

    stopLan.setOnClickListener {
      recordTimelineEvent("Stop requested for receiver and all outputs")
      stopService(Intent(this, Ps5LanService::class.java))
      status.text = "PS5 receiver and all streaming outputs stopped."
    }
  }

  private fun recordTimelineEvent(message: String) {
    ConnectionTimeline.append(this, message)
    refreshTimelineButton()
  }

  private fun refreshTimelineButton() {
    if (!::timelineButton.isInitialized) return
    val count = ConnectionTimeline.count(this)
    timelineButton.text = "View full connection timeline ($count events)"
  }

  private fun showViewerPlaybackConfirmation() {
    val viewerDestinations = arrayOf("Twitch", "Sleipnir", "YouTube", "Kick")
    val destinationPicker = Spinner(this).apply {
      id = R.id.viewer_playback_destination
      adapter = ArrayAdapter(
        this@MainActivity,
        android.R.layout.simple_spinner_item,
        viewerDestinations
      ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
    }
    val videoVisible = CheckBox(this).apply {
      id = R.id.viewer_video_visible
      text = "I can see live video playing in the viewer"
    }
    val audioAudible = CheckBox(this).apply {
      id = R.id.viewer_audio_audible
      text = "I can hear the stream audio/music in the viewer"
    }
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(32, 12, 32, 0)
      addView(TextView(this@MainActivity).apply {
        text = "Check the public viewer/player first. This is a manual confirmation; the encoder cannot detect what viewers hear."
        textSize = 14f
        setPadding(0, 0, 0, 12)
      })
      addView(TextView(this@MainActivity).apply {
        text = "Destination"
        textSize = 14f
      })
      addView(destinationPicker)
      addView(videoVisible)
      addView(audioAudible)
    }
    val dialog = AlertDialog.Builder(this)
      .setTitle("Confirm viewer playback")
      .setView(content)
      .setPositiveButton("Record confirmation", null)
      .setNegativeButton("Cancel", null)
      .create()
    dialog.setOnShowListener {
      val recordButton = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
      val updateEnabled = {
        recordButton.isEnabled = videoVisible.isChecked && audioAudible.isChecked
      }
      recordButton.isEnabled = false
      videoVisible.setOnCheckedChangeListener { _, _ -> updateEnabled() }
      audioAudible.setOnCheckedChangeListener { _, _ -> updateEnabled() }
      recordButton.setOnClickListener {
        val destination = destinationPicker.selectedItem.toString()
        recordTimelineEvent(
          "Manual viewer playback verified · ${destination} · video visible · audio/music audible · operator-confirmed"
        )
        dialog.dismiss()
      }
    }
    dialog.show()
  }

  private fun showConnectionTimeline() {
    val events = ConnectionTimeline.events(this)
    val timelineText = ConnectionTimeline.format(events).ifBlank { "No connection events recorded yet." }
    val content = TextView(this).apply {
      text = timelineText
      textSize = 14f
      setPadding(24, 16, 24, 16)
      setTextIsSelectable(true)
    }
    val scroll = ScrollView(this).apply { addView(content) }
    AlertDialog.Builder(this)
      .setTitle("Full connection timeline · ${events.size} events")
      .setView(scroll)
      .setPositiveButton("Copy timeline") { _, _ ->
        (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(
          ClipData.newPlainText("SweatyClanker connection timeline", timelineText)
        )
      }
      .setNegativeButton("Close", null)
      .show()
  }

  private fun outputCredentialStatus(
    platform: String,
    secretName: String,
    serverPreference: String,
    defaultServer: String? = null
  ): String {
    val keySaved = RtmpsPublisher.keyValid(SecretStore(this).get(secretName))
    val serverSaved = RtmpsPublisher.endpointValid(
      getSharedPreferences("encoder_outputs", MODE_PRIVATE).getString(serverPreference, defaultServer.orEmpty()).orEmpty())
    return when {
      keySaved && serverSaved -> "$platform key saved securely; RTMPS server URL saved."
      keySaved -> "$platform key saved securely; save its RTMPS server URL before streaming."
      serverSaved -> "$platform server URL saved; save a stream key before streaming."
      else -> "$platform stream key and RTMPS server URL are not saved yet."
    }
  }

  private fun browseRemoteCatalog(genre: String) {
    val tracks = RemoteMusicCatalog.forGenre(genre)
    if (tracks.isEmpty()) {
      status.text = "No remote NCS songs are listed for this genre."
      return
    }
    val label = when (genre) {
      GenrePlaylist.CLUB -> "Club / House"
      GenrePlaylist.DUBSTEP -> "Dubstep / Bass"
      GenrePlaylist.POP_TRAP -> "Pop / Trap"
      else -> "Music"
    }
    val selected = linkedSetOf<Int>()
    val options = tracks.map { it.title + " — " + it.artist }.toTypedArray()
    val selectAllButton = Button(this).apply {
      text = "Select all"
      isAllCaps = false
    }
    val trackList = android.widget.ListView(this).apply {
      choiceMode = android.widget.ListView.CHOICE_MODE_MULTIPLE
      adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_list_item_multiple_choice, options)
    }
    trackList.setOnItemClickListener { _, _, position, _ ->
      if (trackList.isItemChecked(position)) selected.add(position) else selected.remove(position)
      selectAllButton.text = if (selected.size == tracks.size) "Deselect all" else "Select all"
    }
    selectAllButton.setOnClickListener {
      val selectEverything = selected.size != tracks.size
      selected.clear()
      if (selectEverything) selected.addAll(tracks.indices)
      tracks.indices.forEach { trackList.setItemChecked(it, selectEverything) }
      selectAllButton.text = if (selectEverything) "Deselect all" else "Select all"
    }
    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(12, 0, 12, 0)
      addView(selectAllButton, LinearLayout.LayoutParams(
        android.view.ViewGroup.LayoutParams.MATCH_PARENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT))
      addView(trackList, LinearLayout.LayoutParams(
        android.view.ViewGroup.LayoutParams.MATCH_PARENT, (resources.displayMetrics.heightPixels * 0.42f).toInt()))
    }
    val dialog = AlertDialog.Builder(this)
      .setTitle("Remote NCS $label catalog")
      .setView(content)
      .setNegativeButton("Cancel", null)
      .setPositiveButton("Add selected") { _, _ ->
        if (selected.isEmpty()) {
          status.text = "No remote songs selected."
          return@setPositiveButton
        }
        val settings = MusicGenreSettings(this)
        val before = settings.tracks(genre).size
        settings.add(genre, selected.map { tracks[it].audioUrl })
        val after = settings.tracks(genre).size
        val added = after - before
        findViewById<TextView>(R.id.genre_library_status)?.text = musicLibrarySummary(settings)
        val savedRemote = allSavedMusicTracks(settings)
          .count { RemoteMusicCatalog.isSupportedAudioUrl(it) }
        findViewById<TextView>(R.id.remote_catalog_status)?.text =
          "Remote NCS catalog: ${RemoteMusicCatalog.tracks.size} creator tracks · " +
            "${RemoteMusicCatalog.forGenre("club").size} Club / House · " +
            "${RemoteMusicCatalog.forGenre("dubstep").size} Dubstep / Bass · " +
            "${RemoteMusicCatalog.forGenre(GenrePlaylist.POP_TRAP).size} Pop / Trap · " +
            "$savedRemote saved. Use required song credits and check current platform terms."
        status.text = if (added > 0)
          "Added $added remote NCS songs to $label. Copy the NCS live-stream credit into each stream description."
        else
          "No new songs added. The tracks may already be saved or this genre has reached its 100-song limit."
        if (added > 0 && Ps5LanService.receiverRunning) refreshGenreService()
      }
      .create()
    dialog.show()
  }

  private fun pickGenreTracks(requestCode: Int) {
    val picker = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "audio/*"
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
    }
    startActivityForResult(picker, requestCode)
  }

  private fun refreshGenreService() {
    startService(Intent(this, Ps5LanService::class.java).apply {
      action = Ps5LanService.ACTION_MUSIC_CONFIG
    })
  }

  private fun allSavedMusicTracks(settings: MusicGenreSettings): List<String> =
    GenrePlaylist.GENRES.flatMap { settings.tracks(it) }

  private fun musicLibrarySummary(settings: MusicGenreSettings): String =
    "Music library: Club ${settings.tracks(GenrePlaylist.CLUB).size} · " +
      "Dubstep / Bass ${settings.tracks(GenrePlaylist.DUBSTEP).size} · " +
      "Pop / Trap ${settings.tracks(GenrePlaylist.POP_TRAP).size}"

  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    val pickedGenre = when (requestCode) {
      PICK_CLUB -> GenrePlaylist.CLUB
      PICK_DUBSTEP -> GenrePlaylist.DUBSTEP
      PICK_POP_TRAP -> GenrePlaylist.POP_TRAP
      else -> null
    }
    if (pickedGenre != null && resultCode == RESULT_OK) {
      val genre = pickedGenre
      val uris = mutableListOf<Uri>()
      data?.data?.let { uris.add(it) }
      data?.clipData?.let { clip ->
        for (i in 0 until minOf(clip.itemCount, GenrePlaylist.MAX_TRACKS_PER_GENRE)) {
          clip.getItemAt(i).uri?.let { uris.add(it) }
        }
      }
      val granted = uris.distinct().mapNotNull { uri ->
        try {
          contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
          uri.toString().takeIf { it.startsWith("content://") && it.length <= 2048 }
        } catch (_: SecurityException) { null }
      }
      if (granted.isNotEmpty()) {
        val store = MusicGenreSettings(this)
        store.add(genre, granted)
        findViewById<TextView>(R.id.genre_library_status)?.text = musicLibrarySummary(store)
        status.text = "Saved ${granted.size} local licensed $genre tracks. ${musicLibrarySummary(store)}"
        if (Ps5LanService.receiverRunning) refreshGenreService()
      } else status.text = "No accessible local songs were selected."
      return
    }
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


  private fun ensureNotificationPermission(button: Button): Boolean {
    if (Build.VERSION.SDK_INT < 33 ||
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      skipNotificationPermissionGateOnce = false
      return true
    }
    if (skipNotificationPermissionGateOnce) {
      skipNotificationPermissionGateOnce = false
      return true
    }
    pendingNotificationStartButton = button
    status.text = "Allow notifications to keep live status and Stop controls visible while this app is in the background."
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_POST_NOTIFICATIONS)
    return false
  }

  @Suppress("DEPRECATION")
  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_POST_NOTIFICATIONS) return
    val button = pendingNotificationStartButton
    pendingNotificationStartButton = null
    if (button == null) return
    if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
      button.performClick()
      return
    }
    AlertDialog.Builder(this)
      .setTitle("Background notification unavailable")
      .setMessage("Android may hide the live status and notification Stop/Reconnect controls. You can still continue, but use the Stop button in the app.")
      .setNegativeButton("Cancel") { _, _ ->
        status.text = "Streaming was not started. Allow notifications for background status and controls."
      }
      .setPositiveButton("Continue") { _, _ ->
        skipNotificationPermissionGateOnce = true
        button.performClick()
      }
      .show()
  }

  override fun onStart() {
    super.onStart()
    val filter = IntentFilter(Ps5LanService.ACTION_STATUS)
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else { @Suppress("DEPRECATION") registerReceiver(statusReceiver, filter) }
    // IRC !volume commands may have changed the persisted slider while this
    // screen was backgrounded in Twitch. Refresh when returning to OBS Lite.
    val remoteMusic = getSharedPreferences("ps5_audio_levels", MODE_PRIVATE)
      .getInt("music", 22).coerceIn(0,100)
    findViewById<SeekBar>(R.id.music_volume)?.let {
      if (it.progress != remoteMusic) it.progress = remoteMusic
    }
    val statusPrefs = getSharedPreferences(Ps5LanService.STATUS_PREFS, MODE_PRIVATE)
    val interrupted = statusPrefs.getBoolean(Ps5LanService.PREF_SESSION_ACTIVE, false) &&
      !Ps5LanService.sessionForegroundActive
    if (interrupted) {
      val wasPublic = statusPrefs.getBoolean(Ps5LanService.PREF_SESSION_PUBLIC, false)
      val previousPhase = statusPrefs.getString(Ps5LanService.PREF_SESSION_PHASE, "")
      val exitDiagnostic = ProcessExitDiagnostics.describeLastExit(
        this,
        statusPrefs.getInt(Ps5LanService.PREF_SESSION_PID, 0),
        statusPrefs.getLong(Ps5LanService.PREF_SESSION_STARTED_AT, 0L)
      )
      if (exitDiagnostic.isNotBlank()) {
        ConnectionTimeline.append(this, "Session recovery diagnostic · $exitDiagnostic")
      }
      val baseMessage = if (!wasPublic)
        "Previous diagnostic test ended before the app confirmed a clean stop. Tap Start network test to reconnect."
      else when (previousPhase) {
        Ps5LanService.SESSION_PHASE_PUBLISH_ACCEPTED ->
          "Previous stream session ended after an RTMPS destination accepted publishing. Viewer playback was not verified; it was not auto-restarted."
        Ps5LanService.SESSION_PHASE_ARMED ->
          "Previous stream session ended before an RTMPS destination accepted publishing. It was not auto-restarted; tap Go live to start a new session."
        else ->
          "Previous stream startup ended before the PS5 receiver was armed. It was not auto-restarted; tap Go live to start a new session."
      }
      val message = baseMessage + (exitDiagnostic.takeIf { it.isNotBlank() }?.let { " Android exit diagnostic: $it." }.orEmpty())
      statusPrefs.edit().putBoolean(Ps5LanService.PREF_SESSION_ACTIVE, false)
        .remove(Ps5LanService.PREF_SESSION_PHASE)
        .remove(Ps5LanService.PREF_SESSION_STARTED_AT)
        .remove(Ps5LanService.PREF_SESSION_PID)
        .putString(Ps5LanService.PREF_STATUS_MESSAGE, message).commit()
      ConnectionTimeline.append(this, "Session recovery notice · $message")
      status.text = message
    } else {
      val saved = statusPrefs.getString(Ps5LanService.PREF_STATUS_MESSAGE, null)
      if (!saved.isNullOrBlank()) status.text = saved
    }
    refreshTimelineButton()
  }

  override fun onStop() {
    unregisterReceiver(statusReceiver)
    super.onStop()
  }
}
