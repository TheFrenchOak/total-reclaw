import type { MemoryCategory } from '../config.js';

export function extractStructuredFields(
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

export function shouldCapture(text: string): boolean {
  if (text.length < 10 || text.length > 500) return false;
  if (text.includes('<relevant-memories>')) return false;
  if (text.startsWith('<') && text.includes('</')) return false;
  if (/^\*\*[^*]+\*\*\n-/.test(text)) return false;
  const emojiCount = (text.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) return false;
  if (SENSITIVE_PATTERNS.some(r => r.test(text))) return false;
  return MEMORY_TRIGGERS.some(r => r.test(text));
}

export function detectCategory(text: string): MemoryCategory {
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
