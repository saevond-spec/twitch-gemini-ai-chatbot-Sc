
import axios from 'axios';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { CircuitBreaker } from '../circuitBreaker/index.js';
import { validateAIResponse, detectPromptInjection } from './safeguards.js';

const log = createLogger('DEEPSEEK');
const promptCache = new Map();
const CACHE_MAX = 100;
const BALANCE_RECHECK_MS = 5 * 60 * 1000;

export class DeepSeekUnavailableError extends Error {
  constructor(message, { status = null, code = 'deepseek_unavailable', retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekUnavailableError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function statusOf(err) {
  return Number(err?.response?.status || 0) || null;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
}
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
    this.billingBlocked = false;
    this.nextBalanceCheckAt = 0;
    this.lastProviderStatus = null;
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

  getHealth() {
    return {
      available: !this.billingBlocked,
      billingBlocked: this.billingBlocked,
      lastProviderStatus: this.lastProviderStatus,
      nextBalanceCheckAt: this.nextBalanceCheckAt || null,
    };
  }

  async _checkBalanceIfBlocked() {
    if (!this.billingBlocked) return true;
    if (Date.now() < this.nextBalanceCheckAt) return false;

    this.nextBalanceCheckAt = Date.now() + BALANCE_RECHECK_MS;
    try {
      const response = await axios.get(this.baseURL + '/user/balance', {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        timeout: Math.min(this.timeout, 8000),
      });
      const available = Boolean(response.data?.is_available);
      if (available) {
        this.billingBlocked = false;
        this.lastProviderStatus = 200;
        log.info('DeepSeek balance is available again; AI calls resumed');
        return true;
      }
      this.lastProviderStatus = 402;
      return false;
    } catch (err) {
      this.lastProviderStatus = statusOf(err);
      log.warn('DeepSeek balance recheck failed: ' + (this.lastProviderStatus || err.message));
      return false;
    }
  }

  async chat(messages, options = {}) {
    if (!(await this._checkBalanceIfBlocked())) {
      throw new DeepSeekUnavailableError('DeepSeek account balance unavailable; using local fallback', {
        status: 402,
        code: 'insufficient_balance',
        retryable: false,
      });
    }

    if (circuitBreaker.isOpen()) {
      throw new DeepSeekUnavailableError('DeepSeek circuit breaker open', {
        code: 'circuit_open',
        retryable: true,
      });
    }

    const userMessages = messages.filter(m => m.role === 'user');
    for (const msg of userMessages) {
      if (detectPromptInjection(msg.content)) {
        throw new DeepSeekUnavailableError('Prompt injection detected', {
          code: 'prompt_injection',
          retryable: false,
        });
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

        this.lastProviderStatus = response.status;
        circuitBreaker.recordSuccess();

        if (stream) return this._handleStream(response);

        const content = response.data.choices[0].message.content;
        validateAIResponse(content);
        log.debug('DeepSeek response received', { usage: response.data.usage });
        return content;

      } catch (err) {
        const status = statusOf(err);
        this.lastProviderStatus = status;
        lastError = err;

        if (status === 402) {
          this.billingBlocked = true;
          this.nextBalanceCheckAt = Date.now() + BALANCE_RECHECK_MS;
          log.warn('DeepSeek reported insufficient balance (402); switching to local fallback and pausing paid API retries');
          throw new DeepSeekUnavailableError('DeepSeek insufficient balance', {
            status: 402,
            code: 'insufficient_balance',
            retryable: false,
          });
        }

        if (status && !isRetryableStatus(status)) {
          log.warn('DeepSeek returned non-retryable HTTP ' + status + '; using local fallback');
          throw new DeepSeekUnavailableError('DeepSeek non-retryable HTTP ' + status, {
            status,
            code: status === 401 ? 'authentication_failed' : 'request_rejected',
            retryable: false,
          });
        }

        attempt++;
        if (attempt < this.retries) {
          const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
          await this._delay(delay);
        }
      }
    }

    circuitBreaker.recordFailure();
    log.error('DeepSeek call failed after retries: ' + (lastError?.message || 'unknown error'));
    throw new DeepSeekUnavailableError('DeepSeek temporarily unavailable', {
      status: statusOf(lastError),
      code: 'provider_unavailable',
      retryable: true,
    });
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
