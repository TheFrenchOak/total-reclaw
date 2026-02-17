import { TTL_DEFAULTS, type DecayClass } from '../config.js';

export function classifyDecay(
  entity: string | null,
  key: string | null,
  value: string | null,
  text: string,
): DecayClass {
  const keyLower = (key || '').toLowerCase();
  const textLower = text.toLowerCase();
  const entityLower = (entity || '').toLowerCase();

  // Permanent: identity facts that never change
  const permanentKeys = [
    'birthday', 'born', 'email', 'phone', 'name', 'real_name', 'full_name',
    'api_key', 'architecture', 'language', 'location', 'stack',
  ];
  if (permanentKeys.some(k => keyLower.includes(k))) return 'permanent';
  if (/\b(born on|birthday is|email is|phone number)\b/i.test(textLower)) return 'permanent';
  // Permanent by text: decisions, architecture, always/never rules
  if (/\b(decided|architecture|always use|never use|always\b|never\b)\b/i.test(textLower)) return 'permanent';
  // Permanent by entity
  if (entityLower === 'decision' || entityLower === 'convention') return 'permanent';

  // Session: temporary context
  const sessionKeys = ['current_file', 'temp', 'debug', 'working_on_right_now'];
  if (sessionKeys.some(k => keyLower.includes(k))) return 'session';
  if (/\b(currently debugging|right now|this session)\b/i.test(textLower))
    return 'session';

  // Active: project-related, changes often
  const activeKeys = [
    'current_task', 'active_branch', 'sprint', 'milestone',
    'task', 'todo', 'wip', 'branch', 'blocker',
  ];
  if (activeKeys.some(k => keyLower.includes(k))) return 'active';
  if (entityLower === 'project' || entityLower === 'sprint') return 'active';
  // Active by text
  if (/\b(working on|need to fix|todo:?|wip)\b/i.test(textLower)) return 'active';

  // Checkpoint: auto-classified by store()
  if (keyLower.startsWith('checkpoint:') || keyLower.includes('preflight')) return 'checkpoint';

  // Stable: default for most structured facts
  return 'stable';
}

export function calculateExpiry(
  decayClass: DecayClass,
  nowSec: number,
): number | null {
  const ttl = TTL_DEFAULTS[decayClass];
  if (ttl === null) return null;
  return nowSec + ttl;
}
