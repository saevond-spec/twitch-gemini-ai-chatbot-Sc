import test from 'node:test';
import assert from 'node:assert/strict';
import {generateServerConfig} from '../server/generate-config.mjs';
const data={receiverPublicIp:'8.8.4.4',receiverPrivateIp:'10.0.0.5',homePublicIp:'9.9.9.9'};
test('limited hostname mapping and home IP restrictions',()=>{
const result=generateServerConfig(data);
assert.match(result.dns,/address=\/ingest\.global-contribute\.live-video\.net\/8\.8\.4\.4/);
assert.match(result.dns,/address=\/contribute\.live-video\.net\/8\.8\.4\.4/);
assert.doesNotMatch(result.dns,/ingest\.twitch\.tv/);
assert.match(result.nginx,/allow publish 9.9.9.9/);
assert.match(result.nginx,/push rtmp:\/\/127\.0\.0\.1:1935\/relay\/ps5/);
assert.equal(result.firewall.ingress.length,3);
assert.ok(result.firewall.ingress.every(rule=>rule.source==='9.9.9.9/32'));
});
test('reject malformed public or private addresses',()=>{
assert.throws(()=>generateServerConfig({...data,receiverPublicIp:'192.168.1.4'}));
assert.throws(()=>generateServerConfig({...data,homePublicIp:'9.9.9.9;evil'}));
assert.throws(()=>generateServerConfig({...data,receiverPrivateIp:'8.8.8.8'}));
});
