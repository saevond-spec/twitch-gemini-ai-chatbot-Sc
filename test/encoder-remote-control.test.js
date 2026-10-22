import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncoderRemoteControl } from '../sweatyobs/server/remoteControl.mjs';

const BRIDGE = 'synthetic-encoder-bridge-token-not-a-live-secret-2026';
const HOST = `Bearer ${BRIDGE}`;
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const RESTARTED_INSTANCE = '22222222-2222-4222-8222-222222222222';

function setup(options = {}) {
  let time = 1_800_000_000_000;
  const remote = createEncoderRemoteControl({
    hostToken: BRIDGE,
    now: () => time,
    sessionTtlMs: 60_000,
    hostTimeoutMs: 10_000,
    ...options,
  });
  return { remote, advance: ms => { time += ms; } };
}

test('remote control issues short-lived opaque sessions and requires them for phone calls', () => {
  const { remote, advance } = setup();
  const { sessionToken, expiresInSeconds } = remote.issueSession();
  assert.equal(sessionToken.length, 43);
  assert.equal(expiresInSeconds, 60);
  assert.equal(remote.phoneStatus('').status, 401);
  assert.equal(remote.phoneStatus(`Bearer ${sessionToken}`).status, 200);
  advance(60_001);
  assert.equal(remote.phoneStatus(`Bearer ${sessionToken}`).status, 401);
});

test('locking revokes the phone session immediately', () => {
  const { remote } = setup();
  const token = remote.issueSession().sessionToken;
  assert.equal(remote.phoneStatus(`Bearer ${token}`).status, 200);
  assert.deepEqual(remote.revokeSession(`Bearer ${token}`), { status: 200, body: { revoked: true } });
  assert.equal(remote.phoneStatus(`Bearer ${token}`).status, 401);
  assert.equal(remote.revokeSession(`Bearer ${token}`).status, 401);
});

test('start requires a fresh host and stale start intent is discarded after a lost heartbeat', () => {
  const { remote, advance } = setup();
  const session = `Bearer ${remote.issueSession().sessionToken}`;
  assert.equal(remote.submitAction(session, { action: 'start' }).status, 409);
  const initialPoll = remote.hostPoll(HOST, '', INSTANCE);
  assert.equal(initialPoll.body.desiredState, 'STOPPED');
  const start = remote.submitAction(session, { action: 'start' });
  assert.equal(start.status, 202);
  assert.equal(start.body.desiredState, 'RUNNING');
  assert.equal(start.body.hostConnected, true);
  assert.equal(remote.submitAction(session, { action: 'reconnect' }).status, 202);

  const startPoll = remote.hostPoll(HOST, initialPoll.body.cursor, INSTANCE);
  assert.equal(startPoll.body.desiredState, 'RUNNING');
  assert.deepEqual(startPoll.body.commands.map(command => command.action), ['start', 'reconnect']);
  advance(10_001);
  const afterReconnect = remote.hostPoll(HOST, startPoll.body.cursor, INSTANCE);
  assert.equal(afterReconnect.body.desiredState, 'STOPPED');
  assert.deepEqual(afterReconnect.body.commands, []);

  const freshStart = remote.submitAction(session, { action: 'start' });
  assert.equal(freshStart.status, 202);
  assert.equal(remote.submitAction(session, {
    action: 'start', streamKey: 'must-not-be-accepted',
  }).status, 400);

  const firstPoll = remote.hostPoll(HOST, afterReconnect.body.cursor, INSTANCE);
  assert.equal(firstPoll.status, 200);
  assert.equal(firstPoll.body.desiredState, 'RUNNING');
  assert.equal(firstPoll.body.reset, false);

  const cursor = firstPoll.body.cursor;
  remote.submitAction(session, { action: 'stop' });
  const nextPoll = remote.hostPoll(HOST, cursor, INSTANCE);
  assert.equal(nextPoll.body.desiredState, 'STOPPED');
  assert.deepEqual(nextPoll.body.commands.map(command => command.action), ['stop']);
  assert.equal(JSON.stringify(nextPoll.body).includes('streamKey'), false);
});

test('stopping before the host polls cancels a queued start', () => {
  const { remote } = setup();
  const session = `Bearer ${remote.issueSession().sessionToken}`;
  const initialPoll = remote.hostPoll(HOST, '', INSTANCE);
  assert.equal(remote.submitAction(session, { action: 'start' }).status, 202);
  assert.equal(remote.submitAction(session, { action: 'stop' }).status, 202);
  const poll = remote.hostPoll(HOST, initialPoll.body.cursor, INSTANCE);
  assert.equal(poll.body.desiredState, 'STOPPED');
  assert.equal(poll.body.commands.some(command => command.action === 'start'), false);
});

test('remote host bridge is separately authenticated and rejects malformed status', () => {
  const { remote } = setup();
  assert.equal(remote.hostPoll('Bearer wrong-token').status, 401);
  remote.hostPoll(HOST, '', INSTANCE);
  assert.equal(remote.reportHostStatus(HOST, { state: 'LIVE', key: 'secret' }, INSTANCE).status, 400);
  assert.equal(remote.reportHostStatus(HOST, {
    state: 'RUNNING_UNVERIFIED',
    desiredRunning: true,
    outputProgress: true,
    outputs: [
      { platform: 'twitch', state: 'LIVE_UNVERIFIED', bitrateKbps: 6000, reconnects: 0, droppedPackets: null, errorCode: 'NONE' },
      { platform: 'youtube', state: 'FAILED', bitrateKbps: null, reconnects: 1, droppedPackets: null, errorCode: 'NETWORK' },
    ],
  }, INSTANCE).status, 202);

  const session = `Bearer ${remote.issueSession().sessionToken}`;
  const status = remote.phoneStatus(session).body;
  assert.equal(status.hostConnected, true);
  assert.equal(status.outputProgress, true);
  assert.deepEqual(status.outputs.map(output => output.platform), ['twitch', 'youtube']);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('rtmps'), false);
});

test('active remote stream survives a control API outage longer than the host lease', () => {
  const { remote, advance } = setup();
  const session = `Bearer ${remote.issueSession().sessionToken}`;
  const initialPoll = remote.hostPoll(HOST, '', INSTANCE);
  assert.equal(remote.submitAction(session, { action: 'start' }).status, 202);
  const started = remote.hostPoll(HOST, initialPoll.body.cursor, INSTANCE);
  assert.equal(started.body.desiredState, 'RUNNING');
  assert.equal(remote.reportHostStatus(HOST, {
    state: 'RUNNING_UNVERIFIED',
    desiredRunning: true,
    outputProgress: true,
    outputs: [
      { platform: 'twitch', state: 'LIVE_UNVERIFIED', bitrateKbps: 6000, reconnects: 0, droppedPackets: null, errorCode: 'NONE' },
    ],
  }, INSTANCE).status, 202);

  advance(10_001);
  const resumed = remote.hostPoll(HOST, started.body.cursor, INSTANCE);
  assert.equal(resumed.body.desiredState, 'RUNNING');
  assert.equal(resumed.body.commands.length, 0);
  assert.equal(remote.phoneStatus(session).body.outputProgress, true);
});

test('host timeout is shown as offline and disabled bridge fails closed', () => {
  const { remote, advance } = setup();
  const session = `Bearer ${remote.issueSession().sessionToken}`;
  remote.hostPoll(HOST, '', INSTANCE);
  advance(10_001);
  const status = remote.phoneStatus(session);
  assert.equal(status.body.hostConnected, false);
  assert.equal(status.body.state, 'OFFLINE');

  const disabled = createEncoderRemoteControl({ hostToken: '' });
  const disabledSession = `Bearer ${disabled.issueSession().sessionToken}`;
  assert.equal(disabled.submitAction(disabledSession, { action: 'start' }).status, 503);
  assert.equal(disabled.phoneStatus(disabledSession).body.state, 'NOT_CONFIGURED');
});

test('a restarted encoder host cannot inherit a prior RUNNING intent', () => {
  const { remote, advance } = setup();
  const session = `Bearer ${remote.issueSession().sessionToken}`;
  const initial = remote.hostPoll(HOST, '', INSTANCE);
  const activeConflict = remote.hostPoll(HOST, '', RESTARTED_INSTANCE);
  assert.equal(activeConflict.status, 409, 'a second live host instance cannot steal the lease');
  assert.equal(activeConflict.body.code, 'HOST_INSTANCE_ACTIVE');
  assert.equal(remote.submitAction(session, { action: 'start' }).status, 202);
  const started = remote.hostPoll(HOST, initial.body.cursor, INSTANCE);
  assert.equal(started.body.desiredState, 'RUNNING');
  assert.equal(remote.reportHostStatus(HOST, {
    state: 'RUNNING_UNVERIFIED', desiredRunning: true, outputProgress: true,
    outputs: [
      { platform: 'twitch', state: 'LIVE_UNVERIFIED', bitrateKbps: 6000, reconnects: 0, droppedPackets: null, errorCode: 'NONE' },
    ],
  }, INSTANCE).status, 202);

  advance(10_001);
  const afterRestart = remote.hostPoll(HOST, '', RESTARTED_INSTANCE);
  assert.equal(afterRestart.body.desiredState, 'STOPPED');
  assert.deepEqual(afterRestart.body.commands, []);
  assert.equal(remote.hostPoll(HOST, '', INSTANCE).status, 409,
    'a superseded process must receive a fencing response on its next poll');
  assert.equal(remote.reportHostStatus(HOST, {
    state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [],
  }, INSTANCE).status, 409, 'old host process cannot overwrite the new instance status');
});

test('control API restart fails closed to STOPPED even if its old host had been streaming', () => {
  let time = 1_800_000_000_000;
  const firstApi = createEncoderRemoteControl({ hostToken: BRIDGE, now: () => time, hostTimeoutMs: 10_000 });
  const session = `Bearer ${firstApi.issueSession().sessionToken}`;
  const initial = firstApi.hostPoll(HOST, '', INSTANCE);
  assert.equal(firstApi.submitAction(session, { action: 'start' }).status, 202);
  const started = firstApi.hostPoll(HOST, initial.body.cursor, INSTANCE);
  assert.equal(started.body.desiredState, 'RUNNING');
  const runningStatus = {
    state: 'RUNNING_UNVERIFIED', desiredRunning: true, outputProgress: true,
    outputs: [
      { platform: 'twitch', state: 'LIVE_UNVERIFIED', bitrateKbps: 6000, reconnects: 0, droppedPackets: null, errorCode: 'NONE' },
    ],
  };
  assert.equal(firstApi.reportHostStatus(HOST, runningStatus, INSTANCE).status, 202);

  const restartedApi = createEncoderRemoteControl({ hostToken: BRIDGE, now: () => time, hostTimeoutMs: 10_000 });
  const resynced = restartedApi.hostPoll(HOST, '', INSTANCE);
  assert.equal(resynced.body.desiredState, 'STOPPED');
  assert.equal(restartedApi.reportHostStatus(HOST, {
    state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [],
  }, INSTANCE).status, 202);
  assert.equal(restartedApi.phoneStatus(`Bearer ${restartedApi.issueSession().sessionToken}`).body.desiredState, 'STOPPED');
});
