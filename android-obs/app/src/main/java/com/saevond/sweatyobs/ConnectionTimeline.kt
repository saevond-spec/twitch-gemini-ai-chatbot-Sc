package com.saevond.sweatyobs

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val CONNECTION_TIMELINE_FILE_NAME = "connection_timeline.jsonl"
internal const val CONNECTION_TIMELINE_MAX_FILE_BYTES = 1_048_576L
internal const val CONNECTION_TIMELINE_BACKUP_COUNT = 3

/** Rotates bounded JSONL history before appending the next row. */
internal fun rotateConnectionTimeline(
  directory: File,
  incomingBytes: Int,
  maxBytes: Long = CONNECTION_TIMELINE_MAX_FILE_BYTES,
  backupCount: Int = CONNECTION_TIMELINE_BACKUP_COUNT
): Boolean {
  require(incomingBytes >= 0 && maxBytes > 0 && backupCount >= 1)
  val active = File(directory, CONNECTION_TIMELINE_FILE_NAME)
  if (!active.exists() || active.length() + incomingBytes <= maxBytes) return false
  for (index in backupCount downTo 1) {
    val source = if (index == 1) active else File(directory, "$CONNECTION_TIMELINE_FILE_NAME.${index - 1}")
    val target = File(directory, "$CONNECTION_TIMELINE_FILE_NAME.$index")
    if (target.exists() && !target.delete()) throw IOException("Unable to prune old connection timeline")
    if (source.exists() && !source.renameTo(target)) throw IOException("Unable to rotate connection timeline")
  }
  return true
}

/** Persists connection and receiver status events in app-private storage. */
internal object ConnectionTimeline {
  private const val FILE_NAME = CONNECTION_TIMELINE_FILE_NAME
  private const val TAG = "SweatyOBS-Timeline"
  private var cachedCount: Int? = null

  data class Event(val timestampMs: Long, val message: String)

  @Synchronized
  fun append(context: Context, message: String) {
    val cleanMessage = message.trim()
    if (cleanMessage.isEmpty()) return
    try {
      val row = JSONObject()
        .put("timestampMs", System.currentTimeMillis())
        .put("message", cleanMessage.take(4_000))
      val bytes = (row.toString() + "\n").toByteArray(Charsets.UTF_8)
      val rotated = rotateConnectionTimeline(context.filesDir, bytes.size)
      if (rotated) cachedCount = null
      context.openFileOutput(FILE_NAME, Context.MODE_APPEND).use { output -> output.write(bytes) }
      cachedCount = cachedCount?.plus(1)
    } catch (error: Exception) {
      Log.w(TAG, "Unable to append a connection timeline event", error)
    }
  }

  @Synchronized
  fun count(context: Context): Int {
    return cachedCount ?: events(context).size.also { cachedCount = it }
  }

  @Synchronized
  fun events(context: Context): List<Event> {
    val files = (CONNECTION_TIMELINE_BACKUP_COUNT downTo 1)
      .map { File(context.filesDir, "$FILE_NAME.$it") } +
      File(context.filesDir, FILE_NAME)
    return buildList {
      files.forEach { file ->
        if (!file.exists()) return@forEach
        try {
          file.bufferedReader(Charsets.UTF_8).useLines { lines ->
            addAll(lines.mapNotNull { line ->
              try {
                val row = JSONObject(line)
                val timestamp = row.optLong("timestampMs", -1L)
                val message = row.optString("message", "").trim()
                if (timestamp < 0L || message.isEmpty()) null else Event(timestamp, message)
              } catch (_: Exception) {
                null
              }
            }.toList())
          }
        } catch (error: Exception) {
          Log.w(TAG, "Unable to read a connection timeline segment", error)
        }
      }
    }
  }

  fun format(events: List<Event>): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.getDefault())
    return events.joinToString("\n") { event ->
      "${formatter.format(Date(event.timestampMs))} · ${event.message}"
    }
  }
}
