import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHighlightSignals,
  isExplicitClipCommand,
  shouldEvaluateAutoClip,
  shouldFallbackClipWithoutAI,
} from '../src/highlights/scoring.js';

const NOW = 10_000_000;
function msg(secondsAgo, username, excitement = 0, message = 'chat') {
  return { at: NOW - secondsAgo * 1000, username, excitement, message };
}

test('quiet-stream multi-viewer hype becomes a high-confidence anomaly', () => {
  const signals = computeHighlightSignals({
    now: NOW,
    messageHistory: [
      msg(8, 'alice', 3, 'NO WAY'),
      msg(5, 'bob', 3, 'holy clutch'),
      msg(2, 'charlie', 3, 'insane'),
    ],
  });
  assert.ok(signals.poissonZ > 3);
  assert.ok(signals.score >= 80);
  assert.equal(shouldEvaluateAutoClip(signals, 64), true);
  assert.equal(shouldFallbackClipWithoutAI(signals, 84), true, 'three independent strong reactions clear the strict no-AI fallback');
});

test('one excited spammer does not beat the auto-clip threshold', () => {
  const signals = computeHighlightSignals({
    now: NOW,
    messageHistory: [
      msg(8, 'spammer', 3, 'OMG'),
      msg(6, 'spammer', 3, 'OMG'),
      msg(4, 'spammer', 3, 'OMG'),
      msg(2, 'spammer', 3, 'OMG'),
    ],
  });
  assert.ok(signals.spamPenalty > 1);
  assert.ok(signals.score < 64);
  assert.equal(shouldEvaluateAutoClip(signals, 64), false);
});

test('busy normal chat is judged against its own baseline instead of raw message count', () => {
  const baseline = Array.from({ length: 40 }, (_, i) =>
    msg(25 + i * 3, 'viewer' + (i % 8), 0, 'normal chat'));
  const recent = Array.from({ length: 5 }, (_, i) =>
    msg(2 + i * 3, 'recent' + i, i === 0 ? 1 : 0, 'nice'));
  const signals = computeHighlightSignals({ now: NOW, messageHistory: [...baseline, ...recent] });
  assert.ok(signals.baselineMessages >= 35);
  assert.ok(signals.score < 64);
});

test('independent clip votes strongly increase evidence', () => {
  const oneVote = computeHighlightSignals({
    now: NOW,
    messageHistory: [
      msg(6, 'alice', 6, '!clip'),
      msg(2, 'bob', 3, 'holy'),
    ],
  });
  const twoVotes = computeHighlightSignals({
    now: NOW,
    messageHistory: [
      msg(6, 'alice', 6, '!clip'),
      msg(2, 'bob', 6, '!clip that'),
    ],
  });
  assert.equal(oneVote.explicitClipVoters, 1);
  assert.equal(twoVotes.explicitClipVoters, 2);
  assert.ok(twoVotes.score > oneVote.score);
  assert.ok(twoVotes.score >= 84);
});

test('a follow without chat evidence never becomes a clip signal', () => {
  const signals = computeHighlightSignals({
    now: NOW,
    messageHistory: [],
    followEvents: [NOW - 1000],
  });
  assert.ok(signals.score < 64);
  assert.equal(shouldEvaluateAutoClip(signals, 64), false);
});

test('!clip command parsing is exact and does not mistake ordinary text for a command', () => {
  assert.equal(isExplicitClipCommand('!clip'), true);
  assert.equal(isExplicitClipCommand('!clip insane parry'), true);
  assert.equal(isExplicitClipCommand('someone clip that'), false);
  assert.equal(isExplicitClipCommand('paperclip'), false);
});
