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
CORS_ORIGIN=http://localhost:3000
```
