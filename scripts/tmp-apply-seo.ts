import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const pairs = JSON.parse(readFileSync('/tmp/seo-pairs.json', 'utf8')) as Record<string, string>;
const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let ok = 0;
for (const [slug, description] of Object.entries(pairs)) {
  const { error } = await client.from('categories').update({ description }).eq('slug', slug);
  if (error) { console.error(`FAIL ${slug}: ${error.message}`); process.exit(1); }
  ok += 1;
  console.log(`OK ${slug} (${description.length} симв.)`);
}
console.log(`DONE: ${ok}`);
