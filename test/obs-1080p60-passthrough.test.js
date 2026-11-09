import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';
const config = {OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'secure-test-publisher-token-123456789abc',OBS_SLEIPNIR_STREAM_KEY:'test-secret-key',OBS_SHARED_HIGH_QUALITY_ENABLED:'true'};
test('explicit bounded passthrough copies source 1080p60 H264 to Sleipnir',()=>{
 const args=buildRelayArgs({...config,OBS_PUBLIC_SMOKE_TEST:'true',OBS_1080P60_PASSTHROUGH_TEST:'true'},{quality:'1080p60',testPassthrough:true,overlay:false});
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
 assert.equal(args.includes('-vf'),false);
 assert.equal(args[args.indexOf('-c:a')+1],'aac');
});
test('passthrough cannot be selected without both explicit test flags',()=>{
 for (const env of [config,{...config,OBS_PUBLIC_SMOKE_TEST:'true'},{...config,OBS_1080P60_PASSTHROUGH_TEST:'true'}]) {
  const args=buildRelayArgs(env,{quality:'1080p60',testPassthrough:true,overlay:false});
  assert.equal(args[args.indexOf('-c:v')+1],'copy');
 }
});
