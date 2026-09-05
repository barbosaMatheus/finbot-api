/**
 * Anthropic adapter for production. Structured outputs constrain the
 * response to the schema; the provider still re-validates and runs the
 * number-containment check, so the model's words never reach the screen
 * unchecked. A refusal or any API failure surfaces as an LlmClientError
 * and the provider falls back to the template.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

import { LlmClientError, type LlmClient, type LlmJsonRequest, type LlmJsonResponse } from './types.js';

export type AnthropicClientOptions = {
  model: string;
  timeoutMs: number;
  /** Thinking depth; narration is simple work, so the default is low. */
  effort: 'low' | 'medium' | 'high';
  apiKey?: string;
};

export class AnthropicClient implements LlmClient {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicClientOptions) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      timeout: options.timeoutMs,
    });
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<LlmJsonResponse> {
    try {
      const response = await this.client.messages.parse({
        model: this.options.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        output_config: {
          effort: this.options.effort,
          format: zodOutputFormat(request.schema),
        },
      });

      if (response.stop_reason === 'refusal') {
        throw new LlmClientError('the model declined the request', 'refusal');
      }

      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (text.trim() === '') {
        throw new LlmClientError('the response carried no text', 'bad_response');
      }

      return { text, model: response.model };
    } catch (error) {
      if (error instanceof LlmClientError) throw error;
      if (error instanceof Anthropic.AuthenticationError) {
        throw new LlmClientError('anthropic authentication failed', 'auth');
      }
      if (error instanceof Anthropic.APIConnectionTimeoutError) {
        throw new LlmClientError('anthropic request timed out', 'timeout');
      }
      if (error instanceof Anthropic.APIError) {
        throw new LlmClientError(`anthropic API error ${error.status ?? ''}: ${error.message}`, 'transport');
      }
      throw new LlmClientError(
        `anthropic request failed: ${error instanceof Error ? error.message : String(error)}`,
        'transport',
      );
    }
  }
}
