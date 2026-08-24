/**
 * Unit tests for the Yugcontract description allowlist sanitizer.
 * Pure functions — no network, no env. Run: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sanitizeYcDescription } = await import(
  '../app/lib/yugcontract/content-sanitize.ts'
);

test('sanitizer keeps benign marketing markup', () => {
  // NOTE: sanitize-html renders void elements XHTML-style (<br />)
  const html =
    '<p><strong>Переваги:</strong></p><ul><li>Метал</li></ul>' +
    '<table><tr><td>Вага</td><td>2 кг</td></tr></table><h4>Опис</h4>';
  assert.equal(sanitizeYcDescription(html), html);
});

test('sanitizer strips script tag WITH its content', () => {
  assert.equal(sanitizeYcDescription('ok<script>alert(1)</script>'), 'ok');
  assert.equal(
    sanitizeYcDescription('<SCRIPT src="https://evil.io/x.js">var a=1;</SCRIPT>x'),
    'x'
  );
});

test('sanitizer strips style tag/attribute content', () => {
  const out = sanitizeYcDescription('<style>.x{background:url(evil)}</style><p>y</p>');
  assert.equal(out, '<p>y</p>');
  const styled = sanitizeYcDescription('<p style="position:fixed" class="x">t</p>');
  assert.equal(styled, '<p>t</p>');
});

test('sanitizer removes event handlers', () => {
  assert.equal(
    sanitizeYcDescription('<img src="https://b2b.yugcontract.ua/a.jpg" onerror="go()">'),
    '<img src="https://b2b.yugcontract.ua/a.jpg" />'
  );
  assert.equal(
    sanitizeYcDescription('<p onclick="steal()">текст</p>'),
    '<p>текст</p>'
  );
});

test('sanitizer neutralizes javascript: and data: URLs', () => {
  const js = sanitizeYcDescription('<img src="javascript:alert(1)">');
  assert.ok(!js.includes('javascript:'));
  const data = sanitizeYcDescription('<img src="data:text/html;base64,PHNjcg==">');
  assert.ok(!data.includes('data:'));
});

test('sanitizer drops iframe tag (content may survive as plain text)', () => {
  const out = sanitizeYcDescription('<iframe src="https://evil.io"></iframe>after');
  assert.ok(!out.toLowerCase().includes('<iframe'));
  assert.ok(!out.includes('evil.io'));
});

test('sanitizer rejects unknown schemes and protocol-relative URLs', () => {
  const proto = sanitizeYcDescription('<img src="//evil.io/x.jpg">');
  assert.ok(!proto.includes('//evil.io'));
  const blob = sanitizeYcDescription('<img src="blob:https://x.io/abc">');
  assert.ok(!blob.includes('blob:'));
});

test('sanitizer strips disallowed containers but keeps their text', () => {
  const out = sanitizeYcDescription('<a href="https://ok.io">лінк</a><form>ф</form>');
  assert.equal(out, 'лінкф');
});

test('sanitizer keeps http(s) images and trims whitespace', () => {
  const html = '  <div><img src="https://b2b.yugcontract.ua/fileslibrary/p.jpg" alt="фото"></div>  ';
  assert.equal(
    sanitizeYcDescription(html),
    '<div><img src="https://b2b.yugcontract.ua/fileslibrary/p.jpg" alt="фото" /></div>'
  );
});
