import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { FactsDB } from './facts-db.js';
import { extractStructuredFields, shouldCapture, detectCategory } from './extraction.js';

const SENSITIVE_PATTERNS = [
  /password/i,
  /api.?key/i,
  /secret/i,
  /token\s+is/i,
  /\bssn\b/i,
  /credit.?card/i,
];

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

export function scanMemoryFiles(factsDb: FactsDB, daysBack = 3): number {
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
