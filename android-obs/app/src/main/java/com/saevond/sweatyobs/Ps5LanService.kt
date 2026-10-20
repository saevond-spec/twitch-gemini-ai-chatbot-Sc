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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.saevond.sweatyobs.ingest.LanRtmpIngest
import java.net.Inet4Address

/**
 * Android 14-compatible, user-started network-connected foreground service.
 *
 * Ingest-only diagnostic: counts authorized PS5 RTMP video/audio packets.
 * It does NOT decode/rebroadcast PS5 gameplay, transmit stream keys, or route music.
 */
class Ps5LanService : Service() {
  companion object {
    const val ACTION_START = "com.saevond.sweatyobs.START_PS5_INGEST"
    const val ACTION_STOP = "com.saevond.sweatyobs.STOP_PS5_INGEST"
    const val EXTRA_PS5_IPV4 = "ps5_ipv4"
    const val ACTION_STATUS = "com.saevond.sweatyobs.DIAGNOSTIC_STATUS"
    const val EXTRA_STATUS_MESSAGE = "diagnostic_status"
    const val STATUS_PREFS = "diagnostic_status_v1"
    const val PREF_STATUS_MESSAGE = "latest_message"
    private const val CHANNEL = "ps5_lan_ingest"
    private const val NOTIFICATION_ID = 734

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
      if (activeWifiIpv4() != wifiAddress || !ingest.active) {
        setNotification("Receiver stopped: Wi-Fi changed or port unavailable")
        terminalReason = true
        stopSelf()
        return
      }
      val summary = if (ingest.connected)
        "PS5 linked · video ${ingest.videoPackets} · audio ${ingest.audioPackets}"
      else "Waiting for PS5 · video ${ingest.videoPackets} · audio ${ingest.audioPackets}"
      val display = if (safety.level == SafetyLevel.WARN) "Warning: " + safety.message else summary
      if (display != report) setNotification(display)
      handler.postDelayed(this, 3000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    phoneSafety = PhoneSafetyMonitor(this)
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager)
      .createNotificationChannel(NotificationChannel(
        CHANNEL, "SweatyClanker PS5 LAN receiver", NotificationManager.IMPORTANCE_LOW))
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (intent?.action != ACTION_START || stopping) return START_NOT_STICKY
    if (receiver != null) { setNotification("Receiver already running; waiting for authorized PS5 packets."); return START_NOT_STICKY }
    val ps5Address = intent.getStringExtra(EXTRA_PS5_IPV4)?.trim().orEmpty()

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
      // Ingest counters come from LanRtmpIngest; media is intentionally discarded
      // until the separate audio-mix + H264 passthrough chain is verified.
      val ingest = LanRtmpIngest(local, ps5Address) { _ -> }
      receiver = ingest
      ingest.start()
      setNotification("Waiting for PS5 at ${local}:1935 — ingest test only")
      handler.postDelayed(updateTask, 3000)
    } catch (error: Exception) {
      Log.w("SweatyOBS-PS5", "LAN receiver unavailable: ${error.javaClass.simpleName}")
      setNotification("PS5 receiver could not start (" + error.javaClass.simpleName + ")")
      terminalReason = true
      stopSelf()
    }
    return START_NOT_STICKY
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
    receiver = null
    if (!terminalReason) publishUiStatus("Receiver stopped. No broadcast was sent.")
    super.onDestroy()
  }
}
