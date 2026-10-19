
import axios from 'axios';
import { config } from '../config/index.js';
import { createLogger } from '../logger/index.js';
import { CircuitBreaker } from '../circuitBreaker/index.js';
import { validateAIResponse, detectPromptInjection } from './safeguards.js';
import { AIProviderRouter } from './providerRouter.js';

const log = createLogger('AI-PROVIDERS');
const promptCache = new Map();
const CACHE_MAX = 100;
const BALANCE_RECHECK_MS = 5 * 60 * 1000;
const CREDENTIAL_CHECK_TIMEOUT_MS = 5_000;
const DEEPSEEK_API_ROOT = 'https://api.deepseek.com';

export class DeepSeekUnavailableError extends Error {
  constructor(message, { status = null, code = 'deepseek_unavailable', retryable = false, canFailover = true } = {}) {
    super(message);
    this.name = 'DeepSeekUnavailableError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.canFailover = canFailover;
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
    this.balanceEndpoint = DEEPSEEK_API_ROOT + '/user/balance';
    this.billingBlocked = false;
    this.nextBalanceCheckAt = 0;
    this.lastProviderStatus = null;
    this.credentialStatus = 'not_checked';
    this.credentialCheckedAt = null;
    this.lastBalanceCheckStatus = null;
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
      available: Boolean(this.apiKey)
        && !this.billingBlocked
        && this.credentialStatus !== 'rejected',
      configured: Boolean(this.apiKey),
      credentialStatus: this.credentialStatus,
      credentialCheckedAt: this.credentialCheckedAt,
      billingBlocked: this.billingBlocked,
      lastProviderStatus: this.lastProviderStatus,
      nextBalanceCheckAt: this.nextBalanceCheckAt || null,
    };
  }

  async verifyCredentials() {
    if (!String(this.apiKey || '').trim()) {
      this.credentialStatus = 'missing';
      this.credentialCheckedAt = new Date().toISOString();
      return {
        provider: 'deepseek',
        configured: false,
        authentication: 'missing',
        httpStatus: null,
        model: this.model,
      };
    }

    try {
      const response = await axios.get(this.balanceEndpoint, {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        timeout: Math.min(this.timeout, CREDENTIAL_CHECK_TIMEOUT_MS),
      });
      const accountAvailable = Boolean(response.data?.is_available);
      this.lastProviderStatus = response.status;
      this.credentialStatus = response.status === 200 ? 'verified' : 'unknown';
      this.credentialCheckedAt = new Date().toISOString();
      this.billingBlocked = response.status === 200 && !accountAvailable;
      this.nextBalanceCheckAt = this.billingBlocked
        ? Date.now() + BALANCE_RECHECK_MS
        : 0;
      return {
        provider: 'deepseek',
        configured: true,
        authentication: this.credentialStatus,
        httpStatus: response.status,
        accountAvailable,
        model: this.model,
      };
    } catch (error) {
      const status = statusOf(error);
      this.lastProviderStatus = status;
      this.credentialStatus = status === 401
        ? 'rejected'
        : status === 403
          ? 'permission_limited'
          : status === 402
            ? 'verified'
            : 'unknown';
      this.credentialCheckedAt = new Date().toISOString();
      if (status === 402) {
        this.billingBlocked = true;
        this.nextBalanceCheckAt = Date.now() + BALANCE_RECHECK_MS;
      }
      return {
        provider: 'deepseek',
        configured: true,
        authentication: this.credentialStatus,
        httpStatus: status,
        accountAvailable: status === 402 ? false : null,
        model: this.model,
      };
    }
  }

  async _checkBalanceIfBlocked() {
    if (!this.billingBlocked) return true;
    if (Date.now() < this.nextBalanceCheckAt) return false;

    this.nextBalanceCheckAt = Date.now() + BALANCE_RECHECK_MS;
    try {
      const response = await axios.get(this.balanceEndpoint, {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        timeout: Math.min(this.timeout, 8000),
      });
      const available = Boolean(response.data?.is_available);
      this.lastBalanceCheckStatus = available ? response.status : 402;
      if (available) {
        this.billingBlocked = false;
        this.lastProviderStatus = 200;
        this.credentialStatus = 'verified';
        this.credentialCheckedAt = new Date().toISOString();
        log.info('DeepSeek balance is available again; AI calls resumed');
        return true;
      }
      this.lastProviderStatus = 402;
      this.credentialStatus = 'verified';
      this.credentialCheckedAt = new Date().toISOString();
      return false;
    } catch (err) {
      this.lastBalanceCheckStatus = statusOf(err);
      this.lastProviderStatus = this.lastBalanceCheckStatus;
      if (this.lastBalanceCheckStatus === 401) this.credentialStatus = 'rejected';
      if (this.lastBalanceCheckStatus === 403) this.credentialStatus = 'permission_limited';
      this.credentialCheckedAt = new Date().toISOString();
      log.warn('DeepSeek balance recheck failed: ' + (this.lastProviderStatus || err.message));
      return false;
    }
  }

  async chat(messages, options = {}) {
    if (!(await this._checkBalanceIfBlocked())) {
      const status = this.lastBalanceCheckStatus;
      const authRejected = status === 401 || status === 403;
      const noBalance = status === 402;
      throw new DeepSeekUnavailableError(
        authRejected
          ? 'DeepSeek credential verification failed'
          : noBalance
            ? 'DeepSeek account balance unavailable'
            : 'DeepSeek balance check temporarily unavailable',
        {
          status,
          code: status === 401
            ? 'authentication_failed'
            : status === 403
              ? 'permission_limited'
              : noBalance
                ? 'insufficient_balance'
                : 'provider_unavailable',
          retryable: !authRejected && !noBalance,
        },
      );
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
          canFailover: false,
        });
      }
    }

    const { temperature = this.temperature, maxTokens = this.maxTokens, stream = false } = options;
    const requestMessages = messages.map(message => ({ ...message }));
    const totalText = requestMessages.map(m => m.content).join(' ');
    const estimatedTokens = this.estimateTokens(totalText);
    const budget = maxTokens || this.maxTokens;

    if (estimatedTokens > budget * 1.5) {
      log.warn('Estimated tokens exceed budget, truncating history');
      while (requestMessages.length > 2 && this.estimateTokens(requestMessages.map(m => m.content).join(' ')) > budget) {
        requestMessages.splice(1, 1);
      }
    }

    const payload = {
      model: this.model,
      messages: requestMessages,
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
        this.credentialStatus = 'verified';
        this.credentialCheckedAt = new Date().toISOString();
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
          this.lastBalanceCheckStatus = 402;
          this.credentialStatus = 'verified';
          this.credentialCheckedAt = new Date().toISOString();
          this.nextBalanceCheckAt = Date.now() + BALANCE_RECHECK_MS;
          log.warn('DeepSeek reported insufficient balance (402); pausing retries so the router can fail over');
          throw new DeepSeekUnavailableError('DeepSeek insufficient balance', {
            status: 402,
            code: 'insufficient_balance',
            retryable: false,
          });
        }

        if (status === 401) {
          this.credentialStatus = 'rejected';
          this.credentialCheckedAt = new Date().toISOString();
        } else if (status === 403) {
          this.credentialStatus = 'permission_limited';
          this.credentialCheckedAt = new Date().toISOString();
        }

        if (status && !isRetryableStatus(status)) {
          log.warn('DeepSeek returned non-retryable HTTP ' + status + '; allowing provider failover');
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

const openAICircuitBreaker = new CircuitBreaker({
  name: 'openai',
  failureThreshold: config.deepseek.circuitBreakerThreshold || 5,
  timeout: 60000,
  resetTimeout: 60000,
});

export class OpenAIUnavailableError extends Error {
  constructor(message, {
    status = null,
    code = 'openai_unavailable',
    retryable = false,
    canFailover = true,
  } = {}) {
    super(message);
    this.name = 'OpenAIUnavailableError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.canFailover = canFailover;
  }
}

export class OpenAIClient {
  constructor() {
    this.apiKey = config.openai.apiKey;
    this.model = config.openai.model;
    this.maxTokens = config.deepseek.maxTokens;
    this.temperature = config.deepseek.temperature;
    this.timeout = config.openai.timeoutMs || 10000;
    this.lastProviderStatus = null;
    this.credentialStatus = 'not_checked';
    this.credentialCheckedAt = null;
    this.endpoint = 'https://api.openai.com/v1/chat/completions';
    this.modelsEndpoint = 'https://api.openai.com/v1/models';
  }

  getHealth() {
    return {
      available: Boolean(this.apiKey)
        && this.credentialStatus !== 'rejected'
        && this.credentialStatus !== 'permission_limited',
      configured: Boolean(this.apiKey),
      credentialStatus: this.credentialStatus,
      credentialCheckedAt: this.credentialCheckedAt,
      lastProviderStatus: this.lastProviderStatus,
      model: this.model,
    };
  }

  async verifyCredentials() {
    if (!String(this.apiKey || '').trim()) {
      this.credentialStatus = 'missing';
      this.credentialCheckedAt = new Date().toISOString();
      return {
        provider: 'openai',
        configured: false,
        authentication: 'missing',
        httpStatus: null,
        model: this.model,
      };
    }

    try {
      const response = await axios.get(this.modelsEndpoint, {
        headers: { Authorization: 'Bearer ' + this.apiKey },
        timeout: Math.min(this.timeout, CREDENTIAL_CHECK_TIMEOUT_MS),
      });
      this.lastProviderStatus = response.status;
      this.credentialStatus = response.status === 200 ? 'verified' : 'unknown';
      this.credentialCheckedAt = new Date().toISOString();
      return {
        provider: 'openai',
        configured: true,
        authentication: this.credentialStatus,
        httpStatus: response.status,
        model: this.model,
      };
    } catch (error) {
      const status = statusOf(error);
      this.lastProviderStatus = status;
      this.credentialStatus = status === 401
        ? 'rejected'
        : status === 403
          ? 'permission_limited'
          : 'unknown';
      this.credentialCheckedAt = new Date().toISOString();
      return {
        provider: 'openai',
        configured: true,
        authentication: this.credentialStatus,
        httpStatus: status,
        model: this.model,
      };
    }
  }

  async chat(messages, options = {}) {
    const userMessages = messages.filter(message => message.role === 'user');
    for (const message of userMessages) {
      if (detectPromptInjection(message.content)) {
        throw new OpenAIUnavailableError('Prompt injection detected', {
          code: 'prompt_injection',
          retryable: false,
          canFailover: false,
        });
      }
    }

    if (openAICircuitBreaker.isOpen()) {
      throw new OpenAIUnavailableError('OpenAI circuit breaker open', {
        code: 'circuit_open',
        retryable: true,
      });
    }

    const requestMessages = messages.map(message => ({ ...message }));
    const budget = Math.max(1, Math.floor(Number(options.maxTokens) || this.maxTokens));
    const payload = {
      model: this.model,
      messages: requestMessages,
      temperature: options.temperature ?? this.temperature,
      max_completion_tokens: budget,
    };

    try {
      const response = await axios.post(this.endpoint, payload, {
        headers: {
          Authorization: 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
      });

      const content = response.data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenAI returned an empty response');
      }

      validateAIResponse(content);
      this.lastProviderStatus = response.status;
      this.credentialStatus = 'verified';
      this.credentialCheckedAt = new Date().toISOString();
      openAICircuitBreaker.recordSuccess();
      log.debug('OpenAI response received', { usage: response.data?.usage });
      return content;
    } catch (error) {
      const status = statusOf(error);
      this.lastProviderStatus = status;
      if (status === 401) this.credentialStatus = 'rejected';
      else if (status === 403) this.credentialStatus = 'permission_limited';
      else if (status === 200) this.credentialStatus = 'verified';
      if (status) this.credentialCheckedAt = new Date().toISOString();
      const retryable = !status || isRetryableStatus(status);
      if (retryable || status === 401 || status === 402 || status === 403) {
        openAICircuitBreaker.recordFailure();
      }

      const code = status === 401 || status === 403
        ? 'authentication_failed'
        : status === 402
          ? 'insufficient_balance'
          : status === 429
            ? 'rate_limited'
            : status
              ? 'request_rejected'
              : 'provider_unavailable';
      log.warn('OpenAI provider request failed', { status, code });
      throw new OpenAIUnavailableError(
        'OpenAI request failed' + (status ? ' with HTTP ' + status : ''),
        { status, code, retryable },
      );
    }
  }
}

export function createAIClient() {
  const providers = [];
  if (config.deepseek.apiKey?.trim()) {
    providers.push({ name: 'deepseek', client: new DeepSeekClient() });
  }
  if (config.openai.apiKey?.trim()) {
    providers.push({ name: 'openai', client: new OpenAIClient() });
  }
  return new AIProviderRouter({
    providers,
    providerOrder: config.ai.providerOrder,
    failbackIntervalMs: config.ai.failbackIntervalMs,
    maxFailbackIntervalMs: config.ai.maxFailbackIntervalMs,
    logger: log,
  });
}
