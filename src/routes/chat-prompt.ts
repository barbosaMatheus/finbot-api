import { Router } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import { generateChatPromptResponse } from '../services/chat-prompt.service.js';
import { ChatPromptError } from '../types/chat-prompt.js';

const router = Router();

export const chatPromptSchema = z.object({
  userId: z.string().uuid(),
  n: z.coerce.number().int().positive().max(50).default(5),
  userPromptText: z.string().trim().min(1, 'userPromptText is required'),
  promptTemplateName: z.string().trim().min(1).optional(),
});

router.post('/', requireAuth, validateBody(chatPromptSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof chatPromptSchema>;

    if (req.user?.id !== body.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const response = await generateChatPromptResponse({
      userId: body.userId,
      n: body.n,
      userPromptText: body.userPromptText,
      promptTemplateName: body.promptTemplateName,
    });

    res.status(200).json({ response });
  } catch (error) {
    if (error instanceof ChatPromptError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    next(error);
  }
});

export default router;