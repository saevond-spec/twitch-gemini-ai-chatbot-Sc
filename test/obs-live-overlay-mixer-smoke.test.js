import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';
const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'test-token-1234567890123456789012345',OBS_SLEIPNIR_STREAM_KEY:'mock-key',OBS_FORCE_VIDEO_REENCODE:'true'};
test('explicit overlay + tone test renders branded H264 and AAC-mixed music without real tracks',()=>{
 const args=buildRelayArgs(env,{syntheticTestTone:true,overlay:true});
 const filter=args[args.indexOf('-filter_complex')+1];
 assert.match(filter,/sine|amix=inputs=2/);
 assert.match(filter,/volume=0.22/);
 assert.match(filter,/volume=0.85/);
 assert.ok(args.some(x=>typeof x==='string' && x.includes('drawtext=text=')));
 assert.equal(args[args.indexOf('-c:v')+1],'libx264');
 assert.equal(args.at(-1),'rtmps://ingest.sleipnir.tv:1936/live/mock-key');
});
test('normal relay never generates a tone or branded overlay without explicit settings',()=>{
 const args=buildRelayArgs(env,{});
 assert.ok(!args.some(x=>typeof x==='string'&&x.includes('sine=frequency')));
 assert.ok(!args.includes('-vf'));
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
});
