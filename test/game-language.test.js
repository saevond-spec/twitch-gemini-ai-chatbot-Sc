import test from 'node:test';
import assert from 'node:assert/strict';
import { gameLanguageInstruction } from '../src/chat/gameLanguage.js';

test('uses the current live game category and drops the previous game on a switch', () => {
  const naraka = gameLanguageInstruction({ live: true, gameName: 'NARAKA: BLADEPOINT' });
  const arcRaiders = gameLanguageInstruction({ live: true, gameName: 'ARC Raiders' });

  assert.match(naraka, /NARAKA: BLADEPOINT/);
  assert.match(arcRaiders, /ARC Raiders/);
  assert.doesNotMatch(arcRaiders, /NARAKA/);
  assert.match(arcRaiders, /switch to its language/);
});

test('uses neutral language when a live game category is unavailable', () => {
  const instruction = gameLanguageInstruction({ live: true, gameName: '' });

  assert.match(instruction, /neutral gaming vocabulary/);
  assert.match(instruction, /do not assume which game/);
});

test('does not carry a prior game into offline replies', () => {
  assert.equal(gameLanguageInstruction({ live: false, gameName: 'NARAKA: BLADEPOINT' }), '');
});

test('treats non-game categories as topics instead of inventing game mechanics', () => {
  const instruction = gameLanguageInstruction({ live: true, gameName: 'Just Chatting' });

  assert.match(instruction, /Just Chatting/);
  assert.match(instruction, /not a game/);
});
