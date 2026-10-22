import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RemoteMultistreamRuntime } from '../server/remoteMultistreamRuntime.mjs';

const destinations = [
  { platform: 'twitch', url: 'rtmps://twitch.example.com/app/synthetic' },
  { platform: 'youtube', url: 'rtmps://youtube.example.com/live/synthetic' },
];

function fakeChild({ delayedClose = false } = {}) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stderr.resume = () => {};
  child.stdio = [null, child.stdout, child.stderr, { destroyed: false, write: () => true }];
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    if (delayedClose) setImmediate(() => child.emit('close', 0));
    else child.emit('close', 0);
    return true;
  };
  return child;
}

test('separate output processes isolate a failure and retry with bounded backoff', () => {
  const children = [];
  const scheduled = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations,
    stations: { club: [], dubstep: [] },
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    random: () => 0.5,
    schedule: (fn, delay) => { const timer = { fn, delay }; scheduled.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });

  runtime.start();
  assert.equal(children.length, 2);
  children[0].stdout.emit('data', 'frame=1\nout_time_ms=20000\nprogress=continue\n');
  children[1].stdout.emit('data', 'frame=1\nout_time_ms=20000\nprogress=continue\n');
  assert.deepEqual(runtime.status().outputs.map(item => item.state), ['LIVE_UNVERIFIED', 'LIVE_UNVERIFIED']);

  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.deepEqual(runtime.status().outputs.map(item => item.state), ['RETRYING', 'LIVE_UNVERIFIED']);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay >= 0 && scheduled[0].delay <= 1000);

  scheduled[0].fn();
  assert.equal(children.length, 3);
  assert.deepEqual(runtime.status().outputs.map(item => item.state), ['CONNECTING', 'LIVE_UNVERIFIED']);
  runtime.stop();
  assert.deepEqual(runtime.status().outputs.map(item => item.state), ['STOPPED', 'STOPPED']);
});

test('manual reconnect restarts only active host outputs and keeps credentials out of status', () => {
  const children = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations,
    stations: { club: [], dubstep: [] },
    spawnProcess: (_bin, args) => {
      assert.ok(args.includes('-progress'));
      assert.ok(args.at(-1).startsWith('rtmps://'));
      const child = fakeChild(); children.push(child); return child;
    },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    random: () => 0,
  });
  runtime.start();
  children[0].stdout.emit('data', 'frame=3\n');
  runtime.command('station', 'club');
  const result = runtime.reconnect();
  assert.equal(result.accepted, true);
  assert.equal(children.length, 4);
  assert.equal(runtime.status().outputs[0].reconnects, 1);
  const serialized = JSON.stringify(runtime.status());
  assert.equal(serialized.includes('synthetic'), false);
  assert.equal(serialized.includes('rtmps'), false);
  runtime.stop();
});

test('stop followed immediately by start waits for process close then restarts without backoff', async () => {
  const children = [];
  const timers = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations: [destinations[0]],
    stations: { club: [], dubstep: [] },
    spawnProcess: () => { const child = fakeChild({ delayedClose: true }); children.push(child); return child; },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
  });
  runtime.start();
  runtime.stop();
  runtime.start();
  assert.equal(children.length, 1);
  assert.equal(runtime.status().state, 'STARTING');
  assert.equal(runtime.status().outputs[0].state, 'CONNECTING');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(runtime.status().outputs[0].state, 'CONNECTING');
  assert.equal(timers.length, 0);
  runtime.stop();
});

test('FFmpeg progress reports measured output bitrate and classifies auth failure without exposing URL', () => {
  const children = [];
  const timers = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations: [destinations[0]],
    stations: { club: [], dubstep: [] },
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
  });
  runtime.start();
  children[0].stdout.emit('data', 'frame=4\nbitrate=6050.0kbits/s\n');
  assert.equal(runtime.status().outputs[0].bitrateKbps, 6050);
  children[0].stderr.emit('data', 'Server returned 403 Forbidden for rtmps://twitch.example/live/sensitive-key\n');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  assert.equal(runtime.status().outputs[0].errorCode, 'AUTH');
  assert.equal(JSON.stringify(runtime.status()).includes('sensitive-key'), false);
  runtime.stop();
});

test('a stalled output is restarted without interrupting a progressing destination', () => {
  let time = 10_000;
  const children = [];
  const timers = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations,
    stations: { club: [], dubstep: [] },
    now: () => time,
    progressTimeoutMs: 1000,
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  runtime.start();
  children[0].stdout.emit('data', 'frame=1\n');
  children[1].stdout.emit('data', 'frame=1\n');
  time += 700;
  children[1].stdout.emit('data', 'frame=2\n');
  time += 400;
  runtime.checkHealth();
  assert.deepEqual(runtime.status().outputs.map(item => item.state), ['RETRYING', 'LIVE_UNVERIFIED']);
  assert.equal(timers.length, 1);
  runtime.stop();
});

test('retry preserves a paused remote music state instead of starting it again', () => {
  const children = [];
  const timers = [];
  const feederCalls = [];
  const runtime = new RemoteMultistreamRuntime({
    destinations: [destinations[0]],
    stations: { club: [], dubstep: [] },
    spawnProcess: () => { const child = fakeChild(); children.push(child); return child; },
    createFeeder: () => ({ start() {}, stop() {}, command: (action, station) => feederCalls.push([action, station]) }),
    schedule: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; },
  });
  runtime.start();
  runtime.command('station', 'club');
  runtime.command('pause');
  children[0].exitCode = 1;
  children[0].emit('close', 1);
  timers[0].fn();
  assert.deepEqual(feederCalls.slice(-2), [['station', 'club'], ['pause', undefined]]);
  runtime.stop();
});
