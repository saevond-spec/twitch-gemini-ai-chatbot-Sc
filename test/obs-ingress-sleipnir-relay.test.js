import test from 'node:test';
import assert from 'node:assert/strict';
import { relayConfiguration, authorizePublisher, buildRelayArgs, SLEIPNIR_RTMP_SERVER } from '../server/ingress-probe/sleipnir-relay.mjs';

const good = { OBS_SLEIPNIR_RELAY_ENABLED:'true', OBS_INGEST_PUBLISH_TOKEN:'private-test-token-12345678901234567890',
  OBS_SLEIPNIR_STREAM_KEY:'mock-sleipnir-secret' };
const payload = 'app=secure&name=' + good.OBS_INGEST_PUBLISH_TOKEN;
test('relay is opt-in and fails closed without configuration', () => {
  assert.equal(relayConfiguration({}).ready, false);
  assert.equal(relayConfiguration({...good, OBS_SLEIPNIR_RELAY_ENABLED:'false'}).ready, false);
  assert.equal(relayConfiguration({...good, OBS_INGEST_PUBLISH_TOKEN:'short'}).ready, false);
  assert.equal(relayConfiguration({...good, OBS_SLEIPNIR_STREAM_KEY:''}).ready, false);
  assert.throws(()=>buildRelayArgs({}),/RELAY_DISABLED/);
});
test('publish callback accepts only exact token for secure app', () => {
  assert.equal(authorizePublisher(payload,good),true);
  assert.equal(authorizePublisher('app=app&name='+good.OBS_INGEST_PUBLISH_TOKEN,good),false);
  assert.equal(authorizePublisher('app=secure&name=wrong',good),false);
  assert.equal(authorizePublisher(payload,{}),false);
  assert.equal(authorizePublisher(payload+'&name=duplicate',good),false);
  assert.equal(authorizePublisher('x'.repeat(4100),good),false);
});
test('valid relay copies video and forwards to whitelisted Sleipnir RTMPS', () => {
  const args = buildRelayArgs(good);
  assert.equal(args[args.indexOf('-c:v')+1], 'copy');
  assert.equal(args[args.indexOf('-i')+1],'rtmp://127.0.0.1:1935/secure/'+good.OBS_INGEST_PUBLISH_TOKEN);
  assert.equal(args.at(-1),SLEIPNIR_RTMP_SERVER+'/mock-sleipnir-secret');
  assert.equal(args.filter(x=>x==='-i').length,1);
});
test('invalid tokens and keys cannot enable public relay', () => {
  assert.equal(relayConfiguration({...good, OBS_INGEST_PUBLISH_TOKEN:'not safe /'.padEnd(32,'x')}).ready,false);
  assert.equal(relayConfiguration({...good, OBS_SLEIPNIR_STREAM_KEY:'key with spaces'}).ready,false);
  assert.equal(relayConfiguration({...good, OBS_SLEIPNIR_STREAM_KEY:'hello\nworld'}).ready,false);
});
