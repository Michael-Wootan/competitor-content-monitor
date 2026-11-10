#!/usr/bin/env node
// Offline tests for sitemap parsing and the lookback window. No network needed.
const assert = require('assert');
const m = require('../src/competitor-content-monitor.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

const urlset = `<?xml version="1.0"?><urlset>
  <url><loc> https://shop.example/blogs/news/new-post </loc><lastmod>2026-11-05T10:00:00Z</lastmod></url>
  <url><loc>https://shop.example/blogs/news/old-post/</loc><lastmod>2026-01-02</lastmod></url>
  <url><loc>https://shop.example/pages/about</loc></url>
</urlset>`;
const index = `<sitemapindex>
  <sitemap><loc>https://shop.example/sitemap_products_1.xml</loc></sitemap>
  <sitemap><loc>https://shop.example/sitemap_blogs_1.xml</loc></sitemap>
  <sitemap><loc>https://shop.example/sitemap_pages_1.xml</loc></sitemap>
</sitemapindex>`;

t('url entries are read with trimmed loc and optional lastmod', () => {
  const e = m.parseUrlEntries(urlset);
  assert.strictEqual(e.length, 3);
  assert.strictEqual(e[0].loc, 'https://shop.example/blogs/news/new-post');
  assert.strictEqual(e[2].lastmod, null);
});

t('a sitemap index is detected and its children listed', () => {
  assert.strictEqual(m.isSitemapIndex(index), true);
  assert.strictEqual(m.isSitemapIndex(urlset), false);
  assert.strictEqual(m.parseSitemapIndex(index).length, 3);
});

t('blog sub-sitemaps are preferred over product and page sitemaps', () => {
  assert.deepStrictEqual(m.pickRelevantSubSitemaps(m.parseSitemapIndex(index)), ['https://shop.example/sitemap_blogs_1.xml']);
});

t('without a blog sitemap the first three children are used', () => {
  const urls = ['a.xml', 'b.xml', 'c.xml', 'd.xml'].map(f => `https://shop.example/${f}`);
  assert.strictEqual(m.pickRelevantSubSitemaps(urls).length, 3);
});

t('age is measured in days and bad dates never count as recent', () => {
  const now = Date.parse('2026-11-09T10:00:00Z');
  assert.strictEqual(Math.round(m.daysAgo('2026-11-05T10:00:00Z', now)), 4);
  assert.strictEqual(m.daysAgo('not a date', now), Infinity);
});

t('slugs come from the last path segment', () => {
  assert.strictEqual(m.slugFromUrl('https://shop.example/blogs/news/old-post/'), 'old-post');
});

t('the report groups new pages by competitor and names unreadable sitemaps', () => {
  const html = m.buildHtml([
    { name: 'Competitor One', newUrls: [{ slug: 'new-post', url: 'https://shop.example/blogs/news/new-post', lastmod: '2026-11-05T10:00:00Z' }], error: null },
    { name: 'Competitor Two', newUrls: [], error: 'timeout' },
  ]);
  assert.ok(html.includes('Competitor One') && html.includes('new-post') && html.includes('2026-11-05'));
  assert.ok(html.includes('Could not read sitemaps for: Competitor Two'));
});

console.log(`\n${n} tests passed`);
