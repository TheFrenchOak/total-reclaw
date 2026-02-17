# Total Reclaw

Hybrid memory plugin for [OpenClaw](https://github.com/openclaw/openclaw). Gives your AI assistant persistent, structured long-term memory using two complementary backends:

1. **SQLite + FTS5** — structured facts with full-text search, porter stemming, and synonym-based search tags. Instant, zero API cost.
2. **LanceDB** — semantic vector search via OpenAI embeddings for fuzzy/contextual recall when keywords don't match.

Retrieval merges results from both backends, deduplicates, and prioritizes high-confidence FTS5 matches over approximate vector matches.

## How it works

```
User message
    │
    ├─ auto-capture ──→ shouldCapture() ──→ extractStructuredFields()
    │                                           │
    │                                    ┌──────┴──────┐
    │                                    ▼             ▼
    │                               SQLite FTS5    LanceDB
    │                               (structured)   (vectors)
    │
    └─ auto-recall ───→ search both backends
                              │
                        mergeResults()
                              │
                        <relevant-memories>
                        injected into context
```

### What gets stored

Total Reclaw doesn't dump raw conversation text. It extracts **structured facts** with automatic classification:

| Category | Examples |
|----------|---------|
| `preference` | "I prefer dark mode", "Je prefere le the vert" |
| `decision` | "We decided to use PostgreSQL for JSONB support" |
| `entity` | "John's email is john@example.com", "My birthday is Nov 13" |
| `fact` | "The API rate limit is 1000 req/min" |

Each fact is stored with:
- **Entity/key/value** extraction (e.g. entity=`John`, key=`email`, value=`john@example.com`)
- **Decay class** determining its TTL (see below)
- **Confidence score** that decays over time
- **Search tags** — auto-generated synonyms for better reformulation recall

### Memory decay model

Not all memories should live forever. Total Reclaw classifies facts into 5 decay classes:

| Class | TTL | Examples |
|-------|-----|---------|
| `permanent` | Never expires | Birthdays, emails, names |
| `stable` | 90 days | Preferences, conventions, tech stack |
| `active` | 14 days | Current project decisions, active tasks |
| `session` | 24 hours | "Currently debugging auth module" |
| `checkpoint` | 4 hours | Pre-flight state before risky operations |

Expired facts are pruned automatically on startup and hourly.

## Installation

```bash
# In the OpenClaw extensions directory
git clone https://github.com/your-org/total-reclaw.git
cd total-reclaw
npm install
```

## Configuration

In your OpenClaw config (`~/.openclaw/openclaw.json`), register the plugin:

```json5
{
  plugins: {
    slots: {
      memory: "total-reclaw"
    }
  }
}
```

Plugin config in `openclaw.plugin.json`:

```json5
{
  embedding: {
    apiKey: "${OPENAI_API_KEY}",   // or a literal key
    model: "text-embedding-3-small" // or "text-embedding-3-large"
  },
  // Optional — defaults shown:
  sqlitePath: "~/.openclaw/memory/facts.db",
  lanceDbPath: "~/.openclaw/memory/lancedb",
  autoCapture: true,   // auto-extract facts from conversations
  autoRecall: true     // auto-inject relevant memories into context
}
```

## Tools

The plugin registers 5 tools available to the LLM:

### `memory_recall`

Search through long-term memories using both structured (exact) and semantic (fuzzy) search.

```
memory_recall({ query: "what database do we use?", limit: 5 })
memory_recall({ query: "John", entity: "John" })  // entity lookup
```

### `memory_store`

Save important information with optional structured fields.

```
memory_store({
  text: "Fred prefers Cursor over VSCode",
  category: "preference",
  entity: "Fred",
  key: "editor",
  value: "Cursor"
})
```

Duplicate detection prevents storing the same fact twice. Upsert on `(entity, key)` automatically updates existing facts.

### `memory_forget`

Delete specific memories by ID or search query.

### `memory_checkpoint`

Save/restore pre-flight checkpoints before risky operations. Auto-expires after 4 hours.

```
memory_checkpoint({ action: "save", intent: "Refactoring auth module", state: "3 files modified" })
memory_checkpoint({ action: "restore" })
```

### `memory_prune`

Manually trigger pruning of expired facts and confidence decay.

## CLI commands

```bash
openclaw total-reclaw stats              # Memory statistics with decay breakdown
openclaw total-reclaw search "query"     # Search across both backends
openclaw total-reclaw lookup "John"      # Exact entity lookup
openclaw total-reclaw prune              # Remove expired + decay confidence
openclaw total-reclaw prune --dry-run    # Preview what would be pruned
openclaw total-reclaw backfill-decay     # Re-classify existing facts
openclaw total-reclaw extract-daily      # Extract facts from MEMORY.md + daily files
openclaw total-reclaw checkpoint save    # Save/restore checkpoints
```

## How it coexists with OpenClaw's built-in memory

OpenClaw natively injects `MEMORY.md` into the system prompt on every turn. Total Reclaw complements this by:

1. **Ingesting** `MEMORY.md` + the last 3 days of `memory/YYYY-MM-DD.md` at startup, extracting structured facts
2. **Providing tools** (`memory_recall`, `memory_store`) so the LLM searches precisely what it needs instead of loading everything
3. **Auto-capturing** facts from conversations that the user never explicitly asked to remember

`MEMORY.md` continues to be injected by OpenClaw. For cost efficiency, keep it small (identity, critical preferences) and let Total Reclaw handle the rest via targeted retrieval.

## Search quality

FTS5 handles most queries well thanks to porter stemming, prefix matching, and synonym-based search tags. The vector layer catches pure semantic queries where there's zero lexical overlap.

### Benchmark results

88 tests (79 unit + 9 benchmark scenarios). Run with `npm run bench`:

```
── FTS-only (SQLite + porter stemming + search tags) ──
┌──────────────────────────────┬──────────┬──────────┬────────┬─────────┐
│ Scenario                     │ Recall@1 │ Recall@5 │ MRR    │ Latency │
├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤
│ Exact recall                 │   100%   │   100%   │  1.000 │   0.4ms │
│ Reformulation                │    88%   │   100%   │  0.917 │   0.3ms │
│ Entity lookup                │   100%   │   100%   │  1.000 │   0.1ms │
│ Temporal decay               │   100%   │   100%   │  1.000 │   0.0ms │
│ Knowledge update             │   100%   │   100%   │  1.000 │   0.0ms │
│ With distractors             │   100%   │   100%   │  1.000 │   0.3ms │
│ Scoring quality              │   100%   │   100%   │  1.000 │   0.0ms │
│ French recall                │   100%   │   100%   │  1.000 │   0.4ms │
│ Pure semantic                │    60%   │    60%   │  0.600 │   0.3ms │
├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤
│ AVERAGE                      │    94%   │    96%   │  0.946 │   0.2ms │
└──────────────────────────────┴──────────┴──────────┴────────┴─────────┘

── Hybrid (FTS + MiniLM-L6-v2 vectors) ──
┌──────────────────────────────┬──────────┬──────────┬────────┬─────────┐
│ Scenario                     │ Recall@1 │ Recall@5 │ MRR    │ Latency │
├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤
│ Exact recall                 │   100%   │   100%   │  1.000 │  14.2ms │
│ Reformulation                │    88%   │   100%   │  0.917 │  12.2ms │
│ Entity lookup                │   100%   │   100%   │  1.000 │   0.1ms │
│ Temporal decay               │   100%   │   100%   │  1.000 │   0.0ms │
│ Knowledge update             │   100%   │   100%   │  1.000 │   0.0ms │
│ With distractors             │   100%   │   100%   │  1.000 │  12.3ms │
│ Scoring quality              │   100%   │   100%   │  1.000 │   0.0ms │
│ French recall                │   100%   │   100%   │  1.000 │  12.2ms │
│ Pure semantic                │    80%   │    80%   │  0.822 │  12.3ms │
├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤
│ AVERAGE                      │    96%   │    98%   │  0.971 │   7.0ms │
└──────────────────────────────┴──────────┴──────────┴────────┴─────────┘
```

The hybrid layer adds +20pp Recall@1 on pure semantic queries (zero lexical overlap) at the cost of ~12ms latency per search.

Benchmarks use local embeddings (all-MiniLM-L6-v2, 384 dims) via `@huggingface/transformers` — no API key needed. Production uses OpenAI embeddings.

## Development

```bash
npm install
npm test          # Run all 88 tests
npm run bench     # Run benchmark only
npm run test:watch # Watch mode
```

### Project structure

```
index.ts                 # Entry point — re-exports plugin + public API
config.ts                # Configuration schema, decay classes, TTL defaults
openclaw.plugin.json     # OpenClaw plugin manifest
src/
  plugin.ts              # Plugin registration (tools, CLI, hooks, service)
  facts-db.ts            # FactsDB class (SQLite + FTS5)
  vector-db.ts           # VectorDB class (LanceDB)
  embeddings.ts          # OpenAI embeddings client
  search.ts              # mergeResults, stop words
  search-tags.ts         # Synonym map, generateSearchTags
  decay.ts               # classifyDecay, calculateExpiry
  extraction.ts          # extractStructuredFields, shouldCapture, detectCategory
  markdown-scan.ts       # MEMORY.md + daily file extraction
  types.ts               # MemoryEntry, SearchResult types
tests/
  facts-db.test.ts       # 33 unit tests — FactsDB (SQLite + FTS5)
  classify.test.ts       # 39 unit tests — decay classification, capture, extraction
  merge.test.ts          # 7 unit tests — result merging and deduplication
  benchmark.test.ts      # 9 benchmark scenarios — FTS vs Hybrid recall quality
  local-embeddings.ts    # Local MiniLM embeddings helper (tests only)
```

## Dependencies

| Package | Purpose | Runtime/Dev |
|---------|---------|-------------|
| `better-sqlite3` | SQLite with FTS5 support | Runtime |
| `@lancedb/lancedb` | Vector database for semantic search | Runtime |
| `openai` | Embedding API client | Runtime |
| `@sinclair/typebox` | JSON schema for tool parameters | Runtime |
| `vitest` | Test runner | Dev |
| `@huggingface/transformers` | Local embeddings for benchmarks | Dev |

## Acknowledgments

This plugin was inspired by the approach described in [Give Your Clawdbot Permanent Memory](https://clawdboss.ai/posts/give-your-clawdbot-permanent-memory) on Clawdboss.ai. The original article laid the groundwork for building a persistent memory layer on top of OpenClaw.

## License

MIT
