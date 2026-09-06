/**
 * Node module-customization hook so node:test can import the real '.tsx'
 * client modules (favorites-context / cart-context). Node's built-in type
 * stripping handles '.ts' but not JSX, so '.tsx' is transpiled here with the
 * project's own TypeScript compiler using the tsconfig jsx mode (react-jsx).
 * The '@/*' tsconfig path alias is resolved against the repository root.
 * Tests never render — they only import the exported pure logic.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

function resolveAlias(specifier) {
  const base = path.join(ROOT, specifier.slice(2));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = resolveAlias(specifier);
    if (target) {
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.endsWith('.tsx')) {
    const source = readFileSync(new URL(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: url,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
