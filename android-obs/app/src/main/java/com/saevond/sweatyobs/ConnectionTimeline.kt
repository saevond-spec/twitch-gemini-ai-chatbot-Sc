package com.saevond.sweatyobs

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.FileNotFoundException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Persists connection and receiver status events in app-private storage. */
internal object ConnectionTimeline {
  private const val FILE_NAME = "connection_timeline.jsonl"
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
        .put("message", cleanMessage)
      context.openFileOutput(FILE_NAME, Context.MODE_APPEND).bufferedWriter(Charsets.UTF_8).use { writer ->
        writer.append(row.toString()).append('\\n')
      }
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
    return try {
      context.openFileInput(FILE_NAME).bufferedReader(Charsets.UTF_8).useLines { lines ->
        lines.mapNotNull { line ->
          try {
            val row = JSONObject(line)
            val timestamp = row.optLong("timestampMs", -1L)
            val message = row.optString("message", "").trim()
            if (timestamp < 0L || message.isEmpty()) null else Event(timestamp, message)
          } catch (_: Exception) {
            null
          }
        }.toList()
      }
    } catch (_: FileNotFoundException) {
      emptyList()
    } catch (error: Exception) {
      Log.w(TAG, "Unable to read the connection timeline", error)
      emptyList()
    }
  }

  fun format(events: List<Event>): String {
    val formatter = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.getDefault())
    return events.joinToString("\\n") { event ->
      "${formatter.format(Date(event.timestampMs))} · ${event.message}"
    }
  }
}
