import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { getRedis } from '../storage/redis.js';
import { readJSON, writeJSON } from '../storage/file.js';
import { createLogger } from '../logger/index.js';

const log = createLogger('TOKEN-VAULT');
const TOKEN_KEY = 'twitch:oauth:bot';
const TOKEN_FILE = './tokens.bot.json';
const PROVIDER = 'twitch-bot';
const VAULT_SALT = 'sweatyclanker:twitch-token-vault:v1';

let pgPool = null;
let schemaReady = false;

function databaseUrl() {
  return String(process.env.TWITCH_TOKEN_DATABASE_URL || '').trim();
}

export function durableTokenVaultConfigured() {
  return Boolean(databaseUrl());
}

export function makeGeneration(previous = 0, now = Date.now(), entropy = Math.floor(Math.random() * 1000)) {
  const timeGeneration = Math.min(
    Number.MAX_SAFE_INTEGER - 1000,
    Math.max(0, Math.floor(Number(now) || Date.now())) * 1000 + Math.max(0, Math.min(999, Number(entropy) || 0)),
  );
  return Math.max(Number(previous || 0) + 1, timeGeneration);
}

function deriveKey() {
  const secret = String(config.twitch.clientSecret || '');
  if (!secret) throw new Error('twitch_client_secret_missing');
  return crypto.scryptSync(secret, VAULT_SALT, 32);
}

export function encryptTokenRecord(tokenData) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  cipher.setAAD(Buffer.from(PROVIDER, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(tokenData), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptTokenRecord(envelope) {
  const [version, ivB64, tagB64, ciphertextB64] = String(envelope || '').split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error('invalid_token_vault_envelope');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAAD(Buffer.from(PROVIDER, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function normalizeRecord(token, source = 'unknown') {
  if (!token?.access_token || !token?.refresh_token) return null;
  return {
    ...token,
    vault_generation: Number(token.vault_generation || 0),
    vault_updated_at: Number(token.vault_updated_at || token.expires_at || 0),
    vault_source: source,
  };
}

export function chooseFreshestToken(records = []) {
  const valid = records.map(record => normalizeRecord(record?.token || record, record?.source || record?.vault_source)).filter(Boolean);
  if (!valid.length) return null;
  return valid.sort((a, b) =>
    Number(b.vault_generation || 0) - Number(a.vault_generation || 0)
    || Number(b.vault_updated_at || 0) - Number(a.vault_updated_at || 0)
    || Number(b.expires_at || 0) - Number(a.expires_at || 0)
  )[0];
}

async function getPgPool() {
  const url = databaseUrl();
  if (!url) return null;
  if (pgPool) return pgPool;
  const { Pool } = await import('pg');
  pgPool = new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  pgPool.on('error', err => log.warn('OAuth vault Postgres pool error', err.message));
  return pgPool;
}

async function ensureSchema() {
  const pool = await getPgPool();
  if (!pool || schemaReady) return pool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS twitch_oauth_vault (
      provider TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      generation BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
  return pool;
}

async function loadFromPostgres() {
  if (!durableTokenVaultConfigured()) return null;
  try {
    const pool = await ensureSchema();
    const result = await pool.query(
      'SELECT payload, generation, updated_at FROM twitch_oauth_vault WHERE provider = $1 LIMIT 1',
      [PROVIDER],
    );
    const row = result.rows?.[0];
    if (!row) return null;
    const token = decryptTokenRecord(row.payload);
    token.vault_generation = Number(row.generation || token.vault_generation || 0);
    token.vault_updated_at = Date.parse(row.updated_at) || token.vault_updated_at || 0;
    return normalizeRecord(token, 'postgres');
  } catch (err) {
    log.warn('Failed to load Twitch token from durable Postgres vault', err.message);
    return null;
  }
}

async function saveToPostgres(token) {
  if (!durableTokenVaultConfigured()) return { attempted: false, saved: false };
  try {
    const pool = await ensureSchema();
    const envelope = encryptTokenRecord(token);
    const result = await pool.query(
      `INSERT INTO twitch_oauth_vault(provider, payload, generation, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT(provider) DO UPDATE SET
         payload = EXCLUDED.payload,
         generation = EXCLUDED.generation,
         updated_at = NOW()
       WHERE twitch_oauth_vault.generation <= EXCLUDED.generation
       RETURNING generation`,
      [PROVIDER, envelope, Number(token.vault_generation || 0)],
    );
    return {
      attempted: true,
      saved: Boolean(result.rowCount),
      generation: Number(result.rows?.[0]?.generation || token.vault_generation || 0),
    };
  } catch (err) {
    log.warn('Failed to save Twitch token to durable Postgres vault', err.message);
    return { attempted: true, saved: false, error: err.message };
  }
}

async function clearPostgres() {
  if (!durableTokenVaultConfigured()) return;
  try {
    const pool = await ensureSchema();
    await pool.query('DELETE FROM twitch_oauth_vault WHERE provider = $1', [PROVIDER]);
  } catch (err) {
    log.warn('Failed to clear durable Twitch token vault', err.message);
  }
}

async function loadFromRedis() {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(TOKEN_KEY);
    if (!raw) return null;
    return normalizeRecord(JSON.parse(raw), 'redis');
  } catch (err) {
    log.warn('Failed to load Twitch token from Redis cache', err.message);
    return null;
  }
}

async function saveToRedis(token) {
  const redis = getRedis();
  if (!redis) return false;
  try {
    // The refresh token outlives the access token. Never expire this cache at
    // access-token expiry, which previously deleted the only refresh copy.
    await redis.set(TOKEN_KEY, JSON.stringify(token));
    return true;
  } catch (err) {
    log.warn('Failed to save Twitch token to Redis cache', err.message);
    return false;
  }
}

async function loadFromFile() {
  try {
    return normalizeRecord(await readJSON(TOKEN_FILE, null), 'file');
  } catch (err) {
    log.warn('Failed to load Twitch token file', err.message);
    return null;
  }
}

async function saveToFile(token) {
  try {
    await writeJSON(TOKEN_FILE, token);
    return true;
  } catch (err) {
    log.warn('Failed to save Twitch token file', err.message);
    return false;
  }
}

export async function loadBestToken() {
  const [postgres, redis, file] = await Promise.all([
    loadFromPostgres(),
    loadFromRedis(),
    loadFromFile(),
  ]);
  const best = chooseFreshestToken([
    postgres && { token: postgres, source: 'postgres' },
    redis && { token: redis, source: 'redis' },
    file && { token: file, source: 'file' },
  ].filter(Boolean));

  if (!best) return null;

  // Read-repair stale/missing caches. Postgres is durable authority when configured.
  const repairs = [];
  if (durableTokenVaultConfigured() && best.vault_source !== 'postgres') repairs.push(saveToPostgres(best));
  if (best.vault_source !== 'redis') repairs.push(saveToRedis(best));
  if (best.vault_source !== 'file') repairs.push(saveToFile(best));
  if (repairs.length) await Promise.allSettled(repairs);

  return best;
}

export async function persistToken(tokenData, { previousGeneration = 0 } = {}) {
  const now = Date.now();
  const token = {
    ...tokenData,
    vault_generation: makeGeneration(
      Math.max(Number(previousGeneration || 0), Number(tokenData?.vault_generation || 0)),
      now,
    ),
    vault_updated_at: now,
  };

  const [postgres, redis, file] = await Promise.all([
    saveToPostgres(token),
    saveToRedis(token),
    saveToFile(token),
  ]);

  const durable = durableTokenVaultConfigured() ? Boolean(postgres.saved) : false;
  return {
    token,
    durable,
    postgres,
    redis,
    file,
  };
}

export async function repairTokenCopies(tokenData) {
  const token = normalizeRecord(tokenData, tokenData?.vault_source || 'memory');
  if (!token) return { durable: false, postgres: { attempted: false, saved: false }, redis: false, file: false };

  const [postgres, redis, file] = await Promise.all([
    saveToPostgres(token),
    saveToRedis(token),
    saveToFile(token),
  ]);
  return {
    token,
    durable: durableTokenVaultConfigured() ? Boolean(postgres.saved) : false,
    postgres,
    redis,
    file,
  };
}

export async function clearTokenVault() {
  const redis = getRedis();
  await Promise.allSettled([
    clearPostgres(),
    redis ? redis.del(TOKEN_KEY) : Promise.resolve(),
    writeJSON(TOKEN_FILE, null),
  ]);
}

export async function tokenVaultHealth() {
  return {
    durableConfigured: durableTokenVaultConfigured(),
    postgresAvailable: Boolean(await loadFromPostgres()),
    redisAvailable: Boolean(getRedis()),
  };
}

export function _resetTokenVaultForTests() {
  pgPool = null;
  schemaReady = false;
}
