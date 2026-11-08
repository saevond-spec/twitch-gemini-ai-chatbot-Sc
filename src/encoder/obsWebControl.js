import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ReceiverControl, normalizeProfile } from './receiverControl.js';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function validateRelay(input = {}, previous = {}) {
  let url;
  try { url = new URL(input.relayUrl); } catch { throw Error('Enter a valid Sleipnir RTMPS server address'); }
  if (url.protocol !== 'rtmps:' || url.hostname !== 'ingest.sleipnir.tv' ||
      !['', '443', '1936'].includes(url.port) || url.pathname !== '/live' ||
      url.username || url.password || url.search || url.hash) {
    throw Error('Use Sleipnir’s RTMPS server address ending in /live, with port 443 or 1936');
  }
  const streamKey = input.clearKey === true ? '' : (input.streamKey || previous.streamKey || '');
  if (typeof streamKey !== 'string' || streamKey.length > 512 || /[\s\x00-\x1f\x7f]/.test(streamKey)) {
    throw Error('Stream key must contain no spaces or control characters');
  }
  const receiverAddress = input.receiverAddress || '';
  if (typeof receiverAddress !== 'string' || (receiverAddress && isIP(receiverAddress) !== 4)) {
    throw Error('Receiver address must be an IPv4 address, without a port');
  }
  return { relayUrl: url.href, streamKey, receiverAddress, profile: normalizeProfile(input.profile ?? previous.profile) };
}

export function probeRelay(relayUrl, connect = tls.connect) {
  const url = new URL(validateRelay({ relayUrl }).relayUrl);
  return new Promise(resolve => {
    let socket, finished = false;
    const finish = reachable => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({ reachable, checkedAt: new Date().toISOString(),
        scope: 'TLS connection only; stream key and video delivery are not tested' });
    };
    const timer = setTimeout(() => finish(false), 5000);
    try {
      socket = connect({ host: url.hostname, port: Number(url.port || 443),
        servername: url.hostname, rejectUnauthorized: true }, () => finish(true));
      socket.on('error', () => finish(false));
    } catch { finish(false); }
  });
}

export class ObsWebControl {
  constructor({ env = process.env, now = Date.now, probe = probeRelay } = {}) {
    this.now = now;
    this.receiver = new ReceiverControl({ now });
    this.redis = null;
    this.redisKey = env.ADMIN_API_KEY?.length >= 32 ? createHash("sha256").update("obs-settings-v1:" + env.ADMIN_API_KEY).digest() : null;
    this.probe = probe;
    this.settings = { relayUrl: 'rtmps://ingest.sleipnir.tv/live', streamKey: '', receiverAddress: '', profile: normalizeProfile() };
    this.storageFile = env.OBS_CONTROL_SETTINGS_FILE;
    this.storageKey = /^[a-f0-9]{64}$/i.test(env.OBS_CONTROL_ENCRYPTION_KEY || '')
      ? Buffer.from(env.OBS_CONTROL_ENCRYPTION_KEY, 'hex') : null;
    this.durable = Boolean(this.storageFile?.startsWith('/') && this.storageKey);
    this.storageError = false;
    this.sample = null;
    this.check = null;
    if (this.durable) {
      try {
        const data = JSON.parse(readFileSync(this.storageFile, 'utf8'));
        const decipher = createDecipheriv('aes-256-gcm', this.storageKey, Buffer.from(data.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
        this.settings = validateRelay(JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(data.data, 'hex')), decipher.final()
        ]).toString('utf8')));
      } catch (error) { if (error.code !== 'ENOENT') this.storageError = true; }
    }
  }
  async initializeRedis(redis) {
    if (this.durable || !redis || !this.redisKey) return;
    try {
      const saved = await redis.get('obs:web:settings:v1');
      if (saved) {
        const data = JSON.parse(saved);
        const decipher = createDecipheriv('aes-256-gcm', this.redisKey, Buffer.from(data.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
        this.settings = validateRelay(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.data, 'hex')), decipher.final()]).toString()));
      }
      this.redis = redis;
    } catch { this.storageError = true; }
  }
  async savePersistent(input) {
    if (!this.redis) return this.save(input);
    if (this.storageError) throw Error('Settings storage needs repair before saving');
    const next = validateRelay(input, this.settings);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.redisKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    try {
      await this.redis.set('obs:web:settings:v1', JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') }));
    } catch { throw Error('Settings were not saved: database unavailable'); }
    this.settings = next; this.check = null;
    return this.snapshot();
  }
  save(input) {
    const next = validateRelay(input, this.settings);
    if (this.storageError) throw Error('Saved settings could not be decrypted; restore the storage encryption key before saving');
    if (this.durable) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.storageKey, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
      const temporary = this.storageFile + '.tmp';
      try {
        writeFileSync(temporary, JSON.stringify({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
          data: data.toString('hex') }), { mode: 0o600 });
        renameSync(temporary, this.storageFile);
      } catch { throw Error('Could not save encrypted settings; previous settings retained'); }
    }
    this.settings = next;
    this.check = null;
    return this.snapshot();
  }
  observe(record) {
    // Called only after encoderDiagnostics has authenticated and validated the report.
    if (record.kind !== 'encoder_connection_sample') return;
    this.sample = { at: this.now(), sessionId: record.sessionId,
      ingest: structuredClone(record.ingest), destinations: structuredClone(record.destinations) };
  }
  snapshot() {
    const fresh = Boolean(this.sample && this.now() - this.sample.at <= 90000);
    return {
      settings: { relayUrl: this.settings.relayUrl, receiverAddress: this.settings.receiverAddress,
        keyConfigured: Boolean(this.settings.streamKey), profile: this.settings.profile, storage: this.redis ? 'encrypted_redis' : this.durable ? 'encrypted_file' : 'session_only',
        storageError: this.storageError, appliedToReceiver: false },
      receiver: { ...this.receiver.snapshot(), controllable: this.receiver.snapshot().connected },
      telemetry: { fresh, receivedAt: this.sample ? new Date(this.sample.at).toISOString() : null,
        source: 'Authenticated encoder report', sample: fresh ? this.sample : null },
      connectionCheck: this.check
    };
  }
}

export function createObsWebRouter({ control, requireAdmin, receiverToken = '', music }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/receiver/poll', rateLimit({ windowMs: 60000, max: 30, validate: false }), (req, res) => {
    const supplied = (req.get('authorization') || '').replace(/^Bearer /, '');
    const valid = receiverToken.length >= 32 && Buffer.byteLength(supplied) === Buffer.byteLength(receiverToken) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(receiverToken));
    if (!valid) return res.status(401).json({ error: 'Receiver authentication required' });
    try { res.json(control.receiver.poll(req.body)); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  router.use(requireAdmin);
  router.get('/status', (_req, res) => res.json(control.snapshot()));
  router.put('/settings', async (req, res) => {
    try { res.json(await control.savePersistent(req.body)); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post('/command', (req, res) => {
    try { control.receiver.command(req.body?.action, control.settings); res.json(control.snapshot()); }
    catch (error) { res.status(409).json({ error: error.message }); }
  });
  router.post('/music', (req, res) => {
    try {
      if (!music) throw Error('Music controller unavailable');
      const { action, volume } = req.body || {};
      if (!['play', 'pause', 'skip', 'club', 'dubstep', 'volume'].includes(action) ||
          (action === 'volume' && (!Number.isInteger(volume) || volume < 0 || volume > 100))) throw Error('Invalid music command');
      res.json({ message: music(action, volume), ...control.snapshot() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  let checking = false, lastCheck = -Infinity;
  router.post('/check', async (_req, res) => {
    if (checking || control.now() - lastCheck < 10000) return res.status(429).json({ error: 'Wait 10 seconds between checks' });
    checking = true;
    lastCheck = control.now();
    const url = control.settings.relayUrl;
    try {
      const result = await control.probe(url);
      if (control.settings.relayUrl !== url) return res.status(409).json({ error: 'Settings changed; run the check again' });
      control.check = result;
      res.json(control.snapshot());
    } catch { res.status(502).json({ error: 'Connection check unavailable' }); }
    finally { checking = false; }
  });
  return router;
}
