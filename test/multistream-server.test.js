import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMultistreamArgs, validateDestinations, estimateWan } from '../server/multistream.mjs';
const destinations = [
{platform:'twitch',url:'rtmps://twitch.example.com/app/test'},
{platform:'youtube',url:'rtmps://youtube.example.com/app/test'},
{platform:'kick',url:'rtmps://kick.example.com/app/test'}];
test('one to three unique destinations',()=>{
assert.equal(validateDestinations(destinations).length,3);
assert.throws(()=>validateDestinations([]));
assert.throws(()=>validateDestinations([destinations[0],destinations[0]]));
});
test('rejects insecure transport, SSRF and FFmpeg tee delimiter injection',()=>{
for(const url of ['rtmp://twitch.example.com/app/test','rtmps://127.0.0.1/app/test',
'rtmps://localhost/app/test','rtmps://example.com/app/test|evil','http://example.com/'])
assert.throws(()=>validateDestinations([{platform:'twitch',url}]));
});
test('copy video once; encode mixed audio once for three outputs',()=>{
const args=buildMultistreamArgs({source:'rtmp://127.0.0.1:1935/relay/ps5',destinations});
assert.deepEqual(args.slice(args.indexOf('-c:v'),args.indexOf('-c:v')+2),['-c:v','copy']);
assert.match(args[args.indexOf('-filter_complex')+1],/amix=inputs=2/);
assert.equal(args.at(-2),'tee');
});
test('offline test allowed only by explicit opt-in',()=>{
assert.equal(buildMultistreamArgs({source:'/tmp/gameplay.mp4',allowLocalTest:true,localTestOutput:'/tmp/mixed.flv'}).at(-1),'/tmp/mixed.flv');
assert.throws(()=>buildMultistreamArgs({source:'/tmp/gameplay.mp4',destinations}));
});
test('three outputs need 15+ Mbps stable uplink budget',()=>{
const estimate=estimateWan({destinations:3});
assert.equal(estimate.outgoingMbps,10.98);
assert.ok(estimate.minimumStableUploadMbps>15);
});
