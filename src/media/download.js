import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';

export async function downloadToTemp(url, extension = '.mp4', maxBytes = 1024 * 1024 * 1024) {
  const target = path.join(os.tmpdir(), `sweatyclanker-${randomUUID()}${extension}`);
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 60000,
    maxRedirects: 3,
  });

  const declared = Number(response.headers['content-length'] || 0);
  if (declared && declared > maxBytes) throw new Error('Media file is larger than the configured limit');

  let received = 0;
  response.data.on('data', chunk => {
    received += chunk.length;
    if (received > maxBytes) response.data.destroy(new Error('Media download exceeded size limit'));
  });

  await pipeline(response.data, fs.createWriteStream(target, { flags: 'wx' }));
  return target;
}

export async function safeUnlink(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch {}
}
