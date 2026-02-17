/**
 * OpenClaw Memory Hybrid Plugin — Total Reclaw
 *
 * Two-tier memory system:
 *   1. SQLite + FTS5 — structured facts, instant full-text search, zero API cost
 *   2. LanceDB — semantic vector search for fuzzy/contextual recall
 *
 * Retrieval merges results from both backends, deduplicates, and prioritizes
 * high-confidence FTS5 matches over approximate vector matches.
 */

export { default } from './src/plugin.js';

// Public API for testing and external use
export { FactsDB } from './src/facts-db.js';
export { VectorDB } from './src/vector-db.js';
export { Embeddings } from './src/embeddings.js';
export { classifyDecay, calculateExpiry } from './src/decay.js';
export { mergeResults } from './src/search.js';
export { generateSearchTags } from './src/search-tags.js';
export { extractStructuredFields, shouldCapture, detectCategory } from './src/extraction.js';
export type { MemoryEntry, SearchResult } from './src/types.js';
