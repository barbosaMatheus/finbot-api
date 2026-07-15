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

Create a `.env` file to configure environment variables such as:

```env
PORT=3000
CORS_ORIGIN=http://localhost:8081
DATABASE_URL=postgres://finbot:finbot@localhost:5432/finbot
JWT_ACCESS_SECRET=change-me-access
JWT_REFRESH_SECRET=change-me-refresh
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
```

`GET /health` reports API status and Postgres connectivity (`"db": "up" | "down"`).

## Auth

Cookie-based JWT auth endpoints:

- `POST /auth/register` — `{ email, password }` → sets httpOnly cookies, returns `{ user }`
- `POST /auth/login` — `{ email, password }` → sets httpOnly cookies, returns `{ user }`
- `POST /auth/refresh` — uses refresh cookie → rotates session, returns `{ user }`
- `POST /auth/logout` — revokes refresh session and clears cookies

Access token cookie: `finbot_access` (`path: /`). Refresh token cookie: `finbot_refresh` (`path: /auth`).

## Docker

This service is orchestrated from the repo root via `docker-compose.yml`
alongside the Expo web client and Postgres. See the root `README.md`.
