/**
 * Total-Reclaw Memory Recall Benchmark
 *
 * Measures recall quality across FTS-only and Hybrid (FTS + Vector) pipelines.
 * Inspired by LOCOMO, GoodAI LTM, and Mem0 evaluation approaches.
 *
 * Local embeddings via all-MiniLM-L6-v2 (384 dims, CPU) — no API key needed.
 *
 * Run:  npm run bench
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FactsDB, VectorDB, mergeResults } from '../index.js';
import type { SearchResult } from '../index.js';
import type { MemoryCategory, DecayClass } from '../config.js';
import { embed, initEmbeddings, VECTOR_DIM } from './local-embeddings.js';

// ============================================================================
// Dataset
// ============================================================================

type FactDef = {
  text: string;
  category: MemoryCategory;
  entity?: string;
  key?: string;
  value?: string;
  decayClass?: DecayClass;
  importance?: number;
};

const FACTS: FactDef[] = [
  // Preferences
  { text: 'I prefer TypeScript over JavaScript', category: 'preference', entity: 'user', key: 'prefer_language', value: 'TypeScript over JavaScript' },
  { text: 'I like dark mode for all my editors', category: 'preference', entity: 'user', key: 'prefer_theme', value: 'dark mode' },
  { text: 'I hate tabs, always use spaces', category: 'preference', entity: 'user', key: 'prefer_indent', value: 'spaces' },
  { text: 'I prefer Vim keybindings in my editor', category: 'preference', entity: 'user', key: 'prefer_keybindings', value: 'Vim' },
  { text: 'I use Bun instead of Node for package management', category: 'preference', entity: 'user', key: 'prefer_pkg_manager', value: 'Bun' },

  // Decisions
  { text: 'We decided to use PostgreSQL because of JSONB support', category: 'decision', entity: 'decision', key: 'PostgreSQL', value: 'JSONB support' },
  { text: 'We decided to use Redis for caching because of low latency', category: 'decision', entity: 'decision', key: 'Redis for caching', value: 'low latency' },
  { text: 'We chose Tailwind CSS over Bootstrap for styling', category: 'decision', entity: 'decision', key: 'Tailwind CSS over Bootstrap', value: 'preference' },
  { text: 'We decided to use GitHub Actions for CI/CD', category: 'decision', entity: 'decision', key: 'GitHub Actions for CI/CD', value: 'no rationale recorded' },
  { text: 'We decided to use monorepo with Turborepo', category: 'decision', entity: 'decision', key: 'monorepo with Turborepo', value: 'no rationale recorded' },

  // Entities / Contacts
  { text: "Fred's email is fred@example.com", category: 'entity', entity: 'Fred', key: 'email', value: 'fred@example.com' },
  { text: "Alice's phone is +33612345678", category: 'entity', entity: 'Alice', key: 'phone', value: '+33612345678' },
  { text: "Bob's role is backend engineer", category: 'entity', entity: 'Bob', key: 'role', value: 'backend engineer' },
  { text: "Charlie's birthday is March 5", category: 'entity', entity: 'Charlie', key: 'birthday', value: 'March 5' },
  { text: 'Diana works at Anthropic', category: 'fact', entity: 'Diana', key: 'company', value: 'Anthropic' },

  // Facts
  { text: 'The project uses MIT license', category: 'fact', entity: 'project', key: 'license', value: 'MIT' },
  { text: 'The API runs on port 3000', category: 'fact', entity: 'project', key: 'api_port', value: '3000' },
  { text: 'The database schema has 42 tables', category: 'fact', entity: 'project', key: 'table_count', value: '42' },
  { text: 'The frontend is a React SPA with Next.js', category: 'fact', entity: 'project', key: 'frontend_stack', value: 'React SPA with Next.js' },
  { text: 'Deployments happen every Friday at 3pm', category: 'fact', entity: 'project', key: 'deploy_schedule', value: 'Friday 3pm' },

  // Conventions
  { text: 'Always use snake_case for database columns', category: 'decision', entity: 'convention', key: 'snake_case for database columns', value: 'always' },
  { text: 'Never commit directly to main branch', category: 'decision', entity: 'convention', key: 'commit directly to main branch', value: 'never' },
  { text: 'Always write tests before merging PRs', category: 'decision', entity: 'convention', key: 'write tests before merging PRs', value: 'always' },
  { text: 'Always use ISO 8601 for date formats', category: 'decision', entity: 'convention', key: 'ISO 8601 for date formats', value: 'always' },

  // Session/Active
  { text: 'Currently debugging the authentication module', category: 'other', decayClass: 'session' },
  { text: 'Working on the payment integration sprint', category: 'other', decayClass: 'active' },
  { text: 'TODO: fix the race condition in the queue processor', category: 'other', decayClass: 'active' },

  // FR
  { text: "On a décidé d'utiliser FastAPI pour le backend Python", category: 'decision', entity: 'decision', key: 'FastAPI pour le backend', value: 'pas de justification' },
  { text: 'Je préfère le café au thé', category: 'preference', entity: 'user', key: 'prefer_boisson', value: 'café' },
  { text: 'Mon anniversaire est le 13 novembre', category: 'fact', entity: 'user', key: 'anniversaire', value: '13 novembre' },
];

function generateDistractors(count: number): FactDef[] {
  const topics = [
    'machine learning', 'deep learning', 'neural networks', 'data science',
    'cloud computing', 'microservices', 'containers', 'orchestration',
    'networking', 'security', 'encryption', 'authentication',
    'mobile development', 'iOS', 'Android', 'React Native',
    'DevOps', 'monitoring', 'logging', 'alerting',
    'GraphQL', 'REST API', 'gRPC', 'WebSocket',
    'testing', 'unit tests', 'integration tests', 'e2e tests',
    'performance', 'optimization', 'profiling', 'benchmarking',
    'documentation', 'code review', 'pair programming', 'refactoring',
    'agile', 'scrum', 'kanban', 'sprint planning',
  ];
  const verbs = [
    'involves', 'requires', 'improves', 'supports', 'enables',
    'facilitates', 'handles', 'processes', 'manages', 'integrates',
  ];
  return Array.from({ length: count }, (_, i) => ({
    text: `${topics[i % topics.length]} ${verbs[i % verbs.length]} various aspects of software development iteration ${i}`,
    category: 'other' as MemoryCategory,
  }));
}

// ============================================================================
// Infrastructure
// ============================================================================

type QueryCase = {
  query: string;
  expectedText: string;
  lookupEntity?: string;
  lookupKey?: string;
};

type ScenarioResult = {
  name: string;
  recall1: number;
  recall5: number;
  mrr: number;
  latencyMs: number;
  details: Array<{ query: string; found: boolean; rank: number | null }>;
};

function computeMetrics(ranks: Array<number | null>) {
  const n = ranks.length;
  if (n === 0) return { recall1: 0, recall5: 0, mrr: 0 };
  let r1 = 0, r5 = 0, rrSum = 0;
  for (const rank of ranks) {
    if (rank === 1) r1++;
    if (rank !== null && rank <= 5) r5++;
    if (rank !== null) rrSum += 1 / rank;
  }
  return { recall1: r1 / n, recall5: r5 / n, mrr: rrSum / n };
}

function printTable(label: string, results: ScenarioResult[]) {
  const n = results.length;
  if (n === 0) return;
  const avgR1 = results.reduce((s, r) => s + r.recall1, 0) / n;
  const avgR5 = results.reduce((s, r) => s + r.recall5, 0) / n;
  const avgMrr = results.reduce((s, r) => s + r.mrr, 0) / n;
  const avgLat = results.reduce((s, r) => s + r.latencyMs, 0) / n;

  console.log(`\n  ── ${label} ──`);
  console.log('  ┌──────────────────────────────┬──────────┬──────────┬────────┬─────────┐');
  console.log('  │ Scenario                     │ Recall@1 │ Recall@5 │ MRR    │ Latency │');
  console.log('  ├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤');
  for (const r of results) {
    const name = r.name.padEnd(28);
    const r1 = `${(r.recall1 * 100).toFixed(0)}%`.padStart(6);
    const r5 = `${(r.recall5 * 100).toFixed(0)}%`.padStart(6);
    const mrr = r.mrr.toFixed(3).padStart(6);
    const lat = `${r.latencyMs.toFixed(1)}ms`.padStart(7);
    console.log(`  │ ${name} │ ${r1}   │ ${r5}   │ ${mrr} │ ${lat} │`);
  }
  console.log('  ├──────────────────────────────┼──────────┼──────────┼────────┼─────────┤');
  const ar1 = `${(avgR1 * 100).toFixed(0)}%`.padStart(6);
  const ar5 = `${(avgR5 * 100).toFixed(0)}%`.padStart(6);
  const amrr = avgMrr.toFixed(3).padStart(6);
  const alat = `${avgLat.toFixed(1)}ms`.padStart(7);
  console.log(`  │ ${'AVERAGE'.padEnd(28)} │ ${ar1}   │ ${ar5}   │ ${amrr} │ ${alat} │`);
  console.log('  └──────────────────────────────┴──────────┴──────────┴────────┴─────────┘');
}

// ============================================================================
// Benchmark
// ============================================================================

describe('Memory Recall Benchmark', () => {
  let factsDb: FactsDB;
  let vectorDb: VectorDB;
  let dir: string;

  const ftsResults: ScenarioResult[] = [];
  const hybridResults: ScenarioResult[] = [];

  beforeAll(async () => {
    await initEmbeddings();

    dir = mkdtempSync(join(tmpdir(), 'reclaw-bench-'));
    factsDb = new FactsDB(join(dir, 'bench.db'));
    vectorDb = new VectorDB(join(dir, 'lancedb'), VECTOR_DIM);

    const allFacts = [...FACTS, ...generateDistractors(200)];
    for (const fact of allFacts) {
      const stored = factsDb.store({
        text: fact.text,
        category: fact.category,
        importance: fact.importance ?? 0.7,
        entity: fact.entity ?? null,
        key: fact.key ?? null,
        value: fact.value ?? null,
        source: 'benchmark',
        ...(fact.decayClass ? { decayClass: fact.decayClass } : {}),
      });

      const vector = await embed(fact.text);
      await vectorDb.store({
        id: stored.id,
        text: fact.text,
        vector,
        importance: fact.importance ?? 0.7,
        category: fact.category,
      });
    }

    console.log(`\n  ${factsDb.count()} facts in SQLite, ${await vectorDb.count()} vectors in LanceDB\n`);
  }, 120_000);

  afterAll(() => {
    // ---- Print comparison ----
    printTable('FTS-only (SQLite + porter stemming + search tags)', ftsResults);
    printTable('Hybrid (FTS + MiniLM-L6-v2 vectors)', hybridResults);

    // ---- Delta comparison ----
    console.log('\n  ── FTS vs Hybrid (delta) ──');
    for (const fts of ftsResults) {
      const hybrid = hybridResults.find(r => r.name === fts.name);
      if (!hybrid) continue;
      const dr1 = ((hybrid.recall1 - fts.recall1) * 100);
      const dr5 = ((hybrid.recall5 - fts.recall5) * 100);
      if (dr1 === 0 && dr5 === 0) continue;
      console.log(`  ${fts.name}: Recall@1 ${dr1 >= 0 ? '+' : ''}${dr1.toFixed(0)}pp  Recall@5 ${dr5 >= 0 ? '+' : ''}${dr5.toFixed(0)}pp`);
    }

    // ---- Misses ----
    const misses = hybridResults.flatMap(r =>
      r.details.filter(d => !d.found).map(d => ({ scenario: r.name, ...d })),
    );
    if (misses.length > 0) {
      console.log(`\n  MISSES (${misses.length}):`);
      for (const m of misses) {
        console.log(`    [${m.scenario}] "${m.query}"`);
      }
    }
    console.log('');

    factsDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- Run a scenario on both pipelines ----

  async function runScenario(name: string, cases: QueryCase[]) {
    const ftsRanks: Array<number | null> = [];
    const hybridRanks: Array<number | null> = [];
    const ftsDetails: ScenarioResult['details'] = [];
    const hybridDetails: ScenarioResult['details'] = [];
    let ftsTimeMs = 0;
    let hybridTimeMs = 0;

    for (const c of cases) {
      const label = c.query || c.lookupEntity!;

      // ---- FTS-only ----
      const ftsStart = performance.now();
      const ftsSearch = c.lookupEntity
        ? factsDb.lookup(c.lookupEntity, c.lookupKey)
        : factsDb.search(c.query, 10);
      ftsTimeMs += performance.now() - ftsStart;

      const ftsIdx = ftsSearch.findIndex(r => r.entry.text === c.expectedText);
      ftsRanks.push(ftsIdx >= 0 ? ftsIdx + 1 : null);
      ftsDetails.push({ query: label, found: ftsIdx >= 0, rank: ftsIdx >= 0 ? ftsIdx + 1 : null });

      // ---- Hybrid ----
      const hybStart = performance.now();
      const sqliteResults = c.lookupEntity
        ? factsDb.lookup(c.lookupEntity, c.lookupKey)
        : factsDb.search(c.query, 10);

      let vectorResults: SearchResult[] = [];
      if (!c.lookupEntity) {
        const queryVector = await embed(c.query);
        vectorResults = await vectorDb.search(queryVector, 10, 0.3);
      }
      const merged = mergeResults(sqliteResults, vectorResults, 10);
      hybridTimeMs += performance.now() - hybStart;

      const hybIdx = merged.findIndex(r => r.entry.text === c.expectedText);
      hybridRanks.push(hybIdx >= 0 ? hybIdx + 1 : null);
      hybridDetails.push({ query: label, found: hybIdx >= 0, rank: hybIdx >= 0 ? hybIdx + 1 : null });
    }

    ftsResults.push({ name, ...computeMetrics(ftsRanks), latencyMs: ftsTimeMs / cases.length, details: ftsDetails });
    hybridResults.push({ name, ...computeMetrics(hybridRanks), latencyMs: hybridTimeMs / cases.length, details: hybridDetails });
  }

  // ========================================================================
  // Scenarios
  // ========================================================================

  it('Exact recall', async () => {
    await runScenario('Exact recall', [
      { query: 'TypeScript JavaScript', expectedText: 'I prefer TypeScript over JavaScript' },
      { query: 'PostgreSQL JSONB', expectedText: 'We decided to use PostgreSQL because of JSONB support' },
      { query: 'Redis caching latency', expectedText: 'We decided to use Redis for caching because of low latency' },
      { query: 'Fred email', expectedText: "Fred's email is fred@example.com" },
      { query: 'Alice phone', expectedText: "Alice's phone is +33612345678" },
      { query: 'snake_case database columns', expectedText: 'Always use snake_case for database columns' },
      { query: 'MIT license project', expectedText: 'The project uses MIT license' },
      { query: 'React Next.js frontend', expectedText: 'The frontend is a React SPA with Next.js' },
      { query: 'Tailwind Bootstrap styling', expectedText: 'We chose Tailwind CSS over Bootstrap for styling' },
      { query: 'GitHub Actions CI/CD', expectedText: 'We decided to use GitHub Actions for CI/CD' },
    ]);
    expect(hybridResults.at(-1)!.recall5).toBeGreaterThanOrEqual(0.8);
  });

  it('Reformulation', async () => {
    await runScenario('Reformulation', [
      { query: 'database choice', expectedText: 'We decided to use PostgreSQL because of JSONB support' },
      { query: 'caching solution', expectedText: 'We decided to use Redis for caching because of low latency' },
      { query: 'CSS framework', expectedText: 'We chose Tailwind CSS over Bootstrap for styling' },
      { query: 'continuous integration', expectedText: 'We decided to use GitHub Actions for CI/CD' },
      { query: 'code formatting indentation', expectedText: 'I hate tabs, always use spaces' },
      { query: 'deployment schedule', expectedText: 'Deployments happen every Friday at 3pm' },
      { query: 'monorepo tool', expectedText: 'We decided to use monorepo with Turborepo' },
      { query: 'API server port', expectedText: 'The API runs on port 3000' },
    ]);
    const hybrid = hybridResults.at(-1)!;
    const fts = ftsResults.at(-1)!;
    expect(hybrid.recall5).toBeGreaterThanOrEqual(fts.recall5);
  });

  it('Entity lookup', async () => {
    await runScenario('Entity lookup', [
      { query: '', lookupEntity: 'Fred', lookupKey: 'email', expectedText: "Fred's email is fred@example.com" },
      { query: '', lookupEntity: 'Alice', lookupKey: 'phone', expectedText: "Alice's phone is +33612345678" },
      { query: '', lookupEntity: 'Bob', lookupKey: 'role', expectedText: "Bob's role is backend engineer" },
      { query: '', lookupEntity: 'Charlie', lookupKey: 'birthday', expectedText: "Charlie's birthday is March 5" },
      { query: '', lookupEntity: 'Diana', lookupKey: 'company', expectedText: 'Diana works at Anthropic' },
      { query: '', lookupEntity: 'project', lookupKey: 'license', expectedText: 'The project uses MIT license' },
      { query: '', lookupEntity: 'project', lookupKey: 'api_port', expectedText: 'The API runs on port 3000' },
      { query: '', lookupEntity: 'project', lookupKey: 'frontend_stack', expectedText: 'The frontend is a React SPA with Next.js' },
    ]);
    expect(hybridResults.at(-1)!.recall1).toBeGreaterThanOrEqual(0.9);
  });

  it('Temporal decay', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    factsDb.store({
      text: 'The old API ran on port 8080',
      category: 'fact', importance: 0.7, entity: 'project', key: 'old_api_port',
      value: '8080', source: 'benchmark', decayClass: 'session', expiresAt: nowSec - 3600,
    });

    const results = factsDb.search('API port', 5);
    expect(results.some(r => r.entry.text.includes('8080'))).toBe(false);
    expect(results.some(r => r.entry.text.includes('3000'))).toBe(true);

    const ok = !results.some(r => r.entry.text.includes('8080')) && results.some(r => r.entry.text.includes('3000'));
    const res: ScenarioResult = { name: 'Temporal decay', recall1: ok ? 1 : 0, recall5: ok ? 1 : 0, mrr: ok ? 1 : 0, latencyMs: 0, details: [{ query: 'API port', found: ok, rank: ok ? 1 : null }] };
    ftsResults.push(res);
    hybridResults.push(res);
  });

  it('Knowledge update (upsert)', () => {
    factsDb.store({ text: 'Fred uses VSCode as his editor', category: 'fact', importance: 0.7, entity: 'Fred', key: 'editor', value: 'VSCode', source: 'benchmark' });
    factsDb.store({ text: 'Fred now uses Cursor as his editor', category: 'fact', importance: 0.7, entity: 'Fred', key: 'editor', value: 'Cursor', source: 'benchmark' });

    const lookup = factsDb.lookup('Fred', 'editor');
    const ok = lookup.length === 1 && lookup[0].entry.value === 'Cursor';
    expect(ok).toBe(true);

    const res: ScenarioResult = { name: 'Knowledge update', recall1: ok ? 1 : 0, recall5: ok ? 1 : 0, mrr: ok ? 1 : 0, latencyMs: 0, details: [{ query: 'Fred editor', found: ok, rank: ok ? 1 : null }] };
    ftsResults.push(res);
    hybridResults.push(res);
  });

  it('With distractors', async () => {
    await runScenario('With distractors', [
      { query: 'TypeScript JavaScript preference', expectedText: 'I prefer TypeScript over JavaScript' },
      { query: 'PostgreSQL JSONB database', expectedText: 'We decided to use PostgreSQL because of JSONB support' },
      { query: 'Fred email address', expectedText: "Fred's email is fred@example.com" },
      { query: 'Tailwind CSS Bootstrap', expectedText: 'We chose Tailwind CSS over Bootstrap for styling' },
      { query: 'snake_case database columns convention', expectedText: 'Always use snake_case for database columns' },
      { query: 'deploy Friday schedule', expectedText: 'Deployments happen every Friday at 3pm' },
      { query: 'main branch commit convention', expectedText: 'Never commit directly to main branch' },
      { query: 'dark mode editor', expectedText: 'I like dark mode for all my editors' },
      { query: 'Vim keybindings editor', expectedText: 'I prefer Vim keybindings in my editor' },
      { query: 'Bun Node package management', expectedText: 'I use Bun instead of Node for package management' },
    ]);
    expect(hybridResults.at(-1)!.recall5).toBeGreaterThanOrEqual(0.8);
  });

  it('Scoring quality', () => {
    const results = factsDb.search('tests merging PRs', 10);
    const rank = results.findIndex(r => r.entry.text === 'Always write tests before merging PRs');
    expect(rank).toBeGreaterThanOrEqual(0);

    const ok = rank >= 0;
    const res: ScenarioResult = { name: 'Scoring quality', recall1: rank === 0 ? 1 : 0, recall5: ok && rank < 5 ? 1 : 0, mrr: ok ? 1 / (rank + 1) : 0, latencyMs: 0, details: [{ query: 'tests merging PRs', found: ok, rank: ok ? rank + 1 : null }] };
    ftsResults.push(res);
    hybridResults.push(res);
  });

  it('French recall', async () => {
    await runScenario('French recall', [
      { query: 'FastAPI backend Python', expectedText: "On a décidé d'utiliser FastAPI pour le backend Python" },
      { query: 'café thé préférence', expectedText: 'Je préfère le café au thé' },
      { query: 'anniversaire novembre', expectedText: 'Mon anniversaire est le 13 novembre' },
    ]);
    expect(hybridResults.at(-1)!.recall5).toBeGreaterThanOrEqual(0.3);
  });

  it('Pure semantic (zero lexical overlap)', async () => {
    await runScenario('Pure semantic', [
      { query: 'what programming language do we use', expectedText: 'I prefer TypeScript over JavaScript' },
      { query: 'how do we style the app', expectedText: 'We chose Tailwind CSS over Bootstrap for styling' },
      { query: 'contact information for the team lead', expectedText: "Fred's email is fred@example.com" },
      { query: 'when does new code go live', expectedText: 'Deployments happen every Friday at 3pm' },
      { query: 'source control branching rules', expectedText: 'Never commit directly to main branch' },
    ]);
    expect(hybridResults.at(-1)!.recall5).toBeGreaterThan(ftsResults.at(-1)!.recall5);
  });
});
