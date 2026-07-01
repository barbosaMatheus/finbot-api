import app from './app.js';

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`[server] finbot-api listening on http://localhost:${port}`);
});
