/**
 * Read-only, fixed-origin probe for the independently deployed RTMP ingress.
 * This does not create an HTTP-to-RTMP gateway. It only reports the real
 * network receiver's readiness to the authenticated dashboard.
 */
export const OBS_INGRESS_STATUS_ORIGIN = 'https://sweatyobs-free-rtmp-probe.onrender.com';

export function normalizeIngressStatus(report, now = Date.now()) {
  if (!report || typeof report !== 'object') throw Error('Missing ingress report');
  const expiry = Date.parse(report.expiresAt);
  if (!Number.isFinite(expiry)) throw Error('Invalid ingress expiration');
  const active = expiry > now;
  const validEndpoint = typeof report.publicEndpoint === 'string' &&
    /^tcp:\/\/[a-z0-9][a-z0-9.-]*:[0-9]{2,5}$/i.test(report.publicEndpoint);
  const url = validEndpoint ? new URL(report.publicEndpoint.replace(/^tcp:/, 'http:')) : null;
  const port = url ? Number(url.port) : 0;
  const endpoint = validEndpoint && port >= 1 && port <= 65535
    ? 'rtmp://' + url.hostname + ':' + port + '/app/ps5' : null;
  const listening = report.mediaReceiver === 'NGINX_LISTENING' ||
    report.mediaReceiver === 'RTMP_PUBLISHER_CONNECTED';
  const tunnelReady = report.tunnel === 'PUBLIC_TCP_ASSIGNED';
  const syntheticPassed = report.syntheticProbe === 'PUBLISHED_THROUGH_PUBLIC_TCP';
  return {
    available: true,
    expiresAt: report.expiresAt,
    remainingSeconds: active ? Math.max(0, Math.floor((expiry - now) / 1000)) : 0,
    receiver: typeof report.mediaReceiver === 'string' ? report.mediaReceiver.slice(0, 64) : 'UNKNOWN',
    tunnel: typeof report.tunnel === 'string' ? report.tunnel.slice(0, 64) : 'UNKNOWN',
    syntheticPassed,
    ingestReady: Boolean(active && listening && tunnelReady && endpoint && syntheticPassed),
    endpoint: active && tunnelReady && listening ? endpoint : null,
    // There is no verified PS5 native routing or downstream publication.
    ps5NativeRouteVerified: false,
    outputToSleipnir: false,
    publicBroadcastStarted: false,
    mode: 'diagnostic_only'
  };
}

export async function fetchIngressStatus({ fetchImpl = fetch, now = Date.now, timeoutMs = 4000 } = {}) {
  const url = OBS_INGRESS_STATUS_ORIGIN + '/status';
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw Error('Ingress status unavailable');
    const data = await response.json();
    return normalizeIngressStatus(data, now());
  } catch {
    return { available: false, ingestReady: false, endpoint: null,
      ps5NativeRouteVerified: false, outputToSleipnir: false,
      publicBroadcastStarted: false, mode: 'diagnostic_only',
      reason: 'Free receiver is unavailable or asleep. Its temporary TCP port may have expired.' };
  }
}
