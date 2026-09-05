/**
 * A deterministic client for tests: returns scripted texts in order, or
 * throws a scripted error, and records every request it received.
 */

import { LlmClientError, type LlmClient, type LlmJsonRequest, type LlmJsonResponse } from './types.js';

export type FakeScript = string | Error | ((request: LlmJsonRequest<unknown>) => string);

export class FakeLlmClient implements LlmClient {
  readonly name = 'fake';
  readonly requests: LlmJsonRequest<unknown>[] = [];
  private readonly scripts: FakeScript[];

  constructor(scripts: FakeScript[] = []) {
    this.scripts = [...scripts];
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResponse> {
    this.requests.push(request as LlmJsonRequest<unknown>);
    const script = this.scripts.shift();

    if (script === undefined) {
      throw new LlmClientError('fake client has no scripted response left', 'bad_response');
    }
    if (script instanceof Error) throw script;

    const text = typeof script === 'function' ? script(request as LlmJsonRequest<unknown>) : script;
    return { text, model: 'fake-1' };
  }
}
