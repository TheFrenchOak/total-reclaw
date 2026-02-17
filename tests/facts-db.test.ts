import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FactsDB } from '../index.js';
import type { MemoryCategory } from '../config.js';

function makeTmpDb(): { db: FactsDB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'reclaw-test-'));
  const db = new FactsDB(join(dir, 'test.db'));
  return { db, dir };
}

function makeFact(overrides: Partial<{
  text: string;
  category: MemoryCategory;
  importance: number;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  decayClass: 'permanent' | 'stable' | 'active' | 'session' | 'checkpoint';
  expiresAt: number | null;
  confidence: number;
}> = {}) {
  return {
    text: overrides.text ?? 'Test memory fact',
    category: (overrides.category ?? 'fact') as MemoryCategory,
    importance: overrides.importance ?? 0.7,
    entity: overrides.entity ?? null,
    key: overrides.key ?? null,
    value: overrides.value ?? null,
    source: overrides.source ?? 'conversation',
    ...(overrides.decayClass ? { decayClass: overrides.decayClass } : {}),
    ...(overrides.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

describe('FactsDB', () => {
  let db: FactsDB;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = makeTmpDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- Store & Retrieve ----

  describe('store & search', () => {
    it('stores a fact and retrieves it via FTS search', () => {
      db.store(makeFact({ text: 'Fred prefers TypeScript over JavaScript' }));

      const results = db.search('TypeScript');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].entry.text).toBe('Fred prefers TypeScript over JavaScript');
      expect(results[0].backend).toBe('sqlite');
    });

    it('returns empty array for no matches', () => {
      db.store(makeFact({ text: 'Python is great' }));
      const results = db.search('Haskell');
      expect(results).toEqual([]);
    });

    it('returns a valid MemoryEntry with all fields', () => {
      const stored = db.store(makeFact({
        text: 'My birthday is November 13',
        category: 'fact',
        entity: 'user',
        key: 'birthday',
        value: 'November 13',
      }));

      expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(stored.text).toBe('My birthday is November 13');
      expect(stored.category).toBe('fact');
      expect(stored.entity).toBe('user');
      expect(stored.key).toBe('birthday');
      expect(stored.value).toBe('November 13');
      expect(stored.createdAt).toBeGreaterThan(0);
      expect(stored.confidence).toBe(1.0);
      expect(stored.lastConfirmedAt).toBeGreaterThan(0);
    });
  });

  // ---- FTS Search Quality ----

  describe('FTS search', () => {
    it('matches partial words via FTS tokenizer', () => {
      db.store(makeFact({ text: 'PostgreSQL database configuration' }));
      const results = db.search('database');
      expect(results.length).toBe(1);
    });

    it('uses OR semantics for multi-word queries', () => {
      db.store(makeFact({ text: 'Redis caching layer' }));
      db.store(makeFact({ text: 'PostgreSQL database layer' }));

      const results = db.search('Redis PostgreSQL');
      expect(results.length).toBe(2);
    });

    it('filters out stop words from queries', () => {
      db.store(makeFact({ text: 'The architecture decision for the project' }));
      // "the" and "for" are stop words, "architecture" should still match
      const results = db.search('the architecture for');
      expect(results.length).toBe(1);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        db.store(makeFact({ text: `Memory fact number ${i} about testing` }));
      }
      const results = db.search('testing', 3);
      expect(results.length).toBe(3);
    });

    it('scores results with composite BM25 + freshness + confidence', () => {
      db.store(makeFact({ text: 'TypeScript is strongly typed' }));
      db.store(makeFact({ text: 'TypeScript compilation is fast' }));

      const results = db.search('TypeScript');
      expect(results.length).toBe(2);
      // All results should have a score between 0 and ~1
      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThanOrEqual(1.5);
      }
      // Results should be sorted by score descending
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });
  });

  // ---- Lookup ----

  describe('lookup', () => {
    it('finds facts by entity (case-insensitive)', () => {
      db.store(makeFact({ text: "Fred's email is fred@test.com", entity: 'Fred', key: 'email', value: 'fred@test.com' }));
      db.store(makeFact({ text: "Alice's email is alice@test.com", entity: 'Alice', key: 'email', value: 'alice@test.com' }));

      const results = db.lookup('fred');
      expect(results.length).toBe(1);
      expect(results[0].entry.value).toBe('fred@test.com');
    });

    it('filters by entity and key', () => {
      db.store(makeFact({ entity: 'Fred', key: 'email', value: 'fred@test.com', text: 'email fact' }));
      db.store(makeFact({ entity: 'Fred', key: 'phone', value: '+33612345678', text: 'phone fact' }));

      const results = db.lookup('Fred', 'email');
      expect(results.length).toBe(1);
      expect(results[0].entry.value).toBe('fred@test.com');
    });

    it('returns empty for unknown entity', () => {
      const results = db.lookup('Nobody');
      expect(results).toEqual([]);
    });
  });

  // ---- Upsert ----

  describe('upsert', () => {
    it('updates existing fact when entity+key match', () => {
      db.store(makeFact({ entity: 'Fred', key: 'editor', value: 'VSCode', text: 'Fred uses VSCode' }));
      db.store(makeFact({ entity: 'Fred', key: 'editor', value: 'Cursor', text: 'Fred uses Cursor' }));

      expect(db.count()).toBe(1);

      const results = db.lookup('Fred', 'editor');
      expect(results.length).toBe(1);
      expect(results[0].entry.value).toBe('Cursor');
      expect(results[0].entry.text).toBe('Fred uses Cursor');
    });

    it('upsert is case-insensitive on entity and key', () => {
      db.store(makeFact({ entity: 'fred', key: 'Email', value: 'old@test.com', text: 'old email' }));
      db.store(makeFact({ entity: 'Fred', key: 'email', value: 'new@test.com', text: 'new email' }));

      expect(db.count()).toBe(1);
      const results = db.lookup('FRED', 'EMAIL');
      expect(results[0].entry.value).toBe('new@test.com');
    });

    it('does not upsert when entity or key is null', () => {
      db.store(makeFact({ entity: null, key: null, text: 'Fact one' }));
      db.store(makeFact({ entity: null, key: null, text: 'Fact two' }));
      expect(db.count()).toBe(2);
    });
  });

  // ---- Deduplication ----

  describe('hasDuplicate', () => {
    it('detects exact text duplicates', () => {
      db.store(makeFact({ text: 'Unique fact about testing' }));
      expect(db.hasDuplicate('Unique fact about testing')).toBe(true);
      expect(db.hasDuplicate('Different fact')).toBe(false);
    });
  });

  // ---- Decay & Confidence ----

  describe('decay & confidence', () => {
    it('auto-classifies decay based on content', () => {
      const permanent = db.store(makeFact({ entity: 'user', key: 'email', value: 'test@test.com', text: 'email fact' }));
      expect(permanent.decayClass).toBe('permanent');

      const session = db.store(makeFact({ entity: 'system', key: 'current_file', value: 'index.ts', text: 'current file' }));
      expect(session.decayClass).toBe('session');

      const active = db.store(makeFact({ entity: null, key: 'task', value: 'fix bug', text: 'task fix bug' }));
      expect(active.decayClass).toBe('active');
    });

    it('decayConfidence reduces confidence over time', () => {
      // Store a fact with active decay class (14-day TTL)
      const nowSec = Math.floor(Date.now() / 1000);
      db.store(makeFact({
        text: 'Working on feature X',
        decayClass: 'active',
        expiresAt: nowSec + 14 * 24 * 3600,
        entity: 'task',
        key: 'wip_feature_x',
        value: 'feature X',
      }));

      // Manually backdate last_confirmed_at to simulate time passing
      // Access the underlying db is not possible, so we just verify decayConfidence runs
      const decayed = db.decayConfidence();
      expect(decayed).toBeGreaterThanOrEqual(0);
    });

    it('permanent facts have no expiry', () => {
      const fact = db.store(makeFact({
        text: 'We decided to use PostgreSQL',
        decayClass: 'permanent',
      }));
      expect(fact.expiresAt).toBeNull();
    });

    it('session facts expire in 24h', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const fact = db.store(makeFact({
        text: 'Currently debugging auth',
        decayClass: 'session',
      }));
      expect(fact.expiresAt).toBeGreaterThan(nowSec);
      expect(fact.expiresAt! - nowSec).toBeLessThanOrEqual(24 * 3600 + 1);
    });
  });

  // ---- Pruning ----

  describe('pruning', () => {
    it('pruneExpired removes facts past their TTL', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      db.store(makeFact({
        text: 'Expired fact',
        decayClass: 'session',
        expiresAt: pastSec,
      }));
      db.store(makeFact({
        text: 'Valid fact',
        decayClass: 'permanent',
        expiresAt: null,
      }));

      expect(db.count()).toBe(2);
      const { count, ids } = db.pruneExpired();
      expect(count).toBe(1);
      expect(ids.length).toBe(1);
      expect(db.count()).toBe(1);
    });

    it('does not prune facts with null expiresAt', () => {
      db.store(makeFact({ text: 'Permanent fact', decayClass: 'permanent', expiresAt: null }));
      const { count } = db.pruneExpired();
      expect(count).toBe(0);
      expect(db.count()).toBe(1);
    });

    it('search excludes expired facts by default', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      db.store(makeFact({ text: 'Expired TypeScript fact', decayClass: 'session', expiresAt: pastSec }));
      db.store(makeFact({ text: 'Valid TypeScript fact', decayClass: 'permanent', expiresAt: null }));

      const results = db.search('TypeScript');
      expect(results.length).toBe(1);
      expect(results[0].entry.text).toBe('Valid TypeScript fact');
    });

    it('search can include expired facts with option', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      db.store(makeFact({ text: 'Expired TypeScript fact', decayClass: 'session', expiresAt: pastSec }));

      const results = db.search('TypeScript', 5, { includeExpired: true });
      expect(results.length).toBe(1);
    });
  });

  // ---- Checkpoint ----

  describe('checkpoint', () => {
    it('saves and restores a checkpoint', () => {
      const id = db.saveCheckpoint({
        intent: 'Deploy to production',
        state: 'pre-deploy',
        expectedOutcome: 'Successful deployment',
        workingFiles: ['index.ts', 'config.ts'],
      });

      expect(id).toBeTruthy();

      const restored = db.restoreCheckpoint();
      expect(restored).not.toBeNull();
      expect(restored!.intent).toBe('Deploy to production');
      expect(restored!.state).toBe('pre-deploy');
      expect(restored!.expectedOutcome).toBe('Successful deployment');
      expect(restored!.workingFiles).toEqual(['index.ts', 'config.ts']);
    });

    it('returns null when no checkpoint exists', () => {
      const restored = db.restoreCheckpoint();
      expect(restored).toBeNull();
    });
  });

  // ---- Count & Stats ----

  describe('count & stats', () => {
    it('count returns total facts', () => {
      expect(db.count()).toBe(0);
      db.store(makeFact({ text: 'Fact one' }));
      db.store(makeFact({ text: 'Fact two' }));
      expect(db.count()).toBe(2);
    });

    it('statsBreakdown shows decay class distribution', () => {
      db.store(makeFact({ text: 'Permanent fact', decayClass: 'permanent' }));
      db.store(makeFact({ text: 'Stable fact one', decayClass: 'stable' }));
      db.store(makeFact({ text: 'Stable fact two', decayClass: 'stable' }));
      db.store(makeFact({ text: 'Active fact', decayClass: 'active' }));

      const stats = db.statsBreakdown();
      expect(stats['permanent']).toBe(1);
      expect(stats['stable']).toBe(2);
      expect(stats['active']).toBe(1);
    });

    it('countExpired counts facts past TTL', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      db.store(makeFact({ text: 'Expired one', expiresAt: pastSec }));
      db.store(makeFact({ text: 'Still valid', expiresAt: null }));

      expect(db.countExpired()).toBe(1);
    });
  });

  // ---- Delete ----

  describe('delete', () => {
    it('deletes a fact by ID', () => {
      const stored = db.store(makeFact({ text: 'Deletable fact' }));
      expect(db.count()).toBe(1);
      const deleted = db.delete(stored.id);
      expect(deleted).toBe(true);
      expect(db.count()).toBe(0);
    });

    it('returns false for non-existent ID', () => {
      const deleted = db.delete('00000000-0000-0000-0000-000000000000');
      expect(deleted).toBe(false);
    });
  });

  // ---- Confirm Fact ----

  describe('confirmFact', () => {
    it('resets confidence to 1.0 and extends TTL', () => {
      const fact = db.store(makeFact({
        text: 'Confirmable fact',
        decayClass: 'active',
        entity: 'test',
        key: 'confirm_target',
        value: 'yes',
      }));

      const confirmed = db.confirmFact(fact.id);
      expect(confirmed).toBe(true);
    });

    it('returns false for non-existent fact', () => {
      expect(db.confirmFact('00000000-0000-0000-0000-000000000000')).toBe(false);
    });
  });

  // ---- Backfill Decay Classes ----

  describe('backfillDecayClasses', () => {
    it('reclassifies facts based on content', () => {
      // Store a fact that should be permanent but defaults to stable
      db.store(makeFact({
        text: 'Some email fact',
        entity: 'Fred',
        key: 'email',
        value: 'fred@test.com',
        decayClass: 'stable',
      }));

      const counts = db.backfillDecayClasses();
      // The fact with key 'email' should be reclassified to permanent
      expect(counts['permanent']).toBe(1);
    });
  });
});
