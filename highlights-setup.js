import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(root, 'src/app.js');
const runtimeDetectorPath = path.join(root, 'src/highlights/detector.js');

// The current app has a first-class detector in src/. Do not replace its queue-backed
// runtime with the legacy compatibility copy from the repository root.
if (fs.existsSync(runtimeDetectorPath) &&
    fs.readFileSync(appPath, 'utf8').includes("from './highlights/detector.js'")) {
  console.log('Native highlight detector already installed; runtime files left intact.');
  process.exit(0);
}

function replaceOnce(filePath, needle, replacement) {
  const current = fs.readFileSync(filePath, 'utf8');
  if (!current.includes(needle)) throw new Error(`Highlight setup could not find its patch point in ${filePath}`);
  fs.writeFileSync(filePath, current.replace(needle, replacement), 'utf8');
}

fs.mkdirSync(path.join(root, 'src/highlights'), { recursive: true });
fs.copyFileSync(path.join(root, 'highlight-detector.js'), path.join(root, 'src/highlights/detector.js'));
fs.copyFileSync(path.join(root, 'highlight-window.js'), path.join(root, 'src/highlights/final-window.js'));

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

fs.appendFileSync(path.join(root, '.env.example'), `
# AI-assisted Twitch VOD highlight detection
HIGHLIGHT_DETECTION_ENABLED=true
HIGHLIGHT_WINDOW_SECONDS=20
HIGHLIGHT_MIN_MESSAGES=3
HIGHLIGHT_COOLDOWN_SECONDS=150
HIGHLIGHT_MAX_CLIPS=5
CLIP_WEBHOOK_URL=https://amaana-yt.onrender.com/api/twitch/vod-clips
CLIP_WEBHOOK_KEY=
`, 'utf8');

console.log('Highlight detector installed.');
