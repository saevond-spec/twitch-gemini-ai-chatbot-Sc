// src/plugins/index.js
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger/index.js';

const log = createLogger('PLUGIN');

export async function loadPlugins(bus, config) {
  const pluginsDir = path.resolve(process.cwd(), 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    log.warn('Plugins directory not found, skipping plugin loading.');
    return;
  }

  const items = fs.readdirSync(pluginsDir, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) continue;
    try {
      const pluginPath = path.join(pluginsDir, item.name, 'index.js');
      if (!fs.existsSync(pluginPath)) continue;
      const plugin = await import(pluginPath);
      if (plugin.manifest && typeof plugin.register === 'function') {
        await plugin.register(bus, config);
        log.info(`✅ Plugin "${item.name}" registered`);
      }
    } catch (err) {
      log.error(`Failed to load plugin "${item.name}"`, err);
    }
  }
}
