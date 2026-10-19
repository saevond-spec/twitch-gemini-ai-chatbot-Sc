export class AIProvidersUnavailableError extends Error {
  constructor(failures = []) {
    const lastFailure = failures[failures.length - 1]?.error || null;
    const balanceFailure = failures.find(({ error }) =>
      error?.status === 402 || error?.code === 'insufficient_balance'
    );
    super(failures.length
      ? 'All configured AI providers are unavailable'
      : 'No AI providers are configured');
    this.name = 'AIProvidersUnavailableError';
    this.status = balanceFailure ? 402 : (lastFailure?.status || null);
    this.code = balanceFailure
      ? 'insufficient_balance'
      : (lastFailure?.code || 'all_providers_unavailable');
    this.retryable = failures.some(({ error }) => error?.retryable !== false);
    this.providerFailures = failures.map(({ provider, error }) => ({
      provider,
      status: error?.status || null,
      code: error?.code || 'provider_unavailable',
    }));
    this.cause = lastFailure;
  }
}

export class AIProviderRouter {
  constructor({
    providers = [],
    providerOrder = [],
    failbackIntervalMs = 60_000,
    maxFailbackIntervalMs = 300_000,
    now = Date.now,
    random = Math.random,
    logger = { info() {}, warn() {} },
  } = {}) {
    const byName = new Map(
      providers
        .filter(provider => provider?.name && provider?.client?.chat)
        .map(provider => [String(provider.name).toLowerCase(), provider]),
    );
    const preferredNames = [...new Set(
      providerOrder.map(name => String(name).trim().toLowerCase()).filter(Boolean),
    )];

    this.providers = [
      ...preferredNames.map(name => byName.get(name)).filter(Boolean),
      ...[...byName.entries()]
        .filter(([name]) => !preferredNames.includes(name))
        .map(([, provider]) => provider),
    ];
    this.preferredProvider = this.providers[0]?.name || null;
    this.activeProvider = this.preferredProvider;
    this.failbackIntervalMs = Math.max(1_000, Number(failbackIntervalMs) || 60_000);
    this.maxFailbackIntervalMs = Math.max(
      this.failbackIntervalMs,
      Number(maxFailbackIntervalMs) || 300_000,
    );
    this.now = typeof now === 'function' ? now : Date.now;
    this.random = typeof random === 'function' ? random : Math.random;
    this.logger = logger;
    this.unavailableUntil = new Map();
    this.failureCounts = new Map();
  }

  getHealth() {
    const now = this.now();
    const providers = this.providers.map(({ name, client }) => {
      const cooldownUntil = this.unavailableUntil.get(name) || 0;
      const cooldownRemainingMs = Math.max(0, cooldownUntil - now);
      return {
        name,
        ...(typeof client.getHealth === 'function' ? client.getHealth() : {}),
        cooldownRemainingMs,
      };
    });

    return {
      configured: providers.length > 0,
      available: providers.some(provider =>
        provider.cooldownRemainingMs === 0 && provider.available !== false
      ),
      primaryProvider: this.preferredProvider,
      activeProvider: this.activeProvider,
      providers,
    };
  }

  async verifyCredentials() {
    return Promise.all(this.providers.map(async ({ name, client }) => {
      if (typeof client.verifyCredentials !== 'function') {
        return {
          provider: name,
          configured: true,
          authentication: 'unsupported',
          httpStatus: null,
        };
      }
      try {
        return await client.verifyCredentials();
      } catch (error) {
        return {
          provider: name,
          configured: true,
          authentication: 'unknown',
          httpStatus: Number(error?.response?.status || error?.status || 0) || null,
        };
      }
    }));
  }

  _orderedProviders() {
    if (!this.providers.length) return [];
    const now = this.now();
    const preferredDownUntil = this.unavailableUntil.get(this.preferredProvider) || 0;
    let ordered = this.providers;

    if (
      this.activeProvider &&
      this.activeProvider !== this.preferredProvider &&
      preferredDownUntil > now
    ) {
      const active = this.providers.find(provider => provider.name === this.activeProvider);
      ordered = [active, ...this.providers.filter(provider => provider !== active)];
    }

    const available = ordered.filter(provider =>
      (this.unavailableUntil.get(provider.name) || 0) <= now
    );
    return available;
  }

  async chat(messages, options = {}) {
    const ordered = this._orderedProviders();
    if (!this.providers.length) throw new AIProvidersUnavailableError();
    if (!ordered.length) {
      const now = this.now();
      const failures = this.providers.map(provider => {
        const error = new Error('Provider is in failback cooldown');
        error.code = 'provider_cooldown';
        error.retryable = true;
        error.status = null;
        return { provider: provider.name, error };
      });
      const error = new AIProvidersUnavailableError(failures);
      error.retryAfterMs = Math.min(...this.providers.map(provider =>
        Math.max(0, (this.unavailableUntil.get(provider.name) || now) - now)
      ));
      throw error;
    }

    const failures = [];
    for (let index = 0; index < ordered.length; index++) {
      const provider = ordered[index];
      try {
        const response = await provider.client.chat(messages, options);
        this.unavailableUntil.delete(provider.name);
        this.failureCounts.delete(provider.name);
        if (this.activeProvider && this.activeProvider !== provider.name) {
          this.logger.info('AI provider failover active: ' + provider.name);
        }
        this.activeProvider = provider.name;
        return response;
      } catch (error) {
        if (error?.canFailover === false || error?.code === 'prompt_injection') {
          throw error;
        }

        failures.push({ provider: provider.name, error });
        const failureCount = (this.failureCounts.get(provider.name) || 0) + 1;
        this.failureCounts.set(provider.name, failureCount);
        const exponent = Math.min(20, failureCount - 1);
        const baseDelay = this.failbackIntervalMs * (2 ** exponent);
        const jitter = 0.75 + (Math.max(0, Math.min(0.999999, Number(this.random()) || 0)) * 0.5);
        const cooldownMs = Math.min(
          this.maxFailbackIntervalMs,
          Math.max(1_000, Math.round(baseDelay * jitter)),
        );
        this.unavailableUntil.set(
          provider.name,
          this.now() + cooldownMs,
        );

        const next = ordered[index + 1];
        if (next) {
          const reason = error?.status
            ? 'HTTP ' + error.status
            : (error?.code || 'provider unavailable');
          this.logger.warn(
            'AI provider ' + provider.name + ' failed (' + reason +
            '); trying ' + next.name,
          );
        }
      }
    }

    throw new AIProvidersUnavailableError(failures);
  }
}
