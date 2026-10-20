# SweatyClanker OBS independent backend (prototype)

**No GoLightstream. No Android APK.** The web browser only controls the system; a Linux VM runs DNS routing, RTMP reception, FFmpeg mixing, and RTMPS fan-out. There is no verified free VM or live deployment yet.

## Deployment prerequisites
- Owner-operated Linux VM with public IPv4, UDP/TCP 53 and TCP 1935.
- Install dnsmasq, nginx with nginx-rtmp module, FFmpeg, and Node.js 22.
- DNS must override only the PS5 Twitch RTMP hostname `contribute.live-video.net` to your server public IPv4. The PS5 may use RTMPS instead; that cannot be redirected by DNS. Never defeat TLS checks.
- Lock VM inbound TCP 1935 and UDP/TCP 53 to your own **home public IPv4** at the cloud firewall AND the Linux firewall. Never create a public recursive DNS server. Do not change the household router's DNS globally.
- `server/generate-config.mjs` provides reviewable dnsmasq, nginx-rtmp and firewall templates. VM configuration varies by distro and cloud. No automatically executed installation script.
- nginx-rtmp should accept the PS5's publish stream, push to local `rtmp://127.0.0.1:1935/relay/ps5`. This mapping is untested against actual PS5 traffic.
- `server/multistream.mjs` accepts that **local** RTMP input, mixes 48k stereo local licensed audio with the PS5 game audio (the music PCM feeder lives in `encoder/encoder.mjs`), and builds FFmpeg outputs for Twitch/YouTube/Kick using single H.264 copy + one AAC encode.
- Use actual **private** RTMPS URLs/keys from each streaming platform. Never commit or screenshot them. Confirm cross-platform music licenses and each platform's simulcasting rules.
- The protected SweatyClanker `/api/encoder/commands` endpoint provides `!play` events; use only a strong 32+ character bridge token in the bot and server environments.
- Test with synthetic RTMP ingress first, then PS5 (if compatible), then live viewer checks. Revert PS5 DNS to previous values on any failure.
- Always Free hosting is subject to capacity and eligibility. Oracle signup commonly requires a card for verification. **Do not assume VM creation or continuous multi-platform egress is free without checking.**
- Keep PR #48 unmerged until CI, ingress, output and privacy checks all pass.

## Network planning
720p30 at 3500 kbps video + 160 kbps AAC = 3.66 Mbps per output. Three platforms need 10.98 Mbps plus overhead, so budget at least 15.69 Mbps stable upload with 30% headroom. About 4.6 GiB per hour (3 platforms) exits the server (~3.3 TiB per 30-day month). Cloud egress billing/limits are a major blocker to a guaranteed $0 service.

## Important gaps
- No operator-owned public DNS server is running.
- No PS5 has connected to our RTMP receiver.
- Browser dashboard is read-only, not an actual video processor.
- No end-to-end Twitch music audio verification.
- A working background VM and usage allowance are prerequisites.
