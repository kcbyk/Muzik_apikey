'use strict';

/**
 * ============================================================================
 *  utils/reAnalyzer.js  —  STATIK TERSINE MUHENDISLIK (STATIC RE) TARAYICISI
 * ============================================================================
 *
 *  AMAC
 *  ----
 *  "audiopipe URL'si istemci tarafinda imzalaniyor mu?" sorusunu TAHMIN
 *  etmek yerine, Suno'nun on-yuz JS bundle'ini tarayip OLCMEK.
 *
 *  Bu modul bir "imza uretici" DEGILDIR. Yalnizca metin taramasi yapar ve
 *  su isaretleri arar:
 *
 *    - URL query'sinde imza parametreleri : ?sig= , ?signature= , ?nonce=
 *    - WebCrypto imzalama cagrilari         : subtle.sign(...) , HMAC
 *    - AWS SigV4 (yanlis pozitif filtresi)  : AWS4-HMAC-SHA256 , X-Amz-Signature
 *    - DRM / lisans yolu                    : /api/mango/rights , AES-CTR , glt
 *    - audiopipe kullanimi                  : "audiopipe" , /passthrough?
 *
 *  CIKTI
 *  -----
 *  Bulgu listesi + bir "verdict" (karar) metni. Bulgular /debug/signer
 *  uzerinden canli olarak ta raporlanir.
 *
 *  NOT: Tarayici otomasyonu (Playwright/Chromium) KULLANILMAZ. Sadece
 *  axios ile JS dosyalari indirilir ve Node'un kendi RegExp'i ile taranir.
 *  Bellek etkisi: dosyalar tek tek islenir (bellekte tum bundle tutulmaz).
 * ============================================================================
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// 1. TARAMA KURALLARI
// ---------------------------------------------------------------------------
//  her kural:
//    id      -> rapor anahtari
//    label   -> insan okunur aciklama
//    re      -> aranacak desen
//    weight  -> yorum agirligi (signing: +, noise: 0)
//    klass   -> 'signed-param' | 'signing-api' | 'false-positive' | 'drm' | 'usage'
// ---------------------------------------------------------------------------
const RULES = [
  {
    id: 'sig_query',
    label: 'URL query icinde sig= parametresi',
    re: /[?&]sig=/g,
    klass: 'signed-param',
    weight: 3,
  },
  {
    id: 'signature_key',
    label: 'signature / x-signature alani',
    re: /x-signature|["']signature["']\s*:/gi,
    klass: 'signed-param',
    weight: 2,
  },
  {
    id: 'expires_param',
    label: 'expires / expiry query parametresi',
    re: /[?&](expires|expiry|exp)=/g,
    klass: 'signed-param',
    weight: 2,
  },
  {
    id: 'crypto_sign',
    label: 'WebCrypto imzalama cagrisi (subtle.sign / HMAC)',
    re: /subtle\.sign\s*\(|name:\s*["']HMAC["']/g,
    klass: 'signing-api',
    weight: 3,
  },
  {
    id: 'node_hmac',
    label: 'createHmac kullanimi',
    re: /createHmac\s*\(/g,
    klass: 'signing-api',
    weight: 2,
  },
  {
    id: 'aws_sigv4',
    label: 'AWS SigV4 (S3 presign) — yanlis pozitif',
    re: /AWS4-HMAC-SHA256|X-Amz-Signature|aws4_request/g,
    klass: 'false-positive',
    weight: -2,
  },
  {
    id: 'drm_license',
    label: 'DRM lisans ucu (/api/mango/rights)',
    re: /\/api\/mango\/rights/g,
    klass: 'drm',
    weight: 0,
  },
  {
    id: 'drm_aes',
    label: 'Icerik sifreleme (AES-CTR / AES-GCM)',
    re: /AES-CTR|AES-GCM/g,
    klass: 'drm',
    weight: 0,
  },
  {
    id: 'drm_guest_token',
    label: 'Anonim oynatma lisans token\'i (glt / guest token)',
    re: /guest token|glt\s*[),]/g,
    klass: 'drm',
    weight: 0,
  },
  {
    id: 'audiopipe_ref',
    label: 'audiopipe referansi',
    re: /audiopipe/g,
    klass: 'usage',
    weight: 0,
  },
  {
    id: 'sig_near_audiopipe',
    label: 'audiopipe referansinin 1000 karakter cevresinde sig/expires/token parametresi',
    re: /[?&](sig|signature|expires|token)=/g,
    klass: 'signed-param',
    weight: 4,
    contextual: 'audiopipe',
  },
  {
    id: 'sw_passthrough',
    label: 'Service Worker passthrough URL builder',
    re: /\/passthrough\?/g,
    klass: 'usage',
    weight: 0,
  },
  {
    id: 'url_searchparams',
    label: 'URLSearchParams ile URL kurulumu',
    re: /new URLSearchParams\s*\(/g,
    klass: 'usage',
    weight: 0,
  },
];

// Bir kaynaktan en fazla kac kanit parcasi saklanir (bellek korumasi).
const MAX_EVIDENCE_PER_RULE = 6;

/**
 * Tek bir metin kaynagini tarar.
 * @param {string} name  dosya adi / URL
 * @param {string} text  JS kaynagi
 * @returns {{name:string, size:number, hits:Array}}
 */
function analyzeText(name, text) {
  const src = String(text || '');
  const hits = [];

  // Baglamsal kural icin pencere indeksleri (audiopipe gecen yerler)
  const contextWindows = [];
  const ctxRe = /audiopipe/g;
  let cm;
  while ((cm = ctxRe.exec(src)) !== null) {
    contextWindows.push([Math.max(0, cm.index - 300), Math.min(src.length, cm.index + 700)]);
  }

  for (const rule of RULES) {
    // g deseni paylasildigi icin lastIndex sifirlanmali
    rule.re.lastIndex = 0;
    let match;
    let count = 0;
    let firstAt = -1;

    while ((match = rule.re.exec(src)) !== null) {
      // Baglamsal kural: yalnizca audiopipe penceresi icindeki eslesmeler sayilir
      if (rule.contextual === 'audiopipe' && !contextWindows.some(([a, b]) => match.index >= a && match.index <= b)) {
        if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
        continue;
      }
      count += 1;
      if (firstAt < 0) firstAt = match.index;
      // sonsuz dongu korumasi (bos eslesme)
      if (match.index === rule.re.lastIndex) rule.re.lastIndex += 1;
      if (count > 5000) break;
    }

    if (count === 0) continue;

    hits.push({
      rule: rule.id,
      label: rule.label,
      klass: rule.klass,
      count,
      evidence:
        firstAt >= 0
          ? src.slice(Math.max(0, firstAt - 70), Math.min(src.length, firstAt + 110)).replace(/\s+/g, ' ')
          : null,
    });
  }

  return { name, size: src.length, hits };
}

/**
 * Birden fazla kaynagi tarar ve ozet uretir.
 * @param {Array<{name:string,text:string}>} sources
 */
function analyzeSources(sources) {
  const startedAt = Date.now();
  const perSource = [];
  const totals = {};

  for (const s of sources) {
    const res = analyzeText(s.name, s.text);
    for (const h of res.hits) {
      if (!totals[h.rule]) {
        totals[h.rule] = {
          rule: h.rule,
          label: h.label,
          klass: h.klass,
          files: 0,
          occurrences: 0,
          evidence: [],
        };
      }
      totals[h.rule].files += 1;
      totals[h.rule].occurrences += h.count;
      if (totals[h.rule].evidence.length < MAX_EVIDENCE_PER_RULE) {
        totals[h.rule].evidence.push({ file: res.name, snippet: h.evidence });
      }
    }
    // kaynak metnini hemen birak (bellek)
    perSource.push({ name: res.name, size: res.size, rules: res.hits.map((h) => h.rule) });
  }

  const findings = Object.values(totals).sort((a, b) => b.occurrences - a.occurrences);
  const scored = findings.reduce((acc, f) => {
    const rule = RULES.find((r) => r.id === f.rule);
    return acc + (rule ? rule.weight : 0);
  }, 0);

  return {
    ok: true,
    scanned_files: sources.length,
    scanned_bytes: sources.reduce((a, s) => a + String(s.text || '').length, 0),
    elapsed_ms: Date.now() - startedAt,
    score: scored,
    verdict: verdictOf(findings),
    findings,
    per_file: perSource,
  };
}

/**
 * Bulgulardan karar metni uretir.
 * Kural: AWS S3 presign (SigV4) kodu ile ayni dosyada bulunan imzalama
 * cagrilari "akis imzasi" sayilmaz — yanlis pozotiftir.
 */
function verdictOf(findings) {
  const byId = (id) => findings.find((f) => f.rule === id);

  const filesOf = (ids) => {
    const set = new Set();
    for (const id of ids) {
      const f = byId(id);
      if (!f) continue;
      for (const e of f.evidence) set.add(e.file);
    }
    return set;
  };

  const signingFiles = filesOf(['crypto_sign', 'node_hmac', 'sig_query', 'signature_key', 'expires_param']);
  const awsFiles = filesOf(['aws_sigv4']);
  const suspect = [...signingFiles].filter((f) => !awsFiles.has(f));

  const nearAudioPipe = byId('sig_near_audiopipe');
  const drm = !!(byId('drm_license') || byId('drm_aes'));

  if (nearAudioPipe && nearAudioPipe.occurrences > 0) {
    return (
      'IMZA IZI VAR (guclu): audiopipe referansinin cevresinde sig/expires/token parametresi ' +
      'geciyor. SIGNER_SPEC ile bu zincir taklit edilebilir.'
    );
  }

  if (suspect.length > 0) {
    return (
      `IMZA IZI VAR (zayif): ${suspect.length} dosyada imzalama cagrisi bulundu (${suspect.join(', ')}). ` +
      'Bu dosyalar akis URL\'si ile ilgiliyse "derive" stratejisi denenebilir.'
    );
  }

  let out =
    'IMZA IZI YOK: taranan bundle icinde akis/audiopipe URL\'sini imzalayan bir kod ' +
    '(sig / signature / HMAC / subtle.sign) bulunmadi.';
  if (awsFiles.size > 0) {
    out += ' Bulunan HMAC/SHA-256 cagrilari yalnizca AWS S3 presign (SigV4) dosyasinda: ' + [...awsFiles].join(', ') + '.';
  }
  if (drm) {
    out +=
      ' Buna karsilik DRM/lisans yolu MEVCUT: icerik AES ile sifreli, anahtar /api/mango/rights ' +
      'lisans ucundan geliyor. Yani eksik olan sey imza degil, cozme anahtari.';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. KAYNAK YUKLEYICILER
// ---------------------------------------------------------------------------

/** Yerel bir dizindeki .js dosyalarini tarar (tek tek okur, bellege yigmaz). */
async function analyzeDirectory(dir, fs, path) {
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
  const sources = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.size > 4 * 1024 * 1024) continue; // 4 MB ustunu atla (bellek korumasi)
    sources.push({ name: n, text: fs.readFileSync(p, 'utf8') });
  }
  return analyzeSources(sources);
}

/** Verilen URL listesini indirip tarar (varsayilan: sirali, nazik). */
async function analyzeUrls(urls, opts = {}) {
  const timeout = opts.timeout || 20000;
  const maxBytes = opts.maxBytes || 3 * 1024 * 1024;
  const ua = opts.userAgent || 'Mozilla/5.0 (compatible; suno-beat-proxy re/1.0)';
  const sources = [];
  const failed = [];

  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await axios.get(url, {
        timeout,
        responseType: 'text',
        maxContentLength: maxBytes,
        proxy: false,
        headers: { 'User-Agent': ua, Accept: '*/*' },
        validateStatus: (s) => s >= 200 && s < 300,
      });
      sources.push({ name: url, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) });
    } catch (err) {
      failed.push({ url, error: err.message });
    }
  }

  const report = analyzeSources(sources);
  report.failed = failed;
  return report;
}

/** HTML icinden <script src> yollarini cikarir. */
function extractScriptSrcs(html, baseUrl, pagePathPrefix = '/_next/static/') {
  const out = new Set();
  const re = /<script[^>]+src=["']([^"']+\.js)["']/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const src = m[1];
    if (!src.includes(pagePathPrefix)) continue;
    try {
      out.add(new URL(src, baseUrl).toString());
    } catch (_e) {
      /* gecersiz src -> atla */
    }
  }
  return Array.from(out);
}

module.exports = {
  RULES,
  analyzeText,
  analyzeSources,
  analyzeUrls,
  analyzeDirectory,
  extractScriptSrcs,
};
