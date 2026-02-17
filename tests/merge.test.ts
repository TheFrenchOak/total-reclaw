import { describe, it, expect } from 'vitest';
import { mergeResults } from '../index.js';
import type { SearchResult, MemoryEntry } from '../index.js';
import type { MemoryCategory, DecayClass } from '../config.js';

function makeResult(overrides: {
  id?: string;
  text?: string;
  score?: number;
  backend?: 'sqlite' | 'lancedb';
}): SearchResult {
  const entry: MemoryEntry = {
    id: overrides.id ?? crypto.randomUUID(),
    text: overrides.text ?? 'Test fact',
    category: 'fact' as MemoryCategory,
    importance: 0.7,
    entity: null,
    key: null,
    value: null,
    source: 'conversation',
    createdAt: Math.floor(Date.now() / 1000),
    decayClass: 'stable' as DecayClass,
    expiresAt: null,
    lastConfirmedAt: Math.floor(Date.now() / 1000),
    confidence: 1.0,
  };
  return {
    entry,
    score: overrides.score ?? 0.8,
    backend: overrides.backend ?? 'sqlite',
  };
}

describe('mergeResults', () => {
  it('deduplicates by ID', () => {
    const id = crypto.randomUUID();
    const sqlite = [makeResult({ id, text: 'Same fact', backend: 'sqlite', score: 0.9 })];
    const lance = [makeResult({ id, text: 'Same fact', backend: 'lancedb', score: 0.7 })];

    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(1);
    expect(merged[0].backend).toBe('sqlite');
  });

  it('deduplicates by text (case-insensitive)', () => {
    const sqlite = [makeResult({ text: 'Fred prefers TypeScript', backend: 'sqlite', score: 0.9 })];
    const lance = [makeResult({ text: 'fred prefers typescript', backend: 'lancedb', score: 0.7 })];

    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(1);
    expect(merged[0].backend).toBe('sqlite');
  });

  it('keeps unique results from both backends', () => {
    const sqlite = [makeResult({ text: 'Fact from SQLite', backend: 'sqlite' })];
    const lance = [makeResult({ text: 'Fact from LanceDB', backend: 'lancedb' })];

    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(2);
  });

  it('sorts by score descending', () => {
    const sqlite = [makeResult({ text: 'Low score', backend: 'sqlite', score: 0.3 })];
    const lance = [makeResult({ text: 'High score', backend: 'lancedb', score: 0.95 })];

    const merged = mergeResults(sqlite, lance, 10);
    expect(merged[0].score).toBeGreaterThan(merged[1].score);
    expect(merged[0].entry.text).toBe('High score');
  });

  it('respects limit', () => {
    const sqlite = Array.from({ length: 5 }, (_, i) =>
      makeResult({ text: `SQLite fact ${i}`, backend: 'sqlite', score: 0.9 - i * 0.1 }),
    );
    const lance = Array.from({ length: 5 }, (_, i) =>
      makeResult({ text: `Lance fact ${i}`, backend: 'lancedb', score: 0.85 - i * 0.1 }),
    );

    const merged = mergeResults(sqlite, lance, 3);
    expect(merged.length).toBe(3);
  });

  it('prioritizes sqlite results when IDs match', () => {
    const id = crypto.randomUUID();
    const sqlite = [makeResult({ id, text: 'Shared fact', backend: 'sqlite', score: 0.5 })];
    const lance = [makeResult({ id, text: 'Shared fact', backend: 'lancedb', score: 0.99 })];

    const merged = mergeResults(sqlite, lance, 10);
    expect(merged.length).toBe(1);
    // SQLite is included first (it's the one kept), not replaced by lance
    expect(merged[0].backend).toBe('sqlite');
  });

  it('handles empty inputs', () => {
    expect(mergeResults([], [], 10)).toEqual([]);
    expect(mergeResults([], [makeResult({})], 10).length).toBe(1);
    expect(mergeResults([makeResult({})], [], 10).length).toBe(1);
  });
});
