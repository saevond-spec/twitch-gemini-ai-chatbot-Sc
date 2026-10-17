const SERVICE_ACCOUNTS = new Set([
  'nightbot',
  'streamelements',
  'wizebot',
  'moobot',
  'fossabot',
]);

export function shouldWelcomeJoin({
  channel,
  username,
  self = false,
  botLogin = '',
  ignoredUsers = [],
} = {}) {
  if (self) return false;

  const login = String(username || '').trim().toLowerCase();
  if (!login) return false;

  const owner = String(channel || '').replace(/^#/, '').trim().toLowerCase();
  const configuredBot = String(botLogin || '').trim().toLowerCase();
  const ignored = new Set((ignoredUsers || []).map(user => String(user || '').trim().toLowerCase()));

  if (login === configuredBot) return false;
  if (login === owner) return false;
  if (ignored.has(login)) return false;
  if (SERVICE_ACCOUNTS.has(login)) return false;

  return true;
}
