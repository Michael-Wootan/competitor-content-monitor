#!/usr/bin/env node
/**
 * competitor-content-monitor.js: weekly competitor new-content monitor
 *
 * Fetches each competitor's sitemap, finds URLs published or updated in the
 * lookback window, and emails a short report grouped by competitor.
 *
 * Usage:
 *   node src/competitor-content-monitor.js            fetch + email report
 *   node src/competitor-content-monitor.js --dry-run  print the findings, don't email
 *
 * Env:
 *   GMAIL_USER, GMAIL_APP_PASSWORD   sender mailbox
 *   EMAIL_NOTIFY                     recipient (defaults to the sender)
 *   LOOKBACK_DAYS                    default 7
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const https = require('https');
const nodemailer = require('nodemailer');

// ── Config ───────────────────────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const EMAIL_TO = process.env.EMAIL_NOTIFY || GMAIL_USER;
const COMPANY_NAME = process.env.COMPANY_NAME || 'Competitor Monitor';
const CLIENT_ID = process.env.CLIENT_ID || 'competitor-content-monitor/1.0 (sitemap reader)';
const DRY_RUN = process.argv.includes('--dry-run');
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '7', 10);

// Competitors to monitor: [{ name, sitemap }] in config/competitors.json
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(__dirname, '..', 'config');
function loadCompetitors() {
  for (const f of ['competitors.json', 'competitors.example.json']) {
    const p = path.join(CONFIG_DIR, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return [];
}
const COMPETITORS = loadCompetitors();

// ── HTTP fetch (follows redirects) ───────────────────────────────────────────
function fetchUrl(url, maxRedirects = 4, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': CLIENT_ID, 'Accept': 'application/xml,text/xml,*/*' },
      timeout,
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchUrl(loc, maxRedirects - 1, timeout));
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Sitemap parsing ──────────────────────────────────────────────────────────
// Extract <url><loc>..</loc><lastmod>..</lastmod></url> blocks.
function parseUrlEntries(xml) {
  const entries = [];
  const urlBlocks = xml.match(/<url\b[\s\S]*?<\/url>/gi) || [];
  for (const block of urlBlocks) {
    const loc = (block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    const lastmod = (block.match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i) || [])[1];
    if (loc) entries.push({ loc: loc.trim(), lastmod: lastmod ? lastmod.trim() : null });
  }
  return entries;
}

// Extract child sitemap URLs from a <sitemapindex>.
function parseSitemapIndex(xml) {
  const out = [];
  const blocks = xml.match(/<sitemap\b[\s\S]*?<\/sitemap>/gi) || [];
  for (const block of blocks) {
    const loc = (block.match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    if (loc) out.push(loc.trim());
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex\b/i.test(xml);
}

// Prefer blog/post/article sub-sitemaps when following an index.
function pickRelevantSubSitemaps(urls) {
  const preferred = urls.filter(u => /(blog|post|article|news)/i.test(u));
  return preferred.length ? preferred : urls.slice(0, 3); // fallback: first few
}

function daysAgo(dateStr, now = Date.now()) {
  const d = new Date(dateStr);
  if (isNaN(d)) return Infinity;
  return (now - d.getTime()) / (86400 * 1000);
}

function slugFromUrl(u) {
  try {
    const path = new URL(u).pathname.replace(/\/$/, '');
    return path.split('/').filter(Boolean).pop() || path;
  } catch { return u; }
}

// ── Per-competitor check ─────────────────────────────────────────────────
async function checkCompetitor(comp) {
  const result = { name: comp.name, newUrls: [], error: null };
  try {
    let { body } = await fetchUrl(comp.sitemap);
    if (!body || !/</.test(body)) throw new Error('empty or non-XML sitemap');

    let entries = [];
    if (isSitemapIndex(body)) {
      const subs = pickRelevantSubSitemaps(parseSitemapIndex(body));
      for (const sub of subs) {
        try {
          const r = await fetchUrl(sub);
          entries.push(...parseUrlEntries(r.body));
        } catch { /* skip bad sub-sitemap */ }
      }
    } else {
      entries = parseUrlEntries(body);
    }

    for (const e of entries) {
      if (e.lastmod && daysAgo(e.lastmod) <= LOOKBACK_DAYS) {
        result.newUrls.push({ slug: slugFromUrl(e.loc), url: e.loc, lastmod: e.lastmod });
      }
    }
    // Sort newest first, cap to keep the email readable
    result.newUrls.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));
    result.newUrls = result.newUrls.slice(0, 15);
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

// ── Report ───────────────────────────────────────────────────────────────────
function buildHtml(results) {
  const withContent = results.filter(r => r.newUrls.length > 0);
  const errored = results.filter(r => r.error);
  const totalNew = withContent.reduce((s, r) => s + r.newUrls.length, 0);
  const today = new Date().toISOString().slice(0, 10);

  let sections = '';
  if (withContent.length === 0) {
    sections = `<p>No new competitor content detected in the last ${LOOKBACK_DAYS} days.</p>`;
  } else {
    for (const r of withContent) {
      const rows = r.newUrls.map(u =>
        `<li><a href="${u.url}">${u.slug}</a> <span style="color:#888;font-size:12px;">(${u.lastmod.slice(0, 10)})</span></li>`
      ).join('');
      sections += `<h3 style="margin:18px 0 6px;">${r.name}: ${r.newUrls.length} new</h3><ul style="margin:0 0 12px;">${rows}</ul>`;
    }
  }

  const errNote = errored.length
    ? `<p style="color:#999;font-size:12px;">Could not read sitemaps for: ${errored.map(e => e.name).join(', ')}.</p>`
    : '';

  return `
  <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto;color:#222;">
    <h2 style="border-bottom:2px solid #27ae60;padding-bottom:8px;">🕵️ Competitor New Content: ${today}</h2>
    <p><strong>${totalNew}</strong> new URLs across <strong>${withContent.length}</strong> competitor(s) in the last ${LOOKBACK_DAYS} days (${results.length} monitored).</p>
    ${sections}
    ${errNote}
    <hr style="border:none;border-top:1px solid #ddd;margin:20px 0;">
    <p style="color:#999;font-size:11px;">Generated by competitor-content-monitor.js.</p>
  </div>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Competitor content monitor: ${new Date().toISOString()}`);
  const results = [];
  for (const comp of COMPETITORS) {
    process.stdout.write(`  ${comp.name}... `);
    const r = await checkCompetitor(comp);
    console.log(r.error ? `error: ${r.error}` : `${r.newUrls.length} new`);
    results.push(r);
    await new Promise(res => setTimeout(res, 400)); // be polite
  }

  const html = buildHtml(results);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Report not emailed.');
    for (const r of results.filter(x => x.newUrls.length)) {
      console.log(`\n${r.name}`);
      for (const u of r.newUrls) console.log(`  ${u.lastmod.slice(0, 10)}  ${u.url}`);
    }
    return;
  }

  if (!GMAIL_USER || !GMAIL_PASS) {
    console.error('Gmail credentials not set: cannot email report');
    process.exit(1);
  }

  const totalNew = results.reduce((s, r) => s + r.newUrls.length, 0);
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({
    from: `"${COMPANY_NAME} Competitor Monitor" <${GMAIL_USER}>`,
    to: EMAIL_TO,
    subject: `[${COMPANY_NAME}] Competitors: ${totalNew} new or updated pages, ${new Date().toISOString().slice(0, 10)}`,
    html,
  });
  console.log(`\nReport emailed to ${EMAIL_TO}.`);
}

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}

module.exports = { parseUrlEntries, parseSitemapIndex, isSitemapIndex, pickRelevantSubSitemaps, daysAgo, slugFromUrl, buildHtml };
