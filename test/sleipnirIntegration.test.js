import test from 'node:test';
import assert from 'node:assert/strict';
import { SleipnirLiveState } from '../src/integrations/sleipnir/liveState.js';
import { createEncoderDiagnostics } from '../src/music/encoderDiagnostics.js';

test('Sleipnir live state is a positive live signal and expires safely', () => {
  let now = 1_000_000;
  const state = new SleipnirLiveState({ staleAfterMs: 90_000, now: () => now });

  assert.equal(state.resolveStreamContext({ live: false }).live, false);

  const accepted = state.observe({
    kind: 'encoder_connection_sample',
    sessionId: '11111111-1111-4111-8111-111111111111',
    destinations: [{
      id: 'sleipnir',
      state: 'LIVE',
      bytesPerSecond: 400_000,
      reconnects: 1,
    }],
  });
  assert.equal(accepted, true);

  const live = state.resolveStreamContext({ live: false });
  assert.equal(live.live, true);
  assert.deepEqual(live.liveSources, ['sleipnir']);
  assert.equal(live.sleipnir.state, 'LIVE');

  now += 90_001;
  const stale = state.resolveStreamContext({ live: false });
  assert.equal(stale.live, false);
  assert.equal(stale.sleipnir.fresh, false);
  assert.equal(stale.sleipnir.state, 'UNKNOWN');

  const twitchWins = state.resolveStreamContext({ live: true });
  assert.equal(twitchWins.live, true);
  assert.deepEqual(twitchWins.liveSources, ['twitch']);
});

test('encoder diagnostics accepts Sleipnir destination and Sleipnir event target', () => {
  const secret = 's'.repeat(40);
  const logged = [];
  const diagnostics = createEncoderDiagnostics({
    bridgeToken: secret,
    now: () => 1_000_000,
    logEvent: event => logged.push(event),
  });

  const session = diagnostics.issueSession('Bearer ' + secret);
  assert.equal(session.status, 200);
  const auth = 'Bearer ' + session.body.token;
  const sessionId = '22222222-2222-4222-8222-222222222222';

  const sample = diagnostics.ingest(auth, {
    samples: [{
      sessionId,
      appVersion: '0.1.10-dev.3-sleipnir',
      mode: 'public',
      ingest: {
        state: 'PUBLISHING',
        videoPackets: 100,
        audioPackets: 100,
        tcpConnections: 1,
      },
      internet: {
        validated: true,
        transport: 'wifi',
      },
      destinations: [{
        id: 'sleipnir',
        state: 'LIVE',
        queueBytes: 0,
        queueMs: 0,
        bytesPerSecond: 400_000,
        reconnects: 0,
        droppedPackets: 0,
        errorCategory: 'NONE',
      }],
      failure: null,
    }],
  });
  assert.equal(sample.status, 202);
  assert.equal(logged.at(-1).destinations[0].id, 'sleipnir');

  const events = diagnostics.ingestEvents(auth, {
    sessionId,
    appVersion: '0.1.10-dev.3-sleipnir',
    mode: 'public',
    events: [{
      sequence: 1,
      name: 'output_state_changed',
      result: 'live',
      target: 'sleipnir',
      errorCategory: 'NONE',
    }],
    droppedEvents: 0,
  });
  assert.equal(events.status, 202);
  assert.equal(logged.at(-1).target, 'sleipnir');
});
