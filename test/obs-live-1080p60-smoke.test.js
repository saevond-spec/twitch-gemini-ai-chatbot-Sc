import test from 'node:test';
import assert from 'node:assert/strict';
import { getActiveQualityProfile, buildQualityVideoArgs } from '../server/ingress-probe/platform-quality.mjs';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';
test('1080p60 high quality profile is explicitly gated and limited to 5 Mbps aggregate',()=>{
 const env={OBS_SHARED_HIGH_QUALITY_ENABLED:'true',OBS_SLEIPNIR_RELAY_ENABLED:'true',
  OBS_INGEST_PUBLISH_TOKEN:'quality-stream-test-token-123456789012345',
  OBS_SLEIPNIR_STREAM_KEY:'dummy'};
 const p=getActiveQualityProfile(env,{quality:'1080p60'});
 assert.equal(p.enabled,true);
 assert.equal(p.width,1920);
 assert.equal(p.height,1080);
 assert.ok(p.videoKbps+p.audioKbps<=5000);
 const ffmpeg=buildRelayArgs({...env,OBS_FORCE_VIDEO_REENCODE:'true'},{quality:'1080p60',overlay:true});
 assert.equal(ffmpeg[ffmpeg.indexOf('-maxrate')+1],'4500k');
 assert.ok(ffmpeg.some(x=>String(x).includes('@saevond')));
});
test('no 1080p transcoding when profile is not selected',()=>{
 const p=getActiveQualityProfile({OBS_SHARED_HIGH_QUALITY_ENABLED:'true'},{quality:'720p30'});
 assert.equal(p.enabled,false);
});
