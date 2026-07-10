# FinBot API (Express / TypeScript)

Agent rules for programming the Express API in this package.

## Stack

- Node.js + Express 4
- TypeScript (`strict: true`, `module` / `moduleResolution`: `NodeNext`)
- ESM (`"type": "module"`) — use `.js` extensions in relative imports
- PostgreSQL via `pg`
- Zod for request/schema validation
- `jose` for JWTs, `bcrypt` for password hashing
- Security middleware already in use: `helmet`, `cors`, `cookie-parser`

Prefer patterns already present in `src/` over inventing a parallel architecture.

## Dependencies

- Do **not** install new packages unless strictly necessary.
- Prefer Node built-ins and packages already listed in `package.json`.
- If a dependency is required, use only well-known, actively maintained, reputable libraries (Express ecosystem, Zod, official Postgres drivers, etc.).
- Prefer packages with strong adoption, clear ownership, and a recent security track record. Avoid obscure or unmaintained modules.
- After adding a dependency, keep versions pinned sensibly and do not introduce redundant libraries that duplicate existing functionality (e.g. another validator when Zod is already used).

## TypeScript

- Keep `strict` mode satisfied. Do not weaken `tsconfig` to bypass type errors.
- Prefer explicit return types on exported functions and service methods.
- Prefer `type` for most shapes; use `interface` only when extension/merging is needed.
- Avoid `any`. Use `unknown` and narrow, or precise generics.
- Type Express handlers with `Request`, `Response`, and `NextFunction` from `express`.
- Infer validated request bodies from Zod schemas (`z.infer<typeof schema>`) instead of hand-rolling duplicate types when possible.

## Naming

- **camelCase** for functions, variables, parameters, and methods: `registerUser`, `accessToken`, `refreshMaxAgeMs`.
- **PascalCase** for types, classes, and error types: `AuthUser`, `AuthError`.
- **UPPER_SNAKE_CASE** for true constants and env-backed constant names when exported as such: `REFRESH_COOKIE_NAME`.
- **kebab-case** for file names: `auth.service.ts`, `require-auth.ts`, `validate.ts`.
- Route/service/type files are grouped by feature name: `auth.ts`, `auth.service.ts`, `types/auth.ts`.

## Project structure (feature-grouped)

Group code by feature. Routes, services, and types for the same domain live under matching feature names.

```text
src/
  server.ts              # process entry: migrations + listen
  app.ts                 # Express app setup, middleware, route mounting
  db.ts                  # DB pool / shared DB access
  db/
    migrate.ts
    migrations/          # SQL migrations
  routes/
    <feature>.ts         # Express Router for one feature (e.g. auth.ts, health.ts)
  services/
    <feature>.service.ts # Business logic for that feature
  types/
    <feature>.ts         # Feature-specific types / domain errors
  middleware/            # Shared Express middleware
  lib/                   # Shared utilities (jwt, cookies, password, etc.)
```

### Feature grouping rules

- Put route handlers for a feature in `src/routes/<feature>.ts` and mount them from `app.ts` under a clear path prefix (`/auth`, `/health`, …).
- Put business logic for that feature in `src/services/<feature>.service.ts`. Keep route files thin: validate → call service → map HTTP response.
- Put feature-specific types and domain errors in `src/types/<feature>.ts`.
- Shared cross-feature helpers belong in `src/lib/` or `src/middleware/`, not copied between feature files.
- Do not dump unrelated functions into a catch-all file. If a function belongs to a feature, it lives with that feature’s service/types/routes.

### Express conventions

- Create routers with `Router()` and `export default router`.
- Register routers in `app.ts` with `app.use('/<feature>', featureRouter)`.
- Use async route handlers; forward unexpected errors with `next(err)`.
- Map known domain errors (e.g. `AuthError`) to the correct status in the route; let the global error handler cover unknowns.
- Keep a 404 handler and a centralized error handler at the end of the middleware chain in `app.ts`.
- Return JSON error shapes consistently: `{ error: string, details?: unknown }`.
- Prefer httpOnly cookie auth patterns already used for access/refresh tokens unless requirements change.

## Zod validation (required)

- Validate all external input with Zod before it reaches service logic: request bodies, and query/params when they are used.
- Use the shared `validateBody` middleware (or equivalent shared validators for query/params) so validation stays consistent.
- Define schemas next to the route that consumes them, or in a feature-local schema module if they grow large — still grouped by feature.
- On failure, return `400` with field errors (see existing `validateBody` behavior). Do not trust `req.body` without parsing.
- After validation, treat the parsed value as the source of truth (typed via `z.infer`).
- Do not introduce a second validation library.

Example pattern:

```ts
const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

router.post('/login', validateBody(credentialsSchema), async (req, res, next) => {
  const { email, password } = req.body as z.infer<typeof credentialsSchema>;
  // ...
});
```

## Environment variables

- Read configuration from `process.env` (loaded via `dotenv` in `app.ts`).
- Whenever a **new** environment variable is introduced:
  1. Use it in code with a clear name and sensible local default only when safe.
  2. **Always update `.env.example`** in this package with the new key, a placeholder/safe example value, and keep related vars grouped.
  3. Update root/docker env docs if the variable is required for compose or deployment.
- Never commit real secrets. `.env.example` must contain placeholders only (`change-me-…`, local URLs, etc.).
- Document newly required vars in `README.md` when they affect how developers run the API.

## Database & migrations

- Use the existing `pg` pool from `db.ts`.
- Schema changes go through SQL migrations under `src/db/migrations` and the existing migrator — do not ad-hoc mutate production schema from app code.
- Keep SQL parameterized (`$1`, `$2`, …). Never interpolate user input into queries.

## Security & API hygiene

- Do not weaken `helmet` / CORS / cookie settings without an explicit reason.
- Hash secrets at rest (passwords, refresh token hashes) using existing `lib/password` helpers.
- Do not log tokens, passwords, or raw Authorization headers.
- Prefer existing auth middleware (`require-auth`) for protected routes.

## Code quality

- Match existing style in neighboring files (imports, error handling, naming).
- Keep changes scoped; avoid unrelated refactors.
- Prefer small, focused functions inside the correct feature service file over large route handlers.
- When adding a feature, add `routes/<feature>.ts`, `services/<feature>.service.ts`, and `types/<feature>.ts` together, then mount the router in `app.ts`.
