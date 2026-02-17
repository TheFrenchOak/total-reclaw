import { Type } from '@sinclair/typebox';
import type { ClawdbotPluginApi } from 'openclaw/plugin-sdk';
import { stringEnum } from 'openclaw/plugin-sdk';

import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  DECAY_CLASSES,
  pluginConfigSchema,
  vectorDimsForModel,
} from '../config.js';
import type { SearchResult } from './types.js';
import { FactsDB } from './facts-db.js';
import { VectorDB } from './vector-db.js';
import { Embeddings } from './embeddings.js';
import { mergeResults } from './search.js';
import { extractStructuredFields, shouldCapture, detectCategory } from './extraction.js';
import { scanMemoryFiles } from './markdown-scan.js';

const memoryPlugin = {
  id: 'total-reclaw',
  name: 'Total Reclaw',
  description:
    'Two-tier memory: SQLite+FTS5 for structured facts, LanceDB for semantic search',
  kind: 'memory' as const,
  configSchema: pluginConfigSchema,

  register(api: ClawdbotPluginApi) {
    const cfg = pluginConfigSchema.parse(api.pluginConfig);
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
            decayClass?: (typeof DECAY_CLASSES)[number];
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
          .command('total-reclaw')
          .description('Total Reclaw memory plugin commands');

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
          'total-reclaw',
          'total-reclaw stats',
          'total-reclaw prune',
          'total-reclaw checkpoint',
          'total-reclaw backfill-decay',
          'total-reclaw extract-daily',
          'total-reclaw search',
          'total-reclaw lookup',
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

export default memoryPlugin;
