package com.saevond.sweatyobs

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

/** Reads Android's retained process-exit record for the process that owned a prior stream. */
internal object ProcessExitDiagnostics {
  fun describeLastExit(context: Context, processId: Int, sessionStartedAtMs: Long): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      return "process exit history unavailable on Android 10"
    }
    if (processId <= 0 || sessionStartedAtMs <= 0L) {
      return "saved stream process identity unavailable"
    }
    val activityManager = context.getSystemService(ActivityManager::class.java)
      ?: return "Android process exit history unavailable"
    val exits = runCatching {
      activityManager.getHistoricalProcessExitReasons(context.packageName, processId, 10)
    }.getOrNull() ?: return "Android process exit history unavailable"
    val exit = exits
      .filter { it.pid == processId && it.timestamp >= sessionStartedAtMs - 5_000L }
      .maxByOrNull { it.timestamp }
      ?: return "Android retained no matching process-exit record"
    val seconds = (exit.timestamp - sessionStartedAtMs).coerceAtLeast(0L) / 1_000L
    val signal = if (exit.reason == ApplicationExitInfo.REASON_SIGNALED && exit.status > 0) {
      " (signal/status ${exit.status})"
    } else ""
    return "${reasonLabel(exit.reason)}$signal after ${seconds}s from session start"
  }

  internal fun reasonLabel(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_EXIT_SELF -> "process exited itself"
    ApplicationExitInfo.REASON_SIGNALED -> "process terminated by an OS signal"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "Android reports low-memory termination"
    ApplicationExitInfo.REASON_CRASH -> "app crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
    ApplicationExitInfo.REASON_ANR -> "app not responding"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "process initialization failure"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "runtime permission change"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource use"
    ApplicationExitInfo.REASON_USER_REQUESTED ->
      "user-requested stop"
    ApplicationExitInfo.REASON_USER_STOPPED -> "Android user profile stopped"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependent process died"
    ApplicationExitInfo.REASON_OTHER -> "other Android system exit"
    ApplicationExitInfo.REASON_FREEZER -> "Android app freezer"
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "app package state changed"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "app updated"
    else -> "unknown Android exit reason ($reason)"
  }
}
