package com.saevond.sweatyobs

import android.content.Context
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/** Only fixed, non-sensitive event codes can enter remote encoder logs. */
internal enum class EncoderDiagnosticEventName(val wire: String) {
  APP_OPENED("app_opened"), DIAGNOSTICS_ENABLED("diagnostics_enabled"),
  DESTINATION_TOGGLED("destination_toggled"), STREAM_KEY_SAVED("stream_key_saved"),
  SERVER_URL_SAVED("server_url_saved"), OVERLAY_TOGGLED("overlay_toggled"),
  PROFILE_SELECTED("profile_selected"), STREAM_START_REQUESTED("stream_start_requested"),
  STREAM_START_REJECTED("stream_start_rejected"), DIAGNOSTIC_START_REQUESTED("diagnostic_start_requested"),
  DIAGNOSTIC_START_REJECTED("diagnostic_start_rejected"), STOP_REQUESTED("stop_requested"),
  MANUAL_RECONNECT_REQUESTED("manual_reconnect_requested"), MANUAL_RECONNECT_REJECTED("manual_reconnect_rejected"),
  SERVICE_STARTED("service_started"), SERVICE_START_FAILED("service_start_failed"),
  SERVICE_STOPPED("service_stopped"), RECEIVER_LISTENING("receiver_listening"),
  SOURCE_CONNECTED("source_connected"), SOURCE_PUBLISHING("source_publishing"),
  SOURCE_DISCONNECTED("source_disconnected"), INGEST_STATE_CHANGED("ingest_state_changed"),
  OUTPUT_STATE_CHANGED("output_state_changed"), OUTPUT_RETRY("output_retry"),
  STALE_PACKETS_DROPPED("stale_packets_dropped"), KEYFRAME_WAIT("keyframe_wait"),
  OVERLAY_READY("overlay_ready"), OVERLAY_FALLBACK("overlay_fallback"),
  MUSIC_PLAY("music_play"), MUSIC_PAUSE("music_pause"), MUSIC_SKIP("music_skip"),
  MUSIC_STATION_SELECTED("music_station_selected"), MUSIC_DECODE_FAILED("music_decode_failed"),
  MUSIC_BRIDGE_STATE("music_bridge_state"), MUSIC_COMMAND_APPLIED("music_command_applied"),
  SAFETY_WARNING("safety_warning"), SAFETY_STOP("safety_stop"), PERMISSION_STATE("permission_state"),
  FILE_PICKER_FAILED("file_picker_failed"), METADATA_COPIED("metadata_copied"),
  BOT_TOKEN_SAVED("bot_token_saved"), DIAGNOSTIC_TEST_REQUESTED("diagnostic_test_requested"),
  SETTING_CHANGED("setting_changed"), DASHBOARD_OPENED("dashboard_opened"),
  CATALOG_OPENED("catalog_opened"), TRACK_SELECTION_SAVED("track_selection_saved"),
  MUSIC_FILE_SELECTED("music_file_selected"), SAFETY_CHECK_REQUESTED("safety_check_requested"),
  BRIDGE_CHECK_REQUESTED("bridge_check_requested"), PS5_ADDRESS_SAVED("ps5_address_saved");
}

internal enum class EncoderDiagnosticResult(val wire: String) {
  NONE("none"), REQUESTED("requested"), ACCEPTED("accepted"), REJECTED("rejected"),
  STARTED("started"), FAILED("failed"), STOPPED("stopped"), ENABLED("enabled"),
  DISABLED("disabled"), CONNECTED("connected"), DISCONNECTED("disconnected"),
  PUBLISHING("publishing"), LIVE("live"), CONNECTING("connecting"), RETRYING("retrying"),
  WAITING("waiting"), DROPPED("dropped"), WARNING("warning"), BLOCKED("blocked"),
  SAVED("saved"), SELECTED("selected"), GRANTED("granted"), DENIED("denied"),
  APPLIED("applied"), COMPLETED("completed");
}

internal enum class EncoderDiagnosticTarget(val wire: String) {
  NONE("none"), APP("app"), DIAGNOSTICS("diagnostics"), NETWORK("network"),
  PERMISSIONS("permissions"), SETTINGS("settings"), OVERLAY("overlay"), MUSIC("music"),
  MULTIPLE("multiple"), TWITCH("twitch"), YOUTUBE("youtube"), KICK("kick");
}

enum class EncoderDiagnosticError(val wire: String) {
  NONE("NONE"), IO_EXCEPTION("IOException"), ILLEGAL_STATE("IllegalStateException"),
  ILLEGAL_ARGUMENT("IllegalArgumentException"), SOCKET_TIMEOUT("SocketTimeoutException"),
  UNKNOWN_HOST("UnknownHostException"), SOCKET("SocketException"), TLS("SSLException"),
  MEDIA_CODEC("MediaCodec"), OTHER("OTHER"), MISSING_CONFIG("MISSING_CONFIG"),
  INVALID_INPUT("INVALID_INPUT"), PERMISSION_DENIED("PERMISSION_DENIED"),
  NETWORK_CHANGED("NETWORK_CHANGED"), PHONE_SAFETY("PHONE_SAFETY"),
  SERVICE_START_DENIED("SERVICE_START_DENIED"), SOURCE_LOST("SOURCE_LOST"),
  BRIDGE_AUTH("BRIDGE_AUTH"), USER_CANCELLED("USER_CANCELLED"),
  APP_RESTRICTION("APP_RESTRICTION"), NO_FILE_PICKER("NO_FILE_PICKER");

  companion object {
    fun fromThrowableName(value: String): EncoderDiagnosticError = when (value) {
      "IOException" -> IO_EXCEPTION
      "IllegalStateException" -> ILLEGAL_STATE
      "IllegalArgumentException" -> ILLEGAL_ARGUMENT
      "SocketTimeoutException" -> SOCKET_TIMEOUT
      "UnknownHostException" -> UNKNOWN_HOST
      "SocketException" -> SOCKET
      "SSLException" -> TLS
      "MediaCodec", "CodecException" -> MEDIA_CODEC
      else -> OTHER
    }
  }
}

internal enum class EncoderDiagnosticMode(val wire: String) {
  IDLE("idle"), DIAGNOSTIC("diagnostic"), PUBLIC("public");
}

internal data class EncoderDiagnosticEvent(
  val sessionId: String,
  val appVersion: String,
  val mode: EncoderDiagnosticMode,
  val sequence: Long,
  val name: EncoderDiagnosticEventName,
  val result: EncoderDiagnosticResult,
  val target: EncoderDiagnosticTarget,
  val errorCategory: EncoderDiagnosticError,
) {
  fun toJson() = org.json.JSONObject()
    .put("sequence", sequence.coerceIn(0, 1_000_000_000_000L))
    .put("name", name.wire)
    .put("result", result.wire)
    .put("target", target.wire)
    .put("errorCategory", errorCategory.wire)
}
/** Process-memory-only telemetry client shared by the setup screen and service. */
internal object EncoderDiagnostics {
  val sessionId = UUID.randomUUID().toString()
  private val sequence = AtomicLong(0)
  @Volatile private var currentMode = EncoderDiagnosticMode.IDLE
  @Volatile private var reporter: RemoteDiagnosticsReporter? = null

  fun setMode(mode: EncoderDiagnosticMode) {
    currentMode = mode
  }

  fun record(
    context: Context,
    name: EncoderDiagnosticEventName,
    result: EncoderDiagnosticResult = EncoderDiagnosticResult.NONE,
    target: EncoderDiagnosticTarget = EncoderDiagnosticTarget.NONE,
    error: EncoderDiagnosticError = EncoderDiagnosticError.NONE,
  ) {
    try {
      val prefs = context.getSharedPreferences(Ps5LanService.DIAGNOSTICS_PREFS, Context.MODE_PRIVATE)
      if (!prefs.getBoolean(Ps5LanService.PREF_REMOTE_DIAGNOSTICS_ENABLED, true)) {
        disable()
        return
      }
      val destination = ensureReporter(context) ?: return
      destination.submitEvent(EncoderDiagnosticEvent(
        sessionId = sessionId,
        appVersion = BuildConfig.VERSION_NAME,
        mode = currentMode,
        sequence = sequence.getAndIncrement().coerceAtLeast(0L),
        name = name,
        result = result,
        target = target,
        errorCategory = error,
      ))
    } catch (_: Exception) {
      // Diagnostics must never affect UI actions or live media.
    }
  }

  fun submitSample(context: Context, sample: EncoderDiagnosticSample) {
    try {
      val prefs = context.getSharedPreferences(Ps5LanService.DIAGNOSTICS_PREFS, Context.MODE_PRIVATE)
      if (!prefs.getBoolean(Ps5LanService.PREF_REMOTE_DIAGNOSTICS_ENABLED, true)) {
        disable()
        return
      }
      ensureReporter(context)?.submit(sample.copy(
        sessionId = sessionId,
        appVersion = BuildConfig.VERSION_NAME,
        mode = currentMode.wire,
      ))
    } catch (_: Exception) {
      // Diagnostics must never affect live media.
    }
  }

  /** Called after the user disables telemetry or replaces the bridge token. */
  @Synchronized
  fun disable() {
    reporter?.disable()
    reporter = null
  }

  @Synchronized
  fun reset(context: Context) {
    reporter?.disable()
    reporter = null
    val prefs = context.getSharedPreferences(Ps5LanService.DIAGNOSTICS_PREFS, Context.MODE_PRIVATE)
    if (prefs.getBoolean(Ps5LanService.PREF_REMOTE_DIAGNOSTICS_ENABLED, true)) ensureReporter(context)
  }

  @Synchronized
  private fun ensureReporter(context: Context): RemoteDiagnosticsReporter? {
    reporter?.let { return it }
    val secret = SecretStore(context.applicationContext).get("bridge_token")
    if (secret.length < 32) return null
    return RemoteDiagnosticsReporter(secret).also { reporter = it }
  }
}
