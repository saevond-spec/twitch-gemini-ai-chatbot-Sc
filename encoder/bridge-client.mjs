export async function pollOnce({url, token, cursor = '', fetchImpl = fetch}) {
  const endpoint = new URL('/api/encoder/commands', url);
  if (cursor) endpoint.searchParams.set('cursor', cursor);
  const response = await fetchImpl(endpoint, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Bridge returned HTTP ' + response.status);
  const packet = await response.json();
  if (typeof packet.cursor !== 'string' || !Array.isArray(packet.events) || typeof packet.reset !== 'boolean') throw new Error('Invalid bridge response');
  return packet;
}
export function applyPacket(feeder, packet) {
  if (packet.reset) {
    const state = packet.state;
    if (state?.station === 'club' || state?.station === 'dubstep') {
      feeder.command('station', state.station);
      if (!state.playing) feeder.command('pause');
    } else feeder.command('pause');
  } else for (const event of packet.events) {
    if (event.action === 'station') feeder.command('station', event.station);
    else if (['play', 'pause', 'skip'].includes(event.action)) feeder.command(event.action);
  }
  return packet.cursor;
}
