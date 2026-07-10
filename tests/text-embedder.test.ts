import {
    buildIdfFromCorpus,
    embedTexts,
    generateNgrams,
    hashStringDJB2,
    textToEmbedding,
    tokenize,
} from "../src/rag/text-embedder";

test("tokenize splits text into tokens", () => {
  expect(tokenize("Hello, world! This is a test.")).toEqual([
    "hello",
    "world",
    "this",
    "is",
    "a",
    "test",
  ]);
});

test("hashStringDJB2 is deterministic", () => {
  expect(hashStringDJB2("hello")).toBe(hashStringDJB2("hello"));
});

test("textToEmbedding returns correct dimension and normalized", () => {
  const v = textToEmbedding("a quick brown fox jumps over the lazy dog", 768);
  expect(v.length).toBe(768);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  // allow small floating point error
  expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
});

test("embedTexts returns multiple embeddings", async () => {
  const res = await embedTexts(["hello", "world"], 64);
  expect(res.length).toBe(2);
  expect(res[0].length).toBe(64);
});

test("generateNgrams produces expected ngrams", () => {
  const toks = ["a", "b", "c"];
  expect(generateNgrams(toks, 2)).toEqual(["a", "a b", "b", "b c", "c"]);
});

test("n-gram option produces different embedding than unigram", () => {
  const v1 = textToEmbedding("the quick brown fox", 64, { nGram: 1 });
  const v2 = textToEmbedding("the quick brown fox", 64, { nGram: 2 });
  expect(v1).not.toEqual(v2);
});

test("buildIdfFromCorpus computes larger idf for rarer tokens", () => {
  const corpus = ["a b a", "a b", "c"];
  const idf = buildIdfFromCorpus(corpus, 1);
  expect(idf.get("c")! > idf.get("a")!).toBe(true);
});
