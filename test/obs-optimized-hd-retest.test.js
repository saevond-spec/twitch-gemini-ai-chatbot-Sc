import test from 'node:test';
import assert from 'node:assert/strict';
import {getActiveQualityProfile,buildQualityVideoArgs} from '../server/ingress-probe/platform-quality.mjs';
import {buildRelayArgs} from '../server/ingress-probe/sleipnir-relay.mjs';
const env={OBS_SHARED_HIGH_QUALITY_ENABLED:'true',OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'secure-test-publish-token-123456789000',OBS_SLEIPNIR_STREAM_KEY:'mock-private-key'};
test('enabled encoder retains full HD source maximum and bitrate gate',()=>{
  const profile=getActiveQualityProfile(env,{quality:'1080p60'});
  assert.equal(profile.enabled,true);
  assert.equal(profile.videoKbps,4500);
  assert.ok(profile.videoKbps+profile.audioKbps<=profile.totalCapKbps);
  const args=buildQualityVideoArgs(profile,{overlay:true});
  assert.equal(args[args.indexOf('-preset')+1],'ultrafast');
  assert.equal(args[args.indexOf('-threads')+1],'2');
  assert.equal(args[args.indexOf('-maxrate')+1],'4500k');
  assert.ok(args[args.indexOf('-vf')+1].includes('min(1920,iw)'));
});
test('real high quality profile enabled only when selected and never alters default relay',()=>{
  assert.equal(buildRelayArgs(env,{quality:'1080p60',overlay:true}).includes('libx264'),true);
  assert.equal(buildRelayArgs(env,{quality:'720p30'}).includes('copy'),true);
});
