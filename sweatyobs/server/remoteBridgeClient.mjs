function authorizedHeaders(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new Error('Remote bridge token must contain at least 32 characters');
  }
  return { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Cache-Control': 'no-store' };
}

function hostHeaders(instanceId) {
  if (typeof instanceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new Error('Remote encoder host instance ID is invalid');
  }
  return { 'X-Encoder-Instance': instanceId };
}

function endpoint(url, path) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Remote encoder API must be an HTTPS origin');
  }
  return new URL(path, base);
}

export async function pollRemoteCommands({ url, token, cursor = '', instanceId, fetchImpl = fetch }) {
  const address = endpoint(url, '/api/encoder/remote/commands');
  if (cursor) address.searchParams.set('cursor', cursor);
  const response = await fetchImpl(address, {
    headers: { ...authorizedHeaders(token), ...hostHeaders(instanceId) }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (response.status === 409) {
    const payload = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {};
    const activeConflict = payload?.code === 'HOST_INSTANCE_ACTIVE';
    const error = new Error(activeConflict
      ? 'Another remote encoder host still owns the active lease.'
      : 'Remote encoder host instance was superseded.');
    error.code = activeConflict ? 'REMOTE_HOST_ACTIVE' : 'REMOTE_HOST_FENCED';
    throw error;
  }
  if (!response.ok) throw new Error('Remote command poll failed');
  const packet = await response.json();
  if (typeof packet.cursor !== 'string' || packet.cursor.length > 128 || typeof packet.reset !== 'boolean' ||
      !['RUNNING', 'STOPPED'].includes(packet.desiredState) || !Array.isArray(packet.commands) || packet.commands.length > 128) {
    throw new Error('Invalid remote command packet');
  }
  return packet;
}

export async function reportRemoteStatus({ url, token, status, instanceId, fetchImpl = fetch }) {
  const response = await fetchImpl(endpoint(url, '/api/encoder/remote/status'), {
    method: 'POST',
    headers: { ...authorizedHeaders(token), ...hostHeaders(instanceId), 'Content-Type': 'application/json' },
    body: JSON.stringify(status), signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (response.status === 409) {
    const error = new Error('Remote encoder host instance was superseded.');
    error.code = 'REMOTE_HOST_FENCED';
    throw error;
  }
  if (!response.ok) throw new Error('Remote status report failed');
}
