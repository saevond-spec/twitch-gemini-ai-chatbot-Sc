import test from 'node:test';
import assert from 'node:assert/strict';
import {generateServerConfig} from '../server/generate-config.mjs';
const data={receiverPublicIp:'8.8.4.4',receiverPrivateIp:'10.0.0.5',homePublicIp:'9.9.9.9'};
test('limited hostname mapping and home IP restrictions',()=>{
const result=generateServerConfig(data);
assert.match(result.dns,/contribute.live-video.net/);
assert.match(result.dns,/global-contribute\.live-video\.net/);
assert.deepEqual(result.receiverPublicIps,['8.8.4.4']);
assert.match(result.nginx,/allow publish 9.9.9.9/);
assert.equal(result.diagnosticOnly,true);
assert.doesNotMatch(result.nginx,/push rtmp:|application relay/);
assert.equal(result.firewall.ingress.length,3);
assert.ok(result.firewall.ingress.every(rule=>rule.source==='9.9.9.9/32'));
});
test('maps the ingest hostname to both stable managed ingress IPs',()=>{
const result=generateServerConfig({...data,receiverPublicIps:['8.8.4.4','8.8.8.8']});
assert.equal((result.dns.match(/^address=/gm)||[]).length,4);
assert.match(result.dns,/address=\/contribute\.live-video\.net\/8\.8\.4\.4/);
assert.match(result.dns,/address=\/contribute\.live-video\.net\/8\.8\.8\.8/);
assert.match(result.dns,/address=\/global-contribute\.live-video\.net\/8\.8\.4\.4/);
assert.match(result.dns,/address=\/global-contribute\.live-video\.net\/8\.8\.8\.8/);
assert.deepEqual(result.receiverPublicIps,['8.8.4.4','8.8.8.8']);
});
test('forwarding is opt-in and only adds the localhost relay hop',()=>{
const result=generateServerConfig({...data,diagnosticOnly:false});
assert.equal(result.diagnosticOnly,false);
assert.match(result.nginx,/push rtmp:\/\/127\.0\.0\.1:1935\/relay\/ps5;/);
assert.match(result.nginx,/application relay/);
});
test('reject malformed public or private addresses',()=>{
assert.throws(()=>generateServerConfig({...data,receiverPublicIp:'192.168.1.4'}));
assert.throws(()=>generateServerConfig({...data,homePublicIp:'9.9.9.9;evil'}));
assert.throws(()=>generateServerConfig({...data,receiverPrivateIp:'8.8.8.8'}));
assert.throws(()=>generateServerConfig({...data,diagnosticOnly:'false'}));
assert.throws(()=>generateServerConfig({...data,receiverPublicIps:['8.8.4.4','8.8.4.4']}));
assert.throws(()=>generateServerConfig({...data,receiverPublicIps:['192.168.1.5']}));
});
