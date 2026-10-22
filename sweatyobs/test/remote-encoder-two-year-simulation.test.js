import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RemoteMultistreamRuntime } from '../server/remoteMultistreamRuntime.mjs';

const destinations = [
  { platform: 'twitch', url: 'rtmps://twitch.example.test/live/synthetic' },
  { platform: 'youtube', url: 'rtmps://youtube.example.test/live/synthetic' },
  { platform: 'kick', url: 'rtmps://kick.example.test/live/synthetic' },
];

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stderr.resume = () => {};
  child.stdio = [null, child.stdout, child.stderr, { write: () => true }];
  child.kill = () => {
    child.exitCode = 0;
    child.emit('close', 0);
    return true;
  };
  return child;
}

test('two-year simulated 6-hour daily workload survives independent output failures', () => {
  // Explicit model assumptions: 730 days, six streaming hours/day, and an
  // independent network reset chance of 1/168 per destination per active hour.
  let time = 1_900_000_000_000;
  let seed = 0x5a17c0de;
  const randomEvent = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const timers = new Set();
  const active = new Map(destinations.map(item => [item.platform, new Set()]));
  const failures = new Map(destinations.map(item => [item.platform, 0]));
  const platformForUrl = new Map(destinations.map(item => [item.url, item.platform]));
  let peakChildren = 0;
  const peakByPlatform = new Map(destinations.map(item => [item.platform, 0]));
  let simulatedFrames = 0;
  let maxRetryDelayMs = 0;
  const hourMs = 60 * 60 * 1000;

  function advanceTo(target) {
    while (true) {
      const due = [...timers].filter(timer => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      timers.delete(due);
      time = Math.max(time, due.due);
      due.fn();
    }
    time = Math.max(time, target);
  }

  const runtime = new RemoteMultistreamRuntime({
    destinations,
    stations: { club: [], dubstep: [] },
    now: () => time,
    random: () => 0.9999,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    spawnProcess: (_binary, args) => {
      const child = fakeChild();
      const platform = platformForUrl.get(args.at(-1));
      const children = active.get(platform);
      children.add(child);
      child.once('close', () => children.delete(child));
      const activeChildren = [...active.values()].reduce((sum, set) => sum + set.size, 0);
      peakChildren = Math.max(peakChildren, activeChildren);
      peakByPlatform.set(platform, Math.max(peakByPlatform.get(platform), children.size));
      return child;
    },
    createFeeder: () => ({ start() {}, stop() {}, command() {} }),
    schedule: (fn, delay) => {
      const timer = { fn, due: time + delay, cancelled: false, unref() {} };
      timers.add(timer);
      maxRetryDelayMs = Math.max(maxRetryDelayMs, delay);
      return timer;
    },
    cancel: timer => { timer.cancelled = true; timers.delete(timer); },
  });

  function reportProgress(platform) {
    const child = active.get(platform).values().next().value;
    if (!child) return;
    child.stdout.emit('data', `frame=${++simulatedFrames}\nbitrate=6000.0kbits/s\n`);
  }

  function reportAllProgress() {
    for (const destination of destinations) reportProgress(destination.platform);
    runtime.checkHealth();
  }

  function failOneOutput(platform) {
    const children = active.get(platform);
    assert.equal(children.size, 1, `${platform} should have exactly one running process`);
    const child = children.values().next().value;
    failures.set(platform, failures.get(platform) + 1);
    child.stderr.emit('data', 'Connection reset by peer for rtmps://synthetic.invalid/key\n');
    child.exitCode = 1;
    child.emit('close', 1);
    const otherStates = runtime.status().outputs.filter(output => output.platform !== platform);
    assert.ok(otherStates.every(output => output.state === 'LIVE_UNVERIFIED'), 'a failed output must not stall peers');
  }

  function runRetryNow() {
    const timer = [...timers].sort((a, b) => a.due - b.due)[0];
    assert.ok(timer, 'a failed output should schedule an independent retry');
    const delay = timer.due - time;
    assert.ok(delay >= 0 && delay <= 30_000, 'retry delay must stay capped');
    advanceTo(timer.due);
  }

  // Persistent destination outage: confirm exponential backoff reaches its cap,
  // then recover that output while the other two continue progressing.
  runtime.start();
  reportAllProgress();
  failOneOutput('twitch');
  for (let attempt = 0; attempt < 12; attempt++) {
    runRetryNow();
    if (attempt < 11) failOneOutput('twitch');
    else reportAllProgress();
  }
  assert.equal(runtime.status().outputs[0].state, 'LIVE_UNVERIFIED');

  // Run 730 daily sessions. Every simulated hour carries fresh progress; a
  // seeded, independent network reset may affect any one destination.
  const outageChancePerOutputHour = 1 / 168;
  for (let day = 0; day < 730; day++) {
    if (day > 0) runtime.start();
    for (let hour = 0; hour < 6; hour++) {
      advanceTo(time + hourMs);
      reportAllProgress();
      for (const destination of destinations) {
        if (randomEvent() < outageChancePerOutputHour) {
          failOneOutput(destination.platform);
          runRetryNow();
          reportAllProgress();
        }
      }
    }
    runtime.stop();
    advanceTo(time + 18 * hourMs);
  }

  const simulatedNetworkFailures = [...failures.values()].reduce((sum, count) => sum + count, 0) - 12;
  assert.equal(simulatedNetworkFailures, 76, 'the seeded two-year scenario should be reproducible');
  assert.equal(simulatedFrames, 730 * 6 * 3 + 6 + 3 * simulatedNetworkFailures);
  assert.ok([...failures.values()].every(count => count >= 10 && count <= 50));
  assert.equal(peakChildren, 3, 'only one process per destination should be active');
  assert.ok([...peakByPlatform.values()].every(count => count === 1), 'no destination may have duplicate processes');
  assert.ok(maxRetryDelayMs >= 29_000, 'persistent failure should exercise the 30-second retry cap');
  assert.ok(maxRetryDelayMs <= 30_000);
  assert.deepEqual(runtime.status().outputs.map(output => output.state), ['STOPPED', 'STOPPED', 'STOPPED']);
});
