
import { createLogger } from '../logger/index.js';
const log = createLogger('CIRCUIT');
export class CircuitBreaker {
  constructor({ name, failureThreshold = 5, timeout = 60000, resetTimeout = 60000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.timeout = timeout;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.lastFailure = 0;
    this.state = 'closed';
    this._openTimer = null;
  }

  // FIX: Half-open now actually allows trial requests
  isOpen() {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'half-open';
        log.info(`Circuit breaker ${this.name} half-open`);
        return false;   // allow trial
      }
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
  }

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      log.warn(`Circuit breaker ${this.name} opened after ${this.failures} failures`);
      this._openTimer = setTimeout(() => {
        this.state = 'half-open';
        log.info(`Circuit breaker ${this.name} half-open`);
      }, this.resetTimeout);
    }
  }

  reset() {
    this.failures = 0;
    this.state = 'closed';
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
  }
}
