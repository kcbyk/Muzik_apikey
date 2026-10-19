'use strict';

/**
 * tools/scan-signer.js
 * ----------------------------------------------------------------------------
 *  Suno on-yuz bundle'ini indirip utils/reAnalyzer.js ile tarar ve sonucu
 *  re/frontend-signature-analysis.json dosyasina yazar.
 *
 *  Kullanim:
 *      node tools/scan-signer.js                # canli tarama (suno.com)
 *      node tools/scan-signer.js --dir /tmp/ch  # yerel chunk dizinini tara
 *      node tools/scan-signer.js --max 40       # indirilecek chunk siniri
 *
 *  Bellek: dosyalar tek tek indirilir ve metinleri tarama sonrasi birakilir.
 *  Chromium/Playwright YOKTUR — yalnizca axios + RegExp.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const re = require('../utils/reAnalyzer');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 're');
const OUT_FILE = path.join(OUT_DIR, 'frontend-signature-analysis.json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const dir = arg('dir');
  const maxChunks = Number.parseInt(arg('max', '60'), 10);
  let report;

  if (dir) {
    console.log(`[scan] yerel dizin: ${dir}`);
    report = await re.analyzeDirectory(dir, fs, path);
    report.mode = 'directory';
    report.target = dir;
  } else {
    const page = 'https://suno.com/';
    console.log(`[scan] ${page} indiriliyor...`);
    const html = (
      await axios.get(page, {
        timeout: 20000,
        responseType: 'text',
        proxy: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; suno-beat-proxy re/1.0)' },
      })
    ).data;

    const srcs = re.extractScriptSrcs(html, page).slice(0, maxChunks);
    console.log(`[scan] ${srcs.length} JS chunk bulundu, taranacak.`);
    report = await re.analyzeUrls(srcs, { timeout: 20000 });
    report.mode = 'live';
    report.target = page;
  }

  report.generated_at = new Date().toISOString();
  report.generator = 'tools/scan-signer.js';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log('\n=== KARAR ===');
  console.log(report.verdict);
  console.log('\n=== BULGULAR ===');
  for (const f of report.findings) {
    console.log(`  ${f.rule.padEnd(18)} ${String(f.occurrences).padStart(6)}  (${f.files} dosya)  ${f.label}`);
  }
  console.log(`\n[ok] rapor: ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((err) => {
  console.error('[scan] hata:', err.message);
  process.exit(1);
});
