import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteEncoderAgent } from '../server/remoteEncoderAgent.mjs';
import { pollRemoteCommands, reportRemoteStatus } from '../server/remoteBridgeClient.mjs';
import { RemoteMultistreamRuntime } from '../server/remoteMultistreamRuntime.mjs';
import { EventEmitter } from 'node:events';

const INSTANCE = '33333333-3333-4333-8333-333333333333';

test('remote agent applies host commands and reconciles desired state after API restart', async () => {
  const calls = [];
  const runtime = {
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    reconnect: () => calls.push('reconnect'),
    command: action => calls.push(action),
    status: () => ({ state: 'RUNNING_UNVERIFIED', desiredRunning: true, outputProgress: true, outputs: [] }),
  };
  let packet = { cursor: 'host:0', reset: true, desiredState: 'STOPPED', commands: [] };
  const reports = [];
  const agent = new RemoteEncoderAgent({ instanceId: INSTANCE, poll: async () => packet,
    report: async value => reports.push(value), runtime, intervalMs: 500 });
  agent.running = true;
  await agent.tick();
  assert.deepEqual(calls, ['stop']);
  assert.equal(reports.length, 1);

  packet = { cursor: 'host:1', reset: false, desiredState: 'RUNNING', commands: [
    { id: 'synthetic-1', sequence: 1, action: 'start', timestamp: 1 },
    { id: 'synthetic-2', sequence: 2, action: 'reconnect', timestamp: 2 },
    { id: 'synthetic-3', sequence: 3, action: 'station', station: 'club', timestamp: 3 },
  ] };
  await agent.tick();
  assert.deepEqual(calls.slice(1), ['start', 'reconnect', 'station', 'start']);
  assert.equal(reports.length, 2);
  agent.stop();
});

test('remote API client uses HTTPS bearer requests without moving media or target keys', async () => {
  const requests = [];
  const token = 'synthetic-token-'.padEnd(48, 'x');
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ cursor: 'generation:0', reset: true,
      desiredState: 'STOPPED', commands: [] }) };
  };
  const packet = await pollRemoteCommands({ url: 'https://encoder.example', token, instanceId: INSTANCE, fetchImpl });
  assert.equal(packet.desiredState, 'STOPPED');
  await reportRemoteStatus({ url: 'https://encoder.example', token,
    status: { state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] }, instanceId: INSTANCE, fetchImpl: async (_url, options) => {
      requests.push({ url: String(_url), options }); return { ok: true };
    } });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.url.startsWith('https://')));
  assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[0].options.headers['X-Encoder-Instance'], INSTANCE);
  assert.equal(requests[1].options.headers['X-Encoder-Instance'], INSTANCE);
  assert.equal(JSON.stringify(requests).includes('rtmps://'), false);
  assert.equal(JSON.stringify(requests).includes('video'), false);
});

test('remote API client rejects insecure service origins and weak host tokens', async () => {
  await assert.rejects(pollRemoteCommands({ url: 'http://encoder.example', token: 'a'.repeat(40), instanceId: INSTANCE }));
  await assert.rejects(pollRemoteCommands({ url: 'https://encoder.example', token: 'short', instanceId: INSTANCE }));
  await assert.rejects(pollRemoteCommands({ url: 'https://encoder.example', token: 'a'.repeat(40), instanceId: 'invalid' }));
});

test('superseded host HTTP responses fence the stale publisher', async () => {
  const token = 'synthetic-token-'.padEnd(48, 'x');
  const errorResponse = { ok: false, status: 409 };
  await assert.rejects(pollRemoteCommands({ url: 'https://encoder.example', token, instanceId: INSTANCE,
    fetchImpl: async () => ({ ...errorResponse, json: async () => ({ code: 'HOST_INSTANCE_ACTIVE' }) }) }),
  error => error.code === 'REMOTE_HOST_ACTIVE');
  await assert.rejects(pollRemoteCommands({ url: 'https://encoder.example', token, instanceId: INSTANCE,
    fetchImpl: async () => errorResponse }), error => error.code === 'REMOTE_HOST_FENCED');
  await assert.rejects(reportRemoteStatus({ url: 'https://encoder.example', token, instanceId: INSTANCE,
    status: { state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] },
    fetchImpl: async () => errorResponse }), error => error.code === 'REMOTE_HOST_FENCED');

  class Child extends EventEmitter {
    constructor() {
      super(); this.exitCode = null; this.stdout = new EventEmitter(); this.stdout.setEncoding = () => {};
      this.stderr = new EventEmitter(); this.stderr.setEncoding = () => {}; this.stderr.resume = () => {};
      this.stdio = [null, this.stdout, this.stderr, { write: () => true }];
    }
    kill() { this.exitCode = 0; this.emit('close', 0); }
  }
  const child = new Child();
  let polls = 0;
  const runtime = new RemoteMultistreamRuntime({
    destinations: [{ platform: 'twitch', url: 'rtmps://synthetic.invalid/live/fake' }],
    spawnProcess: () => child,
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
  });
  const agent = new RemoteEncoderAgent({
    instanceId: INSTANCE,
    poll: async () => {
      polls++;
      if (polls > 1) {
        const error = new Error('superseded');
        error.code = 'REMOTE_HOST_FENCED';
        throw error;
      }
      return { cursor: 'api:1', reset: true, desiredState: 'RUNNING', commands: [] };
    },
    report: async () => {},
    runtime,
    intervalMs: 500,
  });
  agent.running = true;
  await agent.tick();
  assert.equal(runtime.status().desiredRunning, true);
  assert.equal(child.exitCode, null);
  await agent.tick();
  assert.equal(runtime.status().desiredRunning, false);
  assert.equal(child.exitCode, 0, 'a fenced host must terminate its FFmpeg child');
  assert.equal(agent.running, false);
});

test('a replacement host waits for the old lease instead of retiring on an active-owner conflict', async () => {
  const calls = [];
  let polls = 0;
  const agent = new RemoteEncoderAgent({
    instanceId: INSTANCE,
    poll: async () => {
      polls++;
      if (polls === 1) {
        const error = new Error('another host owns the lease');
        error.code = 'REMOTE_HOST_ACTIVE';
        throw error;
      }
      return { cursor: 'api:3', reset: true, desiredState: 'STOPPED', commands: [] };
    },
    report: async () => {},
    runtime: {
      start() { calls.push('start'); },
      stop() { calls.push('stop'); },
      reconnect() {},
      command() {},
      status: () => ({ state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] }),
    },
  });
  agent.running = true;
  await agent.tick();
  assert.equal(agent.running, true);
  assert.equal(agent.hasLease, false);
  assert.deepEqual(calls, []);
  await agent.tick();
  assert.equal(agent.hasLease, true);
  assert.equal(agent.running, true);
  agent.stop();
});

test('host agent keeps its existing media process through a control API outage and resumes polling', async () => {
  class Child extends EventEmitter {
    constructor() {
      super(); this.exitCode = null; this.stdout = new EventEmitter(); this.stdout.setEncoding = () => {};
      this.stderr = new EventEmitter(); this.stderr.setEncoding = () => {}; this.stderr.resume = () => {};
      this.stdio = [null, this.stdout, this.stderr, { write: () => true }];
    }
    kill() { this.exitCode = 0; this.emit('close', 0); }
  }
  const child = new Child();
  let processCount = 0;
  const runtime = new RemoteMultistreamRuntime({
    destinations: [{ platform: 'twitch', url: 'rtmps://synthetic.invalid/live/fake' }],
    spawnProcess: () => { processCount++; return child; },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
  });
  let packet = { cursor: 'api:0', reset: true, desiredState: 'RUNNING', commands: [] };
  let polls = 0;
  let reports = 0;
  const agent = new RemoteEncoderAgent({
    instanceId: INSTANCE,
    poll: async (_cursor, instanceId) => {
      assert.equal(instanceId, INSTANCE);
      polls++;
      if (polls === 2) throw new Error('synthetic API outage');
      return packet;
    },
    report: async (status, instanceId) => {
      assert.equal(instanceId, INSTANCE);
      assert.equal(status.desiredRunning, true);
      reports++;
    },
    runtime,
    intervalMs: 500,
  });
  agent.running = true;

  await agent.tick();
  assert.equal(runtime.status().desiredRunning, true);
  assert.equal(processCount, 1);
  await agent.tick();
  assert.equal(child.exitCode, null, 'the failed API poll must not stop the running child');
  assert.equal(reports, 1);
  await agent.tick();
  assert.equal(processCount, 1, 'reconciling RUNNING must not duplicate the existing process');
  assert.equal(reports, 2);
  assert.equal(polls, 3);
  assert.equal(runtime.status().desiredRunning, true);
  agent.stop();
});

test('stopping the agent while a poll is pending prevents that response from starting FFmpeg', async () => {
  let resolvePoll;
  const calls = [];
  let reports = 0;
  const agent = new RemoteEncoderAgent({
    instanceId: INSTANCE,
    poll: () => new Promise(resolve => { resolvePoll = resolve; }),
    report: async () => { reports++; },
    runtime: {
      checkHealth() {},
      start() { calls.push('start'); },
      stop() { calls.push('stop'); },
      status: () => ({ state: 'STOPPED', desiredRunning: false, outputProgress: false, outputs: [] }),
    },
  });
  agent.running = true;
  const tick = agent.tick();
  agent.stop();
  resolvePoll({ cursor: 'api:1', reset: true, desiredState: 'RUNNING', commands: [] });
  await tick;
  assert.deepEqual(calls, ['stop']);
  assert.equal(reports, 0);
});
