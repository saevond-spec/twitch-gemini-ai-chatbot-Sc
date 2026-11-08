# Managed PS5 ingest path (no VM)

The intended route is a **managed container receiver behind a public Layer‑4 load balancer**. The web page remains the phone control surface; the receiver backend handles network protocols that a browser page or ordinary HTTP web service cannot accept.

## Traffic path

1. The PS5 uses the managed receiver's static public IPs as its DNS resolvers.
2. The DNS service forwards ordinary lookups upstream and rewrites Twitch's `global-contribute.live-video.net` ingest host and its `contribute.live-video.net` target domain to the receiver's static ingress IPs.
3. The same Layer‑4 ingress forwards UDP/TCP 53 to DNS and TCP 1935 to the RTMP receiver. The receiver must reject DNS and RTMP publishes from outside the home public IP allowlist.
4. For a configured stream, the receiver forwards one RTMPS feed to Sleipnir; Sleipnir then fans it out to the linked Twitch, YouTube, and Kick destinations.
5. The existing browser page can control and show status, but it does not carry the video packets itself.

Lightstream documents this PS4/PS5 Twitch-ingest DNS redirect as a workaround, and notes network setups can prevent it from working: [Lightstream PS5 setup](https://support.golightstream.com/hc/en-us/articles/38643168399769-How-do-I-set-up-my-Playstation-4-or-5-to-send-to-Lightstream-Studio). AWS ECS Fargate can attach to a Network Load Balancer, and AWS NLBs support TCP/UDP listeners and static public IPs: [Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html), [NLB listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html), [NLB static IPs](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/availability-zones.html).

## Current code status

- `generate-config.mjs` creates reviewable `dnsmasq`, `nginx-rtmp`, and firewall-rule templates. It accepts one or two managed ingress IPs. Diagnostic-only mode is the default; it does not push media to the relay.
- `multistream.mjs` validates destination URLs and builds FFmpeg arguments. `run.mjs` expects a local RTMP relay and a private destinations file.
- There is **no managed container image or cloud deployment stack in this branch yet**, no public receiver DNS address, and no live receiver deployment. The current Render service is an HTTP web app and cannot receive raw DNS/RTMP traffic.
- The callback/lifecycle wiring that starts and stops the FFmpeg fan-out when the PS5 publishes still needs implementation. Therefore, no video has been verified through this route.

## Deployment and verification gates

- Use a managed container service plus a Layer‑4 load balancer that exposes **UDP 53, TCP 53, and TCP 1935 on the required ports**. AWS ECS Fargate + NLB is one technically compatible shape; it is not a VM you administer. Fargate, the load balancer, public IPv4 addresses, logs, and outbound traffic can incur charges, so a $0 deployment is not assumed. See [Fargate pricing](https://aws.amazon.com/fargate/pricing/) and [NLB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/).
- Restrict the public listeners to the home public IPv4 address, keep the receiver's DNS resolver closed to other clients, and do not put stream keys in the web page or repository.
- Keep diagnostic mode on for deployment validation. First test DNS and synthetic RTMP with fake destinations; then test PS5 ingest privately with forwarding disabled. Only enable destination forwarding after the receiver path passes and real destination secrets are configured securely.
- A home public IP change requires updating the ingress allowlist. A provider account and billing setup are needed before the managed network resources can be created.

No real stream keys are used by the local tests. No public broadcast has been started, and no console or router DNS has been changed.
