const POSITIVE = /\b(lol|lmao|haha|gg|nice|love|fun|funny|cool|awesome|great|good|clutch|insane|crazy|wow|thanks|thank you|fire|goated|w)\b/i;
const NEGATIVE = /\b(boring|annoying|hate|bad bot|shut up|leave me alone|stop bot|don't talk to me|dont talk to me)\b/i;
const OPT_OUT = /\b(stop bot|leave me alone|don't talk to me|dont talk to me|no bot|bot off)\b/i;

export function normalizeViewerProfile(profile = {}, now = Date.now()) {
  return {
    firstSeen: profile.firstSeen || now,
    lastSeen: profile.lastSeen || now,
    firstChatAt: profile.firstChatAt || null,
    messageCount: Number(profile.messageCount || 0),
    botInteractions: Number(profile.botInteractions || 0),
    followed: Boolean(profile.followed),
    followedAt: profile.followedAt || null,
    followPromptedAt: profile.followPromptedAt || null,
    proactiveOptOut: Boolean(profile.proactiveOptOut),
    seenBefore: Boolean(profile.seenBefore),
    preferences: profile.preferences || {},
    notes: Array.isArray(profile.notes) ? profile.notes : [],
  };
}

export function nextViewerProfile(profile, message, now = Date.now()) {
  const current = normalizeViewerProfile(profile, now);
  const firstChat = current.messageCount === 0 && !current.seenBefore;
  return {
    ...current,
    firstChatAt: current.firstChatAt || now,
    lastSeen: now,
    messageCount: current.messageCount + 1,
    proactiveOptOut: current.proactiveOptOut || OPT_OUT.test(String(message || '')),
    firstChat,
  };
}

export function shouldProactivelyWelcome({ profile, message, isCommand = false }) {
  if (!profile?.firstChat || profile.proactiveOptOut || isCommand) return false;
  if (NEGATIVE.test(String(message || ''))) return false;
  return true;
}

export function shouldOfferFollow({ profile, message, now = Date.now(), directInteraction = false }) {
  if (!profile || profile.followed || profile.proactiveOptOut || profile.followPromptedAt) return false;
  if (!directInteraction) return false;
  if (profile.messageCount < 3 || profile.botInteractions < 1) return false;
  if (!profile.firstChatAt || now - profile.firstChatAt < 45_000) return false;
  if (NEGATIVE.test(String(message || ''))) return false;
  return POSITIVE.test(String(message || ''));
}

const FOLLOW_LINES = [
  'If you’re vibing with the chaos, a follow makes it easy to find the stream again 🤖',
  'If you’re having fun, feel free to follow so you can catch the next stream too.',
  'If this is your kind of chaos, a follow helps you find your way back next time ⚡',
];

export function followLineFor(viewer) {
  const value = String(viewer || '');
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FOLLOW_LINES[hash % FOLLOW_LINES.length];
}

export function firstChatInstruction(username, message) {
  return [
    'This is the first chat message we have observed from this viewer in the current retained profile window.',
    `Welcome ${username} naturally without claiming this is their first-ever visit or first-ever message.`
    'Respond to what they actually said first.',
    'Ask at most one easy, relevant question that helps them join the conversation.',
    'Do not ask for a follow on the first interaction.',
    'Do not mention viewer counts, lurking, join events, tracking, profiles, or stored memory.',
    `Their first message is: ${String(message || '').slice(0, 300)}`,
  ].join(' ');
}
