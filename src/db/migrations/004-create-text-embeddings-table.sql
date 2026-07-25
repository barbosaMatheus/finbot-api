CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS context_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_text_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  context_document_id UUID NOT NULL REFERENCES context_documents(id) ON DELETE CASCADE,
  response_text TEXT NOT NULL,
  embedding VECTOR(768) NOT NULL,
  chunk_position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_context_documents_user_id ON context_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_user_id ON user_text_embeddings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_context_document_id ON user_text_embeddings(context_document_id);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_chunk_position ON user_text_embeddings(chunk_position);
CREATE INDEX IF NOT EXISTS idx_user_text_embeddings_created_at ON user_text_embeddings(created_at);
