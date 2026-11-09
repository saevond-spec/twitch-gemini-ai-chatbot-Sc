import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIngressStatus, fetchIngressStatus, OBS_INGRESS_STATUS_ORIGIN } from '../src/encoder/obsIngressStatus.js';

const now = Date.parse('2026-11-09T10:00:00Z');
const healthy = {
  expiresAt:'2026-11-09T10:10:00Z',
  publicEndpoint:'tcp://example.run.pinggy-free.link:43871',
  tunnel:'PUBLIC_TCP_ASSIGNED',
  mediaReceiver:'NGINX_LISTENING',
  syntheticProbe:'PUBLISHED_THROUGH_PUBLIC_TCP'
};
test('dashboard exposes temporary usable RTMP URL for compatible senders only', () => {
  const result = normalizeIngressStatus(healthy, now);
  assert.equal(result.ingestReady, true);
  assert.equal(result.endpoint, 'rtmp://example.run.pinggy-free.link:43871/app/ps5');
  assert.equal(result.ps5NativeRouteVerified, false);
  assert.equal(result.outputToSleipnir, false);
  assert.equal(result.publicBroadcastStarted, false);
  assert.equal(result.remainingSeconds, 600);
});
test('relaying state and unauthorized publisher rejection are safely exposed without credentials', () => {
  const r = normalizeIngressStatus({...healthy,relay:'DISABLED',authRejectionProbe:'REJECTED_AS_EXPECTED'},now);
  assert.equal(r.relay, 'DISABLED');
  assert.equal(r.authRejectionPassed, true);
  assert.equal(r.publicBroadcastStarted, false);
});

test('failed synthetic publish, expired route, or stopped receiver fails closed', () => {
  assert.equal(normalizeIngressStatus({...healthy,syntheticProbe:'FAILED_EXIT_1'},now).ingestReady,false);
  assert.equal(normalizeIngressStatus({...healthy,expiresAt:'2026-11-09T09:59:59Z'},now).endpoint,null);
  assert.equal(normalizeIngressStatus({...healthy,mediaReceiver:'NGINX_EXITED_1'},now).endpoint,null);
});
test('invalid and suspicious endpoints are not exposed', () => {
  for (const publicEndpoint of ['tcp://127.0.0.1:0', 'tcp://host:99999', 'http://host:1234', 'tcp://host:1935/evil', 'tcp://user@host:1935']) {
    const result = normalizeIngressStatus({...healthy,publicEndpoint},now);
    assert.equal(result.ingestReady,false,publicEndpoint);
  }
});
test('only fixed trusted status URL is fetched, with no redirects', async () => {
  let captured;
  const status = await fetchIngressStatus({now:()=>now,fetchImpl:async (url,opts)=>{
    captured={url,opts};
    return {ok:true,json:async()=>healthy};
  }});
  assert.equal(captured.url, OBS_INGRESS_STATUS_ORIGIN + '/status');
  assert.equal(captured.opts.redirect,'error');
  assert.equal(status.ingestReady,true);
});
test('offline or unresponsive probe does not pretend to have video', async () => {
  const result=await fetchIngressStatus({fetchImpl:async()=>{throw Error('offline')}});
  assert.equal(result.ingestReady,false);
  assert.equal(result.endpoint,null);
  assert.equal(result.publicBroadcastStarted,false);
});