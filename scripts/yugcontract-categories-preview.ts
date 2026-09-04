/**
 * Local read-only diagnostics: fetches the Yugcontract get-categories
 * tree and prints IDs, names and hierarchy to stdout.
 *
 * Usage:
 *   1. Put YUGCONTRACT_USER_KEY / YUGCONTRACT_SECRET into .env.local
 *      (server-side only — never commit, never NEXT_PUBLIC_).
 *   2. Run: node scripts/yugcontract-categories-preview.ts
 *
 * Secrets/authToken are never printed. No database access at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env.local loader (KEY=VALUE lines), so no extra dependency.
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // .env.local may be absent — env vars can come from the shell too.
}

const { getCategoriesCatalog } = await import('../app/lib/yugcontract/client.ts');
const {
  extractCategoryRows,
  detectCategoryFields,
  normalizeCategoryNode,
  buildCategoryTree,
} = await import('../app/lib/yugcontract/normalize.ts');

interface TreeNode {
  externalId: string;
  name: string;
  children: TreeNode[];
}

function printTree(nodes: TreeNode[], depth = 0): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    console.log(
      `${'  '.repeat(depth)}[${node.externalId}] ${'—'.repeat(Math.min(depth, 3))}${depth > 0 ? ' ' : ''}${node.name || '(без назви)'}`
    );
    count += printTree(node.children as TreeNode[], depth + 1);
  }
  return count;
}

try {
  const parsed = await getCategoriesCatalog();
  const { rows, arrayPath } = extractCategoryRows(parsed);
  const fields = detectCategoryFields(rows);
  const nodes = rows.map((row) => normalizeCategoryNode(row, fields));
  const { roots, stats } = buildCategoryTree(nodes);

  console.log(`# arrayPath: ${arrayPath}`);
  console.log(`# fields: id=${fields.id} name=${fields.name} parent=${fields.parent}`);
  console.log(
    `# stats: total=${stats.totalNodes} roots=${stats.rootCount} maxDepth=${stats.maxDepth} orphans=${stats.orphanCount}`
  );
  console.log(
    `# levels: ${Object.entries(stats.levelCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([l, c]) => `L${l}:${c}`)
      .join(' ')}`
  );
  console.log('# ---- category tree (id | cat_top → cat_2l → cat) ----');
  const printed = printTree(roots as TreeNode[]);
  console.log(`# ---- end: ${printed} nodes printed ----`);
} catch (err) {
  // YugcontractError messages are credential-free by design.
  console.error('Помилка:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
