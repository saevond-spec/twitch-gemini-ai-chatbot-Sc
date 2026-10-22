import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEncoderRemoteControl } from './remoteControl.mjs';

function secureEqual(left, right) {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
    const error = new Error('Expected JSON body.');
    error.status = 415;
    throw error;
  }
  const contentLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.resume();
    const error = new Error('Request body is too large.');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body.');
    error.status = 400;
    throw error;
  }
}

function rateLimitStore(now) {
  const records = new Map();
  return {
    allowed(key, max, windowMs) {
      const time = now();
      const record = records.get(key);
      if (!record || time - record.startedAt >= record.windowMs) return true;
      return record.count < max;
    },
    consume(key, max, windowMs) {
      const time = now();
      const record = records.get(key);
      if (!record || time - record.startedAt >= windowMs) records.set(key, { startedAt: time, windowMs, count: 1 });
      else record.count++;
      if (records.size > 4096) {
        for (const [entryKey, entry] of records) {
          if (time - entry.startedAt >= entry.windowMs) records.delete(entryKey);
          if (records.size <= 3072) break;
        }
      }
    },
  };
}

function clientKey(request, trustProxy) {
  // Render documents that the first X-Forwarded-For entry is the real client
  // address. Only enable this in the Render entrypoint; local callers do not
  // get to choose their own rate-limit identity.
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
    if (isIP(first)) return first;
  }
  return request.socket.remoteAddress || 'unknown';
}

/** Standalone, control-only HTTP service. It never handles gameplay media. */
export function createEncoderControlApiServer({
  adminKey = '',
  hostToken = '',
  now = () => Date.now(),
  trustProxy = false,
} = {}) {
  if (adminKey && hostToken && adminKey === hostToken) {
    throw new Error('Admin and host tokens must be different values.');
  }
  const remote = createEncoderRemoteControl({ hostToken, now });
  const limits = rateLimitStore(now);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const key = clientKey(request, trustProxy);
    const auth = request.headers.authorization || '';
    const instanceId = request.headers['x-encoder-instance'] || '';
    const rate = (name, max, windowMs, identity = key) => {
      const bucket = `${name}:${identity}`;
      if (!limits.allowed(bucket, max, windowMs)) return false;
      limits.consume(bucket, max, windowMs);
      return true;
    };

    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return json(response, 200, { ok: true, service: 'sweatyobs-control' });
      }

      if (request.method === 'POST' && url.pathname === '/api/encoder/admin/unlock') {
        if (typeof adminKey !== 'string' || adminKey.length < 32 || adminKey.length > 256) {
          return json(response, 503, { error: 'Admin unlock is not configured.' });
        }
        const body = await readJson(request, 2048);
        const candidate = body && typeof body === 'object' && !Array.isArray(body) && typeof body.key === 'string'
          ? body.key : '';
        if (!candidate || candidate.length > 256 || !secureEqual(candidate, adminKey)) {
          // Check and reserve in one synchronous step after parsing. Concurrent
          // requests cannot pass a check-then-increment gap, and valid unlocks
          // do not consume failed-guess quota.
          if (!rate('unlock', 5, 15 * 60 * 1000)) {
            return json(response, 429, { error: 'Too many unlock attempts. Try again later.' });
          }
          return json(response, 401, { error: 'Key not accepted.' });
        }
        const session = remote.issueSession();
        return json(response, 200, { unlocked: true, ...session });
      }

      if (request.method === 'GET' && url.pathname === '/api/encoder/remote/status') {
        const identity = remote.isValidSession(auth) ? `session:${createHash('sha256').update(auth).digest('hex')}` : key;
        if (!rate('phone-status', 60, 60_000, identity)) return json(response, 429, { error: 'Too many requests.' });
        const result = remote.phoneStatus(auth);
        return json(response, result.status, result.body);
      }

      if (request.method === 'POST' && url.pathname === '/api/encoder/remote/session/revoke') {
        const identity = remote.isValidSession(auth) ? `session:${createHash('sha256').update(auth).digest('hex')}` : key;
        if (!rate('revoke', 10, 60_000, identity)) return json(response, 429, { error: 'Too many requests.' });
        const result = remote.revokeSession(auth);
        return json(response, result.status, result.body);
      }

      if (request.method === 'POST' && url.pathname === '/api/encoder/remote/actions') {
        const identity = remote.isValidSession(auth) ? `session:${createHash('sha256').update(auth).digest('hex')}` : key;
        if (!rate('actions', 30, 60_000, identity)) return json(response, 429, { error: 'Too many requests.' });
        const body = await readJson(request, 2048);
        const result = remote.submitAction(auth, body);
        return json(response, result.status, result.body);
      }

      if (request.method === 'GET' && url.pathname === '/api/encoder/remote/commands') {
        const identity = remote.isValidBridge(auth) ? `host:${instanceId}` : key;
        if (!rate('host-poll', 60, 60_000, identity)) return json(response, 429, { error: 'Too many requests.' });
        const result = remote.hostPoll(auth, url.searchParams.get('cursor') || '', instanceId);
        return json(response, result.status, result.body);
      }

      if (request.method === 'POST' && url.pathname === '/api/encoder/remote/status') {
        const identity = remote.isValidBridge(auth) ? `host:${instanceId}` : key;
        if (!rate('host-status', 60, 60_000, identity)) return json(response, 429, { error: 'Too many requests.' });
        const body = await readJson(request, 4096);
        const result = remote.reportHostStatus(auth, body, instanceId);
        return json(response, result.status, result.body);
      }

      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      return json(response, error.status || 400, { error: error.status ? error.message : 'Request failed.' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 5_000;
  server.remoteControl = remote;
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const adminKey = process.env.ENCODER_ADMIN_KEY || '';
  const hostToken = process.env.ENCODER_REMOTE_HOST_TOKEN || '';
  if (adminKey.length < 32 || hostToken.length < 32) {
    throw new Error('Configure independent 32+ character ENCODER_ADMIN_KEY and ENCODER_REMOTE_HOST_TOKEN values.');
  }
  const port = Number(process.env.PORT || '3000');
  const server = createEncoderControlApiServer({ adminKey, hostToken, trustProxy: true });
  server.listen(port, '0.0.0.0', () => console.log(`SweatyOBS control API listening on port ${port}.`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
