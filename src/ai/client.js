
import axios from 'axios';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { CircuitBreaker } from '../circuitBreaker/index.js';
import { validateAIResponse, detectPromptInjection } from './safeguards.js';

const log = createLogger('DEEPSEEK');
const promptCache = new Map();
const CACHE_MAX = 100;
const circuitBreaker = new CircuitBreaker({
  name: 'deepseek',
  failureThreshold: config.deepseek.circuitBreakerThreshold || 5,
  timeout: 60000,
  resetTimeout: 60000,
});

export class DeepSeekClient {
  constructor() {
    this.apiKey = config.deepseek.apiKey;
    this.model = config.deepseek.model;
    this.maxTokens = config.deepseek.maxTokens;
    this.temperature = config.deepseek.temperature;
    this.timeout = config.deepseek.timeoutMs || 10000;
    this.retries = config.deepseek.maxRetries || 3;
    this.baseURL = 'https://api.deepseek.com/v1';
  }

  estimateTokens(text) { return Math.ceil(text.length / 4); }

  getCachedSystemPrompt(systemPrompt) {
    const key = systemPrompt.slice(0, 100);
    if (promptCache.has(key)) return promptCache.get(key);
    promptCache.set(key, systemPrompt);
    if (promptCache.size > CACHE_MAX) {
      const firstKey = promptCache.keys().next().value;
      promptCache.delete(firstKey);
    }
    return systemPrompt;
  }

  async chat(messages, options = {}) {
    if (circuitBreaker.isOpen()) {
      throw new Error('Circuit breaker open – too many failures');
    }

    const userMessages = messages.filter(m => m.role === 'user');
    for (const msg of userMessages) {
      if (detectPromptInjection(msg.content)) {
        throw new Error('Prompt injection detected');
      }
    }

    const { temperature = this.temperature, maxTokens = this.maxTokens, stream = false } = options;
    const totalText = messages.map(m => m.content).join(' ');
    const estimatedTokens = this.estimateTokens(totalText);
    const budget = maxTokens || this.maxTokens;

    if (estimatedTokens > budget * 1.5) {
      log.warn('Estimated tokens exceed budget, truncating history');
      while (messages.length > 2 && this.estimateTokens(messages.map(m => m.content).join(' ')) > budget) {
        messages.splice(1, 1);
      }
    }

    const payload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: budget,
      stream,
    };

    let attempt = 0;
    let lastError;

    while (attempt < this.retries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const response = await axios.post(`${this.baseURL}/chat/completions`, payload, {
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
          timeout: this.timeout,
          responseType: stream ? 'stream' : 'json',
        });
        clearTimeout(timeoutId);

        circuitBreaker.recordSuccess();

        if (stream) return this._handleStream(response);

        const content = response.data.choices[0].message.content;
        validateAIResponse(content);
        log.debug('DeepSeek response received', { usage: response.data.usage });
        return content;

      } catch (err) {
        attempt++;
        lastError = err;
        // Only retry if we still have attempts left
        if (attempt < this.retries) {
          const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
          await this._delay(delay);
        }
      }
    }

    // FIX: Record failure only once after all retries exhausted
    circuitBreaker.recordFailure();
    // FIX: Log only error message, not full object (prevents key leak)
    log.error(`DeepSeek call failed: ${lastError.message}`);
    throw lastError;
  }

  async _handleStream(response) {
    return new Promise((resolve, reject) => {
      let fullContent = '';
      response.data.on('data', chunk => {
        const lines = chunk.toString().split('\n').filter(line => line.trim().startsWith('data:'));
        for (const line of lines) {
          const data = line.replace(/^data: /, '').trim();
          if (data === '[DONE]') { resolve(fullContent); return; }
          try {
            const json = JSON.parse(data);
            const content = json.choices[0]?.delta?.content || '';
            fullContent += content;
          } catch (e) { /* ignore */ }
        }
      });
      response.data.on('error', reject);
      response.data.on('end', () => resolve(fullContent));
    });
  }

  _delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}
