package com.saevond.sweatyobs.ingest
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
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
 @Test fun largeFrameUsesOneSocketWriteAndRetainsDefaultChunkFraming() {
   val payload = ByteArray(24 * 1024) { (it * 31).toByte() }
   val media = RtmpMessage(9, 30000, 1, payload)
   val output = CountingOutputStream()
   sendRtmpMedia(output, media)
   assertEquals("One coalesced write per RTMP media message", 1, output.writeCalls)
   val parsed = RtmpChunkReader(ByteArrayInputStream(output.bytes.toByteArray())).nextMessage()
   assertEquals(media.timestamp, parsed.timestamp)
   assertEquals(media.type, parsed.type)
   assertArrayEquals(payload, parsed.data)
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

 private class CountingOutputStream : OutputStream() {
   val bytes = ByteArrayOutputStream()
   var writeCalls = 0
   override fun write(value: Int) {
     writeCalls++
     bytes.write(value)
   }
   override fun write(data: ByteArray, offset: Int, length: Int) {
     writeCalls++
     bytes.write(data, offset, length)
   }
 }
}
