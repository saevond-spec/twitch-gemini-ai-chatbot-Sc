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
    this.logger = logger;
    this.unavailableUntil = new Map();
  }

  getHealth() {
    return {
      available: this.providers.length > 0,
      primaryProvider: this.preferredProvider,
      activeProvider: this.activeProvider,
      providers: this.providers.map(({ name, client }) => ({
        name,
        ...(typeof client.getHealth === 'function' ? client.getHealth() : {}),
      })),
    };
  }

  _orderedProviders() {
    if (!this.providers.length) return [];
    const now = Date.now();
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
    return available.length ? available : ordered;
  }

  async chat(messages, options = {}) {
    const ordered = this._orderedProviders();
    if (!ordered.length) throw new AIProvidersUnavailableError();

    const failures = [];
    for (let index = 0; index < ordered.length; index++) {
      const provider = ordered[index];
      try {
        const response = await provider.client.chat(messages, options);
        this.unavailableUntil.delete(provider.name);
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
        this.unavailableUntil.set(
          provider.name,
          Date.now() + this.failbackIntervalMs,
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
