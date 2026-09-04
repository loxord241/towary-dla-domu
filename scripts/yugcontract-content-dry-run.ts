/**
 * Yugcontract get-content-goods DRY-RUN (read-only).
 *
 * Makes EXACTLY ONE full get-content-goods call (the endpoint has no
 * server-side filtering), normalizes it in memory, compares against our
 * products (SELECT only) and prints a report. Performs ZERO database
 * writes, ZERO storage uploads and NEVER executes description HTML.
 *
 * Usage:
 *   node scripts/yugcontract-content-dry-run.ts [--sample-images N]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Type-only static import: fully erased before execution, so Node never
// resolves it at runtime.
import type {
  OurProductRow,
  YcContentGood,
  ContentIssue,
} from '../app/lib/yugcontract/content-dry-run.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && match[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
} catch {
  // env vars can come from the shell too
}

const { createClient } = await import('@supabase/supabase-js');
const { getContentGoodsWithMeta, YugcontractError } = await import(
  '../app/lib/yugcontract/client.ts'
);
const {
  extractContentGoods,
  normalizeContentGood,
  dedupeContentGoods,
  matchContentGoodsToProducts,
  buildDescriptionStats,
  buildParamsStats,
  buildImagesStats,
} = await import('../app/lib/yugcontract/content-dry-run.ts');

/**
 * Paged SELECT over products. Supabase caps a single range request at
 * 1000 rows regardless of the requested window, so the page size must
 * stay <= 1000 or rows are SILENTLY TRUNCATED (observed live: a 5000-row
 * page returned exactly 1000).
 */
async function fetchAllProductsPaged(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  select: string
): Promise<{ rows: OurProductRow[]; pages: number }> {
  const PAGE = 1000;
  const rows: OurProductRow[] = [];
  let from = 0;
  for (;;) {
    // client comes from a dynamic import (untyped) → no .returns<T>() here
    const { data, error } = await client
      .from('products')
      .select(select)
      // Stable multi-page windows: OFFSET paging without ORDER BY can
      // return overlapping/gapped pages (live-verified). 'id' is unique.
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as OurProductRow[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, pages: from / PAGE + 1 };
    from += PAGE;
  }
}

// ---- args ------------------------------------------------------------------
const sampleIdx = process.argv.indexOf('--sample-images');
const rawSample = sampleIdx !== -1 ? Number(process.argv[sampleIdx + 1]) : 0;
const SAMPLE_IMAGES = Number.isFinite(rawSample) && rawSample > 0 ? Math.trunc(rawSample) : 0;

const fmtInt = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString('uk-UA');

function printSection(title: string): void {
  console.log(`\n== ${title} ==`);
}

// ---- 1) one full API call ---------------------------------------------------
const t0 = Date.now();
console.log('== CONTENT DRY-RUN (read-only) ==');
console.log(`Старт: ${new Date().toISOString()}`);
if (SAMPLE_IMAGES > 0) console.log(`Опція: --sample-images ${SAMPLE_IMAGES}`);

let parsed: unknown;
let byteLength = 0;
try {
  ({ parsed, byteLength } = await getContentGoodsWithMeta());
} catch (err) {
  if (err instanceof YugcontractError) {
    console.error(
      `Помилка Yugcontract [${err.kind}${err.httpStatus ? `:${err.httpStatus}` : ''}]: ${err.message}`
    );
  } else {
    console.error('Непередбачена помилка запиту до Yugcontract');
  }
  process.exit(1);
}
const apiMs = Date.now() - t0;
console.log(
  `\nAPI: get-content-goods\nВикликів API: 1\nЧас відповіді: ${(apiMs / 1000).toFixed(1)} с\nРозмір тіла: ${(byteLength / 1024 / 1024).toFixed(1)} MB`
);

// ---- 2) extract + normalize -------------------------------------------------
let rawGoods: unknown[];
try {
  ({ goods: rawGoods } = extractContentGoods(parsed));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const issues: ContentIssue[] = [];
const validGoods: YcContentGood[] = [];
for (const raw of rawGoods) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    issues.push({ id: '(не об’єкт)', reason: 'елемент goods не є об’єктом' });
    continue;
  }
  const { good, issues: rowIssues } = normalizeContentGood(raw as Record<string, unknown>);
  issues.push(...rowIssues);
  if (good) validGoods.push(good);
}

const issueCounts = new Map<string, { count: number; examples: string[] }>();
for (const issue of issues) {
  const key = issue.reason.replace(/\d+/g, 'N');
  const entry = issueCounts.get(key) ?? { count: 0, examples: [] };
  entry.count += 1;
  if (entry.examples.length < 5) entry.examples.push(issue.id);
  issueCounts.set(key, entry);
}

const deduped = dedupeContentGoods(validGoods);
const goodsById = new Map(deduped.unique.map((g) => [g.externalId, g]));

printSection('EXTRACT / NORMALIZE');
console.log(`raw goods у відповіді:        ${fmtInt(rawGoods.length)}`);
console.log(`валідних після нормалізації:  ${fmtInt(validGoods.length)}`);
console.log(`унікальних (dedupe за id):    ${fmtInt(deduped.unique.length)}`);
console.log(`дубрів рядків (повторні id):  ${fmtInt(deduped.duplicateRowCount)}`);
if (issueCounts.size > 0) {
  console.log('\nMalformed-записи (за типом):');
  for (const [reason, { count, examples }] of [...issueCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)) {
    console.log(`  ${reason}: ${fmtInt(count)}  приклади: ${examples.slice(0, 3).join(', ')}`);
  }
}

// ---- 3) our products (SELECT only) ------------------------------------------
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!supabaseUrl || !serviceKey) {
  console.error('\nНемає SUPABASE env-змінних');
  process.exit(1);
}
const client = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const { rows: ourProducts, pages } = await fetchAllProductsPaged(
  client,
  'id,yugcontract_id,sku,name,description'
);
console.log(`\nSELECT products: ${ourProducts.length} рядків за ${pages} стор. (по ≤1000)`);

const match = matchContentGoodsToProducts(goodsById, ourProducts);
const matchedPairs = match.matchedLocal;

printSection('MATCHING');
console.log(`наших товарів у БД:                ${fmtInt(ourProducts.length)}`);
console.log(`  з yugcontract_id:                ${fmtInt(ourProducts.length - match.manualLocal.length)}`);
console.log(`  ручних (без yugcontract_id):     ${fmtInt(match.manualLocal.length)}`);
console.log(`matchedLocal (є контент):          ${fmtInt(matchedPairs.length)}`);
console.log(`unmatchedLocal (контенту немає):   ${fmtInt(match.unmatchedLocal.length)}`);
console.log(`ycUnused (контент поза асортиментом): ${fmtInt(match.ycUnusedIds.length)}`);
if (match.unmatchedLocal.length > 0) {
  console.log(
    `  приклади unmatched: ${match.unmatchedLocal.slice(0, 5).map((p) => `${p.sku} (${p.yugcontract_id})`).join(', ')}`
  );
}

// ---- 4) DESCRIPTION ---------------------------------------------------------
const descAll = buildDescriptionStats(
  deduped.unique.map((g) => ({ externalId: g.externalId, description: g.description }))
);
const descMatched = buildDescriptionStats(
  matchedPairs.map(({ product, good }) => ({
    externalId: `${product.sku}/${good.externalId}`,
    description: good.description,
  }))
);

function printDanger(danger: typeof descAll.danger): void {
  console.log(
    `небезпечні конструкції: script=${danger.scriptTag}, iframe=${danger.iframeTag}, on*=${danger.eventHandlers}, javascript:=${danger.javascriptUrl}, style=${danger.styleTagOrAttr}, data:=${danger.dataUrl} (тільки підрахунок, HTML не виконується)`
  );
}

printSection('DESCRIPTION (весь контент YC)');
console.log(`з описом:            ${fmtInt(descAll.withDescription)}`);
console.log(`без/порожній:        ${fmtInt(descAll.emptyDescription)}`);
console.log(`середня довжина:     ${fmtInt(descAll.avgDescriptionLength)} символів`);
console.log(`максимальна:         ${fmtInt(descAll.maxDescriptionLength)} символів`);
console.log(`містить HTML:        ${fmtInt(descAll.htmlCount)}`);
console.log(`plain text:          ${fmtInt(descAll.plainTextCount)}`);
printDanger(descAll.danger);
console.log(`приклади структури (перші ${descAll.samples.length}):`);
for (const s of descAll.samples) {
  console.log(`  id=${s.externalId} len=${s.length} html=${s.containsHtml ? 'yes' : 'no'}`);
}

printSection('DESCRIPTION (наші matched товари)');
console.log(`з описом:            ${fmtInt(descMatched.withDescription)} з ${fmtInt(descMatched.total)}`);
console.log(`без/порожній:        ${fmtInt(descMatched.emptyDescription)}`);
console.log(`середня довжина:     ${fmtInt(descMatched.avgDescriptionLength)}`);
console.log(`HTML/plain:          ${fmtInt(descMatched.htmlCount)}/${fmtInt(descMatched.plainTextCount)}`);
printDanger(descMatched.danger);

// ---- 5) PARAMS --------------------------------------------------------------
const paramsAll = buildParamsStats(deduped.unique);
const paramsMatched = buildParamsStats(matchedPairs.map((m) => m.good));

function printParams(stats: ReturnType<typeof buildParamsStats>, label: string): void {
  console.log(`--- ${label} ---`);
  console.log(`товарів з params:        ${fmtInt(stats.withParams)}`);
  console.log(`товарів без params:      ${fmtInt(stats.withoutParams)}`);
  console.log(`всього параметрів:       ${fmtInt(stats.totalParams)}`);
  console.log(`сер. на товар:           ${stats.avgParamsPerProduct ?? '—'}`);
  console.log(`макс. на товар:          ${fmtInt(stats.maxParamsPerProduct)}`);
  console.log(`унікальних назв:         ${fmtInt(stats.uniqueParamNames)}`);
  console.log(
    `дублі (name,value) в товарі: ${fmtInt(stats.goodsWithDuplicatePairs)}; name повторюється: ${fmtInt(stats.goodsWithNameRepeated)}; той самий name з РІЗНИМИ values: ${fmtInt(stats.goodsWithConflictingValues)}`
  );
}

printSection('PARAMETERS (весь контент YC)');
printParams(paramsAll, 'all');
printSection('PARAMETERS (наші matched товари)');
printParams(paramsMatched, 'matched');
console.log(`\nTOP-${paramsMatched.topNames.length} назв характеристик (matched):`);
for (const t of paramsMatched.topNames) {
  console.log(`  ${t.name.padEnd(40, ' ')} ${fmtInt(t.count)}`);
}

// ---- 6) IMAGES (counts only) ------------------------------------------------
const imgAll = buildImagesStats(deduped.unique);
const imgMatched = buildImagesStats(matchedPairs.map((m) => m.good));

function printImages(stats: ReturnType<typeof buildImagesStats>, label: string): void {
  console.log(`--- ${label} ---`);
  console.log(`товарів з картинками:     ${fmtInt(stats.productsWithPictures)}`);
  console.log(`товарів без картинок:     ${fmtInt(stats.productsWithoutPictures)}`);
  console.log(`всього URL картинок:      ${fmtInt(stats.totalPictureUrls)}`);
  console.log(`унікальних URL:           ${fmtInt(stats.uniquePictureUrls)}`);
  console.log(`дубрів URL:               ${fmtInt(stats.duplicateUrlRows)}`);
  console.log(`сер./макс на товар:       ${stats.avgPicturesPerProduct ?? '—'} / ${fmtInt(stats.maxPicturesPerProduct)}`);
  console.log(`hosts: ${stats.hosts.map((h) => `${h.host}(${h.count})`).slice(0, 5).join(', ') || '—'}`);
  console.log(`розширення: ${stats.extensions.slice(0, 8).map((e) => `${e.ext}:${e.count}`).join(', ') || '—'}`);
}

printSection('IMAGES (кількості, без завантаження)');
printImages(imgAll, 'all YC goods');
printImages(imgMatched, 'наші matched товари');
if (imgAll.duplicateExamples.length > 0) {
  console.log(
    `приклади дублів URL (all): ${imgAll.duplicateExamples
      .slice(0, 3)
      .map((d) => `${d.url.slice(0, 80)}… ×${d.count}`)
      .join('; ')}`
  );
}
if (imgAll.suspiciousUrls.length > 0) {
  console.log(`підозрілі URL: ${imgAll.suspiciousUrls.length}`);
  for (const s of imgAll.suspiciousUrls.slice(0, 3)) {
    console.log(`  [${s.reason}] ${s.url.slice(0, 90)}`);
  }
}
// ---- 7) DB impact (dry-run only) --------------------------------------------
let fillDescriptions = 0;
let alreadySame = 0;
let overwriteRisk = 0;
let keepOldWhenNewEmpty = 0;
let noopEmpty = 0;
let existingNonEmptyOld = 0;
for (const { product, good } of matchedPairs) {
  const old = (product.description ?? '').trim();
  const next = good.description ?? '';
  if (old !== '') existingNonEmptyOld += 1;
  if (old === '' && next === '') noopEmpty += 1;
  else if (old === '') fillDescriptions += 1;
  else if (next === '') keepOldWhenNewEmpty += 1;
  else if (old === next.trim()) alreadySame += 1;
  else overwriteRisk += 1;
}

printSection('DB IMPACT (потенційний, нічого не записано)');
console.log(`потенційних UPDATE products (опис):            ${fmtInt(fillDescriptions + overwriteRisk)}`);
console.log(`  з них ЗАПОВНЕННЯ порожніх:                   ${fmtInt(fillDescriptions)}`);
console.log(`  з них ПЕРЕЗАПИС існуючого опису (ризик):     ${fmtInt(overwriteRisk)}`);
console.log(`опис уже ідентичний (no-op):                   ${fmtInt(alreadySame)}`);
console.log(`новий опис порожній, старий лишається:         ${fmtInt(keepOldWhenNewEmpty)}`);
console.log(`обидва порожні (no-op):                        ${fmtInt(noopEmpty)}`);
console.log(`matched товарів з НЕПОРОЖНІМ поточним описом:  ${fmtInt(existingNonEmptyOld)} (не перезаписувати вслiпу!)`);
console.log(`потенційних записів specifications (matched):  ${fmtInt(paramsMatched.totalParams)} елементів, ${fmtInt(paramsMatched.uniqueParamNames)} унікальних назв`);

// ---- 8) optional image size sampling ----------------------------------------
if (SAMPLE_IMAGES > 0) {
  printSection(`IMAGE SIZE ESTIMATE (sample ${SAMPLE_IMAGES})`);
  const pool: string[] = [];
  const step = Math.max(1, Math.floor(matchedPairs.length / SAMPLE_IMAGES));
  for (let i = 0; i < matchedPairs.length && pool.length < SAMPLE_IMAGES; i += step) {
    const url = matchedPairs[i]?.good.pictures[0];
    if (url) pool.push(url);
  }
  for (const g of deduped.unique) {
    if (pool.length >= SAMPLE_IMAGES) break;
    for (const url of g.pictures) {
      if (pool.length >= SAMPLE_IMAGES) break;
      if (!pool.includes(url)) pool.push(url);
    }
  }

  interface SampleResult {
    url: string;
    host: string;
    status: number | null;
    contentType: string | null;
    bytes: number | null;
    method: string;
  }

  async function probe(url: string): Promise<SampleResult> {
    let host = '(unparseable)';
    try {
      host = new URL(url).host;
    } catch {
      /* counted elsewhere */
    }
    const base = { url, host };
    try {
      const head = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(15_000),
      });
      const lenHead = head.headers.get('content-length');
      if (head.ok) {
        const bytes = lenHead !== null ? Number(lenHead) : null;
        return {
          ...base,
          status: head.status,
          contentType: head.headers.get('content-type'),
          bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
          method: 'HEAD',
        };
      }
      if (head.status !== 405 && head.status !== 501) {
        return { ...base, status: head.status, contentType: head.headers.get('content-type'), bytes: null, method: 'HEAD' };
      }
    } catch {
      /* fall through to ranged GET */
    }
    try {
      const res = await fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(15_000),
      });
      const range = res.headers.get('content-range'); // "bytes 0-0/12345"
      const total = range?.split('/')[1];
      const bytes = total !== undefined && total !== '*' ? Number(total) : null;
      await res.body?.cancel().catch(() => {});
      return {
        ...base,
        status: res.status,
        contentType: res.headers.get('content-type'),
        bytes: bytes !== null && Number.isFinite(bytes) ? bytes : null,
        method: 'GET-range',
      };
    } catch {
      return { ...base, status: null, contentType: null, bytes: null, method: 'failed' };
    }
  }

  const results: SampleResult[] = [];
  for (const url of pool) results.push(await probe(url));

  const sized = results.filter((r) => r.bytes !== null && (r.bytes as number) > 0);
  const sorted = [...sized].sort((a, b) => (a.bytes as number) - (b.bytes as number));
  const median =
    sorted.length > 0
      ? sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!.bytes
        : Math.round(((sorted[sorted.length / 2 - 1]!.bytes as number) + (sorted[sorted.length / 2]!.bytes as number)) / 2)
      : null;
  const avg = sized.length > 0
    ? Math.round(sized.reduce((acc, r) => acc + (r.bytes as number), 0) / sized.length)
    : null;
  const contentTypes = new Map<string, number>();
  for (const r of results) {
    const ct = r.contentType?.split(';')[0] ?? '(немає)';
    contentTypes.set(ct, (contentTypes.get(ct) ?? 0) + 1);
  }

  console.log(`sampled: ${results.length}, successful: ${sized.length}, failed/no-size: ${results.length - sized.length}`);
  console.log(`avgBytes: ${fmtInt(avg)}, medianBytes: ${fmtInt(median)}, maxBytes: ${fmtInt(sized.length > 0 ? Math.max(...sized.map((r) => r.bytes as number)) : null)}`);
  console.log(`contentTypes: ${[...contentTypes.entries()].map(([ct, n]) => `${ct}×${n}`).join(', ') || '—'}`);
  console.log(
    `estimatedTotalBytes (ОЦІНКА avg × ${fmtInt(imgMatched.uniquePictureUrls)} унікальних URL matched): ${
      avg !== null ? fmtInt(avg * imgMatched.uniquePictureUrls) : '—'
    } ≈ ${avg !== null ? ((avg * imgMatched.uniquePictureUrls) / 1024 / 1024 / 1024).toFixed(2) : '—'} GB`
  );
  console.log('УВАГА: це ОЦІНКА за вибіркою, а не фактичний розмір.');
  if (results.some((r) => r.method === 'GET-range')) {
    console.log('Частина запитів виконана GET Range (HEAD відхилено/недоступний).');
  }
  for (const r of results.slice(0, 5)) {
    console.log(`  [${r.method}] ${r.status ?? 'ERR'} ${String(r.bytes ?? '—')}B ${r.contentType ?? '—'} ${r.host}`);
  }
}

// ---- summary ----------------------------------------------------------------
printSection('ПІДСУМОК');
console.log(`Викликів API: 1 (get-content-goods, ${(byteLength / 1024 / 1024).toFixed(1)} MB, ${(apiMs / 1000).toFixed(1)} с)`);
console.log('Production writes: 0');
console.log('Database writes: 0');
console.log('Storage uploads: 0');
console.log(`Тривалість сухого прогону: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
