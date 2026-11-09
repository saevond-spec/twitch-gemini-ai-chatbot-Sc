import test from 'node:test';
import assert from 'node:assert/strict';
import { receiverArgs } from '../server/web-receiver-agent.mjs';

const config = {
  relayUrl: 'rtmps://ingest.sleipnir.tv:1936/live',
  streamKey: 'unit-test-fake-key',
  receiverAddress: '',
  profile: { quality: '540p30', gameVolume: 85 }
};

test('diagnostic direct receiver opens native RTMP listener without publishing to Sleipnir', () => {
  const args = receiverArgs('diagnostic', config, { inputMode: 'direct-rtmp' });
  assert.ok(args.includes('-listen'));
  assert.equal(args[args.indexOf('-listen') + 1], '1');
  assert.equal(args[args.indexOf('-i') + 1], 'rtmp://0.0.0.0:1935/app');
  assert.deepEqual(args.slice(-7), ['-map','0:v:0','-map','0:a:0?','-f','null','-']);
  assert.ok(!args.join(' ').includes('unit-test-fake-key'));
});

test('existing nginx media route remains the default for compatibility', () => {
  const args = receiverArgs('diagnostic', config);
  assert.ok(!args.includes('-listen'));
  assert.equal(args[args.indexOf('-i') + 1], 'rtmp://127.0.0.1:1935/relay/ps5');
});

test('direct broadcast uses one upstream Sleipnir destination', () => {
  const args = receiverArgs('start', config, { inputMode: 'direct-rtmp' });
  assert.equal(args.filter(x => x === '-i').length, 1);
  assert.equal(args.filter(x => x === '-f').length, 1);
  assert.equal(args.at(-1), 'rtmps://ingest.sleipnir.tv:1936/live/unit-test-fake-key');
});

test('unknown mode and action fail closed', () => {
  assert.throws(() => receiverArgs('diagnostic', config, { inputMode: 'http' }), /Unsupported/);
  assert.throws(() => receiverArgs('publish', config), /Unknown receiver action/);
});
