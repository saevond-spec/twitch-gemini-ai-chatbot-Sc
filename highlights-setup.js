import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));

function replaceOnce(filePath, needle, replacement) {
  const current = fs.readFileSync(filePath, 'utf8');
  if (current.includes(replacement)) return false;
  if (!current.includes(needle)) throw new Error(`Highlight setup could not find its patch point in ${filePath}`);
  fs.writeFileSync(filePath, current.replace(needle, replacement), 'utf8');
  return true;
}

fs.mkdirSync(path.join(root, 'src/highlights'), { recursive: true });
fs.copyFileSync(path.join(root, 'highlight-detector.js'), path.join(root, 'src/highlights/detector.js'));

replaceOnce(
  path.join(root, 'src/app.js'),
  "import { writeFile } from 'fs/promises';",
  "import { writeFile } from 'fs/promises';\nimport { HighlightDetector } from './highlights/detector.js';"
);
replaceOnce(
  path.join(root, 'src/app.js'),
  'let pollinations = new PollinationsClient();',
  'let pollinations = new PollinationsClient();\nlet highlightDetector = null;'
);
replaceOnce(
  path.join(root, 'src/app.js'),
  '  await ConversationStore.updateLastActivity(channel);',
  "  await ConversationStore.updateLastActivity(channel);\n  if (highlightDetector) {\n    highlightDetector.observe({ channel, user, message }).catch((err) => log.warn('Highlight observation failed', err.message));\n  }"
);
replaceOnce(
  path.join(root, 'src/app.js'),
  "  deepseek = new DeepSeekClient();\n  log.info('DeepSeek client ready');",
  "  deepseek = new DeepSeekClient();\n  log.info('DeepSeek client ready');\n  highlightDetector = new HighlightDetector(deepseek);\n  await highlightDetector.start();"
);
replaceOnce(
  path.join(root, 'src/app.js'),
  '  if (messageQueue) messageQueue.stop();',
  '  if (messageQueue) messageQueue.stop();\n  if (highlightDetector) highlightDetector.stop();'
);

const envPath = path.join(root, '.env.example');
const envBlock = `
# AI-assisted Twitch VOD highlight detection
HIGHLIGHT_DETECTION_ENABLED=true
HIGHLIGHT_WINDOW_SECONDS=20
HIGHLIGHT_MIN_MESSAGES=3
HIGHLIGHT_COOLDOWN_SECONDS=150
HIGHLIGHT_MAX_CLIPS=5
CLIP_WEBHOOK_URL=https://amaana-yt.onrender.com/api/twitch/vod-clips
CLIP_WEBHOOK_KEY=
`;
const envCurrent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
if (!envCurrent.includes('HIGHLIGHT_DETECTION_ENABLED=')) {
  fs.appendFileSync(envPath, envBlock, 'utf8');
}

console.log('Highlight detector ready (idempotent setup).');
