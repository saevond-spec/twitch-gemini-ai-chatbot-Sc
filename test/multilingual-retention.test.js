import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_USERNAME ||= 'sweatyclanker';
process.env.TWITCH_CLIENT_ID ||= 'test-client';
process.env.TWITCH_CLIENT_SECRET ||= 'test-secret';
process.env.JOIN_CHANNELS ||= 'saevond';
process.env.DEEPSEEK_API_KEY ||= 'test-key';
process.env.REDIS_URL = '';

const {
  detectLanguage,
  languageInstruction,
  localizedRetentionFallback,
  localizedGenericFallback,
} = await import('../src/chat/language.js');
const { RetentionStore } = await import('../src/chat/retentionStore.js');

test('script detection identifies Japanese, Chinese, Korean, and Hindi reliably', () => {
  assert.equal(detectLanguage('この試合やばいね').code, 'ja');
  assert.equal(detectLanguage('这个操作太强了').code, 'zh');
  assert.equal(detectLanguage('이 플레이 미쳤다').code, 'ko');
  assert.equal(detectLanguage('यह खेल बहुत अच्छा है').code, 'hi');
});

test('latin-script language detection handles Spanish, French, Vietnamese, Portuguese, German, and Italian', () => {
  assert.equal(detectLanguage('hola, ¿cómo va este juego?').code, 'es');
  assert.equal(detectLanguage('salut, merci pour cette partie').code, 'fr');
  assert.equal(detectLanguage('cảm ơn, pha này hay quá').code, 'vi');
  assert.equal(detectLanguage('olá, essa jogada foi muito boa').code, 'pt');
  assert.equal(detectLanguage('hallo, das spiel ist sehr gut').code, 'de');
  assert.equal(detectLanguage('ciao, questa giocata è molto bella').code, 'it');
});

test('short ambiguous messages keep the viewer previous language', () => {
  const result = detectLanguage('gg', 'ja');
  assert.equal(result.code, 'ja');
  assert.equal(result.source, 'prior');
});

test('clear language switch overrides the prior language', () => {
  const result = detectLanguage('hola, ¿cómo estás?', 'ja');
  assert.equal(result.code, 'es');
  assert.ok(result.confidence >= 0.75);
});

test('language instruction explicitly mirrors the viewer without exposing detection', () => {
  const text = languageInstruction('ko');
  assert.match(text, /Korean/);
  assert.match(text, /Reply in/);
  assert.match(text, /do not mention language detection/i);
});

test('localized retention fallbacks stay in the selected language', () => {
  const japanese = localizedRetentionFallback({
    code: 'ja',
    username: 'viewer',
    strategy: 'prediction',
    questionAllowed: true,
  });
  assert.match(japanese, /@viewer/);
  assert.match(japanese, /次/);
  assert.doesNotMatch(japanese, /Quick prediction/i);

  const spanish = localizedRetentionFallback({
    code: 'es',
    username: 'viewer',
    strategy: 'analysis',
    questionAllowed: false,
  });
  assert.match(spanish, /circuitos/i);
  assert.doesNotMatch(spanish, /\?/);

  const hindi = localizedGenericFallback({ code: 'hi', username: 'viewer' });
  assert.match(hindi, /@viewer/);
  assert.match(hindi, /मैं/);
});

test('retention stats are segmented by language while global aggregates both', async () => {
  RetentionStore.clearMemoryForTests();

  await RetentionStore.recordImpression({
    channel: '#saevond',
    viewer: 'alice',
    strategy: 'humor',
    language: 'es',
    at: 10_000,
    replyWindowMs: 120_000,
  });
  const reply = await RetentionStore.recordReply({
    channel: '#saevond',
    viewer: 'alice',
    at: 30_000,
  });
  assert.equal(reply.attributed, true);
  assert.equal(reply.language, 'es');

  await RetentionStore.recordImpression({
    channel: '#saevond',
    viewer: 'bob',
    strategy: 'humor',
    language: 'ja',
    at: 40_000,
    replyWindowMs: 120_000,
  });

  const es = await RetentionStore.getStrategyStats('humor', 'es');
  const ja = await RetentionStore.getStrategyStats('humor', 'ja');
  const global = await RetentionStore.getStrategyStats('humor', 'global');

  assert.equal(es.impressions, 1);
  assert.equal(es.replies, 1);
  assert.equal(ja.impressions, 1);
  assert.equal(ja.replies, 0);
  assert.equal(global.impressions, 2);
  assert.equal(global.replies, 1);
});

test('empirical-Bayes pooling gives sparse languages a finite prior without merging observations', async () => {
  RetentionStore.clearMemoryForTests();

  for (let i = 0; i < 8; i += 1) {
    const viewer = 'viewer-' + i;
    await RetentionStore.recordImpression({
      channel: '#saevond',
      viewer,
      strategy: 'analysis',
      language: 'en',
      at: 100_000 + i * 1000,
    });
    if (i < 4) {
      await RetentionStore.recordReply({
        channel: '#saevond',
        viewer,
        at: 100_500 + i * 1000,
      });
    }
  }

  const sparseJapanese = await RetentionStore.getStrategyStats('analysis', 'ja');
  assert.equal(sparseJapanese.impressions, 0);
  assert.equal(sparseJapanese.replies, 0);
  assert.ok(sparseJapanese.alpha > 1);
  assert.ok(sparseJapanese.beta > 4);
  assert.ok(Number.isFinite(sparseJapanese.alpha / (sparseJapanese.alpha + sparseJapanese.beta)));
});
