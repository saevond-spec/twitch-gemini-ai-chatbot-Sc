import { randomUUID } from 'node:crypto';

export const ACTIONS = ['diagnostic', 'start', 'reconnect', 'stop'];
export function normalizeProfile(input = {}) {
  const quality = input.quality ?? '720p30';
  if (!['passthrough', '540p30', '720p30', '1080p30'].includes(quality)) throw Error('Unknown quality profile');
  const gameVolume = input.gameVolume ?? 85;
  if (!Number.isInteger(gameVolume) || gameVolume < 0 || gameVolume > 100) throw Error('Game volume must be 0–100');
  const text = (value, max) => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
  const ps5Address = input.ps5Address || '';
  if (ps5Address && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ps5Address)) throw Error('Enter the PS5 IPv4 address');
  if (ps5Address && ps5Address.split('.').some(n => Number(n) > 255)) throw Error('Enter the PS5 IPv4 address');
  return { quality, gameVolume, rotate180: input.rotate180 === true, overlay: input.overlay === true,
    ps5Address, title: text(input.title, 100), game: text(input.game, 80), keywords: text(input.keywords, 250) };
}

export class ReceiverControl {
  constructor({ now = Date.now } = {}) {
    this.now = now; this.agent = null; this.pending = null; this.events = []; this.revision = 0;
  }
  event(action, result) {
    this.events.push({ at: new Date(this.now()).toISOString(), action, result });
    this.events = this.events.slice(-100);
  }
  snapshot() {
    const connected = Boolean(this.agent && this.now() - this.agent.seen < 30000);
    return { connected, state: connected ? this.agent.state : 'OFFLINE',
      frames: connected ? this.agent.frames : null,
      media: connected ? this.agent.media ?? null : null, lastSeen: this.agent ? new Date(this.agent.seen).toISOString() : null,
      pending: this.pending ? { id: this.pending.id, action: this.pending.action } : null,
      appliedRevision: connected ? this.agent.revision : null,
      reason: connected ? this.agent.state === 'STALLED' ? 'Receiver connected, but processed video frames stopped increasing' :
        this.agent.state === 'STARTING' ? 'Receiver agent connected; awaiting PS5 media' :
        'Receiver agent connected; publisher playback is not verified' : 'No receiver agent connected. Start controls need a host that can receive PS5 video.',
      events: this.events };
  }
  command(action, settings) {
    if (!ACTIONS.includes(action)) throw Error('Unknown receiver command');
    if (!this.snapshot().connected) throw Error('Receiver offline; no command was queued');
    if (this.pending && action !== 'stop') throw Error('Wait for the pending command or press Stop');
    if (action === 'reconnect' && !['STREAMING', 'STALLED'].includes(this.agent.state)) throw Error('Reconnect requires an active or stalled relay');
    if (['start', 'reconnect'].includes(action) && !settings.streamKey) throw Error('Save the Sleipnir stream key first');
    const id = randomUUID();
    this.pending = { id, action, settings: structuredClone(settings), expiresAt: this.now() + 25000, revision: ++this.revision };
    this.event(action, 'requested');
    return this.snapshot();
  }
  poll(report) {
    if (!report || !/^[a-zA-Z0-9_-]{8,80}$/.test(report.id || '') ||
        !['STOPPED', 'STARTING', 'DIAGNOSTIC', 'STREAMING', 'STALLED', 'FAILED'].includes(report.state) ||
        !Number.isSafeInteger(report.frames) || report.frames < 0 ||
        !Number.isSafeInteger(report.revision) || report.revision < 0) throw Error('Invalid receiver report');
    if (report.media !== undefined) {
      const m = report.media;
      const integer = n => Number.isSafeInteger(n) && n >= 0;
      if (!m || !integer(m.videoFrames) || !integer(m.outputBytes) ||
          !integer(m.outputTimeMs) || !['WAITING_FOR_MEDIA', 'PROCESSING', 'STALLED'].includes(m.sourceState) ||
          m.videoFrames !== report.frames || m.audioPackets !== null ||
          m.downstreamPlaybackVerified !== false ||
          (m.lastVideoAt !== null && !Number.isFinite(Date.parse(m.lastVideoAt))) ||
          (m.lastProgressAt !== null && !Number.isFinite(Date.parse(m.lastProgressAt))) ||
          (m.speed !== null && (typeof m.speed !== 'string' || !/^(?:\\d+(?:\\.\\d+)?)x$/.test(m.speed)))) {
        throw Error('Invalid receiver media progress');
      }
    }
    if (this.agent && this.agent.id !== report.id && this.snapshot().connected) throw Error('Another receiver is already connected');
    if (!this.agent || this.agent.id !== report.id) { this.pending = null; this.event('receiver', 'connected'); }
    if (this.pending?.expiresAt <= this.now()) { this.event(this.pending.action, 'expired'); this.pending = null; }
    if (report.ack && this.pending?.id === report.ack) {
      this.event(this.pending.action, report.state === 'FAILED' ? 'failed' : 'accepted');
      this.pending = null;
    }
    if (this.agent && this.agent.state !== report.state) this.event('receiver', report.state.toLowerCase());
    this.agent = { ...report, seen: this.now() };
    return { command: this.pending, leaseSeconds: 30 };
  }
}
