import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  applyReviewItemAction,
  requestRecompute,
} from '../services/corrections.service.js';
import {
  confirmFinancialReview,
  declareLinkingComplete,
  getOnboardingStatus,
  retryAnalysis,
} from '../services/onboarding-status.service.js';
import { getFinancialReviewForUser } from '../services/review.service.js';
import {
  getUserOnboarding,
  upsertUserOnboarding,
} from '../services/user-info.service.js';
import {
  COACHING_PACES,
  INCOME_PATTERNS,
  OBLIGATION_CADENCES,
  OBLIGATION_KINDS,
  PRIMARY_GOALS,
  SECONDARY_GOALS,
  UPCOMING_EVENTS,
  type SecondaryGoal,
} from '../types/manual-profile.js';
import { OnboardingError } from '../types/onboarding.js';

const router = Router();

/**
 * Manual profile v2. The wizard asks only what connected accounts cannot
 * answer, so the only dollar amounts here are for money that is invisible
 * to Plaid by definition: off-book obligations and a savings target.
 */

const amountSchema = z.number().finite().nonnegative().max(1_000_000);

export const declaredObligationSchema = z.object({
  kind: z.enum(OBLIGATION_KINDS),
  label: z.string().trim().max(80).nullable(),
  amount: amountSchema,
  cadence: z.enum(OBLIGATION_CADENCES),
});

export const goalDetailSchema = z.object({
  description: z.string().trim().min(1).max(120),
  targetAmount: amountSchema.nullable(),
  targetMonth: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'targetMonth must be YYYY-MM')
    .nullable(),
});

/**
 * The profile as stored and returned. No refinements here so the same
 * schema doubles as the response shape for GET /onboarding/manual.
 */
export const onboardingPayloadSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  dependentsCount: z.number().int().min(0).max(20),
  sharedAccounts: z.boolean(),
  incomePattern: z.enum(INCOME_PATTERNS),
  declaredObligations: z.array(declaredObligationSchema).max(20),
  upcomingEvents: z.array(z.enum(UPCOMING_EVENTS)).max(8),
  upcomingEventNote: z.string().trim().max(120).nullable(),
  primaryGoal: z.enum(PRIMARY_GOALS),
  secondaryGoals: z.array(z.enum(SECONDARY_GOALS)).max(2),
  goalDetail: goalDetailSchema.nullable(),
  coachingPace: z.enum(COACHING_PACES),
  additionalContext: z.string().max(2000),
});

/** What PUT /onboarding/manual validates: the payload plus cross-field rules. */
export const onboardingSchema = onboardingPayloadSchema.superRefine((value, ctx) => {
  if (value.primaryGoal === 'save_for_specific' && value.goalDetail === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['goalDetail'],
      message: 'goalDetail is required when primaryGoal is save_for_specific',
    });
  }

  if (value.primaryGoal !== 'save_for_specific' && value.goalDetail !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['goalDetail'],
      message: 'goalDetail only applies when primaryGoal is save_for_specific',
    });
  }

  if (value.upcomingEventNote !== null && !value.upcomingEvents.includes('other')) {
    ctx.addIssue({
      code: 'custom',
      path: ['upcomingEventNote'],
      message: 'upcomingEventNote only applies when upcomingEvents includes other',
    });
  }

  if (value.secondaryGoals.includes(value.primaryGoal as SecondaryGoal)) {
    ctx.addIssue({
      code: 'custom',
      path: ['secondaryGoals'],
      message: 'secondaryGoals must not repeat primaryGoal',
    });
  }

  if (new Set(value.secondaryGoals).size !== value.secondaryGoals.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['secondaryGoals'],
      message: 'secondaryGoals must not contain duplicates',
    });
  }
});

/**
 * Save the manual (non-derivable) onboarding answers. Completes the manual
 * gate only — onboarding as a whole finishes when the financial review is
 * confirmed, never here. `PUT /onboarding` is kept as an alias for the
 * pre-redesign client.
 */
const saveManualHandler = [
  requireAuth,
  validateBody(onboardingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const result = await upsertUserOnboarding(
        userId,
        req.body as z.infer<typeof onboardingSchema>,
      );

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('violates foreign key')) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      next(err);
    }
  },
] as const;

router.put('/manual', ...saveManualHandler);
router.put('/', ...saveManualHandler);

/** Resume saved answers. 200 with `saved: null` when nothing is saved yet. */
router.get('/manual', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const saved = await getUserOnboarding(userId);

    res.status(200).json({ saved });
  } catch (err) {
    next(err);
  }
});

/**
 * Latest financial review snapshot with coverage and actionable
 * exceptions. 409 ANALYSIS_NOT_REVIEWABLE while analysis is still running.
 */
router.get('/financial-review', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.status(200).json(await getFinancialReviewForUser(userId));
  } catch (err) {
    if (err instanceof OnboardingError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    next(err);
  }
});

export const correctionSchema = z.object({
  action: z.enum([
    'accept_coverage_limitation',
    'keep_manual_value',
    'use_observed_value',
    'set_value',
    'confirm_stream',
    'dismiss_stream',
    'reclassify_transaction',
    'reclassify_merchant',
  ]),
  snapshotVersion: z.number().int().positive(),
  value: z.record(z.string(), z.unknown()).optional(),
});

/** Correct or accept one review item. */
router.patch(
  '/financial-review/items/:id',
  requireAuth,
  validateBody(correctionSchema),
  async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const body = req.body as z.infer<typeof correctionSchema>;

      const result = await applyReviewItemAction({
        userId,
        reviewItemId: String(req.params.id ?? ''),
        action: body.action,
        snapshotVersion: body.snapshotVersion,
        value: body.value,
      });

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof OnboardingError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }

      next(err);
    }
  },
);

/** Rebuild facts and review after corrections. */
router.post('/financial-review/recompute', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await requestRecompute(userId);

    res.status(202).json(result);
  } catch (err) {
    if (err instanceof OnboardingError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    next(err);
  }
});

/** The authoritative onboarding state: gates, phase, actions, analysis. */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    res.status(200).json(await getOnboardingStatus(userId));
  } catch (err) {
    if (err instanceof OnboardingError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    next(err);
  }
});

/**
 * The user declares they are done adding institutions. Records declared
 * coverage, backstops sync kick-off, creates the analysis run, and starts
 * analysis if every Item is already terminal.
 */
router.post('/linking-complete', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await declareLinkingComplete(userId);

    res.status(200).json(await getOnboardingStatus(userId));
  } catch (err) {
    if (err instanceof OnboardingError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    next(err);
  }
});

export const confirmSchema = z.object({
  snapshotVersion: z.number().int().positive(),
});

/** Confirm the latest review; the only path to onboarding completion. */
router.post(
  '/financial-review/confirm',
  requireAuth,
  validateBody(confirmSchema),
  async (req, res, next) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { snapshotVersion } = req.body as z.infer<typeof confirmSchema>;
      const result = await confirmFinancialReview(userId, snapshotVersion);

      res.status(200).json(result);
    } catch (err) {
      if (err instanceof OnboardingError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }

      next(err);
    }
  },
);

/** Retry a failed analysis phase or failed institution syncs. */
router.post('/retry', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await retryAnalysis(userId);

    res
      .status(202)
      .json(
        result.status === 'already_running'
          ? { ...result, code: 'RETRY_ALREADY_QUEUED' }
          : result,
      );
  } catch (err) {
    if (err instanceof OnboardingError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }

    next(err);
  }
});

export default router;
