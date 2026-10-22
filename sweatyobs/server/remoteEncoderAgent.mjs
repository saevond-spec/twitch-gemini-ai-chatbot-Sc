import { randomUUID } from 'node:crypto';

const COMMANDS = new Set(['start', 'stop', 'reconnect', 'play', 'pause', 'skip', 'station']);
const STATIONS = new Set(['club', 'dubstep']);

function validCommand(command) {
  if (!command || typeof command !== 'object' || typeof command.id !== 'string' || command.id.length > 64 ||
      !COMMANDS.has(command.action)) return false;
  const keys = command.action === 'station' ? ['id', 'sequence', 'action', 'station', 'timestamp'] :
    ['id', 'sequence', 'action', 'timestamp'];
  return Object.keys(command).length === keys.length && keys.every(key => Object.hasOwn(command, key)) &&
    (command.action !== 'station' || STATIONS.has(command.station));
}

export class RemoteEncoderAgent {
  constructor({ poll, report, runtime, instanceId = randomUUID(), intervalMs = 1500, onError = () => {} } = {}) {
    this.poll = poll;
    this.report = report;
    this.runtime = runtime;
    this.instanceId = instanceId;
    this.intervalMs = Math.max(500, intervalMs);
    this.onError = onError;
    this.cursor = '';
    this.processed = new Set();
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.runGeneration = 0;
    this.hasLease = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.runGeneration++;
    void this.tick(this.runGeneration);
  }

  async tick(generation = this.runGeneration) {
    if (!this.running || this.busy || generation !== this.runGeneration) return;
    this.busy = true;
    try {
      this.runtime.checkHealth?.();
      const packet = await this.poll(this.cursor, this.instanceId);
      // SIGTERM/stop can arrive while the poll is pending. Ignore that response
      // so an old agent cannot relaunch FFmpeg after shutdown has begun.
      if (!this.running || generation !== this.runGeneration) return;
      this.hasLease = true;
      if (packet.reset) {
        this.cursor = packet.cursor;
        this.processed.clear();
      } else {
        for (const command of packet.commands) {
          if (!validCommand(command)) throw new Error('Malformed remote command');
          if (this.processed.has(command.id)) continue;
          this.apply(command);
          this.processed.add(command.id);
          if (this.processed.size > 256) this.processed.delete(this.processed.values().next().value);
        }
        this.cursor = packet.cursor;
      }
      if (packet.desiredState === 'RUNNING') this.runtime.start();
      else this.runtime.stop();
      await this.report(this.runtime.status(), this.instanceId);
    } catch (error) {
      this.onError(error);
      // A 409 from the host command endpoint means another process owns the
      // lease. Stop local outputs and retire this agent so a stale host cannot
      // keep publishing after a replacement instance takes over.
      if (error?.code === 'REMOTE_HOST_FENCED' ||
          (error?.code === 'REMOTE_HOST_ACTIVE' && this.hasLease)) this.stop();
    } finally {
      this.busy = false;
      if (this.running) {
        const nextGeneration = this.runGeneration;
        const delay = generation === nextGeneration ? this.intervalMs : 0;
        this.timer = setTimeout(() => { this.timer = null; void this.tick(nextGeneration); }, delay);
        this.timer.unref?.();
      }
    }
  }

  apply(command) {
    if (command.action === 'start') this.runtime.start();
    else if (command.action === 'stop') this.runtime.stop();
    else if (command.action === 'reconnect') this.runtime.reconnect();
    else if (command.action === 'station') this.runtime.command('station', command.station);
    else this.runtime.command(command.action);
  }

  stop() {
    this.running = false;
    this.runGeneration++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.runtime.stop();
  }
}
