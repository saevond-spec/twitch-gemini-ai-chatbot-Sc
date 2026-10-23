package com.saevond.sweatyobs.ingest
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test
class TwitchRtmpsPublisherTest {
 @Test fun keysRejectUrlAndDangerousCharacters() {
   assertFalse(TwitchRtmpsPublisher.keyValid("https://live.twitch.tv/app/a"))
   assertFalse(TwitchRtmpsPublisher.keyValid("secret\ninjection"))
   assertTrue(TwitchRtmpsPublisher.keyValid("live_abcdefghijklmnop_123456"))
 }
 @Test fun sharedPublisherRequiresSecurePublicEndpointShape() {
   assertTrue(RtmpsPublisher.endpointValid("rtmps://ingest.example.com:443/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmp://ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("https://ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://user:pass@ingest.example.com/app"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://ingest.example.com/app?key=secret"))
   assertFalse(RtmpsPublisher.endpointValid("rtmps://ingest.example.com/../admin"))
 }
 @Test fun roundTripChunkedAvcAndAac() {
   for(type in listOf(8,9)) {
     val bytes = ByteArray(500){ (it and 255).toByte() }
     val media = RtmpMessage(type, 30000, 1, bytes)
     val out = ByteArrayOutputStream()
     sendRtmpMedia(out,media)
     val parsed = RtmpChunkReader(ByteArrayInputStream(out.toByteArray())).nextMessage()
     assertEquals(type,parsed.type)
     assertEquals(30000L,parsed.timestamp)
     assertArrayEquals(bytes,parsed.data)
   }
 }
 @Test fun blocksPrivateDnsDestinations() {
   val host = java.net.InetAddress.getByName("192.168.1.105")
   val loop = java.net.InetAddress.getByName("127.0.0.1")
   val publicDns = java.net.InetAddress.getByName("1.1.1.1")
   assertFalse(TwitchRtmpsPublisher.isPublicDestination(host))
   assertFalse(TwitchRtmpsPublisher.isPublicDestination(loop))
   assertTrue(TwitchRtmpsPublisher.isPublicDestination(publicDns))
 }
 @Test fun extendedTimestampRoundTrip() {
   val msg=RtmpMessage(9,0x1000000L,1,ByteArray(270){7})
   val out=ByteArrayOutputStream();sendRtmpMedia(out,msg)
   val parsed=RtmpChunkReader(ByteArrayInputStream(out.toByteArray())).nextMessage()
   assertEquals(msg.timestamp,parsed.timestamp)
   assertArrayEquals(msg.data,parsed.data)
 }
 @Test fun triesAnotherValidatedAddressWithinSharedConnectBudget() {
   val first = java.net.InetAddress.getByName("1.1.1.1")
   val second = java.net.InetAddress.getByName("8.8.8.8")
   var now = 0L
   val attempts = mutableListOf<Pair<java.net.InetAddress, Int>>()
   val result = connectFirstWorkingAddress(listOf(first, second), 1_000, nowMs = { now }) { address, timeout ->
     attempts += address to timeout
     if (address == first) {
       now += timeout
       throw SocketTimeoutException("first address unreachable")
     }
     "connected"
   }
   assertEquals("connected", result)
   assertEquals(listOf(first, second), attempts.map { it.first })
   assertTrue(attempts.sumOf { it.second } <= 1_000)
 }

}
