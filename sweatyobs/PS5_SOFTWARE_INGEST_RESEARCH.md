# SweatyOBS PS5 ingest: current engineering status

SweatyOBS has an Android RTMP receiver and independent RTMPS outputs. The code path receives PS5 media over the local network, passes H.264 video through, mixes supported AAC audio with selected licensed music, and sends the result to selected destinations. There is no screen capture, overlay compositor, or video re-encode.

## What remains unverified

- No retail PS5 has yet been confirmed to send a compatible unencrypted RTMP stream to the Android receiver on this network. PS5 firmware, account, transport, and regional ingest choices can change the result.
- A successful TCP connection or packet count alone does not prove decodable media or successful platform playback. Check AVC/AAC sequence headers, output states, and independent viewers.
- Phone thermal behavior, sustained Wi-Fi performance, audio/video sync, and multi-hour reliability still require a real-device test.

Public proof-of-concept work describes redirecting a PS5 broadcast's RTMP hostname to a controlled receiver. It does not guarantee compatibility on this device or network: https://yashgarg.dev/posts/hijacking-ps5-rtmp-stream/ and https://github.com/Aioros/console-streaming-server.

## Safe test boundary

- Use only an operator-owned PS5 and a private receiver on the same LAN. Keep DNS or network changes limited to the PS5 and document how to restore its previous settings.
- Do not redirect TLS discovery or bypass certificate validation. Do not point arbitrary streaming domains at a local or third-party destination.
- Do not share stream keys, PSN credentials, Wi-Fi passwords, or local network identifiers in reports.
- Automated tests use synthetic media and fake destinations. Public broadcasting and retail-PS5 compatibility require explicit real-device testing.
