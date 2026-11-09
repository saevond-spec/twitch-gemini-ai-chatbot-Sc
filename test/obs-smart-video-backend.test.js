import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseVideoMode } from '../server/ingress-probe/backend-video-mode.mjs';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';
const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'token-123456789012345678901234567890',OBS_SLEIPNIR_STREAM_KEY:'mock',OBS_SHARED_HIGH_QUALITY_ENABLED:'true'};
test('requested 1080p60 remains enabled but video is copied to avoid free CPU overload',()=>{
 const decision=chooseVideoMode(env,{quality:'1080p60'});
 assert.equal(decision.highQuality,true);
 assert.equal(decision.videoMode,'copy');
 const args=buildRelayArgs(env,{quality:'1080p60'});
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
 assert.equal(args[args.indexOf('-c:a')+1],'aac');
});
test('burned-in overlay request is deferred rather than claiming it was rendered',()=>{
 const decision=chooseVideoMode(env,{quality:'1080p60',overlay:true});
 assert.equal(decision.reason,'OVERLAY_DEFERRED_CPU_LIMIT');
 assert.equal(decision.overlayApplied,false);
 const args=buildRelayArgs(env,{quality:'1080p60',overlay:true});
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
 assert.equal(args.includes('-vf'),false);
});
test('administrator can explicitly request expensive burned-in overlay encoding',()=>{
 const on={...env,OBS_FORCE_VIDEO_REENCODE:'true'};
 const decision=chooseVideoMode(on,{quality:'1080p60',overlay:true});
 assert.equal(decision.videoMode,'bounded-encode');
 assert.equal(decision.overlayApplied,true);
 const args=buildRelayArgs(on,{quality:'1080p60',overlay:true});
 assert.equal(args[args.indexOf('-c:v')+1],'libx264');
 assert.equal(args[args.indexOf('-maxrate')+1],'4500k');
});
test('independent heavy motion test bypass remains gated',()=>{
 const on={...env,OBS_PUBLIC_SMOKE_TEST:'true',OBS_HEAVY_MOTION_SMOKE_TEST:'true'};
 assert.equal(chooseVideoMode(on,{testPassthrough:true,quality:'1080p60'}).reason,'EXPLICIT_TEST_PASSTHROUGH');
 assert.equal(chooseVideoMode(env,{testPassthrough:true,quality:'1080p60'}).reason,'HIGH_QUALITY_PASSTHROUGH');
});
