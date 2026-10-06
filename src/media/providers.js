
import axios from 'axios';
import { createLogger } from '../logger/index.js';
const log = createLogger('MEDIA');

export class PollinationsClient {
  async generateImage(prompt) {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'image/png' };
  }
  async generateVideo(prompt) {
    throw new Error('Video generation is currently unavailable. Try !image instead.');
  }
  async generateAudio(prompt) {
    const url = `https://pollinations.ai/audio?text=${encodeURIComponent(prompt)}`;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return { buffer: response.data, mimeType: 'audio/mpeg' };
  }
  async generateMusic(prompt) {
    throw new Error('Music generation is currently unavailable. Try !tts instead.');
  }
}
