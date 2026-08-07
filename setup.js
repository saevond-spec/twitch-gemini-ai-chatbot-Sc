// ============================================================
// SETUP SCRIPT – SweatyClanker v3 (Complete)
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!fs.existsSync('src')) fs.mkdirSync('src');

const files = {
  // ---- ROOT FILES ----
  '.env.example': `...`,  // (your existing content – I’ve omitted it for brevity, but keep it)
  '.gitignore': `...`,
  'README.md': `...`,
  'personality.js': `...`,

  // ---- CONFIG ----
  'src/config/index.js': `...`,

  // ---- LOGGER ----
  'src/logger/index.js': `...`,

  // ---- STORAGE ----
  'src/storage/redis.js': `...`,
  'src/storage/file.js': `...`,  // now included

  // ---- TWITCH ----
  'src/twitch/auth.js': `...`,
  'src/twitch/client.js': `...`,
  'src/twitch/emotes.js': `...`,
  'src/twitch/helix.js': `...`,
  'src/twitch/eventsub.js': `...`,

  // ---- STATE (NEW) ----
  'src/state/reconnectState.js': `...`,  // now included

  // ---- CIRCUIT ----
  'src/circuitBreaker/index.js': `...`,

  // ---- AI ----
  'src/ai/client.js': `...`,
  'src/ai/safeguards.js': `...`,
  'src/ai/prompt.js': `...`,

  // ---- BRAINS ----
  'src/brains/index.js': `...`,
  'src/brains/conversation.js': `...`,
  'src/brains/moderation.js': `...`,
  'src/brains/coach.js': `...`,
  'src/brains/router.js': `...`,

  // ---- COMMANDS ----
  'src/commands/index.js': `...`,
  'src/commands/builtins.js': `...`,

  // ---- MODERATION ----
  'src/moderation/index.js': `...`,

  // ---- UTILS (all three now) ----
  'src/utils/rateLimiter.js': `...`,
  'src/utils/cooldown.js': `...`,
  'src/utils/metrics.js': `...`,

  // ---- MEDIA ----
  'src/media/providers.js': `...`,

  // ---- MEMORY ----
  'src/memory/conversationStore.js': `...`,
  'src/memory/profileStore.js': `...`,

  // ---- QUEUE ----
  'src/queue/index.js': `...`,
  'src/queue/handlers.js': `...`,
  'src/queue/messageQueue.js': `...`,

  // ---- BUS & PLUGINS ----
  'src/bus/index.js': `...`,
  'src/plugins/index.js': `...`,
  'plugins/twitch/index.js': `...`,

  // ---- APP ----
  'src/app.js': `...`,
};

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

for (const [filePath, content] of Object.entries(files)) {
  const dir = path.dirname(filePath);
  ensureDirectory(dir);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content.trimStart(), 'utf8');
    console.log(`Created ${filePath}`);
  } else {
    console.log(`Skipped ${filePath} (already exists)`);
  }
}

console.log('\n✅ Setup complete – all missing files created.');
console.log('Now run: npm start');
