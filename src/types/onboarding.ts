/**
 * Onboarding lifecycle domain types.
 *
 * Onboarding completion is a derived value, never a stored decision:
 *
 *   on_boarding_complete = manual_profile_complete
 *                          AND financial_analysis_reviewable
 *                          AND financial_review_confirmed
 *
 * The pieces progress independently — a user can finish the manual wizard
 * while transaction history is still syncing, or confirm nothing because an
 * institution failed — and the phase shown to the client is derived from the
 * same inputs so the API can never disagree with itself.
 */

/** Status of one user-level analysis run. */
export type AnalysisRunStatus =
  | 'waiting_for_history'
  | 'processing'
  | 'review_ready'
  | 'recomputing'
  | 'confirmed'
  | 'failed'
  | 'superseded';

/** The restricted-shell phase the client should route to. */
export type OnboardingPhase =
  | 'financial_linking'
  | 'manual_profile_in_progress'
  | 'waiting_for_history'
  | 'classifying'
  | 'review_ready'
  | 'recomputing'
  | 'failed_retryable'
  | 'complete';

export type OnboardingGates = {
  hasLinkedInstitution: boolean;
  linkingDeclaredComplete: boolean;
  manualProfileComplete: boolean;
  analysisReviewable: boolean;
  financialReviewConfirmed: boolean;
};

export type OnboardingAction =
  | 'link_institution'
  | 'declare_linking_complete'
  | 'continue_manual_profile'
  | 'view_waiting'
  | 'view_review'
  | 'correct_review'
  | 'confirm_review'
  | 'retry_analysis'
  | 'manage_connections'
  | 'manage_notifications'
  | 'logout';

export type AnalysisRunSummary = {
  id: string;
  status: AnalysisRunStatus;
  requestedLookbackDays: number;
  ruleVersion: string;
  retryCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  reviewReadyAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
};

export type LifecycleState = {
  userId: string;
  hasActiveItem: boolean;
  activeItemCount: number;
  linkingDeclaredCompleteAt: Date | null;
  manualProfileCompletedAt: Date | null;
  latestRun: AnalysisRunSummary | null;
  onboardingCompleteFlag: boolean;
};

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}
