import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();

function allJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('all relative JS imports resolve to committed files', () => {
  const files = [
    ...allJs(path.join(root, 'src')),
    path.join(root, 'personality.js'),
    path.join(root, 'plugins/twitch/index.js'),
  ].filter(fs.existsSync);

  const missing = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      let target = path.resolve(path.dirname(file), spec);
      if (!path.extname(target)) target += '.js';
      if (!fs.existsSync(target)) missing.push(`${path.relative(root, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('all committed runtime JavaScript parses', () => {
  const files = allJs(path.join(root, 'src'));
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr}`);
  }
  assert.deepEqual(failures, []);
});

test('production start does not regenerate source', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prestart, undefined);
  assert.equal(pkg.scripts.start, 'node src/app.js');
  assert.equal(pkg.dependencies['ffmpeg-static'], '5.3.0');
});

test('Render config is DeepSeek-only and runs real workers', () => {
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(render, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(render, /GEMINI_API_KEY|gemini-2\.5|UPSTASH_REDIS_URL|CLIP_WEBHOOK_URL/);
  assert.match(render, /REDIS_URL/);
  assert.match(render, /WORKERS_ENABLED\n\s+value: "true"/);
});

test('OAuth state, admin protection, and Twitch clip scope are present', () => {
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'src/twitch/auth.js'), 'utf8');
  assert.match(app, /createOAuthState/);
  assert.match(app, /consumeOAuthState/);
  assert.match(app, /Invalid or expired OAuth state/);
  assert.match(app, /requireAdmin/);
  assert.match(app, /BOT_SCOPES\.join/);
  assert.match(auth, /channel:manage:clips/);
  assert.match(auth, /missingScopes/);
});

test('highlight finalization uses official Twitch clipping rather than webhook handoff', () => {
  const detector = fs.readFileSync(path.join(root, 'src/highlights/detector.js'), 'utf8');
  assert.match(detector, /createClipFromVod/);
  assert.match(detector, /enqueueTask\('generate-clips'/);
  assert.doesNotMatch(detector, /CLIP_WEBHOOK_URL|Amaana returned/);
});

test('official Twitch download and portrait fallback pipeline is present', () => {
  const twitch = fs.readFileSync(path.join(root, 'src/clips/twitchClipService.js'), 'utf8');
  const handlers = fs.readFileSync(path.join(root, 'src/queue/handlers.js'), 'utf8');
  assert.match(twitch, /clips\/downloads/);
  assert.match(handlers, /portrait_download_url/);
  assert.match(handlers, /landscape_download_url/);
  assert.match(handlers, /renderVerticalShort/);
  assert.doesNotMatch(handlers, /not implemented in SweatyClanker/);
});

test('YouTube uses OAuth resumable upload and defaults to private', () => {
  const auth = fs.readFileSync(path.join(root, 'src/social/youtubeAuth.js'), 'utf8');
  const uploader = fs.readFileSync(path.join(root, 'src/social/youtube.js'), 'utf8');
  assert.match(auth, /youtube\.upload/);
  assert.match(auth, /refresh_token/);
  assert.match(uploader, /uploadType=resumable/);
  assert.match(uploader, /YOUTUBE_ALLOW_PUBLIC/);
});

test('TikTok integration is draft-only and Discord announcements are implemented', () => {
  const tiktok = fs.readFileSync(path.join(root, 'src/social/tiktok.js'), 'utf8');
  const discord = fs.readFileSync(path.join(root, 'src/social/discord.js'), 'utf8');
  assert.match(tiktok, /publish\/inbox\/video\/init/);
  assert.doesNotMatch(tiktok, /creator_info|privacy_level|PUBLIC_TO_EVERYONE/);
  assert.match(discord, /DISCORD_WEBHOOK_URL/);
});

test('publish store separates completion records from retry locks', () => {
  const store = fs.readFileSync(path.join(root, 'src/social/publishStore.js'), 'utf8');
  assert.match(store, /publish-lock:/);
  assert.match(store, /publish-failure:/);
  assert.match(store, /NX/);
  assert.match(store, /redis\.del\(lockKey/);
});


test('analytical brain and adaptive quiet chat are wired into production', () => {
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const brains = fs.readFileSync(path.join(root, 'src/brains/index.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

  assert.match(brains, /analyst:\s*AnalystBrain/);
  assert.match(app, /new StreamMomentTracker\(\)/);
  assert.match(app, /quietSpeakProbability/);
  assert.match(app, /analyticalMomentGate\.allow/);
  assert.match(app, /engagementAttribution\.recordQuiet/);
  assert.match(app, /engagementAttribution\.recordAnalytical/);
  assert.match(render, /AUTO_CHAT_MIN_QUIET_SECONDS\n\s+value: "90"/);
  assert.match(render, /AUTO_CHAT_MAX_QUIET_SECONDS\n\s+value: "360"/);
  assert.match(render, /ANALYTICAL_AUTO_COMMENT_ENABLED\n\s+value: "true"/);
});


test('advanced commerce strategy is wired into Twitch runtime', () => {
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'src/twitch/auth.js'), 'utf8');
  const eventsub = fs.readFileSync(path.join(root, 'src/twitch/eventsub.js'), 'utf8');
  const helix = fs.readFileSync(path.join(root, 'src/twitch/helix.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

  assert.match(app, /new CommerceEngine/);
  assert.match(app, /commerceEngine\.consider/);
  assert.match(app, /\/api\/commerce\/stats/);
  assert.match(app, /\/api\/commerce\/conversion/);
  assert.doesNotMatch(auth, /['"]channel:read:subscriptions['"]/);
  assert.doesNotMatch(auth, /['"]bits:read['"]/);
  assert.doesNotMatch(eventsub, /this\.helix\.subscribeChannelSubscribe/);
  assert.doesNotMatch(eventsub, /this\.helix\.subscribeSubscriptionGift/);
  assert.doesNotMatch(eventsub, /this\.helix\.subscribeBitsUse/);
  assert.match(app, /irc_bits/);
  assert.match(app, /subscriptionNotices/);
  assert.match(helix, /channel\.subscribe/);
  assert.match(helix, /channel\.subscription\.gift/);
  assert.match(helix, /channel\.bits\.use/);
  assert.match(render, /SALES_ENGINE_ENABLED\n\s+value: "true"/);
  assert.match(render, /BRANDED_CONTENT_DISCLOSURE_CONFIRMED\n\s+value: "false"/);
});


test('Twitch chat authorization is bound to the configured bot identity', () => {
  const auth = fs.readFileSync(path.join(root, 'src/twitch/auth.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');

  assert.match(auth, /twitch:oauth:bot/);
  assert.match(auth, /LEGACY_TOKEN_KEY = 'twitch:oauth'/);
  assert.match(auth, /tokenBelongsToConfiguredBot/);
  assert.match(auth, /Wrong Twitch account authorized/);
  assert.match(auth, /revokeAccessToken/);
  assert.match(auth, /Revoking it and refusing chat startup/);
  assert.match(app, /Authorize SweatyClanker bot account/);
});


test('join welcomes are wired into production runtime', () => {
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

  assert.match(app, /new JoinWelcomeBatcher/);
  assert.match(app, /bus\.on\('twitch\.join'/);
  assert.match(app, /joinWelcomeBatcher\.add/);
  assert.match(app, /joinWelcomeBatcher\.hasWelcomed/);
  assert.match(app, /self \|\| !login/);
  assert.match(app, /login === configuredBotLogin\(\)/);
  assert.match(render, /WELCOME_ON_JOIN\n\s+value: "true"/);
  assert.match(render, /JOIN_WELCOME_WARMUP_SECONDS\n\s+value: "20"/);
});
