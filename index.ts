/**
 * OpenClaw Memory Hybrid Plugin
 *
 * Two-tier memory system:
 *   1. SQLite + FTS5 — structured facts, instant full-text search, zero API cost
 *   2. LanceDB — semantic vector search for fuzzy/contextual recall
 *
 * Retrieval merges results from both backends, deduplicates, and prioritizes
 * high-confidence FTS5 matches over approximate vector matches.
 */

import { Type } from '@sinclair/typebox';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ClawdbotPluginApi } from 'openclaw/plugin-sdk';
import { stringEnum } from 'openclaw/plugin-sdk';

import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  DECAY_CLASSES,
  type DecayClass,
  TTL_DEFAULTS,
  type HybridMemoryConfig,
  hybridConfigSchema,
  vectorDimsForModel,
} from './config.js';

// ============================================================================
// Types
// ============================================================================

type MemoryEntry = {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  entity: string | null;
  key: string | null;
  value: string | null;
  source: string;
  createdAt: number;
  decayClass: DecayClass;
  expiresAt: number | null;
  lastConfirmedAt: number;
  confidence: number;
};

type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: 'sqlite' | 'lancedb';
};

// ============================================================================
// SQLite + FTS5 Backend
// ============================================================================

class FactsDB {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Create main table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        importance REAL NOT NULL DEFAULT 0.7,
        entity TEXT,
        key TEXT,
        value TEXT,
        source TEXT NOT NULL DEFAULT 'conversation',
        created_at INTEGER NOT NULL,
        search_tags TEXT DEFAULT ''
      )
    `);

    // Create FTS5 virtual table for full-text search (porter stemming for reformulation)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        text,
        category,
        entity,
        key,
        value,
        search_tags,
        content=facts,
        content_rowid=rowid,
        tokenize='porter unicode61 remove_diacritics 2'
      )
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text, category, entity, key, value, search_tags)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value, new.search_tags);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value, search_tags)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value, old.search_tags);
      END;

      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value, search_tags)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value, old.search_tags);
        INSERT INTO facts_fts(rowid, text, category, entity, key, value, search_tags)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value, new.search_tags);
      END
    `);

    // Index for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
    `);

    // ---- Migrations ----
    this.migrateDecayColumns();
    this.migrateTimestampsToSeconds();
    this.migrateFtsTokenizer();
    this.migrateUpsertIndex();
    this.migrateNullExpiry();
    this.migrateNocaseIndex();
  }

  private migrateDecayColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(facts)`).all() as Array<{
      name: string;
    }>;
    const colNames = new Set(cols.map(c => c.name));

    if (colNames.has('decay_class')) return;

    this.db.exec(`
      ALTER TABLE facts ADD COLUMN decay_class TEXT NOT NULL DEFAULT 'stable';
      ALTER TABLE facts ADD COLUMN expires_at INTEGER;
      ALTER TABLE facts ADD COLUMN last_confirmed_at INTEGER;
      ALTER TABLE facts ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
    `);

    this.db.exec(`
      UPDATE facts SET last_confirmed_at = created_at WHERE last_confirmed_at IS NULL;
    `);
  }

  private migrateTimestampsToSeconds(): void {
    // Convert any millisecond timestamps to seconds
    // Millisecond timestamps are > 1e12 (~year 2001+), second timestamps are < 1e11
    const sample = this.db
      .prepare(`SELECT created_at FROM facts WHERE created_at > 1000000000000 LIMIT 1`)
      .get() as { created_at: number } | undefined;
    if (!sample) return;

    this.db.exec(`
      UPDATE facts SET
        created_at = created_at / 1000,
        last_confirmed_at = CASE
          WHEN last_confirmed_at > 1000000000000 THEN last_confirmed_at / 1000
          ELSE last_confirmed_at
        END
      WHERE created_at > 1000000000000
    `);
  }

  private migrateFtsTokenizer(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`,
    );
    const row = this.db
      .prepare(`SELECT value FROM _meta WHERE key = 'fts_version'`)
      .get() as { value: string } | undefined;
    if (row?.value === '3') return;

    // Add search_tags column if missing
    const cols = this.db.prepare(`PRAGMA table_info(facts)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some(c => c.name === 'search_tags')) {
      this.db.exec(`ALTER TABLE facts ADD COLUMN search_tags TEXT DEFAULT ''`);
    }

    // Drop old FTS table and triggers, recreate with porter stemming + search_tags
    this.db.exec(`
      DROP TRIGGER IF EXISTS facts_ai;
      DROP TRIGGER IF EXISTS facts_ad;
      DROP TRIGGER IF EXISTS facts_au;
      DROP TABLE IF EXISTS facts_fts;

      CREATE VIRTUAL TABLE facts_fts USING fts5(
        text, category, entity, key, value, search_tags,
        content=facts,
        content_rowid=rowid,
        tokenize='porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, text, category, entity, key, value, search_tags)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value, new.search_tags);
      END;

      CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value, search_tags)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value, old.search_tags);
      END;

      CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, text, category, entity, key, value, search_tags)
        VALUES ('delete', old.rowid, old.text, old.category, old.entity, old.key, old.value, old.search_tags);
        INSERT INTO facts_fts(rowid, text, category, entity, key, value, search_tags)
        VALUES (new.rowid, new.text, new.category, new.entity, new.key, new.value, new.search_tags);
      END;

      INSERT INTO facts_fts(facts_fts) VALUES('rebuild');

      INSERT OR REPLACE INTO _meta (key, value) VALUES ('fts_version', '3');
    `);
  }

  private migrateUpsertIndex(): void {
    const indexes = this.db
      .prepare(`PRAGMA index_list(facts)`)
      .all() as Array<{ name: string }>;
    if (indexes.some(i => i.name === 'idx_facts_entity_key_unique')) return;

    // Deduplicate existing (entity, key) pairs (case-insensitive) — keep most recent
    this.db.exec(`
      DELETE FROM facts WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM facts
        WHERE entity IS NOT NULL AND key IS NOT NULL
        GROUP BY entity COLLATE NOCASE, key COLLATE NOCASE
      ) AND entity IS NOT NULL AND key IS NOT NULL
    `);

    this.db.exec(`
      CREATE UNIQUE INDEX idx_facts_entity_key_unique
        ON facts(entity COLLATE NOCASE, key COLLATE NOCASE);
    `);
  }

  store(
    entry: Omit<
      MemoryEntry,
      | 'id'
      | 'createdAt'
      | 'decayClass'
      | 'expiresAt'
      | 'lastConfirmedAt'
      | 'confidence'
    > & {
      decayClass?: DecayClass;
      expiresAt?: number | null;
      confidence?: number;
      searchTags?: string;
    },
  ): MemoryEntry {
    const nowSec = Math.floor(Date.now() / 1000);

    const decayClass =
      entry.decayClass ||
      classifyDecay(entry.entity, entry.key, entry.value, entry.text);
    const expiresAt =
      entry.expiresAt !== undefined
        ? entry.expiresAt
        : calculateExpiry(decayClass, nowSec);
    const confidence = entry.confidence ?? 1.0;
    const searchTags = entry.searchTags || generateSearchTags(entry.text, entry.entity, entry.key, entry.value);

    // UPSERT: if entity+key both set, update existing row
    if (entry.entity && entry.key) {
      const existing = this.db
        .prepare(`SELECT id FROM facts WHERE entity = ? COLLATE NOCASE AND key = ? COLLATE NOCASE`)
        .get(entry.entity, entry.key) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare(
            `UPDATE facts SET text=?, value=?, importance=?, category=?, source=?,
              created_at=?, decay_class=?, expires_at=?, last_confirmed_at=?, confidence=?, search_tags=?
             WHERE id=?`,
          )
          .run(
            entry.text,
            entry.value,
            entry.importance,
            entry.category,
            entry.source,
            nowSec,
            decayClass,
            expiresAt,
            nowSec,
            confidence,
            searchTags,
            existing.id,
          );

        return {
          ...entry,
          id: existing.id,
          createdAt: nowSec,
          decayClass,
          expiresAt,
          lastConfirmedAt: nowSec,
          confidence,
        };
      }
    }

    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO facts (id, text, category, importance, entity, key, value, source, created_at, decay_class, expires_at, last_confirmed_at, confidence, search_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.text,
        entry.category,
        entry.importance,
        entry.entity,
        entry.key,
        entry.value,
        entry.source,
        nowSec,
        decayClass,
        expiresAt,
        nowSec,
        confidence,
        searchTags,
      );

    return {
      ...entry,
      id,
      createdAt: nowSec,
      decayClass,
      expiresAt,
      lastConfirmedAt: nowSec,
      confidence,
    };
  }

  private refreshAccessedFacts(ids: string[]): void {
    if (ids.length === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);

    const stmt = this.db.prepare(`
      UPDATE facts
      SET last_confirmed_at = @now,
          expires_at = CASE decay_class
            WHEN 'stable' THEN @now + @stableTtl
            WHEN 'active' THEN @now + @activeTtl
            ELSE expires_at
          END
      WHERE id = @id
        AND decay_class IN ('stable', 'active')
        AND (expires_at IS NULL OR expires_at > @now)
    `);

    const tx = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run({
          now: nowSec,
          stableTtl: TTL_DEFAULTS.stable,
          activeTtl: TTL_DEFAULTS.active,
          id,
        });
      }
    });
    tx();
  }

  search(
    query: string,
    limit = 5,
    options: { includeExpired?: boolean } = {},
  ): SearchResult[] {
    const { includeExpired = false } = options;

    const words = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9\u00C0-\u024F_-]/g, '')) // strip FTS5 special chars
      .filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

    // Use prefix matching (word*) for words ≥ 3 chars to catch inflections,
    // plus exact match ("word") as fallback for short words
    const safeQuery = words
      .map(w => w.length >= 3 ? `${w}*` : `"${w}"`)
      .join(' OR ');

    if (!safeQuery) return [];

    const nowSec = Math.floor(Date.now() / 1000);
    const expiryFilter = includeExpired
      ? ''
      : 'AND (f.expires_at IS NULL OR f.expires_at > @now)';

    const rows = this.db
      .prepare(
        `SELECT f.*, rank,
           CASE
             WHEN f.expires_at IS NULL THEN 1.0
             WHEN f.expires_at <= @now THEN 0.0
             ELSE MIN(1.0, CAST(f.expires_at - @now AS REAL) / CAST(@decay_window AS REAL))
           END AS freshness
         FROM facts f
         JOIN facts_fts fts ON f.rowid = fts.rowid
         WHERE facts_fts MATCH @query
           ${expiryFilter}
         ORDER BY rank
         LIMIT @limit`,
      )
      .all({
        query: safeQuery,
        now: nowSec,
        limit: limit * 2,
        decay_window: 7 * 24 * 3600,
      }) as Array<Record<string, unknown>>;

    if (rows.length === 0) return [];

    const minRank = Math.min(...rows.map(r => r.rank as number));
    const maxRank = Math.max(...rows.map(r => r.rank as number));
    const range = maxRank - minRank || 1;

    const results = rows.map(row => {
      const rawBm25 = 1 - ((row.rank as number) - minRank) / range;
      const bm25Score = Number.isFinite(rawBm25) ? rawBm25 : 0.8;
      const freshness = (row.freshness as number) || 1.0;
      const confidence = (row.confidence as number) || 1.0;
      const composite = bm25Score * 0.6 + freshness * 0.25 + confidence * 0.15;

      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          category: row.category as MemoryCategory,
          importance: row.importance as number,
          entity: (row.entity as string) || null,
          key: (row.key as string) || null,
          value: (row.value as string) || null,
          source: row.source as string,
          createdAt: row.created_at as number,
          decayClass: (row.decay_class as DecayClass) || 'stable',
          expiresAt: (row.expires_at as number) || null,
          lastConfirmedAt: (row.last_confirmed_at as number) || 0,
          confidence,
        },
        score: composite,
        backend: 'sqlite' as const,
      };
    });

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    this.refreshAccessedFacts(topResults.map(r => r.entry.id));

    return topResults;
  }

  lookup(entity: string, key?: string): SearchResult[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const base = key
      ? `SELECT * FROM facts WHERE entity = ? COLLATE NOCASE AND key = ? COLLATE NOCASE AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, created_at DESC`
      : `SELECT * FROM facts WHERE entity = ? COLLATE NOCASE AND (expires_at IS NULL OR expires_at > ?) ORDER BY confidence DESC, created_at DESC`;

    const params = key ? [entity, key, nowSec] : [entity, nowSec];
    const rows = this.db.prepare(base).all(...params) as Array<
      Record<string, unknown>
    >;

    const results = rows.map(row => ({
      entry: {
        id: row.id as string,
        text: row.text as string,
        category: row.category as MemoryCategory,
        importance: row.importance as number,
        entity: (row.entity as string) || null,
        key: (row.key as string) || null,
        value: (row.value as string) || null,
        source: row.source as string,
        createdAt: row.created_at as number,
        decayClass: (row.decay_class as DecayClass) || 'stable',
        expiresAt: (row.expires_at as number) || null,
        lastConfirmedAt: (row.last_confirmed_at as number) || 0,
        confidence: (row.confidence as number) || 1.0,
      },
      score: (row.confidence as number) || 1.0,
      backend: 'sqlite' as const,
    }));

    this.refreshAccessedFacts(results.map(r => r.entry.id));

    return results;
  }

  delete(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  hasDuplicate(text: string): boolean {
    const row = this.db
      .prepare(`SELECT id FROM facts WHERE text = ? LIMIT 1`)
      .get(text);
    return !!row;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM facts`)
      .get() as Record<string, number>;
    return row.cnt;
  }

  pruneExpired(): { count: number; ids: string[] } {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = this.db
      .prepare(
        `SELECT id FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`,
      )
      .all(nowSec) as Array<{ id: string }>;
    if (rows.length === 0) return { count: 0, ids: [] };
    const ids = rows.map(r => r.id);
    const result = this.db
      .prepare(
        `DELETE FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`,
      )
      .run(nowSec);
    return { count: result.changes, ids };
  }

  decayConfidence(): number {
    const nowSec = Math.floor(Date.now() / 1000);

    // Time-based confidence: linearly decays from 1.0 to 0.0 over the
    // period between last_confirmed_at and expires_at.
    // Accessing a memory (refreshAccessedFacts) resets last_confirmed_at
    // and extends expires_at, which restores confidence — like human recall
    // strengthening a memory.
    // No deletion here — only pruneExpired removes facts at their hard TTL.
    const result = this.db
      .prepare(
        `UPDATE facts
         SET confidence = MAX(0.05, 1.0 - CAST(@now - last_confirmed_at AS REAL)
                           / CAST(expires_at - last_confirmed_at AS REAL))
         WHERE expires_at IS NOT NULL
           AND expires_at > @now
           AND last_confirmed_at IS NOT NULL
           AND (expires_at - last_confirmed_at) > 0`,
      )
      .run({ now: nowSec });

    return result.changes;
  }

  confirmFact(id: string): boolean {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(`SELECT decay_class FROM facts WHERE id = ?`)
      .get(id) as { decay_class: DecayClass } | undefined;
    if (!row) return false;

    const newExpiry = calculateExpiry(row.decay_class, nowSec);
    this.db
      .prepare(
        `UPDATE facts SET confidence = 1.0, last_confirmed_at = ?, expires_at = ? WHERE id = ?`,
      )
      .run(nowSec, newExpiry, id);
    return true;
  }

  saveCheckpoint(context: {
    intent: string;
    state: string;
    expectedOutcome?: string;
    workingFiles?: string[];
  }): string {
    const data = JSON.stringify({
      ...context,
      savedAt: new Date().toISOString(),
    });

    return this.store({
      text: data,
      category: 'other' as MemoryCategory,
      importance: 0.9,
      entity: 'system',
      key: `checkpoint:${Math.floor(Date.now() / 1000)}`,
      value: context.intent.slice(0, 100),
      source: 'checkpoint',
      decayClass: 'checkpoint',
    }).id;
  }

  restoreCheckpoint(): {
    id: string;
    intent: string;
    state: string;
    expectedOutcome?: string;
    workingFiles?: string[];
    savedAt: string;
  } | null {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT id, text FROM facts
         WHERE entity = 'system' AND key LIKE 'checkpoint:%'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(nowSec) as { id: string; text: string } | undefined;

    if (!row) return null;
    try {
      return { id: row.id, ...JSON.parse(row.text) };
    } catch {
      return null;
    }
  }

  statsBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT decay_class, COUNT(*) as cnt FROM facts GROUP BY decay_class`,
      )
      .all() as Array<{ decay_class: string; cnt: number }>;

    const stats: Record<string, number> = {};
    for (const row of rows) {
      stats[row.decay_class || 'unknown'] = row.cnt;
    }
    return stats;
  }

  countExpired(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM facts WHERE expires_at IS NOT NULL AND expires_at < ?`,
      )
      .get(nowSec) as { cnt: number };
    return row.cnt;
  }

  backfillDecayClasses(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT rowid, entity, key, value, text, decay_class, expires_at FROM facts
         WHERE decay_class = 'stable'
            OR (expires_at IS NULL AND decay_class != 'permanent')`,
      )
      .all() as Array<{
      rowid: number;
      entity: string;
      key: string;
      value: string;
      text: string;
      decay_class: string;
      expires_at: number | null;
    }>;

    const nowSec = Math.floor(Date.now() / 1000);
    const update = this.db.prepare(
      `UPDATE facts SET decay_class = ?, expires_at = ? WHERE rowid = ?`,
    );

    const counts: Record<string, number> = {};
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const dc = classifyDecay(row.entity, row.key, row.value, row.text);
        const exp = calculateExpiry(dc, nowSec);
        if (dc === row.decay_class && row.expires_at !== null) continue;
        update.run(dc, exp, row.rowid);
        counts[dc] = (counts[dc] || 0) + 1;
      }
    });
    tx();
    return counts;
  }

  private migrateNullExpiry(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [dc, ttl] of Object.entries(TTL_DEFAULTS)) {
      if (ttl === null) continue;
      this.db
        .prepare(
          `UPDATE facts SET expires_at = ? WHERE decay_class = ? AND expires_at IS NULL`,
        )
        .run(nowSec + ttl, dc);
    }
  }

  private migrateNocaseIndex(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)`,
    );
    const row = this.db
      .prepare(`SELECT value FROM _meta WHERE key = 'nocase_index'`)
      .get() as { value: string } | undefined;
    if (row?.value === '1') return;

    // Deduplicate case-insensitive before recreating the index
    this.db.exec(`
      DELETE FROM facts WHERE rowid NOT IN (
        SELECT MAX(rowid) FROM facts
        WHERE entity IS NOT NULL AND key IS NOT NULL
        GROUP BY entity COLLATE NOCASE, key COLLATE NOCASE
      ) AND entity IS NOT NULL AND key IS NOT NULL
    `);

    this.db.exec(`
      DROP INDEX IF EXISTS idx_facts_entity_key_unique;
      CREATE UNIQUE INDEX idx_facts_entity_key_unique
        ON facts(entity COLLATE NOCASE, key COLLATE NOCASE);
      DROP INDEX IF EXISTS idx_facts_entity;
      CREATE INDEX idx_facts_entity ON facts(entity COLLATE NOCASE);
      INSERT OR REPLACE INTO _meta (key, value) VALUES ('nocase_index', '1');
    `);
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================================
// LanceDB Backend
// ============================================================================

const LANCE_TABLE = 'memories';

class VectorDB {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(LANCE_TABLE)) {
      this.table = await this.db.openTable(LANCE_TABLE);
    } else {
      this.table = await this.db.createTable(LANCE_TABLE, [
        {
          id: '__schema__',
          text: '',
          vector: new Array(this.vectorDim).fill(0),
          importance: 0,
          category: 'other',
          createdAt: 0,
        },
      ]);
      await this.table.delete('id = "__schema__"');
    }
  }

  async store(entry: {
    id?: string;
    text: string;
    vector: number[];
    importance: number;
    category: string;
  }): Promise<string> {
    await this.ensureInitialized();
    const id = entry.id || randomUUID();
    // Delete existing entry with same ID to support upserts
    if (entry.id) {
      try {
        await this.table!.delete(`id = '${id}'`);
      } catch {}
    }
    const nowSec = Math.floor(Date.now() / 1000);
    await this.table!.add([{ ...entry, id, createdAt: nowSec }]);
    return id;
  }

  async search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const results = await this.table!.vectorSearch(vector)
      .limit(limit)
      .toArray();

    return results
      .map(row => {
        const distance = row._distance ?? 0;
        const score = 1 / (1 + distance);
        return {
          entry: {
            id: row.id as string,
            text: row.text as string,
            category: row.category as MemoryCategory,
            importance: row.importance as number,
            entity: null,
            key: null,
            value: null,
            source: 'conversation',
            createdAt: row.createdAt as number,
            decayClass: 'stable' as DecayClass,
            expiresAt: null,
            lastConfirmedAt: row.createdAt as number,
            confidence: 1.0,
          },
          score,
          backend: 'lancedb' as const,
        };
      })
      .filter(r => r.score >= minScore);
  }

  async hasDuplicate(vector: number[], threshold = 0.95): Promise<boolean> {
    await this.ensureInitialized();
    const results = await this.table!.vectorSearch(vector).limit(1).toArray();
    if (results.length === 0) return false;
    const score = 1 / (1 + (results[0]._distance ?? 0));
    return score >= threshold;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInitialized();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) throw new Error(`Invalid ID: ${id}`);
    await this.table!.delete(`id = '${id}'`);
    return true;
  }

  async deleteMany(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.ensureInitialized();
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let deleted = 0;
    for (const id of ids) {
      if (!uuidRegex.test(id)) continue;
      try {
        await this.table!.delete(`id = '${id}'`);
        deleted++;
      } catch {}
    }
    return deleted;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }
}

// ============================================================================
// Embeddings
// ============================================================================

class Embeddings {
  private client: OpenAI;
  constructor(
    apiKey: string,
    private model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(text: string): Promise<number[]> {
    const resp = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });
    return resp.data[0].embedding;
  }
}

// ============================================================================
// Stop Words
// ============================================================================

const STOP_WORDS = new Set([
  // EN
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for', 'not',
  'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by',
  'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my', 'one',
  'all', 'would', 'there', 'their', 'what', 'so', 'up', 'out', 'if', 'about',
  'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'no', 'just',
  'him', 'know', 'take', 'how', 'could', 'them', 'see', 'than', 'now', 'come',
  'its', 'over', 'also', 'after', 'did', 'should', 'any', 'where', 'then',
  'here', 'been', 'has', 'had', 'was', 'were', 'are', 'is', 'am', 'does',
  'yes', 'yeah', 'no', 'ok', 'okay', 'sure', 'please', 'thanks', 'thank',
  'hello', 'hi', 'hey',
  // FR
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'en', 'que',
  'qui', 'dans', 'ce', 'il', 'ne', 'se', 'pas', 'plus', 'par', 'sur', 'est',
  'sont', 'au', 'aux', 'ou', 'mais', 'son', 'sa', 'ses', 'avec', 'pour',
  'nous', 'vous', 'ils', 'elles', 'je', 'tu', 'on', 'elle', 'lui', 'leur',
  'été', 'être', 'avoir', 'fait', 'comme', 'tout', 'bien', 'oui', 'non',
  'merci', 'bonjour', 'salut',
]);

// ============================================================================
// Merge & Deduplicate
// ============================================================================

function mergeResults(
  sqliteResults: SearchResult[],
  lanceResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const r of sqliteResults) {
    if (!seen.has(r.entry.id)) {
      seen.add(r.entry.id);
      merged.push(r);
    }
  }

  for (const r of lanceResults) {
    const isDupe = merged.some(
      m =>
        m.entry.id === r.entry.id ||
        m.entry.text.toLowerCase() === r.entry.text.toLowerCase(),
    );
    if (!isDupe) {
      merged.push(r);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

// ============================================================================
// Search Tag Generation (synonyms & aliases for reformulation)
// ============================================================================

/** Static synonym map — common reformulations that FTS stemming alone can't handle. */
const SYNONYM_MAP: Record<string, string[]> = {
  // Databases
  postgresql: ['database', 'db', 'sql', 'postgres', 'rdbms'],
  mysql: ['database', 'db', 'sql', 'rdbms'],
  sqlite: ['database', 'db', 'sql', 'rdbms'],
  mongodb: ['database', 'db', 'nosql', 'document store'],
  redis: ['cache', 'caching', 'key-value', 'in-memory'],

  // CI/CD
  'github actions': ['ci', 'cd', 'cicd', 'continuous integration', 'continuous delivery', 'pipeline'],
  'gitlab ci': ['ci', 'cd', 'cicd', 'continuous integration', 'pipeline'],
  jenkins: ['ci', 'cd', 'cicd', 'continuous integration', 'pipeline'],

  // Frontend
  react: ['frontend', 'ui', 'spa', 'component', 'jsx'],
  'next.js': ['frontend', 'ssr', 'react framework', 'fullstack'],
  vue: ['frontend', 'ui', 'spa', 'component'],
  tailwind: ['css', 'styling', 'design', 'css framework'],
  bootstrap: ['css', 'styling', 'design', 'css framework'],

  // Backend
  fastapi: ['backend', 'api', 'python', 'rest'],
  express: ['backend', 'api', 'node', 'rest'],

  // Build tools
  turborepo: ['monorepo', 'build', 'workspace'],
  bun: ['runtime', 'package manager', 'bundler'],
  node: ['runtime', 'javascript', 'backend'],

  // Code style
  tabs: ['indentation', 'formatting', 'code style', 'whitespace'],
  spaces: ['indentation', 'formatting', 'code style', 'whitespace'],
  'snake_case': ['naming', 'convention', 'code style', 'formatting'],
  camelcase: ['naming', 'convention', 'code style', 'formatting'],

  // Editor
  vim: ['editor', 'keybindings', 'neovim'],
  vscode: ['editor', 'ide'],
  cursor: ['editor', 'ide', 'ai editor'],

  // Misc
  typescript: ['language', 'typed', 'javascript', 'js', 'ts'],
  javascript: ['language', 'js', 'scripting'],
  mit: ['license', 'open source', 'oss'],
  docker: ['container', 'containerization', 'deployment'],
};

function generateSearchTags(
  text: string,
  entity: string | null,
  key: string | null,
  value: string | null,
): string {
  const tags = new Set<string>();
  const combined = [text, entity, key, value].filter(Boolean).join(' ').toLowerCase();

  for (const [term, synonyms] of Object.entries(SYNONYM_MAP)) {
    if (combined.includes(term.toLowerCase())) {
      for (const syn of synonyms) {
        tags.add(syn);
      }
    }
  }

  return [...tags].join(' ');
}

// ============================================================================
// Decay Classification & TTL
// ============================================================================

function calculateExpiry(
  decayClass: DecayClass,
  fromTimestamp = Math.floor(Date.now() / 1000),
): number | null {
  const ttl = TTL_DEFAULTS[decayClass];
  return ttl ? fromTimestamp + ttl : null;
}

function classifyDecay(
  entity: string | null,
  key: string | null,
  value: string | null,
  text: string,
): DecayClass {
  const keyLower = (key || '').toLowerCase();
  const textLower = text.toLowerCase();

  const permanentKeys = [
    'name',
    'email',
    'api_key',
    'api_endpoint',
    'architecture',
    'decision',
    'birthday',
    'born',
    'phone',
    'language',
    'location',
  ];
  if (permanentKeys.some(k => keyLower.includes(k))) return 'permanent';
  if (/\b(decided|architecture|always use|never use)\b/i.test(textLower))
    return 'permanent';

  if (entity === 'decision' || entity === 'convention') return 'permanent';

  const sessionKeys = ['current_file', 'temp', 'debug', 'working_on_right_now'];
  if (sessionKeys.some(k => keyLower.includes(k))) return 'session';
  if (/\b(currently debugging|right now|this session)\b/i.test(textLower))
    return 'session';

  const activeKeys = ['task', 'todo', 'wip', 'branch', 'sprint', 'blocker'];
  if (activeKeys.some(k => keyLower.includes(k))) return 'active';
  if (/\b(working on|need to|todo|blocker|sprint)\b/i.test(textLower))
    return 'active';

  if (keyLower.includes('checkpoint') || keyLower.includes('preflight'))
    return 'checkpoint';

  return 'stable';
}

// ============================================================================
// Structured Fact Extraction
// ============================================================================

function extractStructuredFields(
  text: string,
  category: MemoryCategory,
): { entity: string | null; key: string | null; value: string | null } {
  const lower = text.toLowerCase();

  const decisionMatch = text.match(
    /(?:decided|chose|picked|went with|selected|choosing)\s+(?:to\s+)?(?:use\s+)?(.+?)(?:\s+(?:because|since|for|due to|over)\s+(.+?))?\.?$/i,
  );
  if (decisionMatch) {
    return {
      entity: 'decision',
      key: decisionMatch[1].trim().slice(0, 100),
      value: decisionMatch[2]?.trim() || 'no rationale recorded',
    };
  }

  const choiceMatch = text.match(
    /(?:use|using|chose|prefer|picked)\s+(.+?)\s+(?:over|instead of|rather than)\s+(.+?)(?:\s+(?:because|since|for|due to)\s+(.+?))?\.?$/i,
  );
  if (choiceMatch) {
    return {
      entity: 'decision',
      key: `${choiceMatch[1].trim()} over ${choiceMatch[2].trim()}`,
      value: choiceMatch[3]?.trim() || 'preference',
    };
  }

  const ruleMatch = text.match(
    /(?:always|never|must|should always|should never)\s+(.+?)\.?$/i,
  );
  if (ruleMatch) {
    return {
      entity: 'convention',
      key: ruleMatch[1].trim().slice(0, 100),
      value: lower.includes('never') ? 'never' : 'always',
    };
  }

  const possessiveMatch = text.match(
    /(?:(\w+(?:\s+\w+)?)'s|[Mm]y)\s+(.+?)\s+(?:is|are|was)\s+(.+?)\.?$/,
  );
  if (possessiveMatch) {
    return {
      entity: possessiveMatch[1] || 'user',
      key: possessiveMatch[2].trim(),
      value: possessiveMatch[3].trim(),
    };
  }

  const preferMatch = text.match(
    /[Ii]\s+(prefer|like|love|hate|want|need|use)\s+(.+?)\.?$/,
  );
  if (preferMatch) {
    return {
      entity: 'user',
      key: preferMatch[1],
      value: preferMatch[2].trim(),
    };
  }

  // FR: decisions
  const frDecisionMatch = text.match(
    /(?:on a décidé|on a choisi|on utilise|on prend)\s+(.+?)(?:\s+(?:parce que|car|pour)\s+(.+?))?\.?$/i,
  );
  if (frDecisionMatch) {
    return {
      entity: 'decision',
      key: frDecisionMatch[1].trim().slice(0, 100),
      value: frDecisionMatch[2]?.trim() || 'pas de justification',
    };
  }

  // FR: conventions
  const frRuleMatch = text.match(
    /(?:toujours|jamais)\s+(?:utiliser|faire|mettre)\s+(.+?)\.?$/i,
  );
  if (frRuleMatch) {
    return {
      entity: 'convention',
      key: frRuleMatch[1].trim().slice(0, 100),
      value: lower.includes('jamais') ? 'never' : 'always',
    };
  }

  // FR: possessive
  const frPossessiveMatch = text.match(
    /(?:mon|ma|mes|son|sa|ses)\s+(.+?)\s+(?:est|c'est|sont)\s+(.+?)\.?$/i,
  );
  if (frPossessiveMatch) {
    return {
      entity: 'user',
      key: frPossessiveMatch[1].trim(),
      value: frPossessiveMatch[2].trim(),
    };
  }

  // FR: preferences
  const frPreferMatch = text.match(
    /je\s+(?:préfère|préfere|aime|déteste|veux|utilise)\s+(.+?)\.?$/i,
  );
  if (frPreferMatch) {
    return {
      entity: 'user',
      key: 'prefer',
      value: frPreferMatch[1].trim(),
    };
  }

  const emailMatch = text.match(/([\w.-]+@[\w.-]+\.\w+)/);
  if (emailMatch) {
    return { entity: null, key: 'email', value: emailMatch[1] };
  }

  const phoneMatch = text.match(/(\+?\d{10,})/);
  if (phoneMatch) {
    return { entity: null, key: 'phone', value: phoneMatch[1] };
  }

  if (category === 'entity') {
    const words = text.split(/\s+/);
    const properNouns = words.filter(w => /^[A-Z][a-z]+/.test(w));
    if (properNouns.length > 0) {
      return { entity: properNouns[0], key: null, value: null };
    }
  }

  return { entity: null, key: null, value: null };
}

// ============================================================================
// Auto-capture Filters
// ============================================================================

const MEMORY_TRIGGERS = [
  /remember|zapamatuj si|pamatuj/i,
  /prefer|radši|nechci/i,
  /decided|rozhodli jsme|budeme používat/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need)/i,
  /always|never|important/i,
  /born on|birthday|lives in|works at/i,
  /password is|api key|token is/i,
  /chose|selected|went with|picked/i,
  /over.*because|instead of.*since/i,
  /\balways\b.*\buse\b|\bnever\b.*\buse\b/i,
  /architecture|stack|approach/i,
  // FR
  /retiens|souviens-toi|n'oublie pas|rappelle-toi/i,
  /je préfère|j'aime|je déteste|je veux|je ne veux pas/i,
  /on a décidé|on utilise|on choisit|on a choisi/i,
  /mon\s+\w+\s+(?:est|c'est)|ma\s+\w+\s+(?:est|c'est)/i,
  /toujours\s+utiliser|jamais\s+utiliser/i,
  /habite à|travaille chez|né le|née le/i,
];

const SENSITIVE_PATTERNS = [
  /password/i,
  /api.?key/i,
  /secret/i,
  /token\s+is/i,
  /\bssn\b/i,
  /credit.?card/i,
];

function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes('<relevant-memories>')) return false;
  if (text.startsWith('<') && text.includes('</')) return false;
  if (/^\*\*[^*]+\*\*\n-/.test(text)) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (SENSITIVE_PATTERNS.some(r => r.test(text))) return false;
  return MEMORY_TRIGGERS.some(r => r.test(text));
}

function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (
    /decided|chose|went with|selected|always use|never use|over.*because|instead of.*since|rozhodli|will use|budeme|on a décidé|on a choisi|on utilise|toujours utiliser|jamais utiliser/i.test(
      lower,
    )
  )
    return 'decision';
  if (/prefer|radši|like|love|hate|want|je préfère|j'aime|je déteste|je veux/i.test(lower))
    return 'preference';
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|s'appelle/i.test(lower))
    return 'entity';
  if (/born|birthday|lives|works|is\s|are\s|has\s|have\s|habite à|travaille chez|née? le/i.test(lower))
    return 'fact';
  return 'other';
}

// ============================================================================
// Markdown File Extraction
// ============================================================================

function extractFromMarkdownFile(
  filePath: string,
  source: string,
  factsDb: FactsDB,
): number {
  if (!existsSync(filePath)) return 0;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content
    .split('\n')
    .filter(l => l.trim().length > 10);

  let stored = 0;
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#>\s]+/, '').trim();
    if (trimmed.length < 15 || trimmed.length > 500) continue;
    if (SENSITIVE_PATTERNS.some(r => r.test(trimmed))) continue;

    const category = detectCategory(trimmed);
    const extracted = extractStructuredFields(trimmed, category);

    if (!extracted.entity && !extracted.key && category !== 'decision')
      continue;

    if (factsDb.hasDuplicate(trimmed)) continue;

    factsDb.store({
      text: trimmed,
      category,
      importance: 0.8,
      entity: extracted.entity,
      key: extracted.key,
      value: extracted.value,
      source,
    });
    stored++;
  }
  return stored;
}

function scanMemoryFiles(factsDb: FactsDB, daysBack = 3): number {
  const memoryDir = join(homedir(), '.openclaw', 'memory');
  let total = 0;

  // Scan MEMORY.md
  total += extractFromMarkdownFile(
    join(homedir(), '.openclaw', 'workspace', 'MEMORY.md'),
    'markdown:MEMORY.md',
    factsDb,
  );

  // Scan daily files
  for (let d = 0; d < daysBack; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    total += extractFromMarkdownFile(
      join(memoryDir, `${dateStr}.md`),
      `daily-scan:${dateStr}`,
      factsDb,
    );
  }
  return total;
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryHybridPlugin = {
  id: 'total-reclaw',
  name: 'Total Reclaw',
  description:
    'Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search',
  kind: 'memory' as const,
  configSchema: hybridConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = hybridConfigSchema.parse(api.pluginConfig);
    const resolvedLancePath = api.resolvePath(cfg.lanceDbPath);
    const resolvedSqlitePath = api.resolvePath(cfg.sqlitePath);
    const vectorDim = vectorDimsForModel(cfg.embedding.model);

    const factsDb = new FactsDB(resolvedSqlitePath);
    const vectorDb = new VectorDB(resolvedLancePath, vectorDim);
    const embeddings = new Embeddings(
      cfg.embedding.apiKey,
      cfg.embedding.model,
    );

    let pruneTimer: ReturnType<typeof setInterval> | null = null;

    api.logger.info(
      `total-reclaw: registered (sqlite: ${resolvedSqlitePath}, lance: ${resolvedLancePath})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: 'memory_recall',
        label: 'Memory Recall',
        description:
          'Search through long-term memories using both structured (exact) and semantic (fuzzy) search.',
        parameters: Type.Object({
          query: Type.String({ description: 'Search query' }),
          limit: Type.Optional(
            Type.Number({ description: 'Max results (default: 5)' }),
          ),
          entity: Type.Optional(
            Type.String({
              description: 'Optional: filter by entity name for exact lookup',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            query,
            limit = 5,
            entity,
          } = params as { query: string; limit?: number; entity?: string };

          let sqliteResults: SearchResult[] = [];
          if (entity) {
            sqliteResults = factsDb.lookup(entity);
          }

          const ftsResults = factsDb.search(query, limit);
          sqliteResults = [...sqliteResults, ...ftsResults];

          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(query);
            lanceResults = await vectorDb.search(vector, limit, 0.3);
          } catch (err) {
            api.logger.warn(`total-reclaw: vector search failed: ${err}`);
          }

          const results = mergeResults(sqliteResults, lanceResults, limit);

          if (results.length === 0) {
            return {
              content: [{ type: 'text', text: 'No relevant memories found.' }],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. [${r.backend}/${r.entry.category}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%)`,
            )
            .join('\n');

          const sanitized = results.map(r => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            entity: r.entry.entity,
            importance: r.entry.importance,
            score: r.score,
            backend: r.backend,
          }));

          return {
            content: [
              {
                type: 'text',
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: { count: results.length, memories: sanitized },
          };
        },
      },
      { name: 'memory_recall' },
    );

    api.registerTool(
      {
        name: 'memory_store',
        label: 'Memory Store',
        description:
          'Save important information in long-term memory. Stores to both structured (SQLite) and semantic (LanceDB) backends.',
        parameters: Type.Object({
          text: Type.String({ description: 'Information to remember' }),
          importance: Type.Optional(
            Type.Number({ description: 'Importance 0-1 (default: 0.7)' }),
          ),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
          entity: Type.Optional(
            Type.String({
              description: 'Entity name (person, project, tool, etc.)',
            }),
          ),
          key: Type.Optional(
            Type.String({
              description: "Structured key (e.g. 'birthday', 'email')",
            }),
          ),
          value: Type.Optional(
            Type.String({
              description:
                "Structured value (e.g. 'Nov 13', 'john@example.com')",
            }),
          ),
          decayClass: Type.Optional(
            stringEnum([...DECAY_CLASSES]),
          ),
        }),
        async execute(_toolCallId, params) {
          const {
            text,
            importance = 0.7,
            category = 'other',
            entity: paramEntity,
            key: paramKey,
            value: paramValue,
            decayClass: paramDecayClass,
          } = params as {
            text: string;
            importance?: number;
            category?: MemoryCategory;
            entity?: string;
            key?: string;
            value?: string;
            decayClass?: DecayClass;
          };

          if (factsDb.hasDuplicate(text)) {
            return {
              content: [
                { type: 'text', text: `Similar memory already exists.` },
              ],
              details: { action: 'duplicate' },
            };
          }

          const extracted = extractStructuredFields(
            text,
            category as MemoryCategory,
          );
          const entity = paramEntity || extracted.entity;
          const key = paramKey || extracted.key;
          const value = paramValue || extracted.value;

          const entry = factsDb.store({
            text,
            category: category as MemoryCategory,
            importance,
            entity,
            key,
            value,
            source: 'conversation',
            decayClass: paramDecayClass,
          });

          try {
            const vector = await embeddings.embed(text);
            if (!(await vectorDb.hasDuplicate(vector))) {
              await vectorDb.store({
                id: entry.id,
                text,
                vector,
                importance,
                category,
              });
            }
          } catch (err) {
            api.logger.warn(`total-reclaw: vector store failed: ${err}`);
          }

          return {
            content: [
              {
                type: 'text',
                text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"${entity ? ` [entity: ${entity}]` : ''} [decay: ${entry.decayClass}]`,
              },
            ],
            details: {
              action: 'created',
              id: entry.id,
              backend: 'both',
              decayClass: entry.decayClass,
            },
          };
        },
      },
      { name: 'memory_store' },
    );

    api.registerTool(
      {
        name: 'memory_forget',
        label: 'Memory Forget',
        description: 'Delete specific memories from both backends.',
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({ description: 'Search to find memory' }),
          ),
          memoryId: Type.Optional(
            Type.String({ description: 'Specific memory ID' }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          if (memoryId) {
            const sqlDeleted = factsDb.delete(memoryId);
            let lanceDeleted = false;
            try {
              lanceDeleted = await vectorDb.delete(memoryId);
            } catch {}

            return {
              content: [
                {
                  type: 'text',
                  text: `Memory ${memoryId} forgotten (sqlite: ${sqlDeleted}, lance: ${lanceDeleted}).`,
                },
              ],
              details: { action: 'deleted', id: memoryId },
            };
          }

          if (query) {
            const sqlResults = factsDb.search(query, 5);
            let lanceResults: SearchResult[] = [];
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, 5, 0.7);
            } catch {}

            const results = mergeResults(sqlResults, lanceResults, 5);

            if (results.length === 0) {
              return {
                content: [
                  { type: 'text', text: 'No matching memories found.' },
                ],
                details: { found: 0 },
              };
            }

            const list = results
              .map(
                r =>
                  `- [${r.entry.id.slice(0, 8)}] (${r.backend}) ${r.entry.text.slice(0, 60)}...`,
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Found ${results.length} candidates. Specify memoryId:\n${list}`,
                },
              ],
              details: {
                action: 'candidates',
                candidates: results.map(r => ({
                  id: r.entry.id,
                  text: r.entry.text,
                  backend: r.backend,
                  score: r.score,
                })),
              },
            };
          }

          return {
            content: [{ type: 'text', text: 'Provide query or memoryId.' }],
            details: { error: 'missing_param' },
          };
        },
      },
      { name: 'memory_forget' },
    );

    api.registerTool(
      {
        name: 'memory_checkpoint',
        label: 'Memory Checkpoint',
        description:
          'Save or restore pre-flight checkpoints before risky/long operations. Auto-expires after 4 hours.',
        parameters: Type.Object({
          action: stringEnum(['save', 'restore'] as const),
          intent: Type.Optional(
            Type.String({ description: "What you're about to do (for save)" }),
          ),
          state: Type.Optional(
            Type.String({ description: 'Current state/context (for save)' }),
          ),
          expectedOutcome: Type.Optional(
            Type.String({ description: 'What should happen if successful' }),
          ),
          workingFiles: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Files being modified',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { action, intent, state, expectedOutcome, workingFiles } =
            params as {
              action: 'save' | 'restore';
              intent?: string;
              state?: string;
              expectedOutcome?: string;
              workingFiles?: string[];
            };

          if (action === 'save') {
            if (!intent || !state) {
              return {
                content: [
                  {
                    type: 'text',
                    text: "Checkpoint save requires 'intent' and 'state'.",
                  },
                ],
                details: { error: 'missing_param' },
              };
            }
            const id = factsDb.saveCheckpoint({
              intent,
              state,
              expectedOutcome,
              workingFiles,
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `Checkpoint saved (id: ${id.slice(0, 8)}..., TTL: 4h). Intent: ${intent.slice(0, 80)}`,
                },
              ],
              details: { action: 'saved', id },
            };
          }

          const checkpoint = factsDb.restoreCheckpoint();
          if (!checkpoint) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No active checkpoint found (may have expired).',
                },
              ],
              details: { action: 'not_found' },
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: `Restored checkpoint (saved: ${checkpoint.savedAt}):\n- Intent: ${checkpoint.intent}\n- State: ${checkpoint.state}${checkpoint.expectedOutcome ? `\n- Expected: ${checkpoint.expectedOutcome}` : ''}${checkpoint.workingFiles?.length ? `\n- Files: ${checkpoint.workingFiles.join(', ')}` : ''}`,
              },
            ],
            details: { action: 'restored', checkpoint },
          };
        },
      },
      { name: 'memory_checkpoint' },
    );

    api.registerTool(
      {
        name: 'memory_prune',
        label: 'Memory Prune',
        description:
          'Prune expired memories and decay confidence of aging facts.',
        parameters: Type.Object({
          mode: Type.Optional(stringEnum(['hard', 'soft', 'both'] as const)),
        }),
        async execute(_toolCallId, params) {
          const { mode = 'both' } = params as {
            mode?: 'hard' | 'soft' | 'both';
          };

          let hardPruned = 0;
          let softDecayed = 0;
          const deletedIds: string[] = [];

          if (mode === 'hard' || mode === 'both') {
            const result = factsDb.pruneExpired();
            hardPruned = result.count;
            deletedIds.push(...result.ids);
          }
          if (mode === 'soft' || mode === 'both') {
            softDecayed = factsDb.decayConfidence();
          }

          if (deletedIds.length > 0) {
            try {
              await vectorDb.deleteMany(deletedIds);
            } catch (err) {
              api.logger.warn(`total-reclaw: vector prune failed: ${err}`);
            }
          }

          const breakdown = factsDb.statsBreakdown();
          const expired = factsDb.countExpired();

          return {
            content: [
              {
                type: 'text',
                text: `Pruned: ${hardPruned} expired. Decayed: ${softDecayed} confidence-updated.\nRemaining by class: ${JSON.stringify(breakdown)}\nPending expired: ${expired}`,
              },
            ],
            details: {
              hardPruned,
              softDecayed,
              breakdown,
              pendingExpired: expired,
            },
          };
        },
      },
      { name: 'memory_prune' },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem = program
          .command('hybrid-mem')
          .description('Hybrid memory plugin commands');

        mem
          .command('stats')
          .description('Show memory statistics with decay breakdown')
          .action(async () => {
            const sqlCount = factsDb.count();
            const lanceCount = await vectorDb.count();
            const breakdown = factsDb.statsBreakdown();
            const expired = factsDb.countExpired();

            console.log(`SQLite facts:    ${sqlCount}`);
            console.log(`LanceDB vectors: ${lanceCount}`);
            console.log(`Total: ${sqlCount + lanceCount} (with overlap)`);
            console.log(`\nBy decay class:`);
            for (const [cls, cnt] of Object.entries(breakdown)) {
              console.log(`  ${cls.padEnd(12)} ${cnt}`);
            }
            if (expired > 0) {
              console.log(`\nExpired (pending prune): ${expired}`);
            }
          });

        mem
          .command('prune')
          .description('Remove expired facts and decay aging confidence')
          .option('--hard', 'Only hard-delete expired facts')
          .option('--soft', 'Only soft-decay confidence')
          .option('--dry-run', 'Show what would be pruned without deleting')
          .action(async opts => {
            if (opts.dryRun) {
              const expired = factsDb.countExpired();
              console.log(`Would prune: ${expired} expired facts`);
              return;
            }
            let hardPruned = 0;
            let softDecayed = 0;
            const deletedIds: string[] = [];
            if (opts.hard) {
              const result = factsDb.pruneExpired();
              hardPruned = result.count;
              deletedIds.push(...result.ids);
            } else if (opts.soft) {
              softDecayed = factsDb.decayConfidence();
            } else {
              const hardResult = factsDb.pruneExpired();
              hardPruned = hardResult.count;
              deletedIds.push(...hardResult.ids);
              softDecayed = factsDb.decayConfidence();
            }
            if (deletedIds.length > 0) {
              const vectorDeleted = await vectorDb.deleteMany(deletedIds);
              console.log(`Vector cleanup: ${vectorDeleted} removed from LanceDB`);
            }
            console.log(`Hard-pruned: ${hardPruned} expired`);
            console.log(`Soft-decayed: ${softDecayed} confidence updated`);
          });

        mem
          .command('checkpoint')
          .description('Save or restore a pre-flight checkpoint')
          .argument('<action>', 'save or restore')
          .option('--intent <text>', 'Intent for save')
          .option('--state <text>', 'State for save')
          .action(async (action, opts) => {
            if (action === 'save') {
              if (!opts.intent || !opts.state) {
                console.error('--intent and --state required for save');
                return;
              }
              const id = factsDb.saveCheckpoint({
                intent: opts.intent,
                state: opts.state,
              });
              console.log(`Checkpoint saved: ${id}`);
            } else if (action === 'restore') {
              const cp = factsDb.restoreCheckpoint();
              if (!cp) {
                console.log('No active checkpoint.');
                return;
              }
              console.log(JSON.stringify(cp, null, 2));
            } else {
              console.error('Usage: checkpoint <save|restore>');
            }
          });

        mem
          .command('backfill-decay')
          .description(
            'Re-classify existing facts with auto-detected decay classes',
          )
          .action(async () => {
            const counts = factsDb.backfillDecayClasses();
            if (Object.keys(counts).length === 0) {
              console.log('All facts already properly classified.');
            } else {
              console.log('Reclassified:');
              for (const [cls, cnt] of Object.entries(counts)) {
                console.log(`  ${cls}: ${cnt}`);
              }
            }
          });

        mem
          .command('extract-daily')
          .description('Extract structured facts from daily memory files')
          .option('--days <n>', 'How many days back to scan', '7')
          .action(async (opts: { days: string }) => {
            const parsed = parseInt(opts.days);
            const daysBack = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
            const stored = scanMemoryFiles(factsDb, daysBack);
            console.log(`Extracted ${stored} new facts from last ${daysBack} days + MEMORY.md`);
          });

        mem
          .command('search')
          .description('Search memories across both backends')
          .argument('<query>', 'Search query')
          .option('--limit <n>', 'Max results', '5')
          .action(async (query, opts) => {
            const parsed = parseInt(opts.limit);
            const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
            const sqlResults = factsDb.search(query, limit);

            let lanceResults: SearchResult[] = [];
            try {
              const vector = await embeddings.embed(query);
              lanceResults = await vectorDb.search(vector, limit, 0.3);
            } catch (err) {
              console.error(`Vector search failed (FTS-only results): ${err}`);
            }

            const merged = mergeResults(sqlResults, lanceResults, limit);

            const output = merged.map(r => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              entity: r.entry.entity,
              score: r.score,
              backend: r.backend,
            }));
            console.log(JSON.stringify(output, null, 2));
          });

        mem
          .command('lookup')
          .description('Exact entity lookup in SQLite')
          .argument('<entity>', 'Entity name')
          .option('--key <key>', 'Optional key filter')
          .action(async (entity, opts) => {
            const results = factsDb.lookup(entity, opts.key);
            const output = results.map(r => ({
              id: r.entry.id,
              text: r.entry.text,
              entity: r.entry.entity,
              key: r.entry.key,
              value: r.entry.value,
            }));
            console.log(JSON.stringify(output, null, 2));
          });
      },
      {
        commands: [
          'hybrid-mem',
          'hybrid-mem stats',
          'hybrid-mem prune',
          'hybrid-mem checkpoint',
          'hybrid-mem backfill-decay',
          'hybrid-mem extract-daily',
          'hybrid-mem search',
          'hybrid-mem lookup',
        ],
      },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on('before_agent_start', async event => {
        if (!event.prompt || event.prompt.length < 5) return;

        try {
          const ftsResults = factsDb.search(event.prompt, 3);

          let lanceResults: SearchResult[] = [];
          try {
            const vector = await embeddings.embed(event.prompt);
            lanceResults = await vectorDb.search(vector, 3, 0.3);
          } catch (err) {
            api.logger.warn(`total-reclaw: vector recall failed: ${err}`);
          }

          const results = mergeResults(ftsResults, lanceResults, 5);
          if (results.length === 0) return;

          const memoryContext = results
            .map(r => `- [${r.backend}/${r.entry.category}] ${r.entry.text}`)
            .join('\n');

          api.logger.info?.(
            `total-reclaw: injecting ${results.length} memories (sqlite: ${ftsResults.length}, lance: ${lanceResults.length})`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant:\n${memoryContext}\n</relevant-memories>`,
          };
        } catch (err) {
          api.logger.warn(`total-reclaw: recall failed: ${String(err)}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on('agent_end', async event => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        try {
          const texts: string[] = [];
          for (const msg of event.messages) {
            if (!msg || typeof msg !== 'object') continue;
            const msgObj = msg as Record<string, unknown>;
            const role = msgObj.role;
            if (role !== 'user') continue;

            const content = msgObj.content;
            if (typeof content === 'string') {
              texts.push(content);
              continue;
            }
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === 'object' &&
                  'type' in block &&
                  (block as Record<string, unknown>).type === 'text' &&
                  'text' in block &&
                  typeof (block as Record<string, unknown>).text === 'string'
                ) {
                  texts.push((block as Record<string, unknown>).text as string);
                }
              }
            }
          }

          const toCapture = texts.filter(t => t && shouldCapture(t));
          if (toCapture.length === 0) return;

          let stored = 0;
          for (const text of toCapture.slice(0, 3)) {
            const category = detectCategory(text);
            const extracted = extractStructuredFields(text, category);

            // Only auto-capture structured facts (entity or key extracted)
            if (!extracted.entity && !extracted.key) continue;

            if (factsDb.hasDuplicate(text)) continue;

            const storedEntry = factsDb.store({
              text,
              category,
              importance: 0.7,
              entity: extracted.entity,
              key: extracted.key,
              value: extracted.value,
              source: 'auto-capture',
            });

            try {
              const vector = await embeddings.embed(text);
              if (!(await vectorDb.hasDuplicate(vector))) {
                await vectorDb.store({
                  id: storedEntry.id,
                  text,
                  vector,
                  importance: 0.7,
                  category,
                });
              }
            } catch (err) {
              api.logger.warn(`total-reclaw: vector capture failed: ${err}`);
            }

            stored++;
          }

          if (stored > 0) {
            api.logger.info(`total-reclaw: auto-captured ${stored} memories`);
          }
        } catch (err) {
          api.logger.warn(`total-reclaw: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: 'total-reclaw',
      start: () => {
        const sqlCount = factsDb.count();
        const expired = factsDb.countExpired();
        api.logger.info(
          `total-reclaw: initialized (sqlite: ${sqlCount} facts, lance: ${resolvedLancePath}, model: ${cfg.embedding.model})`,
        );

        if (expired > 0) {
          const { count: pruned, ids } = factsDb.pruneExpired();
          api.logger.info(
            `total-reclaw: startup prune removed ${pruned} expired facts`,
          );
          if (ids.length > 0) {
            vectorDb.deleteMany(ids).catch(err =>
              api.logger.warn(`total-reclaw: startup vector prune failed: ${err}`),
            );
          }
        }

        // Auto-index Markdown files (MEMORY.md + last 3 days of dailies)
        try {
          const indexed = scanMemoryFiles(factsDb, 3);
          if (indexed > 0) {
            api.logger.info(
              `total-reclaw: startup scan indexed ${indexed} new facts from Markdown files`,
            );
          }
        } catch (err) {
          api.logger.warn(`total-reclaw: startup scan failed: ${err}`);
        }

        if (pruneTimer) clearInterval(pruneTimer);
        pruneTimer = setInterval(() => {
          try {
            const { count: hardPruned, ids: hardIds } = factsDb.pruneExpired();
            const softDecayed = factsDb.decayConfidence();
            if (hardIds.length > 0) {
              vectorDb.deleteMany(hardIds).catch(err =>
                api.logger.warn(`total-reclaw: periodic vector prune failed: ${err}`),
              );
            }
            if (hardPruned > 0 || softDecayed > 0) {
              api.logger.info(
                `total-reclaw: periodic prune — ${hardPruned} expired, ${softDecayed} confidence-updated`,
              );
            }
          } catch (err) {
            api.logger.warn(`total-reclaw: periodic prune failed: ${err}`);
          }
        }, 60 * 60_000);
      },
      stop: () => {
        if (pruneTimer) clearInterval(pruneTimer);
        factsDb.close();
        api.logger.info('total-reclaw: stopped');
      },
    });
  },
};

export default memoryHybridPlugin;

// Test-visible exports
export { FactsDB, VectorDB, Embeddings };
export { classifyDecay, calculateExpiry, mergeResults, generateSearchTags };
export { extractStructuredFields, shouldCapture, detectCategory };
export type { MemoryEntry, SearchResult };
