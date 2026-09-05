/**
 * Simple local text embedder.
 *
 * This implementation produces a deterministic fixed-size vector for a given
 * input string using a hashed token-count approach. It's not a neural
 * embedding model but is fully local, deterministic, and fast — suitable for
 * unit tests and lightweight similarity experiments.
 */

export function hashStringDJB2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return (
    text
      // normalize whitespace and punctuation to spaces
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  );
}

export function generateNgrams(tokens: string[], maxN = 1): string[] {
  const out: string[] = [];
  const n = Math.max(1, Math.floor(maxN));
  for (let i = 0; i < tokens.length; i++) {
    for (let len = 1; len <= n && i + len <= tokens.length; len++) {
      out.push(tokens.slice(i, i + len).join(" "));
    }
  }
  return out;
}

/**
 * Convert text to a fixed-length embedding vector of dimension `dim`.
 *
 * The vector is created by hashing each token to an index and accumulating
 * token counts at that index, then L2-normalizing the resulting vector.
 */
export function textToEmbedding(
  text: string,
  dim = 768,
  options?: { nGram?: number; useTfIdf?: boolean; idfMap?: Map<string, number> | Record<string, number> },
): number[] {
  if (dim <= 0) throw new Error("dim must be positive");
  const nGram = options?.nGram ?? 1;
  const useTfIdf = options?.useTfIdf ?? false;
  let idfMap: Map<string, number> | undefined;
  if (options?.idfMap) {
    if (options.idfMap instanceof Map) idfMap = options.idfMap;
    else idfMap = new Map(Object.entries(options.idfMap));
  }

  const vec = new Float32Array(dim);
  const tokens = generateNgrams(tokenize(text || ""), nGram);

  // compute term frequencies
  const tf = new Map<string, number>();
  for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1);

  for (const [tok, count] of tf.entries()) {
    const h = hashStringDJB2(tok);
    const idx = h % dim;
    const tfVal = count; // raw count
    const idfVal = useTfIdf ? (idfMap?.get(tok) ?? 1) : 1;
    vec[idx] = vec[idx] + tfVal * idfVal;
  }

  // L2 normalize
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;

  return Array.from(vec);
}
