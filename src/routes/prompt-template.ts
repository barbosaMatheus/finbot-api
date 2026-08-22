import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';

const router = Router();

const buildPromptSchema = z.object({
  user_id: z.string().uuid(),
  prompt_template_name: z.string(),
  prompt_text: z.string(),
});

router.post(
  '/',
  requireAuth,
  validateBody(buildPromptSchema),
  async (req, res, next) => {
    const { prompt_template_name, prompt_text } = req.body as z.infer<typeof buildPromptSchema>;

    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Get the newest prompt template with the matching name
        const templateResult = await client.query<( { prompt_contents: string } )>(
          `
          SELECT prompt_contents
          FROM prompt_templates
          WHERE template_name = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
          [prompt_template_name],
        );

        // Get the newest base intelligence
        const baseIntelligenceResult = await client.query<( { contents: string } )>(
          `
          SELECT contents
          FROM base_intelligence
          ORDER BY id DESC
          LIMIT 1
        `,
        );

        if (templateResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Prompt template not found' });
        }

        const template = templateResult.rows[0].prompt_contents;
        const baseIntelligence = baseIntelligenceResult.rows[0]?.contents ?? '';

        // Fill in the placeholders
        let enrichedPrompt = template;
        
        // Replace <BASE_INTELLIGENCE> with actual content
        enrichedPrompt = enrichedPrompt.replace('<BASE_INTELLIGENCE>', baseIntelligence);
        
        // Replace the prompt text placeholder. 
        enrichedPrompt = enrichedPrompt.replace('<PROMPT_TEXT>', prompt_text);

        await client.query('COMMIT');
        res.json({ prompt: enrichedPrompt });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  },
);

export default router;
