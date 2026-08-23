import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import dotenv from 'dotenv';

import { pgVectorSize, pool } from '../db.js';
import { hashPassword } from '../lib/password.js';

dotenv.config();

export type SeedConfig = {
  shouldSeed: boolean;
  email: string;
  password: string;
  onboardingComplete: boolean;
};

export function getSeedConfig(env: NodeJS.ProcessEnv = process.env): SeedConfig {
  const shouldSeed = env.SEED_TEST_DATA?.toLowerCase() === 'true';

  return {
    shouldSeed,
    email: env.TEST_USER_EMAIL ?? 'user@test.com',
    password: env.TEST_USER_PASSWORD ?? '1234qwer',
    onboardingComplete: env.TEST_USER_ONBOARDING_COMPLETE?.toLowerCase() === 'true',
  };
}

function toPgVectorString(values: number[]): string {
  return `[${values.join(',')}]`;
}

export async function seedDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = getSeedConfig(env);

  if (!config.shouldSeed) {
    console.log('[seed] SEED_TEST_DATA is not true; skipping database seed');
    return;
  }

  const passwordHash = await hashPassword(config.password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query<{ id: string }>(
      `
        INSERT INTO users (email, password_hash, on_boarding_complete)
        VALUES ($1, $2, $3)
        ON CONFLICT (email) DO UPDATE SET
          password_hash = EXCLUDED.password_hash,
          on_boarding_complete = EXCLUDED.on_boarding_complete
        RETURNING id
      `,
      [config.email, passwordHash, config.onboardingComplete],
    );

    const userId = userResult.rows[0]?.id;

    if (!userId) {
      throw new Error('Failed to create or update test user');
    }

    await client.query(
      `
        INSERT INTO user_info (
          user_id,
          full_name,
          date_of_birth,
          marital_status,
          dependents_count,
          employment_status,
          monthly_take_home_income,
          monthly_housing_costs,
          monthly_food_grocery_costs,
          monthly_transportation_costs,
          savings_emergency_funds,
          total_debt,
          debt_interest_factor,
          monthly_entertainment_subscriptions_costs,
          entertainment_subscriptions,
          financial_goals,
          additional_money_pools,
          investment_risk_comfort
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (user_id) DO UPDATE SET
          full_name = EXCLUDED.full_name,
          date_of_birth = EXCLUDED.date_of_birth,
          marital_status = EXCLUDED.marital_status,
          dependents_count = EXCLUDED.dependents_count,
          employment_status = EXCLUDED.employment_status,
          monthly_take_home_income = EXCLUDED.monthly_take_home_income,
          monthly_housing_costs = EXCLUDED.monthly_housing_costs,
          monthly_food_grocery_costs = EXCLUDED.monthly_food_grocery_costs,
          monthly_transportation_costs = EXCLUDED.monthly_transportation_costs,
          savings_emergency_funds = EXCLUDED.savings_emergency_funds,
          total_debt = EXCLUDED.total_debt,
          debt_interest_factor = EXCLUDED.debt_interest_factor,
          monthly_entertainment_subscriptions_costs = EXCLUDED.monthly_entertainment_subscriptions_costs,
          entertainment_subscriptions = EXCLUDED.entertainment_subscriptions,
          financial_goals = EXCLUDED.financial_goals,
          additional_money_pools = EXCLUDED.additional_money_pools,
          investment_risk_comfort = EXCLUDED.investment_risk_comfort
      `,
      [
        userId,
        'Test User',
        '1990-01-01',
        'Single',
        0,
        'Full-time',
        5200.5,
        1800.25,
        650.75,
        320.5,
        9000,
        1500,
        false,
        45.5,
        ['Netflix', 'Spotify'],
        ['Build emergency fund', 'Save for retirement', 'Reduce spending'],
        ['Vacation', 'Emergency'],
        'Moderate',
      ],
    );

    const baseIntelligenceExists = await client.query<{ id: string }>(
      'SELECT id FROM base_intelligence LIMIT 1',
    );

    if (baseIntelligenceExists.rows.length === 0) {
      const baseIntelligencePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'example_base_intelligence.txt');
      const baseIntelligenceContent = await readFile(baseIntelligencePath, 'utf-8');
      await client.query(
        `
          INSERT INTO base_intelligence (contents)
          VALUES ($1)
        `,
        [baseIntelligenceContent],
      );
    }

    // Seed prompt templates
    await client.query(
      `
      INSERT INTO prompt_templates (template_name, prompt_contents)
      VALUES ($1, $2)
      ON CONFLICT (template_name) DO UPDATE SET
        prompt_contents = EXCLUDED.prompt_contents
    `,
      [
        'Test Template',
        `You are a personal financial advisor that should give general personal finance advice to the user. You should not suggest buying, selling, trading, or otherwise modifying specific investments and assets. You should give personal finance advice related to budgeting, daily spending and how to partition income into several pools.

### Retrieved Context
<RETRIEVED_CONTEXT>

### Base Intelligence
<BASE_INTELLIGENCE>

### Prompt
Respond to the user prompt, while honoring your prime directives and using the retrieved context to answer the question. You should only respond if the response can be connected back directly to the retrieved context or base intelligence. If that is impossible then respond with a generic message saying that there is not enough context or collected data to answer with confidence.

Below is the user prompt:
<PROMPT_TEXT>`,
      ],
    );


    const existingContext = await client.query<{ id: string }>(
      'SELECT id FROM context_documents WHERE user_id = $1 LIMIT 1',
      [userId],
    );

    let contextDocumentId: string;

    if (existingContext.rows.length > 0) {
      contextDocumentId = existingContext.rows[0].id;
    } else {
      const contextResult = await client.query<{ id: string }>(
        `
          INSERT INTO context_documents (user_id, context)
          VALUES ($1, $2)
          RETURNING id
        `,
        [
          userId,
          'A sample context document for testing the embedding pipeline. It references monthly spending, savings goals, and debt reduction strategies.',
        ],
      );

      contextDocumentId = contextResult.rows[0]?.id;

      if (!contextDocumentId) {
        throw new Error('Failed to create context document');
      }
    }

    const vectorSize = pgVectorSize;
    const embeddingValues = Array.from({ length: vectorSize }, (_, index) =>
      index % 5 === 0 ? 0.1 : 0,
    );
    const embeddingString = toPgVectorString(embeddingValues);

    await client.query(
      `
        INSERT INTO user_text_embeddings (
          user_id,
          context_document_id,
          response_text,
          embedding,
          chunk_position
        )
        VALUES ($1, $2, $3, $4::vector(${vectorSize}), $5)
        ON CONFLICT DO NOTHING
      `,
      [userId, contextDocumentId, 'Sample chunk content for semantic search testing.', embeddingString, 0],
    );

    await client.query('COMMIT');
    console.log(`[seed] ensured test user '${config.email}' and content records exist`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  seedDatabase()
    .catch((err) => {
      console.error('[seed] failed to seed database', err);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end();
    });
}
