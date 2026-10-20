package com.saevond.sweatyobs

import android.widget.Spinner
import android.widget.CheckBox
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GenreUiSmokeTest {
  @get:Rule val scenario = ActivityScenarioRule(MainActivity::class.java)

  @Test fun changingGenreAndAutoNextPersistsSelection() {
    scenario.scenario.onActivity { activity ->
      val genre = activity.findViewById<Spinner>(R.id.music_genre)
      genre.setSelection(2) // Dubstep
      activity.findViewById<CheckBox>(R.id.music_auto_next).isChecked = false
      activity.findViewById<CheckBox>(R.id.music_shuffle).isChecked = true
      val settings = MusicGenreSettings(activity)
      assertEquals("dubstep", settings.selected())
      assertFalse(settings.autoNext())
      assertTrue(settings.shuffle())
      // A genre selection is only a music-control action; no broadcast may start.
    }
  }
}
