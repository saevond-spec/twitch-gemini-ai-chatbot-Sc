import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

test('production start does not regenerate source', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.prestart, undefined);
  assert.equal(pkg.scripts.start, 'node src/app.js');
});

test('Render config is DeepSeek-only and uses the runtime Redis variable', () => {
  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  assert.match(render, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(render, /GEMINI_API_KEY|gemini-2\.5|UPSTASH_REDIS_URL/);
  assert.match(render, /REDIS_URL/);
});

test('OAuth state and admin protections are present', () => {
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.match(app, /createOAuthState/);
  assert.match(app, /consumeOAuthState/);
  assert.match(app, /Invalid or expired OAuth state/);
  assert.match(app, /requireAdmin/);
});

test('incomplete social/media workers cannot report false success', () => {
  const handlers = fs.readFileSync(path.join(root, 'src/queue/handlers.js'), 'utf8');
  for (const name of ['analyze-vod','generate-clips','create-thumbnail','stream-summary','post-social','discord-announce','memory-cleanup']) {
    assert.match(handlers, new RegExp(name));
  }
  assert.match(handlers, /not implemented in SweatyClanker/);
});
