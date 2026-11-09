import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';
import { getActiveQualityProfile } from '../server/ingress-probe/platform-quality.mjs';

const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'test-authorized-publisher-token-123456789',
 OBS_SLEIPNIR_STREAM_KEY:'not-a-real-key',OBS_SHARED_HIGH_QUALITY_ENABLED:'true'};
test('heavy gaming test relay uses H264 passthrough ONLY behind two flags',()=>{
 const on={...env,OBS_PUBLIC_SMOKE_TEST:'true',OBS_HEAVY_MOTION_SMOKE_TEST:'true'};
 const args=buildRelayArgs(on,{quality:'1080p60',testPassthrough:true,overlay:false});
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
 assert.equal(args.includes('-vf'),false);
 for(const off of [env,{...env,OBS_PUBLIC_SMOKE_TEST:'true'},{...env,OBS_HEAVY_MOTION_SMOKE_TEST:'true'}]){
   const a=buildRelayArgs(off,{quality:'1080p60',testPassthrough:true});
   assert.equal(a[a.indexOf('-c:v')+1],'libx264');
 }
});
test('heavy stress does not replace normal selected high quality encoder',()=>{
 const a=buildRelayArgs(env,{quality:'1080p60',overlay:true});
 assert.equal(a[a.indexOf('-c:v')+1],'libx264');
 assert.equal(a[a.indexOf('-maxrate')+1],'4500k');
 assert.equal(getActiveQualityProfile(env,{quality:'1080p60'}).enabled,true);
});
