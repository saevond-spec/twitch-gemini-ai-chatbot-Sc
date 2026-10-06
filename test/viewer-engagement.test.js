import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeViewerProfile,
  nextViewerProfile,
  shouldProactivelyWelcome,
  shouldOfferFollow,
  followLineFor,
  firstChatInstruction,
} from '../src/chat/viewerEngagement.js';

test('silent lurkers are never proactively welcomed from join events', () => {
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /bus\.on\('twitch\.join'/);
});

test('first-time chatter gets a conversational welcome but no follow CTA', () => {
  const now = 1_000_000;
  const profile = nextViewerProfile(normalizeViewerProfile({}, now), 'yo what game is this?', now);

  assert.equal(profile.firstChat, true);
  assert.equal(profile.messageCount, 1);
  assert.equal(shouldProactivelyWelcome({ profile, message: 'yo what game is this?', isCommand: false }), true);
  assert.equal(shouldOfferFollow({ profile, message: 'yo what game is this?', now, directInteraction: false }), false);

  const instruction = firstChatInstruction('newviewer', 'yo what game is this?');
  assert.match(instruction, /first chat message/i);
  assert.match(instruction, /Do not ask for a follow/i);
  assert.match(instruction, /Ask at most one/i);
});

test('first-message commands do not trigger a second welcome response', () => {
  const profile = nextViewerProfile({}, '!help', 2_000_000);
  assert.equal(shouldProactivelyWelcome({ profile, message: '!help', isCommand: true }), false);
});

test('returning viewer is not treated like a first-time chatter', () => {
  const profile = nextViewerProfile({
    firstChatAt: 1000,
    messageCount: 7,
    botInteractions: 3,
  }, 'hey again', 2_000_000);

  assert.equal(profile.firstChat, false);
  assert.equal(shouldProactivelyWelcome({ profile, message: 'hey again', isCommand: false }), false);
});

test('follow CTA requires real engagement, time, positivity, and direct interaction', () => {
  const firstChatAt = 3_000_000;
  const base = {
    firstChatAt,
    messageCount: 3,
    botInteractions: 1,
    followed: false,
    followPromptedAt: null,
    proactiveOptOut: false,
  };

  assert.equal(shouldOfferFollow({
    profile: base,
    message: 'lol that was actually insane',
    now: firstChatAt + 60_000,
    directInteraction: true,
  }), true);

  assert.equal(shouldOfferFollow({
    profile: base,
    message: 'lol that was actually insane',
    now: firstChatAt + 10_000,
    directInteraction: true,
  }), false, 'too early');

  assert.equal(shouldOfferFollow({
    profile: { ...base, messageCount: 2 },
    message: 'that was awesome',
    now: firstChatAt + 60_000,
    directInteraction: true,
  }), false, 'not enough participation');

  assert.equal(shouldOfferFollow({
    profile: base,
    message: 'that was awesome',
    now: firstChatAt + 60_000,
    directInteraction: false,
  }), false, 'viewer has not directly interacted with the bot');
});

test('follow CTA is never repeated once prompted or after viewer follows', () => {
  const profile = {
    firstChatAt: 1,
    messageCount: 10,
    botInteractions: 5,
    followed: false,
    followPromptedAt: 5000,
    proactiveOptOut: false,
  };

  assert.equal(shouldOfferFollow({
    profile,
    message: 'this is fun lol',
    now: 100_000,
    directInteraction: true,
  }), false);

  assert.equal(shouldOfferFollow({
    profile: { ...profile, followPromptedAt: null, followed: true },
    message: 'this is fun lol',
    now: 100_000,
    directInteraction: true,
  }), false);
});

test('negative or opt-out viewers never receive proactive follow prompts', () => {
  const base = {
    firstChatAt: 1,
    messageCount: 5,
    botInteractions: 2,
    followed: false,
    followPromptedAt: null,
    proactiveOptOut: false,
  };

  assert.equal(shouldOfferFollow({
    profile: base,
    message: 'this bot is annoying',
    now: 100_000,
    directInteraction: true,
  }), false);

  const optedOut = nextViewerProfile(base, 'stop bot please', 100_000);
  assert.equal(optedOut.proactiveOptOut, true);
  assert.equal(shouldProactivelyWelcome({ profile: optedOut, message: 'stop bot please', isCommand: false }), false);
  assert.equal(shouldOfferFollow({
    profile: optedOut,
    message: 'nice',
    now: 200_000,
    directInteraction: true,
  }), false);
});

test('follow lines are soft, deterministic, and not coercive', () => {
  const one = followLineFor('viewer123');
  const two = followLineFor('viewer123');
  assert.equal(one, two);
  assert.match(one, /follow/i);
  assert.doesNotMatch(one, /must|need to|have to|otherwise|prove/i);
});

test('real-world session: one new viewer can progress from welcome to one soft CTA', () => {
  const start = 10_000_000;
  let profile = normalizeViewerProfile({}, start);

  profile = nextViewerProfile(profile, 'yo first time here, this game looks wild', start);
  assert.equal(shouldProactivelyWelcome({ profile, message: 'yo first time here, this game looks wild', isCommand: false }), true);
  assert.equal(shouldOfferFollow({ profile, message: 'yo first time here, this game looks wild', now: start, directInteraction: false }), false);

  profile = { ...profile, botInteractions: 1 };
  profile = nextViewerProfile(profile, '@clanker that last fight was crazy', start + 25_000);
  assert.equal(shouldOfferFollow({ profile, message: '@clanker that last fight was crazy', now: start + 25_000, directInteraction: true }), false);

  profile = nextViewerProfile(profile, 'lol okay that was actually awesome', start + 65_000);
  assert.equal(profile.messageCount, 3);
  assert.equal(shouldOfferFollow({ profile, message: 'lol okay that was actually awesome', now: start + 65_000, directInteraction: true }), true);

  profile = { ...profile, followPromptedAt: start + 65_000, botInteractions: 2 };
  profile = nextViewerProfile(profile, 'gg', start + 90_000);
  assert.equal(shouldOfferFollow({ profile, message: 'gg', now: start + 90_000, directInteraction: true }), false);
});

test('real-world session: several newcomers do not all get immediate follow pitches', () => {
  const now = 20_000_000;
  const viewers = [
    { name: 'alice', message: 'hey everyone' },
    { name: 'bob', message: 'what game is this' },
    { name: 'charlie', message: 'nice parry lol' },
    { name: 'dana', message: '!help' },
    { name: 'eve', message: 'just watching' },
  ];

  const results = viewers.map(({ name, message }) => {
    const profile = nextViewerProfile({}, message, now);
    return {
      name,
      welcome: shouldProactivelyWelcome({ profile, message, isCommand: message.startsWith('!') }),
      follow: shouldOfferFollow({ profile, message, now, directInteraction: false }),
    };
  });

  assert.equal(results.filter(x => x.welcome).length, 4);
  assert.equal(results.filter(x => x.follow).length, 0);
  assert.equal(results.find(x => x.name === 'dana').welcome, false);
});
