import type { MemoryCategory } from '../config.js';
import type { DecayClass } from '../config.js';

export type MemoryEntry = {
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

export type SearchResult = {
  entry: MemoryEntry;
  score: number;
  backend: 'sqlite' | 'lancedb';
};
