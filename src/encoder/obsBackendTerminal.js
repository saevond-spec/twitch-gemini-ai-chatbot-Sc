// A command-shaped interface for OBS diagnostics, never a remote shell.
// No spawning processes, reading secrets, or altering broadcasts.
export const OBS_TERMINAL_COMMANDS = Object.freeze(['help','status','ingress','quality','receiver']);
export function normalizeTerminalCommand(value) {
  if (typeof value !== 'string' || value.length > 40) throw Error('Unknown terminal command');
  const command = value.trim().toLowerCase();
  if (!OBS_TERMINAL_COMMANDS.includes(command)) throw Error('Unknown terminal command');
  return command;
}
export function terminalResponse(command, { snapshot, ingress } = {}) {
  const cmd = normalizeTerminalCommand(command);
  const now = new Date().toISOString();
  switch (cmd) {
    case 'help': return {command:cmd, at:now, lines:[
      '$ help','Available read-only commands: help, status, ingress, quality, receiver',
      'This is a restricted diagnostics console; it cannot execute shell programs or start broadcasts.'
    ]};
    case 'status': return {command:cmd, at:now, lines:[
      '$ status', 'Dashboard backend: responding',
      'Remote receiver connected: ' + Boolean(snapshot?.receiver?.connected),
      'Telemetry fresh: ' + Boolean(snapshot?.telemetry?.fresh),
      'Sleipnir connection: ' + (snapshot?.connectionCheck?.reachable === true ? 'TLS reachable (video unverified)' : 'not verified')
    ]};
    case 'receiver': return {command:cmd, at:now, lines:[
      '$ receiver', 'Agent: ' + (snapshot?.receiver?.state || 'OFFLINE'),
      'Frames: ' + (snapshot?.receiver?.frames ?? 'unavailable'),
      'Last seen: ' + (snapshot?.receiver?.lastSeen || 'no heartbeat'),
      'Connected does not prove PS5 media reception or viewer playback.'
    ]};
    case 'ingress': return {command:cmd, at:now, lines:[
      '$ ingress',
      'Backend probe: ' + (ingress?.state || ingress?.status || 'status unavailable'),
      'Public probe response: ' + (ingress ? 'received' : 'unavailable'),
      'Never paste or expose a publish URL or stream key in terminal output.'
    ]};
    case 'quality': return {command:cmd, at:now, lines:[
      '$ quality',
      'Requested profile: ' + (snapshot?.settings?.profile?.quality || 'not configured'),
      'Source codec/FPS: not verified by this console',
      'Shared Sleipnir Free input ceiling: 5 Mbps; source must obey limit',
      'Video passthrough avoids Render CPU overload; burned-in overlays require re-encoding.'
    ]};
  }
}
