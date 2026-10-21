package com.saevond.sweatyobs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TwitchChatClientTest {
  @Test fun burstQueueKeepsOnlyTheNewestVisibleRows() {
    val queue = BoundedLatestQueue<Int>(TwitchChatProtocol.MAX_CHAT_LINES)
    repeat(20, queue::offer)
    assertEquals((12..19).toList(), queue.drain())
    assertTrue(queue.isEmpty())
    queue.offer(21)
    queue.clear()
    assertTrue(queue.isEmpty())
  }

  @Test fun channelAndLoginInputCannotInjectIrcCommands() {
    assertEquals(listOf(
      "PASS oauth:sampleToken123",
      "NICK saevond",
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "JOIN #saevond"
    ),
      TwitchChatProtocol.authCommands("Saevond", "SAEVOND", "oauth:sampleToken123"))
    assertNull(TwitchChatProtocol.authCommands("safe\r\nPRIVMSG #other :x", "saevond", "sampleToken123"))
    assertNull(TwitchChatProtocol.authCommands("saevond", "other\nJOIN #target", "sampleToken123"))
    assertNull(TwitchChatProtocol.authCommands("saevond", "saevond", "bad token"))
  }

  @Test fun onlyPingGetsAnExactPongReply() {
    assertEquals("PONG :tmi.twitch.tv", TwitchChatProtocol.pongLine("PING :tmi.twitch.tv"))
    assertNull(TwitchChatProtocol.pongLine(":tmi.twitch.tv 001 saevond :Welcome"))
    assertNull(TwitchChatProtocol.pongLine("PING "))
  }

  @Test fun parsesDisplayNameAndBoundsUntrustedChatText() {
    val line = "@display-name=Ice\\sQueen :icequeen!icequeen@icequeen.tmi.twitch.tv PRIVMSG #saevond :Clean parry!\u0001"
    val parsed = TwitchChatProtocol.parsePrivmsg(line, "saevond")
    assertNull(TwitchChatProtocol.parsePrivmsg(line.replace("#saevond", "#other"), "saevond"))
    assertEquals("icequeen", parsed?.login)
    assertEquals("Ice Queen", parsed?.displayName)
    assertEquals("Clean parry!", parsed?.text)
    assertNull(TwitchChatProtocol.parsePrivmsg("PING :tmi.twitch.tv"))
    assertNull(TwitchChatProtocol.parsePrivmsg(":icequeen!x@y PRIVMSG #saevond :" + "x".repeat(9_000)))
    assertNull(TwitchChatProtocol.parsePrivmsg(":icequeen!x@y PRIVMSG #saevond :" + "😀".repeat(2_049)))
  }

  @Test fun detectsRoomJoinAndAuthFailuresWithoutSurfacingServerText() {
    assertTrue(TwitchChatProtocol.isJoinedConfirmation(":tmi.twitch.tv ROOMSTATE #saevond", "saevond", "saevond"))
    assertFalse(TwitchChatProtocol.isJoinedConfirmation(":tmi.twitch.tv ROOMSTATE #saevond2", "saevond", "saevond"))
    assertTrue(TwitchChatProtocol.isJoinedConfirmation(":saevond!saevond@saevond.tmi.twitch.tv JOIN #saevond", "saevond", "saevond"))
    assertFalse(TwitchChatProtocol.isJoinedConfirmation(":saevond2!saevond2@host JOIN #saevond", "saevond", "saevond"))
    assertFalse(TwitchChatProtocol.isJoinedConfirmation(":someone!someone@host PRIVMSG #saevond :JOIN #saevond", "saevond", "saevond"))
    assertTrue(TwitchChatProtocol.isAuthenticationFailure("NOTICE * :Login authentication failed"))
    assertFalse(TwitchChatProtocol.isAuthenticationFailure("NOTICE #saevond :A chat message"))
  }

  @Test fun retryDelayUsesBoundedFullJitterAndCapsAtOneMinute() {
    assertEquals(0L, TwitchChatProtocol.retryDelayMillis(0, 0.0))
    assertEquals(500L, TwitchChatProtocol.retryDelayMillis(0, .5))
    assertEquals(60_000L, TwitchChatProtocol.retryDelayMillis(30, 1.0))
    assertEquals(0L, TwitchChatProtocol.retryDelayMillis(-4, -1.0))
    assertTrue(TwitchChatProtocol.retryDelayMillis(30, .99) <= 60_000L)
  }
}
