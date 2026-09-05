import { describe, expect, test } from '@jest/globals';
import { z } from 'zod';

import { OllamaClient } from '../../src/llm/ollama-client.js';
import { LlmClientError } from '../../src/llm/types.js';

const schema = z.object({ reply: z.string() });

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
}

describe('OllamaClient', () => {
  test('posts a non-streaming chat with the JSON schema as the format and returns the content', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const client = new OllamaClient({
      baseUrl: 'http://ollama:11434/',
      model: 'llama3.1',
      timeoutMs: 5000,
      fetchImpl: fakeFetch((url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ model: 'llama3.1', message: { content: '{"reply":"ok"}' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    });

    const response = await client.completeJson({ system: 'be plain', user: '{"x":1}', schema, maxTokens: 256 });

    expect(response).toEqual({ text: '{"reply":"ok"}', model: 'llama3.1' });
    expect(seen!.url).toBe('http://ollama:11434/api/chat');
    expect(seen!.body).toMatchObject({
      model: 'llama3.1',
      stream: false,
      options: { temperature: 0, num_predict: 256 },
      messages: [
        { role: 'system', content: 'be plain' },
        { role: 'user', content: '{"x":1}' },
      ],
    });
    expect(seen!.body.format).toMatchObject({ type: 'object', properties: { reply: { type: 'string' } } });
  });

  test('a non-2xx response, an error payload and a timeout become typed client errors', async () => {
    const failing = new OllamaClient({
      baseUrl: 'http://ollama:11434',
      model: 'llama3.1',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(() => new Response('nope', { status: 500 })),
    });
    await expect(failing.completeJson({ system: '', user: '', schema, maxTokens: 10 })).rejects.toMatchObject({
      name: 'LlmClientError',
      code: 'transport',
    });

    const errored = new OllamaClient({
      baseUrl: 'http://ollama:11434',
      model: 'llama3.1',
      timeoutMs: 5000,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: 'model not found' }), { status: 200 })),
    });
    await expect(errored.completeJson({ system: '', user: '', schema, maxTokens: 10 })).rejects.toMatchObject({
      code: 'bad_response',
    });

    const timeout = new OllamaClient({
      baseUrl: 'http://ollama:11434',
      model: 'llama3.1',
      timeoutMs: 1,
      fetchImpl: (() => {
        const error = new Error('The operation was aborted due to timeout');
        error.name = 'TimeoutError';
        return Promise.reject(error);
      }) as typeof fetch,
    });
    await expect(timeout.completeJson({ system: '', user: '', schema, maxTokens: 10 })).rejects.toBeInstanceOf(LlmClientError);
    await expect(timeout.completeJson({ system: '', user: '', schema, maxTokens: 10 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
