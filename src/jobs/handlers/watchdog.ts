/**
 * SWEEP_STALE_RUNS: scheduled safety net for runs with no live job — the
 * one failure class neither pg-boss expiration (worker died mid-job) nor
 * the dead letter (retries exhausted) can see. See sweepStaleRuns.
 */

import { sweepStaleRuns } from '../../services/analysis-orchestration.service.js';
import { setJobHandler } from '../register.js';
import { JOB } from '../types.js';

setJobHandler(JOB.SWEEP_STALE_RUNS, async () => {
  await sweepStaleRuns();
});
