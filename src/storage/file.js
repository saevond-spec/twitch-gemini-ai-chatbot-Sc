import fs from 'fs/promises';
import { createLogger } from '../logger/index.js';
const log = createLogger('FILE');
export async function readJSON(filePath, defaultValue = null) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    log.error(`Failed to read ${filePath}`, err);
    return defaultValue;
  }
}
export async function writeJSON(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error(`Failed to write ${filePath}`, err);
  }
}
