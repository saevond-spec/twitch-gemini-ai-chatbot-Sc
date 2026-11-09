import test from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY_TARGETS,getActiveQualityProfile,buildQualityVideoArgs } from '../server/ingress-probe/platform-quality.mjs';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';

const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'quality-test-token-12345678901234567890',OBS_SLEIPNIR_STREAM_KEY:'dummy'};
test('Twitch 1440p requires Enhanced Broadcasting, not shared RTMP',()=>{
 assert.equal(QUALITY_TARGETS.twitch.height,1440);
 assert.equal(QUALITY_TARGETS.twitch.codec,'HEVC');
 assert.equal(QUALITY_TARGETS.twitch.activeWithSharedSleipnir,false);
 assert.equal(QUALITY_TARGETS.kick.height,1080);
 assert.equal(QUALITY_TARGETS.kick.videoKbps,8000);
 assert.equal(QUALITY_TARGETS.kick.activeWithSharedSleipnir,false);
});
test('Sleipnir free shared output never exceeds 5 Mbps',()=>{
 const p=getActiveQualityProfile({...env,OBS_SHARED_HIGH_QUALITY_ENABLED:'true'});
 assert.equal(p.width,1920);
 assert.equal(p.height,1080);
 assert.equal(p.videoKbps+p.audioKbps<=p.totalCapKbps,true);
 assert.equal(p.enabled,true);
});
test('full-quality relay is explicit opt-in and adds bounded H264 rate control',()=>{
 const args=buildRelayArgs({...env,OBS_SHARED_HIGH_QUALITY_ENABLED:'true',OBS_FORCE_VIDEO_REENCODE:'true'},{quality:'1080p60',overlay:true});
 assert.equal(args[args.indexOf('-maxrate')+1],'4500k');
 assert.equal(args[args.indexOf('-bufsize')+1],'9000k');
 assert.equal(args[args.indexOf('-c:v')+1],'libx264');
 assert.match(args[args.indexOf('-vf')+1],/force_original_aspect_ratio=decrease/);
 assert.match(args[args.indexOf('-vf')+1],/source_fps/);
 assert.match(args[args.indexOf('-vf')+1],/drawtext/);
});
test('1080p ceiling never increases incoming dimensions',()=>{
 const p=getActiveQualityProfile({...env,OBS_SHARED_HIGH_QUALITY_ENABLED:'true'});
 const args=buildQualityVideoArgs(p);
 const filter=args[args.indexOf('-vf')+1];
 assert.match(filter,/min\(1920,iw\)/);
 assert.match(filter,/min\(1080,ih\)/);
});
test('default safe pipeline retains video passthrough and never upscales',()=>{
 const args=buildRelayArgs(env);
 assert.equal(args[args.indexOf('-c:v')+1],'copy');
 assert.equal(args.includes('-vf'),false);
 const p=getActiveQualityProfile(env);
 assert.equal(p.enabled,false);
});
