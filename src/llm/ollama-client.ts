/**
 * Ollama adapter for local development. Uses the native chat endpoint with
 * a JSON-schema `format` so the model is constrained to the shape asked
 * for, no streaming, temperature 0 for repeatable words, and a mild
 * repeat penalty so a model that starts restating a line pays for it.
 */

import { z } from 'zod';

import {
  LlmClientError,
  type LlmClient,
  type LlmJsonRequest,
  type LlmJsonResponse,
  type LlmTextRequest,
  type LlmTextResponse,
} from './types.js';

export type OllamaClientOptions = {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

type OllamaChatResponse = {
  model?: string;
  message?: { content?: string };
  error?: string;
};

export class OllamaClient implements LlmClient {
  readonly name = 'ollama';

  constructor(private readonly options: OllamaClientOptions) {}

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResponse> {
    const format = z.toJSONSchema(request.schema, { target: 'draft-2020-12', unrepresentable: 'any' });
    return this.chat(request.system, request.user, request.maxTokens, format);
  }

  async completeText(request: LlmTextRequest): Promise<LlmTextResponse> {
    return this.chat(request.system, request.user, request.maxTokens, null);
  }

  /** One non-streaming /api/chat call; `format` constrains the reply to a JSON schema when given. */
  private async chat(system: string, user: string, maxTokens: number, format: unknown): Promise<LlmJsonResponse> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = {
      model: this.options.model,
      stream: false,
      ...(format === null ? {} : { format }),
      options: { temperature: 0, num_predict: maxTokens, repeat_penalty: 1.1 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new LlmClientError(
        `ollama request failed: ${error instanceof Error ? error.message : String(error)}`,
        timedOut ? 'timeout' : 'transport',
      );
    }

    if (!response.ok) {
      throw new LlmClientError(`ollama responded ${response.status}`, 'transport');
    }

    const payload = (await response.json()) as OllamaChatResponse;
    if (payload.error) throw new LlmClientError(`ollama error: ${payload.error}`, 'bad_response');

    const text = payload.message?.content;
    if (typeof text !== 'string') {
      throw new LlmClientError('ollama response carried no message content', 'bad_response');
    }

    return { text, model: payload.model ?? this.options.model };
  }
}
