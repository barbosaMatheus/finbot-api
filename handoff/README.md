# Frontend handoff bundle (API-017)

The normative contract for implementing the `APP-*` tickets. Consume this
bundle plus the canonical design document
(`finbot-app/docs/financial-onboarding-and-transaction-analysis.md`) and your
assigned ticket — nothing else is needed, and handwritten DTO duplication is
prohibited.

## Freeze

| | |
| --- | --- |
| API branch | `feature/onboarding2.0` |
| Frozen at commit | `a9c67166d4fe974f6fc01c81e7150a443a4de26c` (+ this bundle commit) |
| OpenAPI | `../openapi/openapi.json` (3.1.0), served live at `GET /openapi.json` |
| Classification rules | `class-v1` |
| Reconciliation rules | `recon-v1` |
| Recurrence rules | `recur-v1` |
| Facts rules | `facts-v1` |

## Generate the client types (APP-002)

From the `finbot` repo:

```sh
npx openapi-typescript ../finbot-api/openapi/openapi.json -o src/api/types.gen.ts
```

Regeneration must be reproducible: commit the command in an npm script and
the generated file. The document is deterministic; identical input produces
identical output. When the API changes, the API side regenerates
`openapi/openapi.json` (`npm run openapi:generate`) and its drift test fails
CI until the checked-in file matches.

## Contents

- `state-route-matrix.md` — the normative phase → route → actions mapping
  and the confirmation sequence.
- `examples/onboarding-status.waiting.json` — `GET /onboarding/status` shape.
- `examples/financial-review.partial.json` — `GET /onboarding/financial-review`
  with partial coverage and a required external-card review item.
- `examples/errors.json` — every error envelope the client must handle, with
  required client behavior.

## Auth transport (APP-004)

- **Web:** cookie flow (`/auth/register|login|refresh|logout`), HttpOnly
  cookies, `credentials: 'include'`.
- **Native:** `/auth/native/register|login|refresh|logout`; store the token
  pair in Expo SecureStore, send `Authorization: Bearer <accessToken>`,
  rotate via `/auth/native/refresh` on 401 (refresh tokens are single-use;
  always persist the newly returned pair). Logout must call
  `/auth/native/logout` and revoke the push token.
- All authenticated user payloads include `onboardingComplete`, but routing
  decisions come from `GET /onboarding/status`.

## Plaid Link (APP-005)

- `POST /plaid/link-token` — body optional; `{mode:'update', itemId}` for
  reauthentication/account selection on an existing connection.
- Native: exchange the public token at `POST /plaid/exchange-public-token`.
  A `connection.duplicate === true` response means the institution was
  already linked — show "already connected", not a new card.
- Web: open `hostedLinkUrl`, then poll `POST /plaid/hosted-link/complete`
  with the link token until `status === 'connected'`.
- `GET /plaid/connections` includes per-Item `health` for the connections
  screen; `DELETE /plaid/connections/{itemId}` disconnects.
- Finish with `POST /onboarding/linking-complete` — analysis will not start
  until the user declares linking done.

## Push (APP-009)

- Register with `POST /notifications/push-tokens` after permission.
- The only notification is `financial_review_ready`, sent at most once per
  analysis run per device, only when processing exceeded the expected
  window. `data.url` is `finbot://onboarding/review`.
- On tap (foreground, background, or cold start): refetch
  `GET /onboarding/status` before routing.

## Test evidence at freeze

```
npm test        # 23 suites, 296 unit/contract tests, all passing
                # + 1 end-to-end suite (tests/e2e.pipeline.test.ts) run with
                # TEST_DATABASE_URL=postgres://finbot:finbot@localhost:5432/finbot
                # against the compose database: full link→sync→classify→
                # reconcile→recur→facts→review→correct→confirm flow, passing.
npx tsc --noEmit  # clean
```

Local boot verified: `docker compose up --build db api worker` — migrations
001–010 apply to an existing dev database, API healthy, `GET /openapi.json`
served, worker registers all eight handlers plus the dead-letter observer.

## Known platform limitations at freeze

- Real Plaid webhooks require a public tunnel; without one the worker's poll
  fallback completes syncs (see
  `finbot-app/docs/financial-analysis-runtime.md`).
- Expo push delivery requires a development build on a physical device;
  simulators do not receive push. Web has no push and must poll.
- OAuth institutions need `PLAID_REDIRECT_URI` registered in the Plaid
  dashboard (`PLAID_ANDROID_PACKAGE_NAME` on Android); Sandbox works without.
- `docker-compose.prod.yml` does not yet define the worker service.
- The Expo push sender omits the optional Expo access token (enhanced push
  security); wire it in before production.
