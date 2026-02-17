import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'node:crypto';
import type { MemoryCategory, DecayClass } from '../config.js';
import type { SearchResult } from './types.js';

const LANCE_TABLE = 'memories';

export class VectorDB {
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
