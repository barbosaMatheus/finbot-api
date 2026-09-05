/**
 * Gameplan handlers (step 4): the post-onboarding refresh, plan builds,
 * period grades, nudges, and the hourly scheduler. Each re-reads its state
 * from the database, so replays converge.
 */

import { buildGameplan } from '../../services/gameplan-build.service.js';
import { gradeGameplanPeriod } from '../../services/gameplan-grade.service.js';
import { evaluateNudges } from '../../services/gameplan-nudge.service.js';
import { runGameplanScheduler } from '../../services/gameplan-period.service.js';
import { refreshUserAnalysis } from '../../services/gameplan-refresh.service.js';
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.REFRESH_USER_ANALYSIS, async (payload) => {
  await refreshUserAnalysis(payload);
});

setJobHandler(JOB.BUILD_GAMEPLAN, async (payload) => {
  await buildGameplan(payload);
});

setJobHandler(JOB.GRADE_PERIOD, async (payload) => {
  await gradeGameplanPeriod(payload);
});

setJobHandler(JOB.EVALUATE_NUDGES, async (payload) => {
  await evaluateNudges(payload);
});

setJobHandler(JOB.RUN_GAMEPLAN_SCHEDULER, async () => {
  await runGameplanScheduler();
});
