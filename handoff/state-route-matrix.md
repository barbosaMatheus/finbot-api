# Onboarding state → route matrix (normative)

Route every authenticated screen decision from `GET /onboarding/status`.
`phase` is the single routing input; `availableActions` gates which controls
render. Never derive the phase client-side from gates.

| `phase` | Client route | User sees | Available actions (from API) | Exit |
| --- | --- | --- | --- | --- |
| `financial_linking` | `/onboarding/link` | Connected institutions + why FinBot needs them | `link_institution`, `declare_linking_complete`, `manage_connections`, `manage_notifications`, `logout` | `POST /onboarding/linking-complete` succeeds |
| `manual_profile_in_progress` | `/onboarding/manual` | The non-derivable question wizard (resume via `GET /onboarding/manual`) | `continue_manual_profile`, … | `PUT /onboarding/manual` saved |
| `waiting_for_history` | `/onboarding/waiting` | Concrete milestones ("2 of 3 institutions ready"), never a fake percentage | `view_waiting`, … | analysis reaches terminal state (poll) |
| `classifying` | `/onboarding/waiting` | "Analyzing your transactions" | `view_waiting`, … | review snapshot built |
| `review_ready` | `/onboarding/review` | Aggregates, coverage band + reasons, required exceptions | `view_review`, `correct_review`, `confirm_review`, … | required items resolved + `POST /onboarding/financial-review/confirm` |
| `recomputing` | `/onboarding/review` (locked) | "Applying your corrections"; retain submitted edits | `view_review`, … | new snapshot (poll status or review) |
| `failed_retryable` | `/onboarding/retry` | Institution/phase-specific failure | `retry_analysis`, `link_institution`, … | `POST /onboarding/retry` or reconnect |
| `complete` | main app | Normal product | — | final gate stays true |

## Polling contract

- Poll `GET /onboarding/status` while foregrounded in `waiting_for_history`,
  `classifying`, and `recomputing`; back off (e.g. 3s → 10s) and refresh on
  app foreground.
- A push tap deep-links to `finbot://onboarding/review`; the app must refetch
  status before routing — push is a wake-up, never the source of truth.

## Confirmation sequence

1. `GET /onboarding/financial-review` → render; keep `snapshotVersion`.
2. `PATCH /onboarding/financial-review/items/{id}` per correction (pass
   `snapshotVersion`; on `REVIEW_VERSION_STALE`, refetch and re-render).
3. Data-changing corrections flip the run to `recomputing` automatically;
   the response's `recomputeQueued` says so. `POST
   /onboarding/financial-review/recompute` forces one explicitly.
4. When no required item is `open`:
   `POST /onboarding/financial-review/confirm { snapshotVersion }` →
   `{ onboardingComplete: true }` → route to the main app.
