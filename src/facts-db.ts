import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { TTL_DEFAULTS, type MemoryCategory, type DecayClass } from '../config.js';
import type { MemoryEntry, SearchResult } from './types.js';
import { classifyDecay, calculateExpiry } from './decay.js';
import { generateSearchTags } from './search-tags.js';
import { STOP_WORDS } from './search.js';

export class FactsDB {
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

    // Use prefix matching (word*) for words >= 3 chars to catch inflections,
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

  close(): void {
    this.db.close();
  }
}
