import type { SearchResult } from './types.js';

export const STOP_WORDS = new Set([
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

export function mergeResults(
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
