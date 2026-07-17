CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS user_text_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response_text TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_user_id ON user_text_embeddings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_created_at ON user_text_embeddings(created_at);
