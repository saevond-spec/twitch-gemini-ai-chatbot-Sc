# PS5 Wi-Fi → Android RTMP: reversible DNS-only experiment

Status: **research-backed experiment, not verified on this user's PS5** (2026-10-20). No router or PS5 setting has been changed by this repository. Do not trigger public test until the listener, source verification and TLS output have been checked. Do not put keys, MAC addresses or Wi-Fi credentials in tickets.

## Evidence / why we need an exact target

Yash Garg's Sep 28, 2026 PS5 reverse-engineering found that HTTPS discovery at \`ingest.twitch.tv:443\` must **not** be redirected. One plaintext RTMP path resolved \`ingest.global-contribute.live-video.net\` (which is **not** within \`contribute.live-video.net\`), then used regional \`*.contribute.live-video.net\` on TCP **1935**. Their nginx receiver worked with the PS5 on a Mac, not on an Android phone. If PS5 chooses RTMPS on 443 or its firmware changes, a simple DNS rewrite will not capture media.

Source: https://yashgarg.dev/posts/hijacking-ps5-rtmp-stream/

## Preferred $0 DNS test (no PC, no router-wide DNS change)

1. Start the **network diagnostic only** on Android, while connected to the same home non-guest Wi-Fi. It must display **Waiting for PS5 at <PHONE_LAN_IPV4>:1935**. Note PHONE IP **on the phone**, do not use the PS5 IPv4 as the DNS rewrite target. It is the phone address that receives stream packets. Phone and PS5 must not have the same IPv4. If the phone's Wi-Fi address changes, update rewrites (or create a router DHCP reservation specifically for the phone if supported).
2. While on home Wi-Fi (not mobile data or VPN), create a permanent **free** NextDNS profile at https://my.nextdns.io, identify its unique IPv4 resolver pair, and link the home **public WAN IP** under Setup → Linked IP. The NextDNS 300k query/month free cap can disable rewrites after quota; the service continues answering normal DNS, so ingest can silently revert to Twitch. This method has not been tested on this setup; if regional DNS interception or DNS rebind filtering occurs, stop and investigate.
3. Under NextDNS **Settings → Rewrites**, configure only these two entries, each targeting the PHONE's **private IPv4**:
   - \`ingest.global-contribute.live-video.net\` → \`<PHONE_LAN_IPV4>\`
   - \`contribute.live-video.net\` → \`<PHONE_LAN_IPV4>\` (NextDNS rewrites include subdomains; verify in actual NextDNS DNS logs)
   Keep \`ingest.twitch.tv\`, all \`*.twitch.tv\` HTTPS discovery and account endpoints **unchanged**. DO NOT point arbitrary Twitch or YouTube domains at a local address.
4. Check NextDNS **Security → DNS Rebinding Protection**: private IPv4 rewrites may be blocked. Prefer scoped exceptions if supported, rather than disabling protection; if it must be disabled, it affects only the dedicated PS5 profile, not all household devices. Restore after the test.
5. On PS5, first photograph existing **DNS settings only** (no Wi-Fi password, public IP, MAC or PSN profile). Settings → Network → Settings → Set Up Internet Connection → select home Wi-Fi → Options → Advanced Settings → DNS Settings: **Manual**. Enter the **two NextDNS IPv4 resolver addresses shown for your own profile**, not the phone IP (phone is *not* a DNS server). Leave IP configuration DHCP/Automatic, MTU Automatic, proxy Don't Use; save. Avoid an alternate resolver such as 8.8.8.8 that would randomly bypass rewrites.
6. Run PS5 network connection test, check NextDNS Logs for the two domain names and regional subdomains. Start PS5 **Twitch** broadcast; monitor Android for actual PS5 TCP session, AVC/AAC sequence headers and video/audio packet counts. **Do not claim output verified** on merely receiving a socket or seeing a single packet.
7. Only when inbound PS5 media is proven, owner may explicitly initiate the public Twitch relay on Android; inspect Twitch playback independently on another device. Stop if no output, poor thermal margin, packet counts stagnant or sustained dropouts.

## DNS change rollback (30 seconds)

On PS5: Settings → Network → Settings → Set Up Internet Connection → selected Wi-Fi → Options → Advanced Settings → DNS Settings → **Automatic** (or restore the previous custom resolvers). Delete both NextDNS Rewrites / unlink test profile. If PS5 broadcast remains inaccessible, stop the broadcast, reconnect Wi-Fi and retest normal direct Twitch broadcast. **Never touch your household router's DNS without a separate explicit decision.** DNS cannot transparently redirect TLS with an untrusted certificate.

## Wi-Fi bandwidth model (illustrative, not a measured benchmark)

Let R denote total incoming H264+AAC stream bitrate in **Mbps**, U denote **measured steady upload** of the home internet, and h denote a conservative traffic/airtime inefficiency fraction between 0 and 1.

With PS5 → Wi-Fi AP → Android phone → Wi-Fi AP → internet, the same media traverses approximately **three Wi-Fi radio transmissions** on a conventional single-AP network, so a rough necessary radio-delivery budget is

  G >= 3R / (1-h) Mbps equivalent of available Wi-Fi air-time goodput

while WAN upload should have a margin

  U >= 1.3R Mbps.

Illustrations: R=4.5 Mbps and h=0.20 suggests G >=16.875 Mbps airtime-equivalent and WAN >=5.85 Mbps. R=6 Mbps gives G >=22.5 Mbps airtime-equivalent and WAN >=7.8 Mbps. This is a **screening model**, not a throughput/latency guarantee; actual airtime depends heavily on link PHY rates, retransmits, frequency band, Wi-Fi contention and router AP isolation. If PS5 and phone are on 2.4 GHz congested Wi-Fi, prefer an uncongested 5 GHz network where supported. Select PS5 720p60 first if supported; the Android relay does **not** transcode and cannot lower an already-encoded incoming bitrate.

## Fail-closed limits

- No PS5 firmware, NAT, open internet ports, credentials or DNS-over-HTTPS MITM. No network-wide modifications.
- Never intercept \`ingest.twitch.tv\` TLS 443 discovery. Never route PS5's stream directly to a public third-party IP.
- Do not install an APK based solely on unit tests. Synthetic TCP integration + emulator + actual console packet capture + independent Twitch playback are different evidence levels.
- No automation that takes the stream public without explicit, user-visible Start.
- A DNS rewrite toward the phone captures the console's Twitch stream and can interrupt its existing direct Twitch transmission. Start a new test broadcast, not an important ongoing stream.

References:
- https://yashgarg.dev/posts/hijacking-ps5-rtmp-stream/
- https://nextdns.io/pricing
- https://help.nextdns.io/t/g9hmvan/what-is-linked-ip
- https://help.nextdns.io/t/35hjt2x/non-wildcard-dns-rewrites
- https://help.nextdns.io/t/35hmval/what-is-dns-rebinding-protection
- https://help.twitch.tv/s/twitch-ingest-recommendation
