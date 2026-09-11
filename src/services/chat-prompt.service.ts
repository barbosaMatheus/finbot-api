import { pgVectorSize, pool } from '../db.js';
import { buildEmbeddingVector } from '../rag/build-embeddings.js';
import { logger } from '../lib/logger.js';
import { ChatPromptError, type ChatPromptInput } from '../types/chat-prompt.js';

const DEFAULT_PROMPT_TEMPLATE_NAME = 'Test Template';
const DEFAULT_OLLAMA_URL = 'http://ollama:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen3.5-mini';
const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;

function toPgVectorString(values: number[]): string {
  return `[${values.map((value) => (Number.isFinite(value) ? value : 0)).join(',')}]`;
}

async function retrieveTopContexts(
  userId: string,
  queryText: string,
  n: number,
): Promise<string[]> {
  const queryVector = buildEmbeddingVector(queryText, {
    vectorDimension: pgVectorSize,
  });

  const result = await pool.query<{ response_text: string }>(
    `
      SELECT response_text
      FROM user_text_embeddings
      WHERE user_id = $1::uuid
      ORDER BY embedding <=> $2::vector(${pgVectorSize}) ASC
      LIMIT $3
    `,
    [userId, toPgVectorString(queryVector), n],
  );

  return result.rows.map((row) => row.response_text);
}

async function fetchTemplateAndBaseIntelligence(
  templateName: string,
): Promise<{ template: string; baseIntelligence: string }> {
  const templateResult = await pool.query<{ prompt_contents: string }>(
    `
      SELECT prompt_contents
      FROM prompt_templates
      WHERE template_name = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [templateName],
  );

  if (templateResult.rows.length === 0) {
    throw new ChatPromptError('Prompt template not found', 404);
  }

  const baseIntelligenceResult = await pool.query<{ contents: string }>(
    `
      SELECT contents
      FROM base_intelligence
      ORDER BY id DESC
      LIMIT 1
    `,
  );

  return {
    template: templateResult.rows[0].prompt_contents,
    baseIntelligence: baseIntelligenceResult.rows[0]?.contents ?? '',
  };
}

function renderPrompt(
  template: string,
  baseIntelligence: string,
  retrievedContext: string,
  promptText: string,
): string {
  let enrichedPrompt = template;

  enrichedPrompt = enrichedPrompt.replace('<BASE_INTELLIGENCE>', baseIntelligence);
  enrichedPrompt = enrichedPrompt.replace('<RETRIEVED_CONTEXT>', retrievedContext);
  enrichedPrompt = enrichedPrompt.replace('<PROMPT_TEXT>', promptText);

  return enrichedPrompt;
}

function parseTimeoutMs(): number {
  const value = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_OLLAMA_TIMEOUT_MS;
}

async function queryModel(prompt: string): Promise<string> {
  const baseUrl = (process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parseTimeoutMs());

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ model, prompt, stream: false }),
    });

    if (!response.ok) {
      throw new ChatPromptError(`Model request failed with status ${response.status}`, 502);
    }

    const data = (await response.json()) as { response?: string; error?: string };

    if (data.error) {
      throw new ChatPromptError(data.error, 502);
    }

    const modelResponse = data.response?.trim();

    if (!modelResponse) {
      throw new ChatPromptError('Model returned an empty response', 502);
    }

    return modelResponse;
  } catch (error) {
    if (error instanceof ChatPromptError) {
      throw error;
    }

    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Model request timed out'
        : 'Model request failed';

    logger.warn('[chat-prompt] ollama request failed', { err: error });
    throw new ChatPromptError(message, 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateChatPromptResponse(input: ChatPromptInput): Promise<string> {
  const templateName = input.promptTemplateName?.trim() || DEFAULT_PROMPT_TEMPLATE_NAME;

  const [contexts, { template, baseIntelligence }] = await Promise.all([
    retrieveTopContexts(input.userId, input.userPromptText, input.n),
    fetchTemplateAndBaseIntelligence(templateName),
  ]);

  const retrievedContext = contexts.join('\n\n---\n\n');
  const prompt = renderPrompt(
    template,
    baseIntelligence,
    retrievedContext,
    input.userPromptText,
  );

  return queryModel(prompt);
}