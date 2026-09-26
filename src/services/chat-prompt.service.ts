/**
 * Chat: retrieve the user's related context, render the prompt template,
 * and ask the model through the LLM seam (`src/llm/`). LLM_PROVIDER picks
 * the host exactly as it does for the gameplan narration, and the reply
 * passes the same number check: a reply that states a figure the model was
 * not given is withheld and a fixed sentence says so.
 */

import { pgVectorSize, pool } from '../db.js';
import { CHAT_RULES } from '../llm/prompts.js';
import { llmProviderFromEnv } from '../llm/provider.js';
import { CHAT_NUMBER_WITHHELD_REPLY } from '../llm/templates.js';
import type { ChatAnswer, LlmProvider } from '../llm/types.js';
import { buildEmbeddingVector } from '../rag/build-embeddings.js';
import { ChatPromptError, type ChatPromptInput } from '../types/chat-prompt.js';

const DEFAULT_PROMPT_TEMPLATE_NAME = 'Test Template';

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

/** The reply the user sees, or the error the route maps to a status. */
function replyFor(answer: ChatAnswer): string {
    if (answer.ok) return answer.text;

    switch (answer.reason) {
        case 'number_invented':
            return CHAT_NUMBER_WITHHELD_REPLY;
        case 'no_provider':
            throw new ChatPromptError('No model configured: set LLM_PROVIDER to ollama or anthropic', 503);
        case 'malformed':
            throw new ChatPromptError('Model returned an empty response', 502);
        case 'client_error':
        default:
            throw new ChatPromptError(
                answer.clientErrorCode === 'timeout' ? 'Model request timed out' : 'Model request failed',
                502,
            );
    }
}

export async function generateChatPromptResponse(
    input: ChatPromptInput,
    provider: LlmProvider = llmProviderFromEnv(),
): Promise<string> {
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

    return replyFor(await provider.answerChat({ system: CHAT_RULES, prompt }));
}
