/**
 * Ollama adapter for local development. Uses the native chat endpoint with
 * a JSON-schema `format` so the model is constrained to the shape asked
 * for, no streaming, temperature 0 for repeatable words.
 */

import { z } from 'zod';

import { LlmClientError, type LlmClient, type LlmJsonRequest, type LlmJsonResponse } from './types.js';

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
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/chat`;
    const body = {
      model: this.options.model,
      stream: false,
      format: z.toJSONSchema(request.schema, { target: 'draft-2020-12', unrepresentable: 'any' }),
      options: { temperature: 0, num_predict: request.maxTokens },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
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
