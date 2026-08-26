import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { requireAuth } from '../middleware/require-auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  getUserOnboarding,
  upsertUserOnboarding,
} from '../services/user-info.service.js';

const router = Router();

const nonNegativeNumber = z.coerce.number().finite().nonnegative();

const dateOfBirthSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }

    const match = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/((?:19|20)\d{2})$/.exec(
      value,
    );

    if (!match) {
      ctx.addIssue({
        code: 'custom',
        message: 'dateOfBirth must be YYYY-MM-DD or MM/DD/YYYY',
      });
      return z.NEVER;
    }

    return `${match[3]}-${match[1]}-${match[2]}`;
  });

const onboardingSchema = z.object({
  fullName: z.string().trim().min(1),
  dateOfBirth: dateOfBirthSchema,
  maritalStatus: z.enum([
    'single',
    'married',
    'domestic_partnership',
    'divorced',
    'widowed',
    'prefer_not_to_say',
  ]),
  dependentsCount: z.coerce.number().int().nonnegative(),
  employmentStatus: z.enum([
    'full_time',
    'part_time',
    'self_employed',
    'unemployed',
    'retired',
    'student',
  ]),
  monthlyTakeHomeIncome: nonNegativeNumber,
  monthlyHousingCosts: nonNegativeNumber,
  monthlyFoodSpend: nonNegativeNumber,
  monthlyTransportationCosts: nonNegativeNumber,
  subscriptions: z
    .array(
      z.enum([
        'netflix',
        'disney_hulu',
        'amazon_prime',
        'paramount',
        'apple',
        'xbox',
        'playstation',
        'nintendo',
        'none',
      ]),
    )
    .min(1),
  monthlyEntertainmentSubscriptionsCosts: nonNegativeNumber.optional(),
  savingsAndEmergencyFunds: nonNegativeNumber,
  totalDebt: nonNegativeNumber,
  factorInDebtInterest: z.boolean(),
  financialGoals: z
    .array(
      z.enum([
        'emergency_fund',
        'pay_off_debt',
        'save_for_retirement',
        'save_for_home',
        'invest_more',
        'reduce_spending',
      ]),
    )
    .length(3),
  additionalMoneyPools: z
    .array(
      z.enum(['vacation', 'miscellaneous', 'emergency', 'savings', 'investing']),
    )
    .length(3),
  riskComfort: z.enum(['conservative', 'moderate', 'aggressive']),
  additionalContext: z.string(),
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

export default router;
