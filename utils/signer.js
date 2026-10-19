'use strict';

/**
 * ============================================================================
 *  utils/signer.js  —  IMZA MOTORU (Signature Strategy Engine)
 * ============================================================================
 *
 *  NE YAPAR
 *  --------
 *  Bir klip id'si + baglam (timestamp, cerezler, secret) alip **istek
 *  parametreleri** uretir. Ornegin:
 *
 *      { sig: "hmac_sha256_hex(...)", ts: 1792384000, expires: 1792384300 }
 *
 *  Bu parametreler daha sonra audiopipe/CDN URL'sine EKLENIR. Motor, hangi
 *  parametrelerin uretilecegine dair bir "spec" (kucuk bir ifade dili) ile
 *  calisir; varsayilan spec BOSTUR, yani hicbir parametre uretilmez.
 *
 *  NE YAPMAZ  (kapsam siniri)
 *  --------------------------
 *  - Icerik cozmez / sifre cozmez. AES anahtari, DRM lisansi, klip sifre
 *    cozumu BU MODULUN DISINDADIR. Modul yalnizca HTTP request parametresi
 *    uretir; donen baytlara dokunmaz.
 *  - Gizli anahtar (secret) ICERMEZ. `{secret}` token'i .env'den okunur.
 *  - Tarayici otomasyonu kullanmaz (Playwright/Chromium yok).
 *
 *  STRATEJILER (oncelik sirasi ile)
 *  --------------------------------
 *    1. client   : istemci imzali parametreleri kendisi gonderir
 *                  (?sig=...&expires=... veya X-Signed-Url)
 *    2. pool     : Token Cache Pool'da taze bir parametre seti var
 *                  (utils/signerPool.js — arka planda tazelenir)
 *    3. derive   : SIGNER_SPEC ile matematiksel turetim (bu dosya)
 *    4. none     : hicbir parametre yok — URL sablondan geldigi gibi kalir
 *
 *  STRATEJI 3 HAKKINDA DURUST NOT
 *  ------------------------------
 *  Statik RE (bkz. re/frontend-signature-analysis.json) Suno'nun mevcut web
 *  bundle'inda audiopipe URL'sini imzalayan bir kod bulmadi. Yani `derive`
 *  stratejisi "kesfedilmis bir algoritma" degil, **hipotez test aracidir**:
 *  spec'i siz doldurursunuz (orn. tarayicida yakaladiginiz bir sig'in
 *  hangi girdilerden olustugunu buldugunuzda), motor da o spec'e gore
 *  parametre uretir ve /debug/signer ile bayt akitip akitmadigi OLCULUR.
 *  Boylece "imza yuzunden 0 bayt geliyor" iddiasi tahmin degil, olcum olur.
 * ============================================================================
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 1. STATIK RE OZETI  (2026-10-19 tarihli bundle taramasinin sonucu)
// ---------------------------------------------------------------------------
//  Ayrintili kanit: re/frontend-signature-analysis.json
//  Yeniden uretmek icin:  node tools/scan-signer.js
// ---------------------------------------------------------------------------
const RE_FINDINGS = {
  scanned_at: '2026-10-19',
  source: 'https://suno.com/ -> /_next/static/immutable/chunks/*.js',
  files_scanned: 90,
  bytes_scanned: 7_100_000,
  verdict: 'no-client-side-signing',
  summary:
    'Bundle icinde audiopipe/akis URL imzalayan kod yok (sig / signature / HMAC / subtle.sign). ' +
    'Bulunan tek HMAC, AWS S3 presign (SigV4) zinciridir. Buna karsilik DRM yolu mevcut: ' +
    'icerik AES-CTR ile sifreli, anahtar POST /api/mango/rights lisans ucundan geliyor.',
  key_facts: [
    'Akis URL\'si istemcide IMZALANMIYOR: klip nesnesindeki hazir URL (audio_url / encryptedUrl) oldugu gibi kullaniliyor.',
    'Service Worker yolu: `${SW_BASE}/passthrough?contentId=<id>&src=<encryptedUrl>&contentType=clip` — sadece 3 parametre, imza yok.',
    'Alan adi allowlist\'i istemcide: /^(audiopipe|audiopipe-dev)\\./ + dn3ebm5xp8ng9.cloudfront.net + d2lb3d8e434rsy.cloudfront.net',
    'Lisans: POST /api/mango/rights  body:{content_params:{content_id,content_type}} -> { key, iv, glt }',
    'Anahtar zinciri: AES-GCM(key=SHA-256(glt), iv=ilk 12 bayt, aad=content_id) -> AES-CTR anahtari -> icerik cozumu.',
    'Yani 0 bayt sorunu bir imza sorunu degil; ya URL/oturum gecerliligi ya da lisans/cozme katmani sorunudur.',
  ],
};

// ---------------------------------------------------------------------------
// 2. TURETIM FONKSIYONLARI  (spec icinde cagrilabilir saf fonksiyonlar)
// ---------------------------------------------------------------------------
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const DERIVERS = {
  // --- hash aileleri ---
  sha256_hex: (s) => crypto.createHash('sha256').update(String(s)).digest('hex'),
  sha256_b64url: (s) => b64url(crypto.createHash('sha256').update(String(s)).digest()),
  sha1_hex: (s) => crypto.createHash('sha1').update(String(s)).digest('hex'),
  md5_hex: (s) => crypto.createHash('md5').update(String(s)).digest('hex'),
  md5_b64url: (s) => b64url(crypto.createHash('md5').update(String(s)).digest()),

  // --- hmac ailesi (anahtar spec'ten veya .env'den gelir) ---
  hmac_sha256_hex: (data, key) =>
    crypto.createHmac('sha256', String(key)).update(String(data)).digest('hex'),
  hmac_sha256_b64url: (data, key) =>
    b64url(crypto.createHmac('sha256', String(key)).update(String(data)).digest()),
  hmac_sha1_hex: (data, key) =>
    crypto.createHmac('sha1', String(key)).update(String(data)).digest('hex'),

  // --- kodlama / normalizasyon ---
  b64url: (s) => b64url(Buffer.from(String(s))),
  b64: (s) => Buffer.from(String(s)).toString('base64'),
  hex: (s) => Buffer.from(String(s), 'utf8').toString('hex'),
  urlenc: (s) => encodeURIComponent(String(s)),
  upper: (s) => String(s).toUpperCase(),
  lower: (s) => String(s).toLowerCase(),

  // --- zaman / rastgele ---
  unix: () => String(Math.floor(Date.now() / 1000)),
  unix_ms: () => String(Date.now()),
  uuid: () => crypto.randomUUID(),
  nonce: () => crypto.randomBytes(8).toString('hex'),
};

// Fonksiyon adlari -> minimum arguman sayisi (spec dogrulamasi icin)
const DERIVER_ARITY = {
  sha256_hex: 1,
  sha256_b64url: 1,
  sha1_hex: 1,
  md5_hex: 1,
  md5_b64url: 1,
  hmac_sha256_hex: 2,
  hmac_sha256_b64url: 2,
  hmac_sha1_hex: 2,
  b64url: 1,
  b64: 1,
  hex: 1,
  urlenc: 1,
  upper: 1,
  lower: 1,
  unix: 0,
  unix_ms: 0,
  uuid: 0,
  nonce: 0,
};

// ---------------------------------------------------------------------------
// 3. TOKEN COZUMLEME
// ---------------------------------------------------------------------------
//  Desteklenen token'lar:
//     {id}              -> klip id
//     {ts}              -> unix saniye
//     {ts_ms}           -> unix milisaniye
//     {ts_plus:300}     -> unix saniye + 300
//     {nonce}           -> 16 hex rastgele
//     {secret}          -> SIGNER_SECRET (loglanmaz)
//     {cookie:__client} -> ham Cookie header'indan okunur
//     {query:sig}       -> istemci istegindeki query parametresi
//     {env:MY_VAR}      -> process.env
//     {header:x-foo}    -> istek header'i
// ---------------------------------------------------------------------------
const TOKEN_RE = /\{([a-zA-Z0-9_:.\-]+)\}/g;

function readCookie(cookieHeader, name) {
  const raw = String(cookieHeader || '');
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function resolveToken(name, ctx) {
  const colon = name.indexOf(':');
  const head = colon < 0 ? name : name.slice(0, colon);
  const tail = colon < 0 ? '' : name.slice(colon + 1);

  switch (head) {
    case 'id':
      return String(ctx.clipId || '');
    case 'ts':
      return String(Math.floor((ctx.now || Date.now()) / 1000));
    case 'ts_ms':
      return String(ctx.now || Date.now());
    case 'ts_plus':
      return String(Math.floor((ctx.now || Date.now()) / 1000) + (Number.parseInt(tail, 10) || 0));
    case 'nonce':
      return ctx.nonce || crypto.randomBytes(8).toString('hex');
    case 'secret':
      return ctx.secret || '';
    case 'cookie':
      return readCookie(ctx.cookieHeader, tail);
    case 'query':
      return ctx.query && ctx.query[tail] !== undefined ? String(ctx.query[tail]) : '';
    case 'header':
      return ctx.headers && ctx.headers[tail.toLowerCase()] ? String(ctx.headers[tail.toLowerCase()]) : '';
    case 'env':
      return process.env[tail] || '';
    default:
      return ''; // bilinmeyen token -> bos string (URL'i bozmayalim)
  }
}

function interpolate(expr, ctx) {
  return String(expr).replace(TOKEN_RE, (_m, name) => resolveToken(name, ctx));
}

// ---------------------------------------------------------------------------
// 4. IFADE COZUMLEME  (fonksiyon cagrilari + tirnakli literaller + token'lar)
// ---------------------------------------------------------------------------
const FN_RE = /^([a-z0-9_]+)\(([\s\S]*)\)$/i;

/** Ust seviye virgullere gore argumanlari boler (parantez/tirnak farkinda). */
function splitArgs(raw) {
  const args = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of String(raw)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '' || args.length > 0) args.push(cur.trim());
  return args;
}

/** Bir degeri cozer. Hatalar firlatilir; cagiran taraf yakalar. */
function resolveExpression(expr, ctx) {
  const raw = String(expr).trim();
  if (raw === '') return '';

  // 1) tirnakli literal
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1);
  }

  // 2) fonksiyon cagrisi
  const fn = raw.match(FN_RE);
  if (fn && DERIVERS[fn[1].toLowerCase()]) {
    const name = fn[1].toLowerCase();
    const args = splitArgs(fn[2]).map((a) => resolveExpression(a, ctx));
    const arity = DERIVER_ARITY[name] || 0;
    if (args.length < arity && !(arity === 0 && args.length === 1 && args[0] === '')) {
      throw new Error(`${name} en az ${arity} arguman bekliyor, ${args.length} aldi`);
    }
    return String(DERIVERS[name](...args));
  }
  if (fn) throw new Error(`Bilinmeyen fonksiyon: ${fn[1]}`);

  // 3) token interpolasyonu
  return interpolate(raw, ctx);
}

// ---------------------------------------------------------------------------
// 5. SPEC PARSER
// ---------------------------------------------------------------------------
//  Sozdizimi (noktali virgul veya & ile ayrilir):
//      key=ifade;key2=ifade
//
//  Ornek:
//      sig=hmac_sha256_hex({id}|{ts},{secret});ts={ts};expires={ts_plus:300}
// ---------------------------------------------------------------------------
const MAX_PARAMS = 12;
const MAX_VALUE_LEN = 2048;
const MAX_SPEC_LEN = 2000;

function parseSpec(spec) {
  const out = { ok: true, assignments: [], errors: [] };
  const text = String(spec || '').trim();
  if (!text) return out;
  if (text.length > MAX_SPEC_LEN) {
    return { ok: false, assignments: [], errors: ['spec cok uzun (max 2000 karakter)'] };
  }

  const parts = text.split(/[;&]/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      out.errors.push(`Gecersiz atama (key=value bekleniyor): ${part.slice(0, 40)}`);
      continue;
    }
    const key = part.slice(0, eq).trim();
    const expr = part.slice(eq + 1).trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) {
      out.errors.push(`Gecersiz parametre adi: ${key.slice(0, 40)}`);
      continue;
    }
    out.assignments.push({ key, expr });
  }

  if (out.assignments.length > MAX_PARAMS) {
    out.errors.push(`Cok fazla parametre (max ${MAX_PARAMS})`);
    out.assignments = out.assignments.slice(0, MAX_PARAMS);
  }
  out.ok = out.errors.length === 0;
  return out;
}

/**
 * Spec'e gore parametreleri uretir.
 * ASLA throw etmez; hatalari `errors` dizisinde dondurur.
 *
 * @param {string} spec
 * @param {object} ctx  {clipId, now?, secret?, cookieHeader?, query?, headers?}
 * @returns {{ok:boolean, params:object, errors:string[], spec?:string}}
 */
function deriveParams(spec, ctx = {}) {
  const parsed = parseSpec(spec);
  if (!parsed.assignments.length) {
    return { ok: parsed.ok, params: {}, errors: parsed.errors, empty: true };
  }

  const params = {};
  const errors = [...parsed.errors];
  const localCtx = { ...ctx, nonce: ctx.nonce || crypto.randomBytes(8).toString('hex') };

  for (const { key, expr } of parsed.assignments) {
    try {
      const value = resolveExpression(expr, localCtx);
      if (String(value).length > MAX_VALUE_LEN) {
        errors.push(`${key}: deger cok uzun`);
        continue;
      }
      params[key] = value;
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }

  return { ok: errors.length === 0, params, errors, spec: String(spec) };
}

// ---------------------------------------------------------------------------
// 6. URL'E EKLEME
// ---------------------------------------------------------------------------
/** Parametreleri URL'e ekler (mevcut degeri ezer). Gecersiz URL -> aynen doner. */
function buildSignedUrl(baseUrl, params) {
  try {
    const u = new URL(String(baseUrl));
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  } catch (_e) {
    return String(baseUrl);
  }
}

/** Log/rapor icin hassas degerleri maskeler. */
function redactParams(params, keys = ['sig', 'signature', 'token', 'hmac', 'key', 'secret']) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    const s = String(v);
    out[k] = keys.includes(k.toLowerCase()) ? `${s.slice(0, 6)}…(${s.length})` : s;
  }
  return out;
}

/** URL'i loglanabilir hale getirir (imza degerleri kisaltilir). */
function redactUrl(url) {
  try {
    const u = new URL(String(url));
    const keys = ['sig', 'signature', 'token', 'hmac', 'key'];
    for (const k of keys) {
      if (u.searchParams.has(k)) {
        const v = u.searchParams.get(k);
        u.searchParams.set(k, `${v.slice(0, 6)}…(${v.length})`);
      }
    }
    return u.toString();
  } catch (_e) {
    return String(url);
  }
}

// ---------------------------------------------------------------------------
// 7. OZET / RAPOR
// ---------------------------------------------------------------------------
function summary() {
  return {
    strategies: [
      { id: 'client', priority: 1, available: true, note: 'Istemci imzali parametre gonderir (?sig= / X-Signed-Url).' },
      { id: 'pool', priority: 2, available: true, note: 'Token cache havuzu (utils/signerPool.js).' },
      { id: 'derive', priority: 3, available: true, note: 'SIGNER_SPEC ile deterministik turetim.' },
      { id: 'none', priority: 4, available: true, note: 'Parametresiz sablon URL.' },
    ],
    derivers: Object.keys(DERIVERS),
    re_findings: RE_FINDINGS,
  };
}

module.exports = {
  RE_FINDINGS,
  DERIVERS,
  DERIVER_ARITY,
  parseSpec,
  deriveParams,
  resolveExpression,
  buildSignedUrl,
  redactParams,
  redactUrl,
  readCookie,
  summary,
};
