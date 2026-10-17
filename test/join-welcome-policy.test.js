import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWelcomeJoin } from '../src/chat/joinWelcomePolicy.js';

test('channel owner is not treated as an incoming viewer', () => {
  assert.equal(shouldWelcomeJoin({
    channel: '#saevond',
    username: 'saevond',
    botLogin: 'sweatyclanker',
  }), false);
});

test('SweatyClanker never welcomes itself', () => {
  assert.equal(shouldWelcomeJoin({
    channel: '#saevond',
    username: 'SweatyClanker',
    botLogin: 'sweatyclanker',
  }), false);
});

test('known service bots are filtered even if env ignore list is incomplete', () => {
  for (const username of ['Nightbot', 'StreamElements', 'WizeBot', 'Moobot', 'Fossabot']) {
    assert.equal(shouldWelcomeJoin({
      channel: '#saevond',
      username,
      botLogin: 'sweatyclanker',
      ignoredUsers: [],
    }), false, username);
  }
});

test('configured ignored users are not welcomed', () => {
  assert.equal(shouldWelcomeJoin({
    channel: '#saevond',
    username: 'customhelper',
    botLogin: 'sweatyclanker',
    ignoredUsers: ['customhelper'],
  }), false);
});

test('real incoming viewers are welcomed', () => {
  assert.equal(shouldWelcomeJoin({
    channel: '#saevond',
    username: 'newviewer42',
    botLogin: 'sweatyclanker',
    ignoredUsers: ['nightbot'],
  }), true);
});
