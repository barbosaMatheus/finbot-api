# finbot-api

A modern Express + TypeScript API scaffold for the finbot-api project.

## Scripts

- `npm install` - install dependencies
- `npm run dev` - start the API in development mode with hot reload
- `npm run build` - compile the TypeScript source to JavaScript
- `npm start` - start the compiled production build

## Health check

Once the server is running, visit:

- `http://localhost:3000/health`

## Environment

Copy the template and adjust:

```bash
cp .env.example .env
```

`.env.example` is the full, commented list of everything the API reads. The ones
that will break the app if they are missing:

| Variable | Why it's required |
| -------- | ----------------- |
| `DATABASE_URL` | Postgres connection string; without it every DB-backed route fails |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | `src/lib/jwt.ts` throws if unset, so `/auth/*` returns 500 |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | Plaid API credentials, from the [Plaid dashboard](https://dashboard.plaid.com/developers/keys) |
| `PLAID_TOKEN_ENC_KEY` | 32-byte base64 key used to encrypt Plaid access tokens at rest |

Generate an encryption key with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Running under Docker Compose? This file is not used — the stack is configured
from the repo root instead. See `../DOCKER.md`.

`GET /health` reports API status and Postgres connectivity (`"db": "up" | "down"`).

## Auth

Cookie-based JWT auth endpoints:

- `POST /auth/register` — `{ email, password }` → sets httpOnly cookies, returns `{ user }`
- `POST /auth/login` — `{ email, password }` → sets httpOnly cookies, returns `{ user }`
- `POST /auth/refresh` — uses refresh cookie → rotates session, returns `{ user }`
- `POST /auth/logout` — revokes refresh session and clears cookies

Access token cookie: `finbot_access` (`path: /`). Refresh token cookie: `finbot_refresh` (`path: /auth`).

## Plaid

The standard Plaid link flow. All routes require auth.

- `POST /plaid/link-token` — → `{ linkToken, expiration, hostedLinkUrl }`. `hostedLinkUrl`
  is a Plaid-hosted browser flow, used by the web client because Plaid Link's native
  module does not exist on web.
- `POST /plaid/exchange-public-token` — `{ publicToken }` → `{ connection }`. Exchanges for
  an access token, snapshots the Item's accounts, returns the saved connection.
- `POST /plaid/hosted-link/complete` — `{ linkToken }` → `{ status: 'pending' }` or
  `{ status: 'connected', connection }`. Hosted Link has no client callback, so the web
  client polls this until the session finishes.
- `GET /plaid/connections` — → `{ connections }`.

Access tokens are encrypted with AES-256-GCM (`src/lib/crypto.ts`) before being written to
`plaid_items`; they are never returned to the client.

## Docker

This service is orchestrated from the repo root via `docker-compose.yml`
alongside the Expo web client and Postgres. See the root `README.md`.
