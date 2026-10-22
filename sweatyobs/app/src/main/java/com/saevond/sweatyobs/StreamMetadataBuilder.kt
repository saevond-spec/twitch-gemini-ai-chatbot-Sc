package com.saevond.sweatyobs

/** Builds a clean, searchable description for the streamer to paste into each platform dashboard. */
object StreamMetadataBuilder {
  fun build(
    title: String,
    game: String,
    keywords: String,
    platforms: List<String>,
    musicCredits: String = ""
  ): String {
    val cleanTitle = title.cleanLine().ifBlank { game.cleanLine().ifBlank { "PS5 gameplay live" } }
    val cleanGame = game.cleanLine()
    val tags = keywords.split(',', '\n', '#')
      .map { it.trim().replace(Regex("\\s+"), " ") }
      .filter { it.length in 2..40 }
      .distinctBy { it.lowercase() }
      .take(8)
    val cleanPlatforms = platforms.map { it.cleanLine() }.filter { it.isNotBlank() }.distinct()
    return buildList {
      add(cleanTitle)
      add("")
      add(if (cleanGame.isBlank()) "Live PlayStation 5 gameplay and community chat." else
        "Live $cleanGame gameplay on PlayStation 5 with real-time game audio and community chat.")
      if (cleanPlatforms.isNotEmpty()) add("Streaming on: ${cleanPlatforms.joinToString(" · ")}.")
      add("Follow for more live gameplay, new streams, and gaming highlights.")
      if (tags.isNotEmpty()) add("")
      if (tags.isNotEmpty()) add(tags.joinToString(" ") { "#${it.replace(Regex("[^A-Za-z0-9_]"), "")}" })
      if (musicCredits.isNotBlank()) {
        add("")
        add("Music credits")
        add(musicCredits.trim())
      }
    }.joinToString("\n")
  }

  private fun String.cleanLine(): String = trim().replace(Regex("[\\r\\n\\t]+"), " ")
}
