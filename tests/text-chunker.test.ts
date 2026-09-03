import chunkText from "../src/rag/text-chunker";

test("chunkText splits text into overlapping chunks using defaults", () => {
    const text =
        "The quick brown fox jumps over the lazy dog. " +
        "Pack my box with five dozen liquor jugs. " +
        "Sphinx of black quartz, judge my vow.";

    const chunks = chunkText(text, {
        maxChunkSize: 50,
        overlap: 10,
        minChunkSize: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toBe(text.slice(0, 50));
    expect(chunks[1].start).toBe(40);
    expect(chunks[1].end).toBe(90);
    expect(chunks[1].text).toBe(text.slice(40, 90));
    expect(chunks.every((chunk, index) => chunk.id === `chunk_${index}`)).toBe(
        true,
    );
});

test("chunkText respects maxChunkSize and overlap boundaries", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const chunks = chunkText(text, {
        maxChunkSize: 10,
        overlap: 3,
        minChunkSize: 1,
    });

    expect(chunks).toEqual([
        { id: "chunk_0", text: "abcdefghij", start: 0, end: 10 },
        { id: "chunk_1", text: "hijklmnopq", start: 7, end: 17 },
        { id: "chunk_2", text: "opqrstuvwx", start: 14, end: 24 },
        { id: "chunk_3", text: "vwxyz", start: 21, end: 26 },
    ]);
});

test("chunkText merges a tiny final chunk below minChunkSize into the previous chunk", () => {
    const text = "01234567890123456789"; // 20 chars
    const chunks = chunkText(text, {
        maxChunkSize: 12,
        overlap: 5,
        minChunkSize: 10,
    });

    expect(chunks.length).toBe(2);
    expect(chunks[0]).toEqual({
        id: "chunk_0",
        text: "012345678901",
        start: 0,
        end: 12,
    });
    expect(chunks[1]).toEqual({
        id: "chunk_1",
        text: "789012345678456789",
        start: 7,
        end: 20,
    });
});

test("chunkText returns an empty array for empty or whitespace-only input", () => {
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText("\n\t")).toEqual([]);
});

test("chunkText handles invalid non-string input gracefully", () => {
    const result = chunkText(123 as unknown as string);
    expect(result).toEqual([]);
});

test("chunkText rejects overlap equal to or greater than maxChunkSize", () => {
    const result = chunkText("abcdefghijklmnopqrstuvwxyz", {
        maxChunkSize: 10,
        overlap: 10,
        minChunkSize: 1,
    });
    expect(result).toEqual([]);
});
