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

export function generateSearchTags(
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
