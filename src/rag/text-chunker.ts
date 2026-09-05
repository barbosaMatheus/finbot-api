// textChunker.ts
// A robust TS utility for splitting long text into overlapping chunks for RAG pipelines.

export interface ChunkerOptions {
  maxChunkSize?: number; // Approx character limit per chunk
  overlap?: number; // Number of characters to overlap
  minChunkSize?: number; // Minimum characters before forcing a merge
}

export interface Chunk {
  id: string;
  text: string;
  start: number;
  end: number;
}

export function chunkText(
  input: string,
  options: ChunkerOptions = {},
): Chunk[] {
  try {
    if (typeof input !== "string") {
      throw new Error("Input must be a string.");
    }

    const maxChunkSize = options.maxChunkSize ?? 1200;
    const overlap = options.overlap ?? 200;
    const minChunkSize = options.minChunkSize ?? 300;

    if (maxChunkSize <= 0 || overlap < 0 || minChunkSize < 0) {
      throw new Error("Invalid chunker configuration values.");
    }

    if (overlap >= maxChunkSize) {
      throw new Error("Overlap must be smaller than maxChunkSize.");
    }

    if (minChunkSize > maxChunkSize) {
      throw new Error("minChunkSize must not exceed maxChunkSize.");
    }

    if (input.trim().length === 0) {
      return [];
    }

    const chunks: Chunk[] = [];
    let position = 0;

    while (position < input.length) {
      const end = Math.min(position + maxChunkSize, input.length);
      let chunk = input.slice(position, end);

      // Avoid tiny last chunk by merging if below minimum size
      if (chunk.length < minChunkSize && chunks.length > 0) {
        const last = chunks[chunks.length - 1];
        last.text += chunk;
        last.end = end;
        break;
      }

      chunks.push({
        id: `chunk_${chunks.length}`,
        text: chunk,
        start: position,
        end: end,
      });

      if (end === input.length) {
        break;
      }

      const nextPosition = end - overlap;
      position = nextPosition > position ? nextPosition : end;
    }

    return chunks;
  } catch (err) {
    console.error("Chunking error:", err);
    return [];
  }
}
