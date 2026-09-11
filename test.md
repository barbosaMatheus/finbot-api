# Testing POST /chat-prompt

Manual test flow for the `POST /chat-prompt` endpoint (retrieved-context RAG
completion through the hosted Ollama model).

## Prerequisites

- The stack must be running **with the `llm` profile** so the Ollama container
  is up. From the repo root (`finbot-app/`):

  ```bash
  docker compose --profile llm up --build
  ```

- Without the `llm` profile the endpoint returns `502 Model request failed`.

## Step 1 — login as the seeded test user

Login saves the HttpOnly access cookie into a jar **and** prints the user's
`id`, which you use as `userId` in the next request.

```bash
curl -s -c /tmp/finbot-cookies -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@test.com","password":"1234qwer"}'
```

Seeded credentials (from `.env.example`): `user@test.com` / `1234qwer`.

## Step 2 — call chat-prompt

```bash
curl -s -b /tmp/finbot-cookies -X POST http://localhost:3000/chat-prompt \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<uuid-from-login>","n":3,"userPromptText":"How should I budget my income?"}'
```

## Notes / troubleshooting

- **`docker exec` shell:** the API image is `node:20-bookworm-slim`, which has
  `node` (with global `fetch`) but **no `curl`**. Use `node -e` inside the
  container, e.g.:

  ```bash
  docker exec -it --env-file .env finbot-api-node-1 \
    node -e "fetch('http://localhost:3000/health').then(r => console.log(r.status))"
  ```

- **Embeddings:** the seeded test user already has one embedding chunk
  ("Sample chunk content..."), so retrieval won't be empty out of the box. Add
  more context with `POST /embeddings`.
- **`userId` must match the logged-in user:** the endpoint verifies the body
  `userId` against the access token's subject and returns `403 Forbidden`
  otherwise, so test with the id from your own login.