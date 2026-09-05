/**
 * Jest stand-in for pg-boss. The real package ships ESM-only, which the CJS
 * ts-jest transform cannot load; unit tests exercise the job layer through
 * the BossLike seam with fakes, so this stub only needs to exist and satisfy
 * the constructor/type surface used at import time.
 */

export class PgBoss {
  constructor(_options: unknown) {}

  on(): this {
    return this;
  }

  async start(): Promise<this> {
    return this;
  }

  async stop(): Promise<void> {}

  async createQueue(): Promise<void> {}

  async send(): Promise<string | null> {
    return null;
  }

  async sendDebounced(): Promise<string | null> {
    return null;
  }

  async work(): Promise<string> {
    return 'stub-worker';
  }
}

export default PgBoss;
