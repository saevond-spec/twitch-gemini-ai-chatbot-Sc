package com.saevond.sweatyobs

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ConnectionTimelineRotationTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @Test fun rotationBoundsEachSegmentAndKeepsRecentRows() {
    val directory = temporaryFolder.newFolder("timeline")

    fun append(value: String) {
      val bytes = (value + "\n").toByteArray(Charsets.UTF_8)
      rotateConnectionTimeline(directory, bytes.size, maxBytes = 4, backupCount = 2)
      File(directory, "connection_timeline.jsonl").appendBytes(bytes)
    }

    append("a")
    append("b")
    append("c")
    append("d")
    append("e")

    assertEquals("e\n", File(directory, "connection_timeline.jsonl").readText())
    assertEquals("c\nd\n", File(directory, "connection_timeline.jsonl.1").readText())
    assertEquals("a\nb\n", File(directory, "connection_timeline.jsonl.2").readText())
    directory.listFiles().orEmpty().forEach { assertTrue(it.length() <= 4L) }
  }
}
