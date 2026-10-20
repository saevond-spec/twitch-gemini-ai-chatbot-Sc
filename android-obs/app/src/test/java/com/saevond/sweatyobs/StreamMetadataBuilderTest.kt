package com.saevond.sweatyobs

import org.junit.Assert.*
import org.junit.Test

class StreamMetadataBuilderTest {
  @Test fun buildsPlatformAwareSearchDescriptionWithoutDuplicatingTags() {
    val result = StreamMetadataBuilder.build(
      title = "Ranked matches tonight",
      game = "Apex Legends",
      keywords = "Apex Legends, PS5 gameplay, #apex legends, ranked matches",
      platforms = listOf("Twitch", "YouTube", "Kick"),
      musicCredits = "Music provided by NoCopyrightSounds")

    assertTrue(result.startsWith("Ranked matches tonight"))
    assertTrue(result.contains("Live Apex Legends gameplay on PlayStation 5"))
    assertTrue(result.contains("Twitch · YouTube · Kick"))
    assertTrue(result.contains("#ApexLegends"))
    assertTrue(result.contains("Music provided by NoCopyrightSounds"))
    assertEquals(1, Regex("#ApexLegends").findAll(result).count())
  }

  @Test fun suppliesTitleForMissingMetadataAndCapsTags() {
    val result = StreamMetadataBuilder.build("", "Gran Turismo 7", (1..12).joinToString(",") { "tag$it" }, emptyList())
    assertTrue(result.startsWith("Gran Turismo 7"))
    assertEquals(8, Regex("#[A-Za-z0-9_]+").findAll(result).count())
  }
}
