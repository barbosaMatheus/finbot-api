/**
 * A deterministic client for tests: returns scripted texts in order, or
 * throws a scripted error, and records every request it received.
 */

import {
  LlmClientError,
  type LlmClient,
  type LlmJsonRequest,
  type LlmJsonResponse,
  type LlmTextRequest,
  type LlmTextResponse,
} from './types.js';

export type FakeScript = string | Error | ((request: LlmJsonRequest<unknown> | LlmTextRequest) => string);

export class FakeLlmClient implements LlmClient {
  readonly name = 'fake';
  readonly requests: LlmJsonRequest<unknown>[] = [];
  readonly textRequests: LlmTextRequest[] = [];
  private readonly scripts: FakeScript[];

  constructor(scripts: FakeScript[] = []) {
    this.scripts = [...scripts];
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResponse> {
    this.requests.push(request as LlmJsonRequest<unknown>);
    return this.next(request as LlmJsonRequest<unknown>);
  }

  async completeText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.textRequests.push(request);
    return this.next(request);
  }

  private next(request: LlmJsonRequest<unknown> | LlmTextRequest): LlmJsonResponse {
    const script = this.scripts.shift();

    if (script === undefined) {
      throw new LlmClientError('fake client has no scripted response left', 'bad_response');
    }
    if (script instanceof Error) throw script;

    const text = typeof script === 'function' ? script(request) : script;
    return { text, model: 'fake-1' };
  }
}
