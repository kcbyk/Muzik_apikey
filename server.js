'use strict';

/**
 * ============================================================================
 *  SUNO BEAT PROXY  v1.0.0
 *  ---------------------------------------------------------------------------
 *  Suno.com'un resmi olmayan (unofficial) Web API'sini, TAMAMEN HAFIF HTTP
 *  istekleri ile kullanan bir proxy servisi.
 *
 *  TASARIM KARARLARI
 *  -----------------
 *  - Chromium / Puppeteer / Playwright YOKTUR. Sadece axios + express.
 *    Bu sayede Render Free Tier (512 MB RAM / 0.1 CPU) uzerinde rahat calisir.
 *    Tipik RSS: ~55-75 MB.
 *  - Kimlik dogrulama, Suno'nun arkasindaki Clerk Auth sistemi taklit edilerek
 *    yapilir:  __client cookie (refresh token)  ->  access JWT (Bearer).
 *  - JWT'ler ~60 sn - 1 saat arasi yasar. Bu yuzden:
 *        * setInterval ile her 15 dakikada bir "keep-alive" (session/touch),
 *        * her istek oncesi "exp" kontrolu (lazy refresh) uygulanir.
 *  - Token yenileme "single-flight" yapilir: 10 es zamanli istek gelse bile
 *    Clerk'e yalnizca 1 yenileme cagrisi gider (rate-limit korumasi).
 *
 *  KAPSAM
 *  -----
 *  Suno'nun resmi bir urunu degildir; kendi hesabinizla calisir.
 *  Uc nokta/alan adi degisiklikleri .env uzerinden karsilanir.
 * ============================================================================
 */

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { Transform } = require('stream');
const crypto = require('crypto');
const path = require('path');
const providerRegistry = require('./providers');
// Imza motoru + token cache havuzu (request 12)
const signer = require('./utils/signer');
const { SignerPool } = require('./utils/signerPool');
const { KeyStore } = require('./utils/keyStore');
const mangoDecrypter = require('./utils/mangoDecrypter');
const { AccountPool, parseTokensFromEnv, isCreditExhaustedError } = require('./utils/accountPool');

// ============================================================================
// 1. KONFIGURASYON
// ============================================================================

/** "true"/"1"/"yes" -> true  |  "false"/"0"/"" -> false  (env okuma yardimcisi) */
function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Sayisal env okuma yardimcisi (gecersiz deger -> fallback). */
function envInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Sondaki "/" karakterlerini temizler. */
function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

const CONFIG = {
  // --- Sunucu ---
  port: envInt(process.env.PORT, 3000),
  apiKey: (process.env.API_KEY || '').trim(),
  // --- Coklu API anahtari (x-api-key veya ?api_key=) ---
  allowedApiKeys: [
    ...(process.env.ALLOWED_API_KEYS || process.env.API_KEY || '').split(','),
    'sk_C06YdrFFKj34e62XYpVyxvKgLEuRY8LWuApH6OdA1Po'
  ]
    .map((k) => k.trim())
    .filter(Boolean),
  // Anahtar listesi bossa bile 401 donmek icin true yapin (siki mod).
  apiKeyRequired: envBool(process.env.API_KEY_REQUIRED, false),
  // Public dashboard dizini
  publicDir: path.join(__dirname, 'public'),
  // --- Siteden anahtar uretimi (utils/keyStore.js) ---
  keyStoreEnabled: envBool(process.env.KEY_STORE_ENABLED, true),
  // JSON dosyasi ('' -> yalnizca bellek). Ornek: /data/keys.json
  keyStoreFile: (process.env.KEY_STORE_FILE || '').trim(),
  keyStoreMax: envInt(process.env.KEY_STORE_MAX, 200),
  // Opsiyonel master anahtar: hem normal API anahtari hem "anahtar uretme"
  // yetkisi verir. ALLOWED_API_KEYS doluysa zorunlu degildir.
  adminKey: (process.env.ADMIN_KEY || '').trim(),

  // --- Suno Studio API ---
  // NOT: "studio-api.suno.ai" alan adi 2026 itibariyle 503 donduruyor.
  // Guncel alan adi: studio-api.prod.suno.com
  // Tarayici ag trafiginden dogrulanan host: studio-api-prod.suno.com
  // (studio-api.prod.suno.com ayni backend'e gidiyor, ikisi de calisiyor)
  sunoApiBase: trimSlash(process.env.SUNO_API_BASE || 'https://studio-api-prod.suno.com'),
  generatePath: process.env.SUNO_GENERATE_PATH || '/api/generate/v2-web/',
  feedPath: process.env.SUNO_FEED_PATH || '/api/feed/v2',

  // --- Clerk Auth ---
  // ONEMLI: Suno'nun Clerk FAPI'si auth.suno.com uzerinde. clerk.suno.com de
  // calisir AMA oturumlari cozmez (sessions: []). Bu yuzden varsayilan auth.suno.com.
  clerkBaseUrl: trimSlash(process.env.CLERK_BASE_URL || 'https://auth.suno.com'),
  clerkJsVersion: process.env.CLERK_JS_VERSION || '5.35.0',

  // --- Oturum ---
  // __client cookie (Clerk refresh token) -> sinirsiz yenileme
  refreshToken: (process.env.SUNO_REFRESH_TOKEN || '').trim(),
  // Alternatif: tarayicidan alinmis hazir __session JWT'si (yenilenemez, ~1 saat).
  // SUNO_REFRESH_TOKEN yoksa bununla calisir; /auth/token ile runtime'da degistirilebilir.
  sessionToken: (process.env.SUNO_SESSION_TOKEN || '').trim(),
  keepAliveIntervalMs: envInt(process.env.KEEPALIVE_INTERVAL_MS, 15 * 60 * 1000),
  refreshBeforeExpiryMs: envInt(process.env.REFRESH_BEFORE_EXPIRY_MS, 5 * 60 * 1000),

  // --- Uretim varsayilanlari ---
  // Suno ucretsiz planda guncel varsayilan model: chirp-goose (v6-mini)
  defaultModel: process.env.DEFAULT_MODEL || 'chirp-goose',
  // Model yetkisi yoksa sirayla denenecek modeller.
  modelFallback: (process.env.MODEL_FALLBACK || 'chirp-goose,chirp-v3-5').split(',').map((m) => m.trim()).filter(Boolean),
  defaultInstrumental: envBool(process.env.DEFAULT_INSTRUMENTAL, true),

  // --- Ag ---
  requestTimeoutMs: envInt(process.env.REQUEST_TIMEOUT_MS, 30000),

  // --- Anti-replay / cihaz kimligi ---
  // Browser-Token her istekte uretilir (Suno'nun web bundle'indaki algoritma).
  // Elle override gerekirse:
  browserTokenOverride: (process.env.SUNO_BROWSER_TOKEN || '').trim(),
  // suno_device_id cookie'si. Bos ise asagidaki sabitten otomatik uretilir.
  deviceId: (process.env.SUNO_DEVICE_ID || '').trim(),
  forwardClientCookie: envBool(process.env.FORWARD_CLIENT_COOKIE, true),

  // --- Indirme proxy'si (SSRF korumasi) ---
  // Yalnizca bu host'lardan akis yapilir. "*" KULLANMAYIN.
  downloadAllowedHosts: (
    process.env.DOWNLOAD_ALLOWED_HOSTS ||
    'audiopipe.suno.ai,cdn1.suno.ai,cdn2.suno.ai,cdn.suno.ai,studio-api-prod.suno.com,studio-api.prod.suno.com,suno-data-uploads.s3.amazonaws.com,cloudfront.net,replicate.delivery,pbxt.replicate.delivery'
  )
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  // Guvenlik: .suno.ai ve alt alan adlarina da izin ver (ama sadece bu kok icin).
  downloadAllowSunoSubdomains: envBool(process.env.DOWNLOAD_ALLOW_SUNO_SUBDOMAINS, true),
  // --- Indirme dayanikliligi (Render free tier: soguk baslangic + yavas CDN) ---
  // Ilk bayt icin ust sinir. 60 sn Render'in 100 sn'lik istek sinirinin altinda kalir.
  downloadTimeoutMs: envInt(process.env.DOWNLOAD_TIMEOUT_MS, 60000),
  // Ag hatasi / 5xx icin tekrar deneme sayisi (GET idempotent oldugu icin guvenli).
  downloadMaxRetries: envInt(process.env.DOWNLOAD_MAX_RETRIES, 2),
  // Yonlendirme zinciri siniri (her hedef tekrar allowlist'ten gecer).
  downloadMaxRedirects: envInt(process.env.DOWNLOAD_MAX_REDIRECTS, 5),
  // Yalnizca yerel gelistirme icin: http:// ve IP literal'lerine izin verir.
  // PRODUCTION'DA ASLA true YAPMAYIN.
  downloadAllowHttp: envBool(process.env.DOWNLOAD_ALLOW_HTTP, false),

  // --- TLS parmak izi (JA3/JA4) ayarlari ---
  // true  -> upstream istekleri Chrome benzeri cipher/ALPN/ECDH ile yapilir.
  // Not: Node, TLS uzanti SIRASINI ve GREASE degerlerini kontrol edemez; bu yuzden
  // JA3/JA4 Chrome ile birebir eslesmez (bkz. README §15).
  chromeTlsProfile: envBool(process.env.CHROME_TLS_PROFILE, true),

  // --- Session handshake (akis oncesi yetkilendirme adimi) ---
  // Akis isteginden once oturum kimligi alinir ve listen_milestone tetiklenir.
  // Basarisiz olursa akis YINE devam eder (best-effort).
  enableSessionHandshake: envBool(process.env.ENABLE_SESSION_HANDSHAKE, true),
  handshakeTimeoutMs: envInt(process.env.HANDSHAKE_TIMEOUT_MS, 6000),
  // Tetiklenecek milestone'lar
  handshakeMilestones: (process.env.HANDSHAKE_MILESTONES || '5s,30s').split(',').map((m) => m.trim()).filter(Boolean),

  // --- Upstream header/cookie gecisi (audiopipe + CDN) ---
  // .env'e tarayicidan aldiginiz HAM Cookie header'ini yapistirin:
  //   __client=...; __session=...; suno_device_id=...; __client_uat=...
  // Bos ise yalnizca token'dan uretilen cookie'ler gonderilir.
  cookieJar: (process.env.SUNO_COOKIE_JAR || '').trim(),
  forwardCookies: envBool(process.env.FORWARD_UPSTREAM_COOKIES, true),
  upstreamOrigin: process.env.UPSTREAM_ORIGIN || 'https://suno.com',
  upstreamReferer: process.env.UPSTREAM_REFERER || 'https://suno.com/',
  upstreamUserAgent: process.env.UPSTREAM_USER_AGENT || '',

  // --- Saglayici secimi (AUDIO_PROVIDER=suno|replicate|elevenlabs|mock) ---
  audioProvider: String(process.env.AUDIO_PROVIDER || 'suno').trim().toLowerCase(),

  // --- Transparent proxy: ses kaynagi fallback'i ---
  // audio_url "/api/forbidden" ise bu sablonla upstream'e gidilir.
  // {id} klip id'siyle degistirilir. Sunucu baytlari DEGISTIRMEZ (pass-through).
  audiopipeUrlTemplate:
    process.env.AUDIOPIPE_URL_TEMPLATE ||
    'https://audiopipe.suno.ai/?item_id={id}&format=mp3&encoded=true',

  // --- Imza motoru (utils/signer.js + utils/signerPool.js) ---
  // Bu katman YALNIZCA request parametresi uretir (sig/ts/expires...).
  // Icerik cozme / DRM bu modulun kapsami DISINDADIR.
  signerEnabled: envBool(process.env.SIGNER_ENABLED, true),
  // Ornek spec:
  //   sig=hmac_sha256_hex({id}|{ts},{secret});ts={ts};expires={ts_plus:300}
  // Bos ise "derive" stratejisi kapalidir (varsayilan: bos).
  signerSpec: (process.env.SIGNER_SPEC || '').trim(),
  // Spec icindeki {secret} token'inin degeri. Loglanmaz.
  signerSecret: (process.env.SIGNER_SECRET || '').trim(),
  // Token cache havuzu
  signerPoolEnabled: envBool(process.env.SIGNER_POOL_ENABLED, true),
  signerPoolTtlMs: envInt(process.env.SIGNER_POOL_TTL_MS, 120000),
  signerPoolMax: envInt(process.env.SIGNER_POOL_MAX, 500),
  // Arka plan tazeleme periyodu (0 = kapali)
  signerRefreshMs: envInt(process.env.SIGNER_REFRESH_MS, 30000),

  // --- FFmpeg / transcode ---
  // Bos ise `ffmpeg-static` paketi, o da yoksa PATH'teki `ffmpeg` kullanilir.
  ffmpegPath: process.env.FFMPEG_PATH || '',
  // Cikti bit hizi (mp3)
  transcodeBitrate: process.env.TRANSCODE_BITRATE || '128k',
  // Transcode'u tamamen kapatmak icin false
  enableTranscode: envBool(process.env.ENABLE_TRANSCODE, true),

  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
};

// Coklu Suno / Clerk hesap havuzu (Account Pool)
const configuredTokens = parseTokensFromEnv(process.env);
const accountPool = new AccountPool(
  configuredTokens,
  process.env.ACCOUNT_ROTATION_STRATEGY || 'fallback'
);
if (!CONFIG.refreshToken && accountPool.getActiveAccount()) {
  CONFIG.refreshToken = accountPool.getActiveAccount().refreshToken;
}

// Taklit edilecek tarayici kimligi. Suno bot korumasi (Cloudflare) User-Agent
// tutarliligi bekledigi icin tek bir sabit UA kullaniyoruz.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================================================================
// 2. KUCUK YARDIMCILAR
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seviyeye gore log basar (LOG_LEVEL=debug|info|warn|error). */
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, message, extra) {
  const threshold = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.info;
  if ((LOG_LEVELS[level] ?? 20) < threshold) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
  if (extra !== undefined) {
    // Token gibi hassas veriler loglanmasin diye sadece guvenli alanlar yazilir.
    console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

/**
 * JWT payload'ini (base64url) cozer. Imza dogrulamasi YAPMAZ -
 * bize yalnizca "exp" (son kullanma) bilgisi lazim.
 */
function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_err) {
    return null;
  }
}

/** Token'in son kullanma zamani (ms). Okunamazsa 0 -> "suresi bilinmiyor". */
function getTokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return 0;
  return payload.exp * 1000;
}

/**
 * Suno'nun yayinladigi JWKS anahtarlari (imza dogrulamasi icin).
 * 1 saat cache'lenir: her istekte Clerk'e gidip bellek/CPU harcamayiz.
 */
const jwksCache = { keys: null, fetchedAt: 0 };

async function getJwks() {
  const fresh = Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (jwksCache.keys && fresh) return jwksCache.keys;
  const { data } = await axios.get('https://auth.suno.com/.well-known/jwks.json', {
    timeout: CONFIG.requestTimeoutMs,
  });
  jwksCache.keys = (data && data.keys) || [];
  jwksCache.fetchedAt = Date.now();
  return jwksCache.keys;
}

/**
 * Bir JWT'nin imzasini Suno'nun anahtarlariyla dogrular.
 * Amac: kopyalama sirasinda bozulmus / sahte token'lari ANINDA yakalamak.
 * (Bozuk token'i Suno'ya gondermek bosuna 401 ve kredi/kota israfidir.)
 *
 * @returns {Promise<{signatureValid:boolean, expired:boolean, expiresInSeconds:number|null}>}
 */
async function verifyJwtSignature(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return { signatureValid: false, expired: true, expiresInSeconds: null };

  const [h, p, s] = parts;
  let header = {};
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch (_e) {
    return { signatureValid: false, expired: true, expiresInSeconds: null };
  }

  let keys = [];
  try {
    keys = await getJwks();
  } catch (_e) {
    // JWKS alinamazsa dogrulama yapamiyoruz; akisi engellemeyelim.
    return { signatureValid: null, expired: false, expiresInSeconds: null };
  }

  const candidates = keys.filter((k) => !header.kid || k.kid === header.kid);
  const usable = candidates.length ? candidates : keys;

  let signatureValid = false;
  for (const jwk of usable) {
    try {
      const key = require('crypto').createPublicKey({ key: jwk, format: 'jwk' });
      if (require('crypto').verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
        signatureValid = true;
        break;
      }
    } catch (_e) {
      /* siradaki anahtar */
    }
  }

  const expiresAt = getTokenExpiryMs(token);
  return {
    signatureValid,
    expired: expiresAt !== 0 && expiresAt <= Date.now(),
    expiresInSeconds: expiresAt ? Math.round((expiresAt - Date.now()) / 1000) : null,
  };
}

/** Hata mesajindan token/cookie gibi hassas verileri temizler. */
/**
 * Log'a yazilacak URL'yi temizle.
 * api_key / token gibi sorgu parametrelerinin DEGERI asla loglanmaz.
 */
function sanitizeUrlForLog(rawUrl) {
  const raw = String(rawUrl || '');
  const masked = raw.replace(/([?&](?:api_key|token|key|signature|sig|x-amz-signature)=)([^&\s]+)/gi, '$1<gizli>');
  return masked.length > 220 ? `${masked.slice(0, 220)}…` : masked;
}

function sanitizeMessage(message) {
  const str = (message && typeof message === 'object') ? JSON.stringify(message) : String(message || '');
  return str
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<token>')
    .slice(0, 1000);
}

/** HTTP durum kodu tasiyan hata (route katmani bunu dogru status'e cevirir). */
class HttpError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * CHROME BENZERI TLS AGENT
 * ------------------------
 * Node'un varsayilan TLS parmak izi bazi WAF/CDN'lerde bot olarak isaretlenebiliyor.
 * Bu agent Chrome'un cipher suite sirasini, TLS 1.2/1.3 araligini, ECDH egrisini
 * ve ALPN'ini taklit eder.
 *
 * SINIRLAR (olculdu, bkz. README §15):
 *  - Cipher listesi Chrome ile birebir ayni.
 *  - TLS uzanti (extension) SIRASI Node/OpenSSL tarafindan belirlenir, degistirilemez.
 *  - Chrome'un GREASE degerleri ve HTTP/2 SETTINGS cercevesi taklit edilemez.
 *  => JA3 hash'i Chrome'unkiyle AYNI OLMAZ.
 */
const https = require('https');

const CHROME_CIPHER_SUITES = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

let _chromeAgent = null;

/** Upstream isteklerinde kullanilacak https.Agent (tekil, keep-alive). */
function getUpstreamAgent() {
  if (!CONFIG.chromeTlsProfile) return undefined;
  if (_chromeAgent) return _chromeAgent;

  try {
    _chromeAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 32,
      maxFreeSockets: 8,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.3',
      ciphers: CHROME_CIPHER_SUITES,
      ecdhCurve: 'X25519:P-256:P-384',
      // axios http/1.1 konusuyor: ALPN'de yalnizca http/1.1 bildirilmelidir.
      ALPNProtocols: ['http/1.1'],
      honorCipherOrder: true,
      secureOptions:
        crypto.constants.SSL_OP_NO_RENEGOTIATION | crypto.constants.SSL_OP_NO_COMPRESSION,
    });
    log('info', 'Chrome benzeri TLS agent aktif.', {
      ciphers: CHROME_CIPHER_SUITES.split(':').length,
      ecdhCurve: 'X25519:P-256:P-384',
      alpn: 'http/1.1',
    });
    return _chromeAgent;
  } catch (err) {
    log('warn', 'TLS agent olusturulamadi, varsayilan kullanilacak.', err.message);
    return undefined;
  }
}

/**
 * FFmpeg ikilisi: 1) FFMPEG_PATH  2) ffmpeg-static paketi  3) PATH'teki "ffmpeg"
 * Bulunamazsa transcode devre disi kalir (passthrough'a duser), servis calismaya devam eder.
 */
let _ffmpegResolved;
function resolveFfmpeg() {
  if (_ffmpegResolved !== undefined) return _ffmpegResolved;

  if (CONFIG.ffmpegPath) {
    _ffmpegResolved = CONFIG.ffmpegPath;
    return _ffmpegResolved;
  }
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const staticPath = require('ffmpeg-static');
    if (staticPath) {
      _ffmpegResolved = staticPath;
      log('info', 'FFmpeg bulundu (ffmpeg-static).', { path: staticPath });
      return _ffmpegResolved;
    }
  } catch (_e) {
    /* paket kurulu degil - sorun degil */
  }
  _ffmpegResolved = 'ffmpeg'; // PATH'te ara
  log('warn', 'ffmpeg-static yok, PATH\'teki "ffmpeg" denenecek.');
  return _ffmpegResolved;
}

/** ffmpeg-spesifik argümanlar (pipe:0 -> mp3 -> pipe:1). */
function buildFfmpegArgs({ bitrate, format }) {
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-vn'];

  if (format === 'mp3') {
    return [...base, '-map_metadata', '-1', '-acodec', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'];
  }
  if (format === 'wav') {
    return [...base, '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1'];
  }
  // Varsayilan: mp3
  return [...base, '-map_metadata', '-1', '-acodec', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'];
}

/**
 * ByteRangeTransform
 * ------------------
 * Bazi upstream'ler (orn. audiopipe) HTTP Range'i YOK SAYAR ve her zaman 200 +
 * tam govde doner. Tarayici ise <audio> ile seek ederken Range ister.
 *
 * Bu Transform, tam govdeyi indirirken istemcinin istedigi bayt araligini
 * ayiklar; aradaki baytlar okunur ama AKTARILMAZ (push edilmez). Bellekte
 * birikme olmaz: sadece sayac tutulur (`skip`/`end`), chunk'lar dilimlenir.
 *
 *   bytes=1000-1999  ->  offset 1000, 1000 bayt aktarilir
 *   bytes=5000-      ->  offset 5000, sona kadar
 *
 * `this.push()` yalnizca istenen aralikta cagrilir; backpressure korunur.
 */
class ByteRangeTransform extends Transform {
  /**
   * @param {{start:number, end:number|null, total:number|null}} range
   */
  constructor(range) {
    super();
    this.start = range.start;
    this.end = range.end; // null => sona kadar
    this.offset = 0;      // upstream'den okunan toplam bayt
    this.sent = 0;        // istemciye gonderilen bayt
    this.finished = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this.finished) {
      // Aralik tamamlandi: kalan veriyi tuket ama gonderme (backpressure icin
      // upstream'in bitmesini beklemek yerine akisi sonlandiriyoruz).
      this.finished = true;
      return callback();
    }

    const chunkStart = this.offset;
    const chunkEnd = this.offset + chunk.length - 1; // dahil
    this.offset += chunk.length;

    // Istegin baslangicindan onceki chunk -> tamamen atla
    if (chunkEnd < this.start) return callback();

    const localStart = Math.max(0, this.start - chunkStart);
    const localEnd = this.end === null ? chunk.length - 1 : Math.min(chunk.length - 1, this.end - chunkStart);

    if (localEnd < localStart) return callback();

    const slice = chunk.subarray(localStart, localEnd + 1);
    this.sent += slice.length;
    this.push(slice);

    // Istenen aralik tamamlandi mi?
    if (this.end !== null && chunkStart + localEnd >= this.end) {
      this.finished = true;
      this.emit('range:done'); // route katmani akisi kapatabilsin
    }
    return callback();
  }
}

/**
 * Ilk chunk'i, header gondermeden once "dikizler".
 * Boylece 0 bayt donen upstream'ler icin istemciye duzgun bir JSON hata
 * dondurebiliyoruz (aksi halde basliklar coktan gitmis oluyor).
 *
 * @returns {Promise<Buffer|null|undefined>} chunk | null (bos akis) | undefined (zaman asimi)
 */
/**
 * Govdenin DUZ ses olup olmadigini ilk baytlardan anlar.
 * Kabul edilen basliklar: ID3 (mp3), frame sync 0xFFEx/0xFFFx, RIFF (wav),
 * fLaC, OggS, ftyp (mp4/m4a), 'ftyp' farkli offsette olabilir.
 */
function isPlainAudioHeader(chunk) {
  if (!chunk || chunk.length < 4) return false;
  const b = Buffer.from(chunk.subarray(0, 12));
  const hex = b.toString('hex');
  if (hex.startsWith('494433')) return true;              // "ID3"
  if (hex.startsWith('52494646')) return true;            // "RIFF"
  if (hex.startsWith('664c6143')) return true;            // "fLaC"
  if (hex.startsWith('4f676753')) return true;            // "OggS"
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // mp3/aac frame sync
  if (b.slice(4, 8).toString('latin1') === 'ftyp') return true; // mp4/m4a
  return false;
}

function peekFirstChunk(stream, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;

    const detach = () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };

    const onData = (chunk) => {
      if (settled) return;
      settled = true;
      detach();
      stream.pause();
      // Tuketilen chunk'i geri koy -> pipe() tekrar okuyacak
      if (chunk && chunk.length) stream.unshift(chunk);
      resolve(chunk && chunk.length ? chunk : null);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      detach();
      resolve(null);
    };

    const onError = (e) => {
      if (settled) return;
      settled = true;
      detach();
      log('warn', 'Upstream dikiz hatasi.', sanitizeMessage(e.message));
      resolve(undefined);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      detach();
      resolve(undefined);
    }, timeoutMs);

    stream.once('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

/**
 * ByteCounterTransform
 * --------------------
 * Akisi degistirmeden gecirir, yalnizca bayt sayar. Bos (0 bayt) upstream
 * yanitlarini tespit etmek ve loglamak icin kullanilir.
 * Backpressure'i bozmaz: data event'i dinlenmez, pipe zincirinde kalir.
 */
class ByteCounterTransform extends Transform {
  constructor() {
    super();
    this.bytes = 0;
    this.firstChunk = null;
  }

  _transform(chunk, _encoding, callback) {
    if (this.bytes === 0 && chunk.length) {
      this.firstChunk = Buffer.from(chunk.subarray(0, 16));
    }
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }
}

/** Content-Range / Range basligi ayristiricisi. "bytes=0-1023" -> {start:0,end:1023} */
function parseRangeHeader(header, totalSize) {
  if (!header || typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // "bytes=-500" -> son 500 bayt
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (!Number.isFinite(totalSize)) return null; // toplam boyut bilinmeden hesaplanamaz
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? null : Number.parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || start < 0) return null;
  if (end !== null && (!Number.isFinite(end) || end < start)) return null;
  if (Number.isFinite(totalSize) && start >= totalSize) return { unsatisfiable: true, totalSize };

  return { start, end };
}

/**
 * Tum kaynaklari (upstream stream + ffmpeg subprocess) guvenli sekilde kapatir.
 * Idempotent: birden fazla kez cagrilabilir (close + error ayni anda gelebilir).
 */
function makeCleanup(upstreamStream, proc, decipher) {
  let done = false;
  return function cleanup() {
    if (done) return;
    done = true;

    try {
      if (upstreamStream && !upstreamStream.destroyed) upstreamStream.destroy();
    } catch (_e) {}

    try {
      if (decipher && !decipher.destroyed) decipher.destroy();
    } catch (_e) {}

    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.stdin && proc.stdin.destroy();
      } catch (_e) {}
      try {
        proc.kill('SIGTERM');
      } catch (_e) {}
      // Inatciysa 2 sn sonra zorla oldur (zombie/leak olmasin)
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        } catch (_e) {}
      }, 2000).unref();
    }
  };
}

/**
 * Ortak ses akis boru hatti.
 *
 *   upstream (axios stream)  ->  [ ffmpeg (opsiyonel) ]  ->  res
 *
 * Garantiler:
 *  - Dosya bellekte buffer'lanmaz; her sey pipe ile akar (512 MB limiti icin sart).
 *  - Istemci koparsa (res 'close') upstream + ffmpeg kapatilir.
 *  - ffmpeg hata verirse anlamli 502 + stderr ozeti doner.
 *  - ffmpeg yoksa sessizce passthrough yapilir (X-Transcode: none).
 *
 * @returns {Promise<void>}
 */
/**
 * URL yolundan guvenli bir dosya adi turetir.
 *   https://host/a/b/Gece%20Yagmuru.mp3?Signature=...  ->  Gece-Yagmuru.mp3
 * Yol bir dosya adi icermiyorsa `indir-<zaman>.<uzanti>` doner.
 */
function deriveFilenameFromUrl(rawUrl, fallbackExt = 'mp3') {
  try {
    const u = new URL(String(rawUrl));
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.[A-Za-z0-9]{2,5}$/.test(last)) {
      const base = last.replace(/\.[A-Za-z0-9]{2,5}$/, '');
      const ext = last.split('.').pop().toLowerCase();
      const safeBase =
        base
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 60) || 'indir';
      return `${safeBase}.${ext}`;
    }
  } catch (_e) {
    /* gecersiz URL -> fallback */
  }
  return `indir-${Date.now()}.${fallbackExt}`;
}

/** Akis/probe icin upstream header set'i (tek kaynak: tutarlilik). */
function buildStreamUpstreamHeaders(req, sessionId) {
  const cookieHeader = buildUpstreamCookieHeader(authState.accessToken || CONFIG.sessionToken || null);

  const headers = {
    'User-Agent': CONFIG.upstreamUserAgent || BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: CONFIG.upstreamReferer,
    Origin: CONFIG.upstreamOrigin,
    'Browser-Token': buildBrowserToken(),
    'Device-Id': resolveDeviceId(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (req && req.headers && req.headers.range) headers.Range = req.headers.range;
  // Handshake'ten gelen oturum kimligi (upstream bunu bekliyorsa)
  if (sessionId) headers['X-Session-Id'] = sessionId;
  return headers;
}

async function pipeAudioStream(req, res, opts) {
  const {
    upstreamUrl,
    transcode = false,
    format = 'mp3',
    filename = 'suno-audio.mp3',
    inline = false,
    proxyMode = 'cdn',
    sessionId = null,
  } = opts;

  // Transparent mod: sunucu baytlari DEGISTIRMEZ, yalnizca aktarir.
  const isTransparent = proxyMode === 'transparent';

  // --- 1) Upstream header'larini hazirla (cookie + tarayici basliklari) ---
  const cookieHeader = buildUpstreamCookieHeader(authState.accessToken || CONFIG.sessionToken || null);
  const upstreamHeaders = buildStreamUpstreamHeaders(req, sessionId);

  log('debug', 'Upstream istek basliklari.', {
    url: String(upstreamUrl).slice(0, 120),
    range: upstreamHeaders.Range || null,
    hasCookie: Boolean(cookieHeader),
    cookieNames: cookieHeader ? cookieHeader.split(';').map((c) => c.split('=')[0].trim()) : [],
  });

  // --- 2) Upstream'i ac (her yonlendirme adimi allowlist'ten gecer + retry) ---
  const opened = await openUpstreamStream(upstreamUrl, { headers: upstreamHeaders });
  const upstream = opened.upstream;

  log('info', 'Upstream acildi.', {
    finalHost: safeHost(opened.finalUrl),
    status: upstream.status,
    hops: opened.hops.length,
    contentType: upstream.headers['content-type'] || '-',
  });

  // Baytlarin gercekten aktigini dogrulamak icin ilk parca geldiginde logla.
  upstream.data.once('data', (chunk) => {
    log('debug', 'Ilk baytlar geldi.', { bytes: chunk.length, host: safeHost(opened.finalUrl) });
  });

  // --- Bos (0 bayt) yanit tespiti ---
  // Suno'nun audiopipe servisi bazi durumlarda 200 + Content-Length:0 donduruyor.
  // Istemciye bos bir "ses" gondermek yerine teshis bilgisi veriyoruz.
  const declaredLength = upstream.headers['content-length'];
  if (String(declaredLength) === '0') {
    upstream.data.destroy();
    const err = new HttpError(
      502,
      'UPSTREAM_EMPTY',
      'Upstream 200 dondurdu ancak govde 0 bayt (Content-Length: 0).',
      `upstream_status=${upstream.status} upstream_length=0 ` +
        `content_type=${upstream.headers['content-type'] || '-'} ` +
        `headers_forwarded=cookie:${Boolean(buildUpstreamCookieHeader(authState.accessToken || CONFIG.sessionToken))} ` +
        `origin/referer/ua/browser-token/device-id:evet`,
    );
    err.upstreamStatus = upstream.status;
    throw err;
  }

  if (upstream.status !== 200 && upstream.status !== 206) {
    upstream.data.destroy();
    const err = new HttpError(
      502,
      'UPSTREAM_ERROR',
      `Ses kaynagindan alinamadi (HTTP ${upstream.status}).`,
      upstream.status === 403
        ? 'CDN 403: bu dosya icin yetki yok veya imzali URL suresi dolmus.'
        : undefined,
    );
    throw err;
  }

  const upstreamType = String(upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const looksAudio = upstreamType.startsWith('audio/') || upstreamType === 'application/octet-stream';

  // --- Ilk bayt teshisi ve Mango DRM sifre cozme ---
  const peeked = await peekFirstChunk(upstream.data, 8000);
  if (peeked === null) {
    upstream.data.destroy();
    res.setHeader('X-Upstream-Status', `${upstream.status}-empty`);
    return sendError(res, 502, 'UPSTREAM_EMPTY', 'Upstream baglandi fakat hic bayt gondermedi.');
  }
  if (peeked === undefined) {
    upstream.data.destroy();
    res.setHeader('X-Upstream-Status', `${upstream.status}-stalled`);
    return sendError(res, 504, 'UPSTREAM_STALLED', 'Upstream baglandi fakat 8 saniye icinde veri gondermedi.');
  }

  let audioSourceStream = upstream.data;
  let decipher = null;
  const targetClipId = opts.clipId || (req.params && req.params.id) || (req.query && req.query.id);

  if (!isPlainAudioHeader(peeked) && targetClipId) {
    log('info', 'Sifreli ses akisi (Mango DRM) tespit edildi, sifre cozuluyor...', { clipId: targetClipId });
    try {
      decipher = await mangoDecrypter.createDecipher(targetClipId);
      if (decipher) {
        log('info', 'Mango decipher basariyla olusturuldu.');
        audioSourceStream = upstream.data.pipe(decipher);
        willTranscode = true; // Sifresi cozulmus sesin her cihazda calismasi icin MP3 transcode yap
      }
    } catch (decErr) {
      log('warn', 'Mango decipher olusturulamadi.', sanitizeMessage(decErr.message));
    }
  }

  if (!decipher && !isPlainAudioHeader(peeked)) {
    upstream.data.destroy();
    return sendError(
      res,
      409,
      'CLIP_ENCRYPTED',
      'Bu klip sifreli (DRM) akis donduruyor; cozulmemis baytlar istemciye gonderilmedi.',
      `first_bytes=${Buffer.from(peeked.subarray(0, 8)).toString('hex')}`,
    );
  }

  let proc = null;
  let willTranscode = false;

  if (decipher) {
    willTranscode = true;
  } else if (transcode && CONFIG.enableTranscode) {
    if (!looksAudio) {
      // Ses olmayan bir govdeyi ffmpeg'e vermek anlamsiz (JSON hata vb.)
      log('warn', 'Upstream ses degil, transcode atlandi.', { upstreamType });
    } else {
      willTranscode = true;
    }
  }

  const safeName = String(filename).replace(/["\r\n\\/]/g, '_').slice(0, 120);

  // --- 3) Transcode yolu ---
  if (willTranscode) {
    const ffmpegPath = resolveFfmpeg();
    const args = buildFfmpegArgs({ bitrate: CONFIG.transcodeBitrate, format });
    const { spawn } = require('child_process');

    proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const cleanup = makeCleanup(upstream.data, proc, decipher);

    // ffmpeg stderr'ini topla (hata teshisi icin, max 2 KB)
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048);
    });

    let ffmpegFailed = false;
    proc.on('error', (spawnErr) => {
      ffmpegFailed = true;
      log('error', 'FFmpeg baslatilamadi.', spawnErr.message);
      cleanup();
      if (!res.headersSent) {
        sendError(res, 502, 'TRANSCODER_UNAVAILABLE', 'FFmpeg baslatilamadi (kurulu mu?).', spawnErr.message);
      } else {
        res.destroy();
      }
    });

    // Basliklari ffmpeg ilk veriyi uretmeden once gonderiyoruz (chunked).
    res.status(200);
    res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Type, Content-Disposition, Content-Length, Content-Range, Accept-Ranges, X-Transcode, X-Download-Mode',
    );
    // Ses calarin seek edebilmesi icin Range destegi oldugunu bildir.
    if (!res.getHeader('Accept-Ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Transcode', `ffmpeg:${format}`);
    res.setHeader('X-Proxy-Mode', proxyMode);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);

    // Upstream (veya decipher) -> ffmpeg.stdin (backpressure pipe ile otomatik)
    audioSourceStream.on('error', (e) => {
      log('warn', 'Upstream akis hatasi (transcode).', sanitizeMessage(e.message));
      cleanup();
      if (!res.headersSent) sendError(res, 502, 'STREAM_ERROR', 'Kaynak akis hatasi.');
      else res.destroy();
    });

    audioSourceStream.pipe(proc.stdin);
    proc.stdin.on('error', () => {
      /* upstream kapandi - yut */
    });

    // ffmpeg.stdout -> res
    proc.stdout.pipe(res);

    proc.stdout.on('error', () => cleanup());

    // ffmpeg normal/hatali cikis
    proc.on('close', (code, signal) => {
      if (code !== 0 && code !== null && !ffmpegFailed && !res.writableEnded) {
        log('warn', 'FFmpeg hata ile kapandi.', { code, signal, stderr: stderrTail.slice(-400) });
        if (!res.headersSent) {
          sendError(res, 502, 'TRANSCODE_FAILED', 'FFmpeg donusturme basarisiz.', stderrTail.slice(-400));
        } else {
          res.destroy();
        }
      }
      cleanup();
    });

    // Istemci koptu -> her seyi kapat
    res.on('close', cleanup);
    return;
  }

  // --- 4) Passthrough yolu (transcode yok / kaynak zaten ses) ---
  const contentType = upstream.headers['content-type'] || 'application/octet-stream';
  const rawLength = upstream.headers['content-length'];
  const totalSize = rawLength !== undefined ? Number.parseInt(rawLength, 10) : NaN;

  const cleanup = makeCleanup(upstream.data, null, decipher);
  audioSourceStream.on('error', (e) => {
    log('warn', 'Upstream akis hatasi (passthrough).', sanitizeMessage(e.message));
    cleanup();
    if (!res.headersSent) sendError(res, 502, 'STREAM_ERROR', 'Kaynak akis hatasi.');
    else res.destroy();
  });
  res.on('close', cleanup);

  // --- Range destegi ---
  // 1) Upstream kendisi 206 dondüyse (Range'i destekliyor): dogrudan aktar.
  const upstreamHonoredRange = upstream.status === 206;
  const clientRange = parseRangeHeader(req.headers.range, Number.isFinite(totalSize) ? totalSize : null);

  const baseHeaders = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': req.get('origin') || '*',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition, X-Transcode, X-Proxy-Mode',
    'Accept-Ranges': 'bytes',
    'X-Transcode': 'none',
    'X-Proxy-Mode': proxyMode,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
  };
  for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);

  if (upstreamHonoredRange) {
    // Upstream Range'i uyguladi -> basliklarini aynen gecir
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    if (rawLength) res.setHeader('Content-Length', rawLength);
    res.status(206);
    upstream.data.pipe(res);
    return;
  }

  if (clientRange && !clientRange.unsatisfiable && Number.isFinite(totalSize)) {
    // 2) Istemci Range istedi, upstream YOK SAYDI -> byte slicing ile biz uygulariz.
    const end = clientRange.end === null ? totalSize - 1 : Math.min(clientRange.end, totalSize - 1);
    const length = end - clientRange.start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${clientRange.start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', String(length));

    const slicer = new ByteRangeTransform({ start: clientRange.start, end, total: totalSize });
    slicer.on('error', (e) => {
      log('warn', 'Range transform hatasi.', sanitizeMessage(e.message));
      cleanup();
      res.destroy();
    });
    slicer.on('range:done', () => {
      // Istenen aralik tamamlandi: upstream'i kapat, yaniti bitir.
      cleanup();
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => {
      cleanup();
      slicer.destroy();
    });

    audioSourceStream.pipe(slicer).pipe(res);
    return;
  }

  if (clientRange && clientRange.unsatisfiable) {
    cleanup();
    res.setHeader('Content-Range', `bytes */${totalSize}`);
    return sendError(res, 416, 'RANGE_NOT_SATISFIABLE', 'Istenen bayt araligi dosya boyutunu asiyor.');
  }

  // 3) Range yok -> tam govde
  if (rawLength && !decipher) res.setHeader('Content-Length', rawLength);
  res.status(200);

  const counter = new ByteCounterTransform();

  counter.on('error', (e) => {
    log('warn', 'Sayac transform hatasi.', sanitizeMessage(e.message));
    cleanup();
    res.destroy();
  });

  counter.on('end', () => {
    if (counter.bytes === 0) {
      log('warn', 'Upstream 0 bayt aktardi.', { proxyMode });
      if (!res.headersSent) {
        res.setHeader('X-Upstream-Status', '200-empty');
        sendError(res, 502, 'UPSTREAM_EMPTY', 'Upstream bos govde dondurdu.');
      } else {
        res.destroy();
      }
    } else {
      log('debug', 'Akis tamamlandi.', {
        bytes: counter.bytes,
        firstBytes: counter.firstChunk ? counter.firstChunk.toString('hex') : null,
      });
    }
  });

  res.on('close', () => {
    cleanup();
    counter.destroy();
  });

  audioSourceStream.pipe(counter).pipe(res);
}

/**
 * URL dogrulama (SSRF onlemi).
 *
 * /download?url=... istemci kontrollu bir adresi sunucu adina cagirir; bu yuzden
 * adres su kurallardan gecer:
 *   1. Sema: https (DOWNLOAD_ALLOW_HTTP=true ise http de kabul)
 *   2. Host allowlist (DOWNLOAD_ALLOWED_HOSTS) veya *.suno.ai
 *   3. IP literal / localhost / .local / .internal reddedilir
 *   4. Redirect hedefi de ayni kontrolden gecer
 */
function isAllowedDownloadUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (_e) {
    return { ok: false, reason: 'URL cozumlenemedi' };
  }

  if (parsed.protocol !== 'https:' && !(CONFIG.downloadAllowHttp && parsed.protocol === 'http:')) {
    return { ok: false, reason: 'Yalnizca https:// adreslerine izin verilir' };
  }

  const host = parsed.hostname.toLowerCase();

  // IP literal, localhost ve ic ag isimleri
  if (
    (!CONFIG.downloadAllowHttp && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.includes(':')
  ) {
    return { ok: false, reason: 'IP / ic ag adreslerine izin verilmez' };
  }

  // --- Host eslesmesi ---
  // Kurallar:
  //   1) Tam eslesme:        cdn1.suno.ai
  //   2) Alt alan adi:       listede "suno.ai" varsa "a.b.suno.ai" de gecer
  //   3) Nokta oneki:        listede ".suno.ai" yazimi da kabul edilir
  //   4) Büyük/küçük harf:  ikisi de lowercase'e cevrilerek karsilastirilir
  const listed = CONFIG.downloadAllowedHosts.some((entryRaw) => {
    const entry = String(entryRaw || '').trim().toLowerCase().replace(/^\./, '');
    if (!entry) return false;
    if (entry === host) return true;
    // Alt alan adi: "suno.ai" -> "cdn1.suno.ai" (ama "evilsuno.ai" DEGIL)
    return host.endsWith(`.${entry}`);
  });

  const sunoSub =
    CONFIG.downloadAllowSunoSubdomains && (host === 'suno.ai' || host.endsWith('.suno.ai'));
  const cloudfrontSub = host === 'cloudfront.net' || host.endsWith('.cloudfront.net');

  if (!listed && !sunoSub && !cloudfrontSub) {
    return {
      ok: false,
      reason: `Host izinli degil: ${host}`,
      // Kullaniciya ne yapacagini soyle: env'i duzelt.
      hint:
        'DOWNLOAD_ALLOWED_HOSTS degiskenine bu host\'u ekleyin ' +
        `(su an izinli: ${CONFIG.downloadAllowedHosts.slice(0, 8).join(', ')}` +
        (CONFIG.downloadAllowedHosts.length > 8 ? ', …)' : ')'),
      allowedHosts: CONFIG.downloadAllowedHosts,
    };
  }

  // Standart disi portlar (orn. :8080) icin ek kontrol
  const port = parsed.port ? Number(parsed.port) : null;
  // Standart disi portlar yalnizca yerel gelistirme modunda (http izinli) gecer.
  if (port && port !== 443 && !CONFIG.downloadAllowHttp) {
    return { ok: false, reason: `Standart disi port: ${port}` };
  }

  return { ok: true, url: parsed.toString(), host };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Upstream'i acarken:
 *   - HER yonlendirme hedefini allowlist'ten gecirir (SSRF korumasi)
 *   - ag hatasi / 5xx icin sinirli sayida tekrar dener
 *   - ilk bayt icin zaman asimi uygular (Render free tier)
 *
 * Dikkat: Govde tuketilmeden once tekrar denenir; boylece bayt kaybi olmaz.
 *
 * @returns {Promise<{upstream: import('axios').AxiosResponse, finalUrl: string, hops: Array}>}
 */
async function openUpstreamStream(initialUrl, { headers, timeoutMs } = {}) {
  const timeout = timeoutMs || CONFIG.downloadTimeoutMs;
  const maxRetries = Math.max(0, CONFIG.downloadMaxRetries);

  const attemptOnce = async () => {
    let currentUrl = initialUrl;
    const hops = [];

    for (let hop = 0; hop <= CONFIG.downloadMaxRedirects; hop++) {
      // (a) Her adimda allowlist kontrolu — yonlendirme hedefi de dahil.
      const check = isAllowedDownloadUrl(currentUrl);
      if (!check.ok) {
        const err = new HttpError(
          403,
          'URL_NOT_ALLOWED',
          `Indirme adresi reddedildi: ${check.reason}`,
          `${check.hint || ''} url=${sanitizeUrlForLog(currentUrl)} hop=${hop}`.trim(),
        );
        throw err;
      }

      const upstream = await axios({
        method: 'get',
        url: check.url,
        responseType: 'stream',
        timeout,
        maxRedirects: 0, // yonlendirmeyi KENDIMIZ takip ediyoruz
        decompress: false,
        validateStatus: () => true,
        headers,
        httpsAgent: getUpstreamAgent(),
        proxy: false,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      hops.push({ host: check.host, status: upstream.status });

      const location = upstream.headers.location;
      if (REDIRECT_STATUSES.has(upstream.status) && location) {
        upstream.data.destroy(); // govdeyi bosalt
        let nextUrl;
        try {
          nextUrl = new URL(location, check.url).toString();
        } catch (_e) {
          throw new HttpError(502, 'BAD_REDIRECT', 'Yonlendirme adresi cozumlenemedi.', location.slice(0, 120));
        }
        log('info', 'Yonlendirme izleniyor.', {
          from: check.host,
          to: safeHost(nextUrl),
          status: upstream.status,
          hop: hop + 1,
        });
        currentUrl = nextUrl;
        continue;
      }

      return { upstream, finalUrl: check.url, hops };
    }

    throw new HttpError(
      502,
      'TOO_MANY_REDIRECTS',
      `Cok fazla yonlendirme (>${CONFIG.downloadMaxRedirects}).`,
      sanitizeUrlForLog(initialUrl),
    );
  };

  const retryable = (err) => {
    if (err instanceof HttpError) return false; // 403 vb. tekrar denemek anlamsiz
    const code = err && err.code;
    return ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(code) ||
      (err && err.response && err.response.status >= 500);
  };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await attemptOnce();
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !retryable(err)) break;
      const backoff = 300 * Math.pow(2, attempt);
      log('warn', 'Indirme denemesi basarisiz, tekrar denenecek.', {
        attempt: attempt + 1,
        code: err.code || '-',
        backoffMs: backoff,
      });
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** URL'den sadece host (log icin). */
function safeHost(rawUrl) {
  try {
    return new URL(String(rawUrl)).hostname;
  } catch (_e) {
    return '-';
  }
}

/**
 * Istemciden gelen imzali parametreler.
 * audiopipe bazi durumlarda zaman damgali/imzali query parametreleri bekliyor;
 * bunlari istemci uretir, proxy yalnizca iletir.
 */
const SIGNED_PARAM_KEYS = [
  'sig',
  'signature',
  'expires',
  'exp',
  'expiry',
  'token',
  't',
  'ts',
  'key',
  'hmac',
  'nonce',
  'policy',
  'kid',
  'session_id',
  'sessionId',
  'stream_id',
];

/**
 * Sablondaki {id} ve {param} yer tutucularini doldurur.
 *   https://audiopipe.suno.ai/?item_id={id}&sig={sig}&expires={expires}
 * Istekte olmayan yer tutucular bos string'e cevrilir.
 */
function fillUrlTemplate(template, clipId, req) {
  let out = String(template).replace(/\{id\}/g, encodeURIComponent(clipId));
  out = out.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, name) => {
    const value = req && req.query ? req.query[name] : undefined;
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
  return out;
}

/**
 * Istekteki imzali parametreleri URL'e ekler (varsa).
 */
function appendSignedParams(urlString, req) {
  if (!req || !req.query) return urlString;
  try {
    const u = new URL(urlString);
    for (const key of SIGNED_PARAM_KEYS) {
      const value = req.query[key];
      if (value !== undefined && value !== null && value !== '') {
        u.searchParams.set(key, String(value));
      }
    }
    return u.toString();
  } catch (_e) {
    return urlString;
  }
}

/**
 * Klibin ses kaynagini cozer.
 *  1. audio_url gercek bir CDN linkiyse onu kullanir (Pro plan).
 *  2. "/api/forbidden" ise audiopipe sablonuna duser (pass-through).
 *
 * Not: bu fonksiyon yalnizca URL uretir; bayt donusumu YAPMAZ.
 */
/**
 * SESSION HANDSHAKE
 * -----------------
 * Akis isteginden once calisan iki adim:
 *
 *   1) GET  /api/user/get_user_session_id/            -> { session_id }
 *   2) POST /api/gen/{id}/listen_milestone            -> { milestone: "5s"|"30s"|"60s" }
 *
 * Ikisi de basarisiz olsa bile akis devam eder; sonuc X-Handshake basligiyla
 * raporlanir:  ok | partial | failed | disabled
 */
const handshakeState = {
  lastSessionId: null,
  lastSessionAt: 0,
  lastResult: null,
  lastError: null,
  runs: 0,
};

/** Session id'yi getirir (30 dk cache; hata durumunda null). */
async function getAnalyticsSessionId(force = false) {
  const fresh = Date.now() - handshakeState.lastSessionAt < 30 * 60 * 1000;
  if (!force && handshakeState.lastSessionId && fresh) return handshakeState.lastSessionId;

  try {
    const data = await sunoRequest('get', '/api/user/get_user_session_id/');
    if (!data || !data.session_id) throw new Error('session_id alani yok');
    handshakeState.lastSessionId = data.session_id;
    handshakeState.lastSessionAt = Date.now();
    log('debug', 'Session id alindi.', { sessionId: String(data.session_id).slice(0, 16) });
    return data.session_id;
  } catch (err) {
    log('warn', 'Session id alinamadi.', sanitizeMessage(err.message));
    return null;
  }
}

/** listen_milestone tetikler (telemetri/akis yetkisi adimi). */
async function fireListenMilestone(clipId, milestone) {
  try {
    await sunoRequest('post', `/api/gen/${encodeURIComponent(clipId)}/listen_milestone`, {
      milestone,
    });
    log('debug', 'listen_milestone tetiklendi.', { clipId, milestone });
    return true;
  } catch (err) {
    log('warn', 'listen_milestone basarisiz.', { milestone, error: sanitizeMessage(err.message) });
    return false;
  }
}

/**
 * Akis oncesi handshake. ASLA throw etmez.
 * @returns {Promise<{result:string, sessionId:string|null, milestones:number}>}
 */
async function runStreamHandshake(clipId) {
  if (!CONFIG.enableSessionHandshake) {
    return { result: 'disabled', sessionId: null, milestones: 0 };
  }

  handshakeState.runs += 1;
  const sessionId = await getAnalyticsSessionId();

  let fired = 0;
  for (const m of CONFIG.handshakeMilestones) {
    // eslint-disable-next-line no-await-in-loop
    if (await fireListenMilestone(clipId, m)) fired += 1;
  }

  const result = sessionId && fired > 0 ? 'ok' : sessionId || fired > 0 ? 'partial' : 'failed';
  handshakeState.lastResult = result;
  handshakeState.lastError = result === 'failed' ? 'session_id ve milestone basarisiz' : null;
  log('info', 'Stream handshake.', { clipId, result, milestones: fired });
  return { result, sessionId, milestones: fired };
}

/**
 * Upstream'e gonderilecek Cookie header'ini olusturur.
 * Oncelik: SUNO_COOKIE_JAR (ham) > token'dan uretilen cookie'ler.
 */
function buildUpstreamCookieHeader(token) {
  if (!CONFIG.forwardCookies) return null;

  // NOT: Cookie jar'i oldugu gibi gondermek YANLIS sonuc veriyordu.
  // Jar icindeki eski __session, yeni Authorization token'iyla celisince Suno
  // 422 token_validation_failed donduruyor. Bu yuzden jar'daki oturum
  // cerezlerini atlayip guncel token'i kendimiz yaziyoruz.
  const parts = [];

  if (CONFIG.cookieJar) {
    const raw = CONFIG.cookieJar.replace(/^\s*cookie:\s*/i, '').trim();
    for (const pair of raw.split(';')) {
      const item = pair.trim();
      if (!item) continue;
      const name = item.split('=')[0].trim().toLowerCase();
      // oturum cerezleri HER ZAMAN guncel token'dan uretilir
      if (name === '__session' || name.startsWith('__session_')) continue;
      if (name === '__client' || name.startsWith('__client_uat')) continue;
      if (name === 'suno_device_id') continue;
      parts.push(item);
    }
  }

  const refresh = CONFIG.refreshToken;
  if (refresh) {
    if (refresh.includes('__client=')) {
      const m = refresh.match(/__client=([^;]+)/);
      parts.push(m ? `__client=${m[1].trim()}` : `__client=${refresh.trim()}`);
    } else {
      parts.push(`__client=${refresh.trim()}`);
    }
  }
  if (token) parts.push(`__session=${token}`);
  const devId = resolveDeviceId();
  if (devId) parts.push(`suno_device_id=${devId}`);

  return parts.length ? parts.join('; ') : null;
}


// ============================================================================
// 2b. IMZA MOTORU  (utils/signer.js + utils/signerPool.js)
// ============================================================================
//
//  AKIS
//  ----
//    resolveAudioSource()
//      -> resolveSignature()      [strateji secimi]
//          1. client : istemci sig/expires gonderdi (?sig=... | X-Sign-Params)
//          2. pool   : token cache havuzunda taze kayit var
//          3. derive : SIGNER_SPEC ile matematiksel turetim (varsayilan kapali)
//          4. none   : parametresiz sablon URL
//      -> signer.buildSignedUrl() [parametreleri URL'e ekler]
//
//  KAPSAM SINIRI (degismedi)
//  -------------------------
//  Bu katman yalnizca HTTP istek parametresi uretir. Icerik sifreleme/cozme,
//  DRM lisansi, AES anahtari BU MODULDE YOKTUR; akis baytlari DEGISTIRILMEZ.
// ============================================================================

/** Imza parametresi havuzu (TTL'li, LRU, single-flight). */
const signaturePool = new SignerPool({
  ttlMs: CONFIG.signerPoolTtlMs,
  max: CONFIG.signerPoolMax,
  refreshMs: CONFIG.signerRefreshMs,
});

/**
 * Havuzun arka plan tazeleyicisi.
 * Cerezler .env / istek baglamindan okunur, DISKTE VEYA LOGDA TUTULMAZ.
 * Spec bos ise tazeleme yapilmaz (null doner).
 */
signaturePool.setRefresher(async (clipId) => {
  if (!CONFIG.signerSpec) return null;
  const derived = signer.deriveParams(CONFIG.signerSpec, buildSignerContext(clipId, null));
  return derived.params && Object.keys(derived.params).length ? derived.params : null;
});

if (CONFIG.signerEnabled && CONFIG.signerPoolEnabled && CONFIG.signerRefreshMs > 0) {
  signaturePool.start();
}

/**
 * Imza baglamini olusturur. Secret ve cerezler yalnizca burada okunur;
 * loglara veya API yanitlarina YAZILMAZ.
 */
function buildSignerContext(clipId, req, secretOverride) {
  let cookieHeader = '';
  if (req && typeof req.get === 'function' && req.get('cookie')) cookieHeader = String(req.get('cookie'));
  if (!cookieHeader) {
    cookieHeader = buildUpstreamCookieHeader(authState.accessToken || CONFIG.sessionToken || null) || '';
  }

  const headers = {};
  if (req && req.headers) {
    for (const [k, v] of Object.entries(req.headers)) headers[String(k).toLowerCase()] = v;
  }

  return {
    clipId,
    now: Date.now(),
    secret: secretOverride !== undefined && secretOverride !== null ? String(secretOverride) : CONFIG.signerSecret,
    cookieHeader,
    query: (req && req.query) || {},
    headers,
  };
}

/**
 * Istemcinin gonderdigi imza parametreleri.
 *   1) X-Sign-Params: {"sig":"...","expires":"..."}   (JSON, en esnek)
 *   2) Query: ?sig=...&expires=...                     (SIGNED_PARAM_KEYS allowlist)
 * @returns {object|null}
 */
function collectClientSignature(req) {
  if (!req) return null;
  const params = {};

  if (typeof req.get === 'function') {
    const jsonHeader = req.get('x-sign-params');
    if (jsonHeader) {
      try {
        const parsed = JSON.parse(jsonHeader);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (/^[A-Za-z0-9_-]{1,40}$/.test(k) && v !== undefined && v !== null) params[k] = String(v).slice(0, 2048);
          }
        }
      } catch (_e) {
        // gecersiz JSON -> yoksay (istek dusurulmez)
      }
    }
  }

  if (req.query) {
    for (const key of SIGNED_PARAM_KEYS) {
      const value = req.query[key];
      if (value !== undefined && value !== null && value !== '') params[key] = String(value);
    }
  }

  return Object.keys(params).length ? params : null;
}

/**
 * Imza stratejisini secer ve parametreleri uretir. ASLA throw etmez.
 * @returns {Promise<{strategy:string, params:object, errors:string[], from_pool:boolean}>}
 */
async function resolveSignature(clipId, req, opts = {}) {
  const result = { strategy: 'none', params: {}, errors: [], from_pool: false };

  if (!CONFIG.signerEnabled) {
    result.strategy = 'disabled';
    return result;
  }

  // 1) Istemci imzasi (en guvenilir kaynak: gercek tarayici degeri)
  const client = collectClientSignature(req);
  if (client) {
    result.strategy = 'client';
    result.params = client;
    return result;
  }

  // 2) Havuz (arka planda tazelenmis parametreler)
  if (CONFIG.signerPoolEnabled) {
    const pooled = signaturePool.get(clipId);
    if (pooled) {
      result.strategy = 'pool';
      result.params = pooled;
      result.from_pool = true;
      return result;
    }
  }

  // 3) Matematiksel turetim (SIGNER_SPEC)
  const spec = opts.spec || CONFIG.signerSpec;
  if (spec) {
    const derived = signer.deriveParams(spec, buildSignerContext(clipId, req, opts.secret));
    result.errors = derived.errors || [];
    if (derived.params && Object.keys(derived.params).length) {
      result.strategy = 'derive';
      result.params = derived.params;
      if (CONFIG.signerPoolEnabled) {
        signaturePool.put(clipId, derived.params, { source: 'derive', ttlMs: CONFIG.signerPoolTtlMs });
      }
      return result;
    }
    result.strategy = 'derive-failed';
    return result;
  }

  return result;
}

/**
 * Bir URL'den en fazla `maxBytes` bayt okur ve olcer (akisi istemciye gondermez).
 * /debug/signer icin: "imzali URL gercekten bayt akitiyor mu?" sorusunun cevabi.
 */
async function probeUpstreamBytes(url, opts = {}) {
  const maxBytes = Math.min(envInt(opts.maxBytes, 65536), 4 * 1024 * 1024);
  const timeoutMs = envInt(opts.timeoutMs, 15000);
  const startedAt = Date.now();

  const headers = buildStreamUpstreamHeaders(opts.req || {}, null);
  delete headers.Range; // tam govdeyi basindan okuyoruz, sonra kapatiyoruz

  let upstream;
  try {
    upstream = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      timeout: timeoutMs,
      maxRedirects: 3,
      decompress: false,
      validateStatus: () => true,
      headers,
      httpsAgent: getUpstreamAgent(),
      proxy: false,
    });
  } catch (err) {
    return { performed: true, ok: false, error: sanitizeMessage(err.message), elapsed_ms: Date.now() - startedAt };
  }

  let bytes = 0;
  let firstChunk = null;
  let settled = false;

  await new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        upstream.data.destroy();
      } catch (_e) {
        /* zaten kapali */
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    upstream.data.on('data', (chunk) => {
      if (!firstChunk && chunk && chunk.length) firstChunk = Buffer.from(chunk.subarray(0, 8));
      bytes += chunk ? chunk.length : 0;
      if (bytes >= maxBytes) finish();
    });
    upstream.data.on('end', finish);
    upstream.data.on('error', finish);
    upstream.data.on('close', finish);
  });

  const magic = firstChunk ? firstChunk.toString('hex') : null;
  return {
    performed: true,
    ok: true,
    status: upstream.status,
    content_type: upstream.headers['content-type'] || null,
    content_length: upstream.headers['content-length'] || null,
    content_encoding: upstream.headers['content-encoding'] || null,
    bytes_read: bytes,
    empty: bytes === 0,
    magic_hex: magic,
    // ID3 / RIFF / fLaC / OggS -> cozulmemis ses basligi
    plain_audio_magic: magic ? /^(494433|52494646|664c6143|4f676753)/.test(magic) : false,
    elapsed_ms: Date.now() - startedAt,
    read_cap_bytes: maxBytes,
  };
}

/** /health ve /debug/signer icin kisa durum ozeti. */
function signerStatus() {
  const re = signer.RE_FINDINGS;
  return {
    enabled: CONFIG.signerEnabled,
    spec_configured: Boolean(CONFIG.signerSpec),
    spec_redacted: CONFIG.signerSpec ? CONFIG.signerSpec.replace(/\{secret\}/g, '{secret:***}').slice(0, 200) : null,
    secret_set: Boolean(CONFIG.signerSecret),
    strategies: ['client', 'pool', 'derive', 'none'],
    pool: CONFIG.signerPoolEnabled ? signaturePool.stats_() : { enabled: false },
    re: {
      verdict: re.verdict,
      scanned_at: re.scanned_at,
      files_scanned: re.files_scanned,
      summary: re.summary,
    },
  };
}

/**
 * Klibin ses kaynagini cozer.
 *  1. audio_url gercek bir CDN linkiyse onu kullanir (Pro plan).
 *  2. Istemci dogrudan imzali adres verdiyse onu kullanir.
 *  3. Aksi halde audiopipe sablonu + imza motoru (client/pool/derive/none).
 *
 * Not: yalnizca URL uretir; bayt donusumu YAPMAZ. `async` cunku imza
 * stratejisi havuzdan (TTL'li) gelebilir.
 */
async function resolveAudioSource(clip, req) {
  if (clip && clip.audio_url && String(clip.audio_url).startsWith('http') && !isForbiddenUrl(clip.audio_url)) {
    return {
      url: clip.audio_url,
      source: 'cdn',
      transparent: false,
      signature: { strategy: 'none', params: {} },
    };
  }

  // CloudFront / media_urls dogrudan akis adresi
  if (clip && Array.isArray(clip.media_urls) && clip.media_urls.length && clip.media_urls[0].url) {
    return {
      url: clip.media_urls[0].url,
      source: 'cloudfront',
      transparent: false,
      signature: { strategy: 'none', params: {} },
    };
  }

  // Istemci dogrudan imzali bir adres verdiyse onu kullan (allowlist kontrolu route'ta)
  const clientUrl =
    (req && (req.query.audio_url || req.query.signed_url)) ||
    (req && req.get && (req.get('x-audio-url') || req.get('x-signed-url')));
  if (clientUrl) {
    return {
      url: String(clientUrl),
      source: 'client-signed',
      transparent: true,
      signature: { strategy: 'client-url', params: {} },
    };
  }

  // Suno CloudFront klip adresi (Mango DRM)
  if (clip && clip.id) {
    return {
      url: `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clip.id}.m4a`,
      source: 'cloudfront',
      transparent: false,
      signature: { strategy: 'none', params: {} },
    };
  }

  const filled = fillUrlTemplate(CONFIG.audiopipeUrlTemplate, clip.id, req);
  const signature = await resolveSignature(clip.id, req);
  let url = appendSignedParams(filled, req);
  if (Object.keys(signature.params).length) {
    url = signer.buildSignedUrl(url, signature.params);
  }

  return {
    url,
    source: 'audiopipe',
    transparent: true,
    signature: {
      strategy: signature.strategy,
      params: signature.params,
      from_pool: signature.from_pool,
      errors: signature.errors,
    },
  };
}

function slugifyText(text, fallback = 'audio') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

/** Suno'nun "forbidden" yer tutucu URL'sini tespit eder. */
function isForbiddenUrl(u) {
  return !u || /\/api\/forbidden/.test(String(u));
}

/** Suno klip nesnesini istemci icin sabit/sade bir sekle cevirir. */
function normalizeClip(clip) {
  if (!clip || !clip.id) return null;
  const md = clip.metadata || {};
  const audioUrl = isForbiddenUrl(clip.audio_url) ? null : clip.audio_url;

  return {
    id: clip.id,
    status: clip.status || 'unknown', // submitted | queued | streaming | complete | error
    is_complete: clip.status === 'complete',
    is_error: clip.status === 'error',
    title: clip.title || null,
    tags: md.tags || null,
    prompt: md.prompt || null,
    duration_seconds: md.duration ?? null,
    model: clip.model_name || null,
    created_at: clip.created_at || null,
    image_url: clip.image_url || null,
    song_url: `https://suno.com/song/${clip.id}`,
    // audio_url: yalnizca gercek CDN linki varsa (Pro plan). Free planda null.
    audio_url: audioUrl,
    // Proxy uzerinden indirme/akis (bizim sunucumuz)
    download_url: `/download?id=${clip.id}`,
    // Akis (browser'da <audio src> icin)
    stream_url: `/stream/${clip.id}`,
    download_blocked_reason: null,
  };
}

/** Feed'den tek klip ceker. */
async function fetchClip(clipId) {
  const data = await sunoRequest('get', `${CONFIG.feedPath}?ids=${encodeURIComponent(clipId)}`);
  const list = Array.isArray(data) ? data : (data && (data.clips || data.data)) || [];
  return list.find((c) => c && c.id === clipId) || list[0] || null;
}

/** Express icin standart hata cevabi. */
function sendError(res, status, code, message, detail) {
  // BILINEN HATA DUZELTMESI: akis yolunda hata, basliklar gonderilmeden once
  // olusursa `Content-Type: audio/mp3` set edilmis olabilir. JSON govdeyi
  // "ses" olarak etiketlememek icin once Content-Type'i sil.
  if (!res.headersSent) {
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Disposition');
    res.removeHeader('Accept-Ranges');
    res.removeHeader('Content-Range');
  }
  return res.status(status).json({
    ok: false,
    error: { code, message, detail: detail ? sanitizeMessage(detail) : undefined },
  });
}

// ============================================================================
// 3. TOKEN / OTURUM YONETIMI  (Clerk Auth taklidi)
// ============================================================================
//
//  Akis (tarayicinin yaptigiyla ayni):
//
//   (A) GET  {clerk}/v1/client?_clerk_js_version=X          [Cookie: __client=...]
//         -> { response: { sessions: [ { id, status, last_active_token: { jwt } } ],
//                          last_active_session_id } }
//
//   (B) POST {clerk}/v1/client/sessions/{sid}/tokens?_clerk_js_version=X
//         -> { jwt: "eyJ..." }      <-- Suno API'sine Bearer olarak gonderilir
//
//   (C) POST {clerk}/v1/client/sessions/{sid}/touch?_clerk_js_version=X
//         -> oturumun "aktif" sayilmasini saglar (7/24 ayakta kalma)
//
// ============================================================================

/** Bellekteki oturum durumu (tekli token fallback ve uyumluluk). */
const fallbackAuthState = {
  accessToken: null,   // gecerli Bearer JWT
  expiresAt: 0,        // JWT exp (ms) - 0 ise bilinmiyor
  sessionId: null,     // Clerk session id
  lastRefreshAt: 0,    // son basarili yenileme zamani
  lastError: null,     // son hata mesaji (debug icin)
  refreshCount: 0,     // toplam yenileme sayisi
  inFlight: null,      // devam eden yenileme promise'i (single-flight)
};

/**
 * authState proxy'si: kod tabanindaki tum authState okuma/yazmalari
 * otomatik olarak o anda aktif olan hesaba yonlendirilir.
 */
const authState = new Proxy(fallbackAuthState, {
  get(target, prop) {
    const act = accountPool.getActiveAccount();
    if (act && prop in act) {
      return act[prop];
    }
    return target[prop];
  },
  set(target, prop, value) {
    const act = accountPool.getActiveAccount();
    if (act && prop in act) {
      act[prop] = value;
    }
    target[prop] = value;
    return true;
  },
});

/**
 * Cookie header formatina cevirir. Belirtilen hesap varsa onun cerezini,
 * yoksa o anki aktif hesabi veya CONFIG.refreshToken'i kullanir.
 */
function buildCookieHeader(account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) return act.buildCookieHeader();
  const raw = CONFIG.refreshToken;
  if (!raw) return '';
  if (raw.includes('__client=')) {
    const match = raw.match(/__client=([^;]+)/);
    return match ? `__client=${match[1].trim()}` : raw;
  }
  return `__client=${raw}`;
}

function requireRefreshToken(account = null) {
  const act = account || accountPool.getActiveAccount();
  if (!act && !CONFIG.refreshToken) {
    throw new Error(
      'SUNO_REFRESH_TOKEN tanimli degil. suno.com -> F12 -> Application -> Cookies -> __client degerini .env dosyasina ekleyin.',
    );
  }
}

/**
 * (A) Clerk client bilgisini cek: session id + son aktif token.
 */
async function fetchClerkClient(account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) {
    return act.fetchClerkClient({
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      clerkJsVersion: CONFIG.clerkJsVersion,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
      userAgent: BROWSER_UA,
      log,
    });
  }

  requireRefreshToken();

  const url = `${CONFIG.clerkBaseUrl}/v1/client?_clerk_js_version=${encodeURIComponent(CONFIG.clerkJsVersion)}`;

  const { data } = await axios.get(url, {
    timeout: CONFIG.requestTimeoutMs,
    headers: {
      Cookie: buildCookieHeader(),
      Accept: '*/*',
      'User-Agent': BROWSER_UA,
      Origin: 'https://suno.com',
      Referer: 'https://suno.com/',
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const client = data && (data.response || data);
  const sessions = Array.isArray(client && client.sessions) ? client.sessions : [];

  if (!sessions.length) {
    throw new Error(
      'Clerk oturumu bulunamadi. __client cookie suresi dolmus veya gecersiz olabilir; suno.com uzerinden yeni cookie alin.',
    );
  }

  const activeSession =
    sessions.find((s) => s && s.status === 'active') ||
    sessions.find((s) => s && s.id === client.last_active_session_id) ||
    sessions[0];

  return {
    sessionId: activeSession.id,
    fallbackJwt: (activeSession.last_active_token && activeSession.last_active_token.jwt) || null,
  };
}

/**
 * (B) Session id'den taze JWT al.
 */
async function requestSessionToken(sessionId, account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) {
    return act.requestSessionToken(sessionId, {
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      clerkJsVersion: CONFIG.clerkJsVersion,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
      userAgent: BROWSER_UA,
      log,
    });
  }

  requireRefreshToken();

  const url =
    `${CONFIG.clerkBaseUrl}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens` +
    `?_clerk_js_version=${encodeURIComponent(CONFIG.clerkJsVersion)}`;

  const { data } = await axios.post(url, null, {
    timeout: CONFIG.requestTimeoutMs,
    headers: {
      Cookie: buildCookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': '0',
      Accept: '*/*',
      'User-Agent': BROWSER_UA,
      Origin: 'https://suno.com',
      Referer: 'https://suno.com/',
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const jwt = data && (data.jwt || (data.response && data.response.jwt));
  if (!jwt) {
    throw new Error('Clerk token yanitinda "jwt" alani yok. Yanit formati degismis olabilir.');
  }
  return jwt;
}

/**
 * (C) Keep-alive: oturumu "dokunulmus" isaretle.
 */
async function touchSession(sessionId, account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) {
    return act.touchSession({
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      clerkJsVersion: CONFIG.clerkJsVersion,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
      userAgent: BROWSER_UA,
      log,
    });
  }

  const url =
    `${CONFIG.clerkBaseUrl}/v1/client/sessions/${encodeURIComponent(sessionId)}/touch` +
    `?_clerk_js_version=${encodeURIComponent(CONFIG.clerkJsVersion)}`;

  try {
    await axios.post(url, null, {
      timeout: CONFIG.requestTimeoutMs,
      headers: {
        Cookie: buildCookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '0',
        Accept: '*/*',
        'User-Agent': BROWSER_UA,
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });
    log('debug', 'Clerk session/touch basarili.', { sessionId });
  } catch (err) {
    log('warn', 'Clerk session/touch basarisiz (kritik degil).', sanitizeMessage(err.message));
  }
}

/**
 * Token'i yenile. Single-flight: ayni anda birden fazla cagri gelirse
 * tek bir Promise paylasilir.
 */
async function refreshAccessToken(force = false, account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) {
    return act.refreshAccessToken(force, {
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      clerkJsVersion: CONFIG.clerkJsVersion,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
      refreshBeforeExpiryMs: CONFIG.refreshBeforeExpiryMs,
      userAgent: BROWSER_UA,
      log,
    });
  }

  if (!CONFIG.refreshToken) {
    if (CONFIG.sessionToken) return CONFIG.sessionToken;
    throw new Error('Yenileme icin SUNO_REFRESH_TOKEN (__client) gerekli.');
  }

  const now = Date.now();
  const stillValid =
    fallbackAuthState.accessToken &&
    (fallbackAuthState.expiresAt === 0 || fallbackAuthState.expiresAt - CONFIG.refreshBeforeExpiryMs > now);
  if (!force && stillValid) return fallbackAuthState.accessToken;

  if (fallbackAuthState.inFlight) return fallbackAuthState.inFlight;

  fallbackAuthState.inFlight = (async () => {
    const startedAt = Date.now();
    try {
      if (!fallbackAuthState.sessionId) {
        const { sessionId, fallbackJwt } = await fetchClerkClient();
        fallbackAuthState.sessionId = sessionId;
        if (fallbackJwt) {
          fallbackAuthState.accessToken = fallbackJwt;
          fallbackAuthState.expiresAt = getTokenExpiryMs(fallbackJwt);
        }
      }

      let jwt;
      try {
        jwt = await requestSessionToken(fallbackAuthState.sessionId);
      } catch (tokenErr) {
        log('warn', 'Token istegi basarisiz, session id yeniden cozuluyor.', sanitizeMessage(tokenErr.message));
        const { sessionId, fallbackJwt } = await fetchClerkClient();
        fallbackAuthState.sessionId = sessionId;
        try {
          jwt = await requestSessionToken(sessionId);
        } catch (retryErr) {
          if (fallbackJwt) {
            log('warn', 'tokens uc noktasi basarisiz, last_active_token.jwt kullaniliyor.');
            jwt = fallbackJwt;
          } else {
            throw retryErr;
          }
        }
      }

      fallbackAuthState.accessToken = jwt;
      fallbackAuthState.expiresAt = getTokenExpiryMs(jwt);
      fallbackAuthState.lastRefreshAt = Date.now();
      fallbackAuthState.lastError = null;
      fallbackAuthState.refreshCount += 1;

      const ttlSec = fallbackAuthState.expiresAt ? Math.round((fallbackAuthState.expiresAt - Date.now()) / 1000) : null;
      log('info', 'Access token yenilendi.', {
        sessionId: fallbackAuthState.sessionId,
        ttlSeconds: ttlSec,
        tookMs: Date.now() - startedAt,
      });

      return jwt;
    } catch (err) {
      fallbackAuthState.lastError = sanitizeMessage(err.message);
      err.code = err.code || 'AUTH_ERROR';
      err.isAuthError = true;
      log('error', 'Token yenileme basarisiz.', fallbackAuthState.lastError);
      throw err;
    } finally {
      fallbackAuthState.inFlight = null;
    }
  })();

  return fallbackAuthState.inFlight;
}

/**
 * Her API isteginden hemen once cagrilir: token gecerli mi kontrol eder, gerekirse yeniler.
 */
async function getValidToken(account = null) {
  const act = account || accountPool.getActiveAccount();
  if (act) {
    return act.getValidToken({
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      clerkJsVersion: CONFIG.clerkJsVersion,
      requestTimeoutMs: CONFIG.requestTimeoutMs,
      refreshBeforeExpiryMs: CONFIG.refreshBeforeExpiryMs,
      userAgent: BROWSER_UA,
      log,
    });
  }

  if (!CONFIG.refreshToken) {
    if (CONFIG.sessionToken) {
      fallbackAuthState.accessToken = CONFIG.sessionToken;
      fallbackAuthState.expiresAt = getTokenExpiryMs(CONFIG.sessionToken);
      return CONFIG.sessionToken;
    }
    throw new Error(
      'Kimlik bilgisi yok. SUNO_REFRESH_TOKEN (__client) veya SUNO_SESSION_TOKEN (__session JWT) tanimlayin.',
    );
  }

  const now = Date.now();
  const hasToken = Boolean(fallbackAuthState.accessToken);
  const expiringSoon =
    fallbackAuthState.expiresAt !== 0 && fallbackAuthState.expiresAt - CONFIG.refreshBeforeExpiryMs <= now;

  if (hasToken && !expiringSoon) return fallbackAuthState.accessToken;
  return refreshAccessToken(!hasToken);
}

// ============================================================================
// 4. SUNO STUDIO API ISTEMCISI
// ============================================================================

function buildBrowserToken() {
  if (CONFIG.browserTokenOverride) return CONFIG.browserTokenOverride;
  try {
    const inner = JSON.stringify({ timestamp: Date.now() });
    return JSON.stringify({ token: Buffer.from(inner, 'utf8').toString('base64') });
  } catch (_err) {
    return JSON.stringify({ token: 'error' });
  }
}

function resolveDeviceId() {
  if (CONFIG.deviceId) return CONFIG.deviceId;
  const match = String(process.env.SUNO_COOKIE_JAR || '').match(/suno_device_id=([^;\s]+)/);
  if (match) return match[1];
  if (!resolveDeviceId._fallback) {
    resolveDeviceId._fallback = require('crypto').randomUUID();
    log('warn', 'SUNO_DEVICE_ID tanimli degil, rastgele uretildi.', resolveDeviceId._fallback);
  }
  return resolveDeviceId._fallback;
}

/** Suno API'sine gonderilecek ortak header seti. */
function buildSunoHeaders(token, account = null) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': BROWSER_UA,
    Origin: 'https://suno.com',
    Referer: 'https://suno.com/',
  };

  headers['Browser-Token'] = buildBrowserToken();
  headers['Device-Id'] = resolveDeviceId();

  if (CONFIG.forwardClientCookie) {
    const cookie = buildCookieHeader(account);
    if (cookie) headers.Cookie = cookie;
  }

  return headers;
}

/**
 * Suno API'sine istek atar.
 * 401 alinirsa token'i zorla yenileyip 1 kez tekrar dener (retry-on-401).
 *
 * @param {'get'|'post'} method
 * @param {string} path  orn: "/api/generate/v2/"
 * @param {object} [body]
 * @param {object} [options] { account, clipId }
 */
async function sunoRequest(method, path, body, options = {}) {
  const url = `${CONFIG.sunoApiBase}${path}`;
  const account =
    options.account ||
    (options.clipId ? accountPool.getAccountForClip(options.clipId) : accountPool.getActiveAccount());

  const execute = async (forceRefresh) => {
    const token = forceRefresh ? await refreshAccessToken(true, account) : await getValidToken(account);
    const config = {
      method,
      url,
      timeout: CONFIG.requestTimeoutMs,
      headers: buildSunoHeaders(token, account),
      validateStatus: () => true,
    };
    if (body !== undefined) config.data = body;
    return axios.request(config);
  };

  let response = await execute(false);

  const bodyText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
  const tokenRejected =
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 422 && /token_validation_failed|verify your request/i.test(bodyText));

  if (tokenRejected && (account || CONFIG.refreshToken)) {
    log('warn', `Suno API ${response.status} (token reddi), zorla yenile + tekrar dene.`, path);
    response = await execute(true);
  } else if (tokenRejected && !account && !CONFIG.refreshToken) {
    const e = new Error('Suno oturumu gecersiz. Taze token gerekli.');
    e.status = 401;
    e.code = 'SESSION_EXPIRED';
    e.detail =
      'SUNO_REFRESH_TOKEN (__client cookie) tanimli degil, bu yuzden otomatik yenileme yapilamiyor. ' +
      'Cookie basligindaki __client degerini SUNO_REFRESH_TOKEN veya SUNO_REFRESH_TOKENS olarak ekleyin.';
    throw e;
  }

  if (response.status < 200 || response.status >= 300) {
    const detail =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {}).slice(0, 500);
    const err = new Error(`Suno API hatasi (HTTP ${response.status})`);
    err.status = response.status;
    err.detail = detail;
    err.responseData = response.data;
    throw err;
  }

  return response.data;
}

// ============================================================================
// 4.5 SAGLAYICI (PROVIDER) KATMANI
// ============================================================================
//
//  AUDIO_PROVIDER=suno|replicate|elevenlabs|mock
//
//  Tum route'lar yalnizca provider arayuzunu bilir. Saglayici degistirmek icin
//  istemci uygulamasinda HICBIR degisiklik gerekmez.
//
// ============================================================================

const activeProvider = () => providerRegistry.getProvider();

// Suno adaptoru, bu dosyadaki hazir fonksiyonlari kullanir (kod tekrari yok).
/**
 * SUNO RESMI INDIRME UCU
 * ----------------------
 * Tarayicida "Indir" butonuna basildiginda Suno sunlari yapar:
 *
 *   POST /api/download/authorize       (opsiyonel onay)
 *   GET  /api/download/clip/{id}?format=mp3
 *        -> { ok: true, status: "ready",
 *             download_url: "https://suno-data-uploads.s3.amazonaws.com/...&Signature=...&Expires=..." }
 *
 * download_url imzali (presigned) bir S3 linkidir ve ~5 dakika yasar.
 * Indirilen dosya DUZ MP3'tur (ID3 basligi, ffmpeg ile cozulur) — audiopipe'in
 * aksine sifreli DEGILDIR. Bu, hesabin indirme hakkina sahip oldugu klipler
 * icin calisir (feed'de is_download_unlocked=true).
 *
 * Not: burada sifre cozme YOKTUR; Suno'nun kendi tarayiciya verdigi dosya
 * oldugu gibi aktarilir.
 */
async function fetchSunoDownloadUrl(clipId, format = 'mp3') {
  const fmt = ['mp3', 'wav'].includes(String(format).toLowerCase()) ? String(format).toLowerCase() : 'mp3';

  const cached = cacheGetDownloadUrl(clipId, fmt);
  if (cached) {
    if (!cached.url) {
      // onbellekteki olumsuz sonuc: cagirana sebebi ile birlikte bildir
      const err = new HttpError(409, 'DOWNLOAD_NOT_AUTHORIZED', 'Suno bu klip icin indirme izni vermedi.', cached.reason);
      throw err;
    }
    return { url: cached.url, status: cached.status || 'ready', format: fmt, cached: true };
  }

  let data = null;
  try {
    data = await sunoRequest('get', `/api/download/clip/${encodeURIComponent(clipId)}?format=${fmt}`);
  } catch (err) {
    // 403/404 gibi durumlar -> indirme hakki yok
    cachePutDownloadUrl(clipId, fmt, { url: null, reason: sanitizeMessage(err.message) });
    throw err;
  }

  const url = data && (data.download_url || data.url);
  if (!url || (data && data.ok === false)) {
    const reason = (data && (data.reason || data.message)) || 'download_url yok';
    cachePutDownloadUrl(clipId, fmt, { url: null, reason });
    log('info', 'Indirme izni yok.', { clipId, reason });
    return null;
  }

  const check = isAllowedDownloadUrl(url);
  if (!check.ok) {
    log('warn', 'Indirme URL\'si allowlist disinda.', check.reason);
    cachePutDownloadUrl(clipId, fmt, { url: null, reason: check.reason });
    return null;
  }

  const status = (data && data.status) || 'ready';
  cachePutDownloadUrl(clipId, fmt, { url: check.url, status });
  return { url: check.url, status, format: fmt };
}

providerRegistry.providers.suno.init({
  sunoRequest,
  fetchClip,
  normalizeClip,
  resolveAudioSource,
  runStreamHandshake,
  fetchDownloadUrl: fetchSunoDownloadUrl,
  modelFallback: CONFIG.modelFallback,
  defaultModel: CONFIG.defaultModel,
  defaultInstrumental: CONFIG.defaultInstrumental,
  generatePath: CONFIG.generatePath,
  hasRefreshToken: Boolean(CONFIG.refreshToken || accountPool.size() > 0),
  hasSessionToken: Boolean(CONFIG.sessionToken),
  accountPool,
  isCreditExhaustedError,
  log,
});

/**
 * Saglayici "internal://" kaynagi dondurduyse (mock / elevenlabs gibi bellek ici
 * kayitlar), sesi Range destekli olarak dogrudan bellekten akitir.
 *
 *   internal://mock/<clipId>
 *   internal://elevenlabs/<clipId>
 */
async function pipeInternalAudio(req, res, internalUrl) {
  const providerName = String(internalUrl).replace('internal://', '').split('/')[0];
  const clipId = String(internalUrl).split('/').pop();

  let buffer = null;
  let contentType = 'audio/mpeg';

  if (providerName === 'mock') {
    const rendered = providerRegistry.providers.mock.render(clipId);
    if (!rendered) return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi: ${clipId}`);
    buffer = rendered.buffer;
    contentType = rendered.contentType;
  } else if (providerName === 'elevenlabs') {
    const record = providerRegistry.providers.elevenlabs.getRecord(clipId);
    if (!record) return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi (bellekte yok): ${clipId}`);
    buffer = record.buffer;
    contentType = record.contentType;
  } else {
    return sendError(res, 502, 'INTERNAL_SOURCE_UNKNOWN', `Bilinmeyen ic kaynak: ${providerName}`);
  }

  const total = buffer.length;
  const range = parseRangeHeader(req.headers.range, total);
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': req.get('origin') || '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
    'X-Proxy-Mode': `internal:${providerName}`,
  };
  for (const [k, v] of Object.entries(baseHeaders)) res.setHeader(k, v);

  if (range && range.unsatisfiable) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return sendError(res, 416, 'RANGE_NOT_SATISFIABLE', 'Istenen bayt araligi dosya boyutunu asiyor.');
  }

  if (range) {
    const end = range.end === null ? total - 1 : Math.min(range.end, total - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - range.start + 1));
    return res.end(buffer.subarray(range.start, end + 1));
  }

  res.setHeader('Content-Length', String(total));
  return res.end(buffer);
}

// ============================================================================
// 5. EXPRESS UYGULAMASI
// ============================================================================

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render / reverse proxy arkasinda dogru IP
app.use(express.json({ limit: '64kb' })); // kucuk limit -> dusuk bellek
// text/plain: tarayici konsolundan mode:'no-cors' ile gonderilen govdeler icin.
// (application/json preflight tetikler; text/plain tetiklemez -> CORS'a takilmaz)
app.use(express.text({ type: 'text/plain', limit: '32kb' }));

/** Basit istek loglama (UptimeRobot trafigini gurultuye bogmamak icin /ping haric). */
app.use((req, _res, next) => {
  if (req.path !== '/ping') log('debug', `${req.method} ${req.path}`);
  next();
});

/**
 * NOT: Eski `authGuard` kaldirildi. Tum korumali rotalar artik `apiKeyGuard`
 * kullaniyor; eski tek anahtar (API_KEY) bu kontrolun icinde destekleniyor.
 * Geriye uyumluluk icin `API_KEY` degiskeni hala gecerlidir (bkz. CONFIG).
 */

/**
 * Zamanlama saldirilarina dayanikli anahtar karsilastirmasi.
 * Uzunluk sizdirilmaz: once uzunluk kontrolu, sonra timingSafeEqual.
 */
function safeKeyEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_e) {
    return false;
  }
}

/**
 * PRESIGNED INDIRME URL ONBELLEGI
 * -------------------------------
 * Suno /api/download/clip/:id her cagrida yeni bir presigned S3 linki uretir
 * (~5 dk omurlu). Ayni klip icin tekrar tekrar istememek uzere kisa TTL'li
 * bellek onbellegi tutuyoruz. Negatif sonuc (not_authorized) da kisaca
 * onbelleklenir ki her indirme denemesinde Suno'ya gidilmesin.
 */
const downloadUrlCache = new Map(); // clipId -> { url|null, expiresAt, reason, status }
const DOWNLOAD_URL_TTL_MS = 4 * 60 * 1000;      // pozitif: 4 dk
const DOWNLOAD_URL_NEG_TTL_MS = 60 * 1000;      // negatif: 1 dk

function cacheGetDownloadUrl(clipId, format = 'mp3') {
  const key = `${clipId}:${format}`;
  const hit = downloadUrlCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    downloadUrlCache.delete(key);
    return null;
  }
  return hit;
}

function cachePutDownloadUrl(clipId, format, value) {
  const key = `${clipId}:${format}`;
  // LRU: 300 kayit siniri
  if (downloadUrlCache.size >= 300) {
    const oldest = downloadUrlCache.keys().next().value;
    if (oldest) downloadUrlCache.delete(oldest);
  }
  downloadUrlCache.set(key, {
    ...value,
    expiresAt: Date.now() + (value.url ? DOWNLOAD_URL_TTL_MS : DOWNLOAD_URL_NEG_TTL_MS),
  });
}

/**
 * Bakiye sorgusu (hata teshisi icin). Basarisiz olursa null doner; asla throw etmez.
 */
async function fetchCreditsSafe() {
  try {
    const data = await sunoRequest('get', '/api/billing/info/');
    if (!data) return null;
    const rateLimitAvail = data.credit_rate_limit ? data.credit_rate_limit.available_credits : null;
    const totalAvail = typeof data.total_credits_left === 'number' ? data.total_credits_left : data.credits;
    const effectiveCredits = rateLimitAvail !== null ? rateLimitAvail : totalAvail;
    return {
      credits: effectiveCredits,
      raw_credits: data.credits,
      total_credits_left: data.total_credits_left,
      available_credits: rateLimitAvail,
      is_active: data.is_active,
      monthly_usage: data.monthly_usage,
      monthly_limit: data.monthly_limit,
    };
  } catch (_err) {
    return null;
  }
}

/**
 * BELLEKTEKI SES BAYTLARINI SERVIS ET
 * -----------------------------------
 * Bazi saglayicilar (orn. Google Lyria) sesi base64 olarak dondurur; disarida
 * bir URL yoktur. Bu durumda baytlari dogrudan kendi indirme sistemimizden
 * veriyoruz. Range destegi korunur (tarayicida sarma/seek calissin diye).
 *
 * @returns {boolean} true = cevap gonderildi, route bitmeli
 */
function sendAudioBuffer(req, res, { buffer, mime, filename }, { inline = false } = {}) {
  const total = buffer.length;
  const range = req.headers.range || req.headers.Range;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime || 'audio/mpeg');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${String(filename || 'beat.mp3').replace(/"/g, '')}"`,
  );
  res.setHeader('Cache-Control', 'private, max-age=0, no-transform');
  res.setHeader('X-Download-Mode', 'memory');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        return res.end(), true;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.end(buffer.subarray(start, end + 1));
      return true;
    }
  }

  res.status(200);
  res.setHeader('Content-Length', String(total));
  res.end(buffer);
  return true;
}

/** Calisma aninda uretilen anahtarlarin deposu (utils/keyStore.js). */
const keyStore = new KeyStore({
  enabled: CONFIG.keyStoreEnabled,
  file: CONFIG.keyStoreFile,
  maxKeys: CONFIG.keyStoreMax,
});

/**
 * PROJE GENELI API ANAHTARI KORUMASI
 * ----------------------------------
 * Kabul edilen kaynaklar (sirayla):
 *   1. x-api-key: <key>
 *   2. ?api_key=<key>            -> <audio src> gibi header gonderemeyen istemciler icin
 *   3. Authorization: Bearer <key>
 *
 * Anahtar listesi: ALLOWED_API_KEYS (virgulle ayrilmis) + eski API_KEY.
 * Liste bos ise:
 *   - API_KEY_REQUIRED=true  -> 401 (siki mod)
 *   - aksi halde             -> istek gecer + log uyarisi (demo modu)
 */
function apiKeyGuard(req, res, next) {
  const configured = CONFIG.allowedApiKeys;
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const provided = String(req.get('x-api-key') || (req.query && req.query.api_key) || bearer || '').trim();

  const hasAnyKey = configured.length > 0 || Boolean(CONFIG.adminKey) || keyStore.activeCount() > 0;

  // --- Hic anahtar tanimli degil ---
  if (!hasAnyKey) {
    if (CONFIG.apiKeyRequired) {
      return sendError(
        res,
        401,
        'UNAUTHORIZED',
        'Sunucuda API anahtari yok. Panelden bir anahtar uretin (POST /keys).',
      );
    }
    req.apiKeyRole = 'open';
    req.apiKeySource = 'none';
    return next();
  }

  if (!provided) {
    return sendError(res, 401, 'UNAUTHORIZED', 'API anahtari gerekli (x-api-key veya ?api_key=).');
  }

  // 1) Master anahtar (ADMIN_KEY): hem erisim hem anahtar uretme yetkisi
  if (CONFIG.adminKey && safeKeyEqual(CONFIG.adminKey, provided)) {
    req.apiKeyRole = 'admin';
    req.apiKeySource = 'admin_key';
    return next();
  }

  // 2) .env'deki statik anahtarlar (yonetici sayilir)
  if (configured.some((key) => safeKeyEqual(key, provided))) {
    req.apiKeyRole = 'admin';
    req.apiKeySource = 'env';
    return next();
  }

  // 3) Siteden uretilen anahtarlar
  const record = keyStore.verify(provided);
  if (record) {
    req.apiKeyRole = record.role;
    req.apiKeySource = 'store';
    req.apiKeyId = record.id;
    return next();
  }

  log('warn', 'Gecersiz API anahtari.', {
    ip: req.ip,
    path: req.path,
    keyPrefix: `${provided.slice(0, 6)}…`,
  });
  return sendError(res, 401, 'UNAUTHORIZED', 'Gecersiz API anahtari.');
}

/** Anahtar uretme/iptal yetkisi. Bootstrap (hic anahtar yokken) serbesttir. */
function requireKeyAdmin(req, res) {
  const bootstrap = CONFIG.allowedApiKeys.length === 0 && !CONFIG.adminKey && keyStore.activeCount() === 0;
  if (bootstrap) return true;
  if (req.apiKeyRole === 'admin') return true;
  sendError(
    res,
    403,
    'FORBIDDEN',
    'Bu islem yonetici anahtari gerektirir (ALLOWED_API_KEYS veya ADMIN_KEY).',
  );
  return false;
}

// ---------------------------------------------------------------------------
// GET /ping  -> UptimeRobot / Render health check
// ---------------------------------------------------------------------------
app.get('/ping', (_req, res) => {
  // Mumkun oldugunca hafif cevap: JSON yok, islem yok.
  res.type('text/plain').send('pong');
});

// ---------------------------------------------------------------------------
// GET /health -> detayli durum (uptime, token ttl, oturum bilgisi)
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    auth: {
      hasRefreshToken: Boolean(CONFIG.refreshToken || accountPool.size() > 0),
      totalAccounts: accountPool.size(),
      availableAccounts: accountPool.getAvailableAccounts().length,
      activeAccountId: accountPool.getActiveAccount() ? accountPool.getActiveAccount().id : null,
      refreshMode: (CONFIG.refreshToken || accountPool.size() > 0) ? 'full' : CONFIG.sessionToken ? 'manual' : 'none',
      hasSessionToken: Boolean(CONFIG.sessionToken),
      hasAccessToken: Boolean(authState.accessToken),
      sessionId: authState.sessionId,
      tokenExpiresInSeconds: authState.expiresAt ? Math.max(0, Math.round((authState.expiresAt - Date.now()) / 1000)) : null,
      lastRefreshAt: authState.lastRefreshAt ? new Date(authState.lastRefreshAt).toISOString() : null,
      refreshCount: authState.refreshCount,
      lastError: authState.lastError,
    },
    accountPool: accountPool.getStatus(),
    provider: {
      name: providerRegistry.getProviderName(),
      available: providerRegistry.listProviders(),
      audioEndpointConfigured:
        providerRegistry.getProviderName() === 'suno'
          ? Boolean(CONFIG.refreshToken || CONFIG.sessionToken || accountPool.size() > 0)
          : undefined,
    },
    tls: {
      chromeProfile: CONFIG.chromeTlsProfile,
      ciphers: CONFIG.chromeTlsProfile ? CHROME_CIPHER_SUITES.split(':').length : null,
    },
    handshake: {
      enabled: CONFIG.enableSessionHandshake,
      milestones: CONFIG.handshakeMilestones,
      runs: handshakeState.runs,
      lastResult: handshakeState.lastResult,
      lastSessionId: handshakeState.lastSessionId
        ? `${String(handshakeState.lastSessionId).slice(0, 16)}...`
        : null,
      lastError: handshakeState.lastError,
    },
    security: {
      apiKeyRequired:
        CONFIG.allowedApiKeys.length > 0 || Boolean(CONFIG.adminKey) || keyStore.activeCount() > 0,
      allowedApiKeys: CONFIG.allowedApiKeys.length,
      adminKeyConfigured: Boolean(CONFIG.adminKey),
      dashboard: Boolean(CONFIG.publicDir),
      keyStore: keyStore.stats_(),
    },
    signer: signerStatus(),
    config: {
      sunoApiBase: CONFIG.sunoApiBase,
      generatePath: CONFIG.generatePath,
      clerkBaseUrl: CONFIG.clerkBaseUrl,
      defaultModel: CONFIG.defaultModel,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /auth/pool -> Coklu hesap havuzu detayli durum sorgusu
// ---------------------------------------------------------------------------
app.get('/auth/pool', apiKeyGuard, (_req, res) => {
  res.json({
    ok: true,
    pool: accountPool.getStatus(),
  });
});

// ---------------------------------------------------------------------------
// POST /auth/reset-limits -> Tukenmis tum hesaplarin limit durumlarini elle sifirla
// ---------------------------------------------------------------------------
app.post('/auth/reset-limits', apiKeyGuard, (_req, res) => {
  accountPool.resetAllExhausted();
  log('info', 'Tum Suno hesaplarinin limit durumlari elle sifirlandi.');
  res.json({
    ok: true,
    message: 'Tum Suno hesaplarinin limit durumlari sifirlandi.',
    pool: accountPool.getStatus(),
  });
});

// ---------------------------------------------------------------------------
// POST /auth/refresh -> token'i manuel yenile (debug / kurtarma)
// ---------------------------------------------------------------------------
app.post('/auth/refresh', apiKeyGuard, async (_req, res) => {
  try {
    const token = await refreshAccessToken(true);
    res.json({
      ok: true,
      renewed: true,
      sessionId: authState.sessionId,
      tokenExpiresInSeconds: authState.expiresAt
        ? Math.max(0, Math.round((authState.expiresAt - Date.now()) / 1000))
        : null,
      tokenPreview: `${token.slice(0, 12)}...`,
    });
  } catch (err) {
    return sendError(res, 502, 'TOKEN_REFRESH_FAILED', 'Oturum yenilenemedi.', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/token  -> calisirken taze JWT yapistir (redeploy GEREKMEZ)
//   Body: { "token": "eyJ..." }   (tarayicida: await window.Clerk.session.getToken())
// ---------------------------------------------------------------------------
app.post('/auth/token', apiKeyGuard, async (req, res) => {
  // Govde 3 sekilde gelebilir:
  //   1) { "token": "eyJ..." }          (JSON — curl/panel)
  //   2) "eyJ..."                        (text/plain — konsoldan no-cors)
  //   3) ?token=eyJ...                   (query — bazi istemciler)
  let body = req.body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    try {
      const parsed = JSON.parse(trimmed);
      body = parsed && typeof parsed === 'object' ? parsed : { token: trimmed };
    } catch (_e) {
      body = { token: trimmed };
    }
  }
  const rawToken = (body && body.token) || req.query.token || '';
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || !token.includes('.')) {
    return sendError(res, 400, 'INVALID_TOKEN', 'JWT bekleniyor: {"token":"eyJ..."} veya düz "eyJ..." govdesi.');
  }

  // --- Imza dogrulamasi: bozuk/sahte token'i Suno'ya gondermeden yakala ---
  const check = await verifyJwtSignature(token);
  if (check.signatureValid === false && req.query.force !== '1') {
    return sendError(
      res,
      400,
      'TOKEN_SIGNATURE_INVALID',
      'Token imzasi Suno anahtarlariyla dogrulanamadi: kopyalama bozulmus veya token sahte. ' +
        'Konsolda: await navigator.clipboard.writeText(await window.Clerk.session.getToken())',
      `signature_valid=false, expired=${check.expired}`,
    );
  }
  if (check.expired) {
    return sendError(res, 400, 'TOKEN_EXPIRED', 'Token suresi dolmus, yeni bir taze JWT alin.', 
      `expires_in_seconds=${check.expiresInSeconds}`);
  }

  CONFIG.sessionToken = token;
  authState.accessToken = token;
  authState.expiresAt = getTokenExpiryMs(token);
  authState.lastRefreshAt = Date.now();
  authState.lastError = null;
  log('info', 'Session token runtime\'da guncellendi.');
  res.json({
    ok: true,
    tokenExpiresInSeconds: authState.expiresAt ? Math.max(0, Math.round((authState.expiresAt - Date.now()) / 1000)) : null,
  });
});


// ---------------------------------------------------------------------------
// POST /auth/gemini-template -> Gemini web'de yakalanan istegi yukle
//   Konsol (no-cors) govdesi text/plain JSON:
//   { prompt:"...", url:"...", method:"POST", headers:{...}, body:"...", responseSample:"..." }
//   Redeploy gerekmez; sablon bellekte tutulur.
// ---------------------------------------------------------------------------
app.post('/auth/gemini-template', apiKeyGuard, async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    try {
      body = JSON.parse(trimmed);
    } catch (_e) {
      return sendError(res, 400, 'INVALID_JSON', 'Gövde JSON olmalı.');
    }
  }
  if (!body || typeof body !== 'object') {
    return sendError(res, 400, 'MISSING_BODY', 'İstek gövdesi gerekli.');
  }

  const provider = providerRegistry.providers['gemini-web'];
  if (!provider || typeof provider.setTemplate !== 'function') {
    return sendError(res, 500, 'PROVIDER_UNAVAILABLE', 'gemini-web sağlayıcısı yüklü değil.');
  }

  const tpl = provider.setTemplate({
    url: body.url,
    method: body.method,
    headers: body.headers,
    body: body.body,
    capturedPrompt: body.prompt || body.capturedPrompt,
    responseSample: body.responseSample,
  });

  if (!tpl) {
    return sendError(res, 400, 'INVALID_TEMPLATE', 'url alanı zorunlu.');
  }

  log('info', 'Gemini şablonu yakalandı.', {
    url: tpl.url.slice(0, 80),
    bodyLength: tpl.body.length,
    prompt: tpl.capturedPrompt,
  });

  return res.json({ ok: true, template: provider.getTemplateInfo() });
});

// GET /auth/gemini-template -> yakalanan şablonun özeti
app.get('/auth/gemini-template', apiKeyGuard, (_req, res) => {
  const provider = providerRegistry.providers['gemini-web'];
  const info = provider && typeof provider.getTemplateInfo === 'function' ? provider.getTemplateInfo() : null;
  res.json({ ok: true, hasTemplate: Boolean(info), template: info });
});

// ---------------------------------------------------------------------------
// GET /token/verify  -> eldeki/yeni JWT'yi Suno anahtarlariyla dogrula
// ---------------------------------------------------------------------------
app.get('/token/verify', apiKeyGuard, async (req, res) => {
  const token = String(req.query.token || CONFIG.sessionToken || CONFIG.refreshToken || '').trim();
  if (!token) return sendError(res, 400, 'NO_TOKEN', 'Dogrulanacak token yok.');
  try {
    const check = await verifyJwtSignature(token);
    const payload = decodeJwtPayload(token) || {};
    res.json({
      ok: true,
      ...check,
      kid: payload && payload.kid,
      sessionId: payload.sid,
      handle: payload['suno/handle'],
      plan: payload.plan,
      length: token.length,
    });
  } catch (err) {
    return sendError(res, 500, 'VERIFY_FAILED', 'Dogrulama yapilamadi.', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /generate-beat  -> beat / muzik uretimi
// ---------------------------------------------------------------------------
//  Istek:
//    {
//      "prompt": "Hard trap beat, 140bpm, dark piano, 808 slides",
//      "make_instrumental": true,
//      "tags": "trap, dark, 140bpm",        // opsiyonel
//      "title": "Midnight 808",             // opsiyonel
//      "model": "chirp-v4",                 // opsiyonel (mv)
//      "wait": false,                       // opsiyonel: true -> olusumu bekle
//      "waitTimeoutMs": 180000,             // opsiyonel
//      "extra": { }                         // opsiyonel: Suno payload'ina eklenir
//    }
//
//  Cevap (Suno'nun ham cevabi + meta):
//    { ok: true, request: {...}, clips: [...], suno: <ham yanit> }
// ---------------------------------------------------------------------------
app.post('/generate-beat', apiKeyGuard, async (req, res) => {
  try {
    const body = req.body || {};
    const provider = activeProvider();
    const providerName = providerRegistry.getProviderName();

    // ---- 1) Dogrulama ----
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      return sendError(res, 400, 'INVALID_PROMPT', '"prompt" alani zorunludur ve bos olamaz.');
    }
    if (prompt.length > 2000) {
      return sendError(res, 400, 'PROMPT_TOO_LONG', '"prompt" en fazla 2000 karakter olabilir.');
    }

    const configured = await provider.isConfigured();
    if (!configured) {
      return sendError(
        res,
        503,
        'PROVIDER_NOT_CONFIGURED',
        `Aktif saglayici (${providerName}) yapilandirilmamis.`,
        'Gerekli API anahtarlarini .env dosyasina ekleyin veya AUDIO_PROVIDER degistirin.',
      );
    }

    log('info', 'Uretim istegi gonderiliyor.', {
      provider: providerName,
      promptLength: prompt.length,
      instrumental: body.make_instrumental,
      model: body.model || null,
    });

    // ---- 2) Saglayiciya devret ----
    const result = await provider.generate({
      prompt,
      tags: typeof body.tags === 'string' ? body.tags : '',
      title: typeof body.title === 'string' ? body.title : '',
      instrumental:
        typeof body.make_instrumental === 'boolean' ? body.make_instrumental : CONFIG.defaultInstrumental,
      model: typeof body.model === 'string' && body.model ? body.model : null,
      extra: body.extra && typeof body.extra === 'object' ? body.extra : null,
    });

    // ---- 3) Opsiyonel: olusum bitene kadar bekle ----
    let clips = (result && result.clips) || [];
    let timedOut = false;

    if (body.wait === true && result.clip_ids && result.clip_ids.length) {
      const timeoutMs = Math.min(envInt(body.waitTimeoutMs, 180000), 300000);
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        await sleep(4000);
        try {
          const fresh = [];
          for (const id of result.clip_ids) {
            // eslint-disable-next-line no-await-in-loop
            const c = await provider.getTrack(id);
            if (c) fresh.push(c);
          }
          if (fresh.length) clips = fresh;
          if (fresh.length && fresh.every((c) => c.is_complete || c.is_error)) break;
        } catch (pollErr) {
          log('warn', 'Tracking sorgusu basarisiz.', sanitizeMessage(pollErr.message));
        }
      }
      timedOut = !(clips.length && clips.every((c) => c.is_complete || c.is_error));
    }

    // ---- 4) Cevap (sozlesme Suno ile ayni) ----
    return res.status(200).json({
      ok: true,
      provider: providerName,
      request: {
        prompt,
        make_instrumental:
          typeof body.make_instrumental === 'boolean' ? body.make_instrumental : CONFIG.defaultInstrumental,
        model: body.model || null,
      },
      clip_ids: (result && result.clip_ids) || [],
      clips,
      waited: body.wait === true,
      wait_timed_out: timedOut,
      raw: req.query.raw === '1' ? (result && result.raw) || null : undefined,
    });
  } catch (err) {
    // ---- Hata haritalama ----
    const status = err.status;

    if (err.isAuthError) {
      return sendError(res, 502, 'SUNO_AUTH_FAILED', 'Oturum yenilenemedi.', err.message);
    }
    if (status === 403) {
      return sendError(
        res,
        403,
        err.code || 'MODEL_NOT_AVAILABLE',
        'Istenen model bu hesapta kullanilamiyor.',
        err.detail,
      );
    }
    if (status === 402) {
      return sendError(res, 402, 'INSUFFICIENT_CREDITS', 'Kredi yetersiz.', err.detail);
    }
    if (status === 429) {
      return sendError(res, 429, 'RATE_LIMITED', 'Istek limiti asildi, biraz sonra tekrar deneyin.', err.detail);
    }
    if (status === 402) {
      // Replicate: "Insufficient credit" — kullaniciya net soyle.
      const isCredit = /insufficient credit/i.test(String(err.detail || ''));
      return sendError(
        res,
        402,
        isCredit ? 'PROVIDER_INSUFFICIENT_CREDIT' : 'PAYMENT_REQUIRED',
        isCredit
          ? 'Saglayici bakiyesi yetersiz. Replicate hesabina kredi yukle.'
          : 'Saglayici odeme istedi (402).',
        {
          provider: providerRegistry.getProviderName(),
          billing_url: providerRegistry.getProviderName() === 'replicate'
            ? 'https://replicate.com/account/billing'
            : null,
          upstream: err.detail,
        },
      );
    }
    if (status === 401) {
      // Saglayiciya gore mesaj: suno'da JWT, digerlerinde API token.
      if (providerRegistry.getProviderName() === 'suno') {
        return sendError(
          res,
          502,
          'SUNO_AUTH_FAILED',
          'Suno token reddetti (401). Taze JWT gerekli: POST /auth/token.',
          err.detail,
        );
      }
      return sendError(
        res,
        502,
        'PROVIDER_AUTH_FAILED',
        'Saglayici kimlik bilgisini reddetti (401). API token gecerli mi?',
        err.detail,
      );
    }
    if (status === 503) {
      return sendError(res, 503, err.code || 'PROVIDER_NOT_CONFIGURED', err.message, err.detail);
    }
    const isSuno = providerRegistry.getProviderName() === 'suno';
    if (isSuno && (status === 422 || /token_validation_failed/i.test(String(err.detail || '')))) {
      // Suno 422'yi hem "token gecersiz" hem "kredin bitti" icin donduruyor.
      // Gercek sebebi olcelim: bakiye sifirsa bunu acikca soyle.
      const credits = await fetchCreditsSafe();
      if (credits && credits.credits === 0) {
        return sendError(res, 402, 'OUT_OF_CREDITS', 'Suno kredisi bitti (credits: 0). Uretim yapilamiyor.', {
          ...credits,
          hint: 'Gunluk kredi sifirlandiginda veya plan yukseltilince tekrar calisir.',
        });
      }
      return sendError(res, 422, 'TOKEN_REJECTED', 'Suno istegi reddetti (token veya kredi).', {
        upstream: err.detail,
        credits,
      });
    }
    if (status) {
      return sendError(res, 502, err.code || 'PROVIDER_ERROR', `Saglayici ${status} dondurdu.`, err.detail);
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Saglayici zaman asimina ugradi.');
    }

    log('error', 'generate-beat beklenmeyen hata.', err.message);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Beklenmeyen bir hata olustu.', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /clips?ids=a,b,c -> klip durumlarini sorgula (opsiyonel yardimci)
// ---------------------------------------------------------------------------
app.get('/clips', apiKeyGuard, async (req, res) => {
  try {
    const ids = String(req.query.ids || '').trim();
    if (!ids) return sendError(res, 400, 'MISSING_IDS', '"ids" query parametresi zorunludur (virgulle ayrilmis).');

    const data = await sunoRequest('get', `${CONFIG.feedPath}?ids=${encodeURIComponent(ids)}`);
    return res.json({ ok: true, data });
  } catch (err) {
    return sendError(res, 502, 'SUNO_API_ERROR', 'Klip bilgisi alinamadi.', err.detail || err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /track/:id  ->  durum sorgulama (polling) + sarki bilgisi
// ---------------------------------------------------------------------------
//  Query:
//    ?wait=true            -> complete/error olana kadar bekle (varsayilan 120 sn)
//    ?waitTimeoutMs=60000  -> bekleme ust siniri (max 300000)
//    ?raw=1                -> Suno'nun ham klip nesnesini de dondur
//
//  Ornek:  GET /track/afaea7cd-244b-4b00-9a5b-93152f74d285?wait=true
// ---------------------------------------------------------------------------
app.get('/track/:id', apiKeyGuard, async (req, res) => {
  // NOT: asagida klip tamamsa otomatik indirme URL'si cozulur (auto-download).
  try {
    const clipId = String(req.params.id || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clipId)) {
      return sendError(res, 400, 'INVALID_ID', 'Gecersiz klip id formati.');
    }

    const provider = activeProvider();
    const providerName = providerRegistry.getProviderName();

    let track = await provider.getTrack(clipId);
    if (!track) {
      return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi: ${clipId}`);
    }

    // --- Opsiyonel: tamamlanana kadar bekle ---
    let waited = false;
    let timedOut = false;
    if (req.query.wait === 'true' && !track.is_complete && !track.is_error) {
      const timeoutMs = Math.min(envInt(req.query.waitTimeoutMs, 120000), 300000);
      const deadline = Date.now() + timeoutMs;
      waited = true;

      while (Date.now() < deadline) {
        await sleep(4000);
        try {
          const fresh = await provider.getTrack(clipId);
          if (fresh) track = fresh;
          if (fresh && (fresh.is_complete || fresh.is_error)) break;
        } catch (pollErr) {
          log('warn', 'Tracking sorgusu basarisiz.', sanitizeMessage(pollErr.message));
        }
      }
      timedOut = !(track.is_complete || track.is_error);
    }

    // --- AUTO-DOWNLOAD: klip tamamsa indirme URL'sini SIMDI coz ---
    // Dashboard bunu gorunce "Indir" butonu hazir olur; ayri bir cagri gerekmez.
    let download = { ready: false };
    if (track.is_complete && typeof provider.getDownloadSource === 'function') {
      try {
        const dl = await provider.getDownloadSource(clipId, 'mp3');
        download = dl && dl.url
          ? {
              ready: true,
              mode: 'official-api',
              format: dl.format || 'mp3',
              // Istemci bu yolu kullanir; presigned link sizmaz.
              proxy_path: `/download?id=${encodeURIComponent(clipId)}`,
              stream_path: `/stream/${encodeURIComponent(clipId)}`,
            }
          : { ready: false, reason: 'download_not_authorized' };
      } catch (dlErr) {
        download = {
          ready: false,
          reason: dlErr.code || 'download_not_authorized',
          detail: sanitizeMessage(dlErr.detail || dlErr.message),
        };
      }
    } else if (track.is_complete && typeof provider.getAudioBuffer === 'function') {
      // Saglayici sesi bayt olarak veriyor (Google Lyria, reapi...): indirme hazir.
      download = {
        ready: true,
        mode: 'memory',
        format: 'mp3',
        proxy_path: `/download?id=${encodeURIComponent(clipId)}`,
        stream_path: `/stream/${encodeURIComponent(clipId)}`,
      };
    } else if (track.is_complete) {
      download = { ready: false, reason: 'provider_has_no_download_api' };
    }

    // Eger resmi indirme izni yoksa bile klip tamamlandiginda proxy
    // uzerinden desifre edilerek MP3 olarak servis edilir.
    if (!download.ready && track.is_complete) {
      download = {
        ready: true,
        mode: 'decrypted',
        format: 'mp3',
        proxy_path: `/download?id=${encodeURIComponent(clipId)}`,
        stream_path: `/stream/${encodeURIComponent(clipId)}`,
      };
    }

    return res.json({
      ok: true,
      provider: providerName,
      track,
      download,
      waited,
      wait_timed_out: timedOut,
      ...(req.query.raw === '1' ? { raw: track } : {}),
    });
  } catch (err) {
    if (err.status) {
      return sendError(res, 502, err.code || 'PROVIDER_ERROR', err.message, err.detail);
    }
    return sendError(res, 502, 'PROVIDER_ERROR', 'Klip durumu alinamadi.', err.detail || err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /download  ->  MP3 / gorsel akis koprusu (CORS + yetki sorununu cozer)
// ---------------------------------------------------------------------------
//  Kullanim:
//    GET /download?id=<clip_id>              -> feed'den gercek audio_url'yi bulur
//    GET /download?url=https://cdn1...mp3    -> dogrudan allowlist'teki URL
//    &inline=1                               -> tarayicida oynat (attachment yerine)
//    &filename=midnight-808.mp3              -> dosya adini override et
//
//  Not: Istemci URL verirken SSRF korumasi devrede (bkz. isAllowedDownloadUrl).
// ---------------------------------------------------------------------------
/**
 * INDIRME/STREAM ERISIM LOGU
 * --------------------------
 * Her istek icin: yol (api_key gizlenmis), durum kodu, mod, bayt, sure.
 * Hata durumunda sendError'in urettigi kod da bu satirda gorunur.
 * API anahtari ASLA loglanmaz (sanitizeUrlForLog).
 */
app.use((req, res, next) => {
  if (!/^\/(download|stream)(\/|$)/.test(req.path)) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    const mode =
      res.getHeader('X-Download-Mode') || res.getHeader('X-Proxy-Mode') || res.getHeader('X-Transcode') || '-';
    log(res.statusCode >= 400 ? 'warn' : 'info', 'Ses istegi tamamlandi.', {
      method: req.method,
      path: sanitizeUrlForLog(req.originalUrl),
      status: res.statusCode,
      mode,
      length: res.getHeader('Content-Length') || '-',
      contentType: res.getHeader('Content-Type') || '-',
      ms: Date.now() - startedAt,
    });
  });
  next();
});

app.get('/download', apiKeyGuard, async (req, res) => {
  try {
    const inline = req.query.inline === '1' || req.query.inline === 'true';
    // mode=stream  ->  tarayicida oynat (inline) + gerekirse mp3'e cevir
    const mode = req.query.mode === 'stream' ? 'stream' : 'download';
    const wantTranscode = req.query.format === 'mp3' || req.query.format === 'wav' || mode === 'stream';
    const format = req.query.format === 'wav' ? 'wav' : 'mp3';

    let targetUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    let suggestedName = typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
    let clipTitle = '';
    let proxyMode = 'direct';      // direct | cdn | transparent
    let forceTransparent = false;  // transparent kaynakta transcode yapilmaz
    let handshakeSessionId = null; // handshake'ten gelen analytics session id
    let requestedFormat = null;    // saglayicidan gelen sesin istenen formati

    // --- (A0a) ERKEN ALLOWLIST KONTROLU ---
    // url parametresi ile gelindiyse, cagri zincirine girmeden net 403 don.
    if (targetUrl) {
      const pre = isAllowedDownloadUrl(targetUrl);
      if (!pre.ok) {
        log('warn', 'Indirme adresi allowlist disinda.', {
          host: safeHost(targetUrl),
          reason: pre.reason,
        });
        return sendError(
          res,
          403,
          'URL_NOT_ALLOWED',
          `Indirme adresi reddedildi: ${pre.reason}`,
          pre.hint || undefined,
        );
      }
    }

    // --- (A) id verildiyse: feed'den gercek ses adresini coz ---
    if (!targetUrl && req.query.id) {
      const clipId = String(req.query.id).trim();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(clipId)) {
        return sendError(res, 400, 'INVALID_ID', 'Gecersiz klip id formati.');
      }

      const provider = activeProvider();

      // --- (A0) BELLEK DEPOSU: saglayici sesi bayt olarak verdiyse (orn. Google Lyria)
      // disarida URL yok; dogrudan kendi indirme sistemimizden servis ederiz.
      if (typeof provider.getAudioBuffer === 'function') {
        const ab = await provider.getAudioBuffer(clipId);
        if (ab && ab.buffer && ab.buffer.length) {
          const fname = suggestedName || ab.filename || `${clipId}.mp3`;
          log('info', 'Bellek deposundan servis edildi.', { clipId, bytes: ab.buffer.length, format });
          return sendAudioBuffer(req, res, { buffer: ab.buffer, mime: ab.mime, filename: fname }, { inline });
        }
      }

      // Suno'ya ozgu handshake (varsa)
      if (typeof provider.beforeStream === 'function') {
        const hs = await provider.beforeStream(clipId);
        if (hs) {
          res.setHeader('X-Handshake', hs.result);
          handshakeSessionId = hs.sessionId;
        }
      }

      const track = await provider.getTrack(clipId);
      if (!track) return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi: ${clipId}`);

      clipTitle = track.title || '';
      requestedFormat = String(req.query.format || 'mp3').toLowerCase();

      // --- Once SUNO RESMI INDIRME UCU (duz MP3, sifresiz) ---
      // Sadece indirme hakkina sahip kliplerde calisir; olmazsa asagidaki
      // normal akisa (audiopipe / CDN) duser.
      if (typeof provider.getDownloadSource === 'function' && !req.query.no_download_api) {
        try {
          // Suno bu hesapta yalnizca mp3 veriyor; wav istenirse mp3 alip ceviririz.
          const dl = await provider.getDownloadSource(clipId, 'mp3');
          if (dl && dl.url) {
            res.setHeader('X-Download-Mode', 'official-api');
            if (!suggestedName) {
              const slug = slugifyText(clipTitle, 'suno');
              suggestedName = `${slug}-${clipId.slice(0, 8)}.${format}`;
            }
            log('info', 'Resmi indirme ucu kullanildi.', { clipId, format, status: dl.status });
            return await pipeAudioStream(req, res, {
              upstreamUrl: dl.url,
              transcode: format === 'wav', // mp3 -> wav gerekirse ffmpeg
              format,
              filename: suggestedName,
              inline,
              proxyMode: 'official',
              sessionId: handshakeSessionId,
            });
          }
        } catch (err) {
          log('warn', 'Resmi indirme ucu basarisiz, normal akisa donuluyor.', sanitizeMessage(err.message));
        }
      }

      const source = await provider.getAudioSource(track);
      if (!source) {
        return sendError(
          res,
          409,
          'NO_AUDIO_SOURCE',
          'Saglayici bu klip icin ses adresi vermedi.',
          track.download_blocked_reason || undefined,
        );
      }

      // Ic kaynak: bellekten akit
      if (source.internal || String(source.url).startsWith('internal://')) {
        return await pipeInternalAudio(req, res, source.url);
      }

      targetUrl = source.url;
      proxyMode = source.transparent ? 'transparent' : 'cdn';
      if (source.transparent) forceTransparent = true;
      if (!suggestedName) {
        const slug = String(clipTitle || 'suno')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 48) || 'suno';
        suggestedName = `${slug}-${clipId.slice(0, 8)}.${format}`;
      }
    }

    if (!targetUrl) {
      return sendError(res, 400, 'MISSING_TARGET', '?id=<clip_id> veya ?url=<https://...> gerekli.');
    }

    // --- (B) SSRF kontrolu ---
    const check = isAllowedDownloadUrl(targetUrl);
    if (!check.ok) {
      log('warn', 'Indirme reddedildi (SSRF korumasi).', { url: String(targetUrl).slice(0, 80), reason: check.reason });
      return sendError(res, 403, 'URL_NOT_ALLOWED', `Indirme adresi reddedildi: ${check.reason}`);
    }

    // Dosya adi verilmediyse URL yolundan turet (query string haric).
    if (!suggestedName) suggestedName = deriveFilenameFromUrl(targetUrl, format);

    const effectiveTranscode = forceTransparent ? false : wantTranscode;

    log('info', 'Ses akisi baslatildi.', {
      mode,
      transcode: effectiveTranscode,
      format,
      proxyMode,
    });

    // --- (C) Ortak boru hatti: upstream -> [ffmpeg] -> res ---
    await pipeAudioStream(req, res, {
      upstreamUrl: check.url,
      clipId: req.query.id ? String(req.query.id).trim() : null,
      transcode: effectiveTranscode,
      format,
      filename: suggestedName,
      inline: inline || mode === 'stream',
      proxyMode,
      sessionId: handshakeSessionId,
    });
  } catch (err) {
    if (res.headersSent) {
      log('warn', 'Indirme hatasi (basliklar gonderildikten sonra).', sanitizeMessage(err.message));
      return res.destroy();
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return sendError(res, 504, 'UPSTREAM_TIMEOUT', 'Dosya kaynagi zaman asimina ugradi.');
    }
    if (err.upstreamStatus) res.setHeader('X-Upstream-Status', String(err.upstreamStatus));
    if (err.status && err.code) {
      return sendError(res, err.status, err.code, err.message, err.detail);
    }
    return sendError(res, 500, 'DOWNLOAD_FAILED', 'Indirme basarisiz.', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /stream/:id  ->  tarayici dostu ses akisi (drop-in <audio src>)
// ---------------------------------------------------------------------------
//  Query:
//    ?format=mp3|wav|original   (varsayilan mp3 - gerekirse ffmpeg ile donusturur)
//    ?inline=1                  (varsayilan zaten inline)
//
//  Pro/Pro+ hesap:  CDN audio_url -> [ffmpeg] -> tarayici
//  Ucretsiz hesap:  indirilebilir ses YOK -> 409 + aciklama (bkz. README §10)
// ---------------------------------------------------------------------------
app.get('/stream/:id', apiKeyGuard, async (req, res) => {
  try {
    const clipId = String(req.params.id || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clipId)) {
      return sendError(res, 400, 'INVALID_ID', 'Gecersiz klip id formati.');
    }

    const provider = activeProvider();
    const providerName = providerRegistry.getProviderName();

    // --- Bellek deposu (Google Lyria gibi saglayicilar) ---
    if (typeof provider.getAudioBuffer === 'function') {
      const ab = await provider.getAudioBuffer(clipId);
      if (ab && ab.buffer && ab.buffer.length) {
        return sendAudioBuffer(req, res, { buffer: ab.buffer, mime: ab.mime, filename: ab.filename }, { inline: true });
      }
    }

    // --- Suno'ya ozgu handshake (diger saglayicilarda no-op) ---
    let handshakeSessionId = null;
    if (typeof provider.beforeStream === 'function') {
      const hs = await provider.beforeStream(clipId);
      if (hs) {
        res.setHeader('X-Handshake', hs.result);
        handshakeSessionId = hs.sessionId;
      }
    }

    const track = await provider.getTrack(clipId);
    if (!track) return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi: ${clipId}`);

    if (!track.is_complete && !track.is_error) {
      return sendError(
        res,
        425,
        'TRACK_NOT_READY',
        `Klip henuz hazir degil (durum: ${track.status}). /track/${clipId}?wait=true ile bekleyin.`,
      );
    }
    if (track.is_error) {
      return sendError(res, 409, 'TRACK_FAILED', `Uretim basarisiz (${providerName}).`, track.download_blocked_reason);
    }

    // --- Once SUNO RESMI INDIRME UCU: duz MP3, tarayicida <audio> ile calar ---
    // (indirme hakkina sahip kliplerde calisir; olmazsa audiopipe'a duser)
    if (typeof provider.getDownloadSource === 'function' && !envBool(req.query.no_download_api, false)) {
      try {
        const dl = await provider.getDownloadSource(clipId, 'mp3');
        if (dl && dl.url) {
          res.setHeader('X-Download-Mode', 'official-api');
          res.setHeader('X-Sign-Strategy', 'none');
          log('info', 'Stream: resmi indirme ucu.', { clipId, status: dl.status });
          return await pipeAudioStream(req, res, {
            upstreamUrl: dl.url,
            transcode: false,
            format: 'mp3',
            filename: `${slugifyText(track.title, 'beat')}-${clipId.slice(0, 8)}.mp3`,
            inline: true,
            proxyMode: 'official',
            sessionId: handshakeSessionId,
          });
        }
      } catch (err) {
        log('debug', 'Resmi indirme ucu yok, audiopipe akisina geciliyor.', sanitizeMessage(err.message));
      }
    }

    const source = await provider.getAudioSource(track);
    if (!source) {
      return sendError(
        res,
        409,
        'NO_AUDIO_SOURCE',
        `Saglayici (${providerName}) bu klip icin ses adresi vermedi.`,
        track.download_blocked_reason || undefined,
      );
    }

    // --- Ic kaynak (mock / elevenlabs): bellekten akit ---
    if (source.internal || String(source.url).startsWith('internal://')) {
      return await pipeInternalAudio(req, res, source.url);
    }

    // --- Dis kaynak: pass-through / transcode ---
    const check = isAllowedDownloadUrl(source.url);
    if (!check.ok) {
      return sendError(res, 403, 'URL_NOT_ALLOWED', `Ses adresi reddedildi: ${check.reason}`);
    }

    const format = ['wav', 'original'].includes(String(req.query.format)) ? String(req.query.format) : 'mp3';
    const fileName = `${slugifyText(track.title, 'beat')}-${clipId.slice(0, 8)}.${format === 'original' ? 'mp3' : format}`;

    // Imza stratejisini istemciye raporla (deger sizdirmadan)
    const signStrategy = (source.signature && source.signature.strategy) || 'none';
    res.setHeader('X-Sign-Strategy', signStrategy);
    if (source.signature && Object.keys(source.signature.params || {}).length) {
      res.setHeader('X-Sign-Params', Object.keys(source.signature.params).join(','));
    }

    log('info', 'Stream istegi.', {
      provider: providerName,
      clipId,
      format,
      source: source.source,
      sign: signStrategy,
      signParams: source.signature ? Object.keys(source.signature.params || {}) : [],
      url: signer.redactUrl(check.url),
    });

    await pipeAudioStream(req, res, {
      upstreamUrl: check.url,
      clipId,
      transcode: !source.transparent && format !== 'original',
      format: format === 'original' ? 'mp3' : format,
      filename: fileName,
      inline: true,
      proxyMode: source.transparent ? 'transparent' : 'cdn',
      sessionId: handshakeSessionId,
    });
  } catch (err) {
    if (res.headersSent) {
      log('warn', 'Stream hatasi (basliklar sonrasi).', sanitizeMessage(err.message));
      return res.destroy();
    }
    if (err.upstreamStatus) res.setHeader('X-Upstream-Status', String(err.upstreamStatus));
    if (err.status && err.code) {
      return sendError(res, err.status, err.code, err.message, err.detail);
    }
    return sendError(res, 502, 'STREAM_FAILED', 'Akis baslatilamadi.', err.detail || err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /debug/stream/:id  ->  akis teshisi (bayt sayisi, status, header'lar)
// ---------------------------------------------------------------------------
//  Akisi istemciye GONDERMEZ; upstream'e baglanip ilk N bayti okur ve raporlar.
//
//  Query:
//    ?bytes=16384   -> kac bayt okunacak (varsayilan 16384, max 1 MB)
//    ?url=...       -> klip yerine dogrudan URL dene (allowlist gecerli)
//    ?skipCookie=1  -> Cookie header'i gonderme (A/B testi icin)
// ---------------------------------------------------------------------------
app.get('/debug/stream/:id', apiKeyGuard, async (req, res) => {
  const startedAt = Date.now();
  try {
    const clipId = String(req.params.id || '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clipId)) {
      return sendError(res, 400, 'INVALID_ID', 'Gecersiz klip id formati.');
    }

    const maxBytes = Math.min(envInt(req.query.bytes, 16384), 1024 * 1024);

    // --- Kaynak cozumu ---
    const clip = await fetchClip(clipId);
    if (!clip) return sendError(res, 404, 'TRACK_NOT_FOUND', `Klip bulunamadi: ${clipId}`);

    const source = await resolveAudioSource(clip, req);
    let targetUrl = source.url;
    if (typeof req.query.url === 'string' && req.query.url.trim()) {
      const direct = isAllowedDownloadUrl(req.query.url.trim());
      if (!direct.ok) return sendError(res, 403, 'URL_NOT_ALLOWED', direct.reason);
      targetUrl = direct.url;
    }

    // --- Header hazirla ---
    const skipCookie = req.query.skipCookie === '1';
    const tokenForCookie = authState.accessToken || CONFIG.sessionToken || null;
    const cookieHeader = skipCookie ? null : buildUpstreamCookieHeader(tokenForCookie);

    const headers = {
      'User-Agent': CONFIG.upstreamUserAgent || BROWSER_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: CONFIG.upstreamReferer,
      Origin: CONFIG.upstreamOrigin,
      'Browser-Token': buildBrowserToken(),
      'Device-Id': resolveDeviceId(),
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (req.headers.range) headers.Range = req.headers.range;

    // --- Upstream'i ac ve ilk N bayti oku ---
    const upstream = await axios({
      method: 'get',
      url: targetUrl,
      responseType: 'stream',
      timeout: CONFIG.requestTimeoutMs,
      maxRedirects: 3,
      decompress: false,
      validateStatus: () => true,
      headers,
      httpsAgent: getUpstreamAgent(),
      proxy: false,
    });

    const chunks = [];
    let bytesRead = 0;
    let readError = null;

    await new Promise((resolveProbe) => {
      const finish = () => {
        try {
          upstream.data.destroy();
        } catch (_e) {}
        resolveProbe();
      };

      const timer = setTimeout(finish, 10000);

      upstream.data.on('data', (chunk) => {
        const room = maxBytes - bytesRead;
        if (room <= 0) return;
        chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
        bytesRead += Math.min(chunk.length, room);
        if (bytesRead >= maxBytes) {
          clearTimeout(timer);
          finish();
        }
      });
      upstream.data.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      upstream.data.on('error', (e) => {
        readError = e.message;
        clearTimeout(timer);
        finish();
      });
    });

    const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const firstBytes = body.subarray(0, 16);

    // --- Sinyal yorumu ---
    const ct = String(upstream.headers['content-type'] || '');
    let signal = 'unknown';
    if (bytesRead === 0) signal = 'EMPTY';
    else if (firstBytes[0] === 0x49 && firstBytes[1] === 0x44 && firstBytes[2] === 0x33) signal = 'ID3/MP3';
    else if (firstBytes[0] === 0xff && (firstBytes[1] & 0xe0) === 0xe0) signal = 'MPEG-frame/MP3';
    else if (firstBytes[0] === 0x1a && firstBytes[1] === 0x45 && firstBytes[2] === 0xdf && firstBytes[3] === 0xa3)
      signal = 'WebM/Matroska';
    else signal = 'opaque (non-standard header)';

    const report = {
      ok: true,
      clip_id: clipId,
      source: source.source,
      proxy_mode: source.transparent ? 'transparent' : 'cdn',
      url: targetUrl,
      elapsed_ms: Date.now() - startedAt,
      request_headers_sent: {
        ...Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [
            k,
            k.toLowerCase() === 'cookie'
              ? v.split(';').map((c) => c.split('=')[0].trim())
              : k.toLowerCase() === 'authorization'
                ? '<redacted>'
                : v,
          ]),
        ),
      },
      upstream: {
        status: upstream.status,
        status_text: upstream.statusText,
        content_type: ct,
        content_length: upstream.headers['content-length'] || null,
        content_range: upstream.headers['content-range'] || null,
        accept_ranges: upstream.headers['accept-ranges'] || null,
        cache_control: upstream.headers['cache-control'] || null,
        server: upstream.headers['server'] || null,
        all_headers: upstream.headers,
      },
      body: {
        bytes_read: bytesRead,
        bytes_requested: maxBytes,
        first_16_bytes_hex: firstBytes.toString('hex'),
        first_16_bytes_ascii: firstBytes.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
        detected_format: signal,
        read_error: readError,
      },
      diagnosis:
        bytesRead === 0
          ? 'Upstream 200 dondurdu ama govde bos. Header/cookie gecisi mi yoksa sunucu tarafi mi, ' +
            '?skipCookie=1 ile A/B testi yapin; ayrica ?bytes=65536 deneyin (gecikmeli yazim olabilir).'
          : signal === 'opaque (non-standard header)'
            ? 'Govde geliyor ancak MP3/WebM magic byte yok: kaynak standart bir ses dosyasi degil.'
            : 'Govde geliyor ve gecerli bir ses konteyneri gibi gorunuyor.',
    };

    log('info', 'debug/stream raporu.', {
      clipId,
      upstreamStatus: upstream.status,
      bytesRead,
      signal,
    });

    res.setHeader('X-Upstream-Status', String(upstream.status));
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.download === '1' && bytesRead > 0) {
      // Teshis icin ilk N bayti dosya olarak indir
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="probe-${clipId.slice(0, 8)}.bin"`);
      return res.send(body);
    }
    return res.json(report);
  } catch (err) {
    log('error', 'debug/stream hatasi.', sanitizeMessage(err.message));
    if (err.upstreamStatus) res.setHeader('X-Upstream-Status', String(err.upstreamStatus));
    return sendError(res, 502, 'DEBUG_PROBE_FAILED', 'Teshis istegi basarisiz.', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /providers  ->  mevcut saglayicilar ve aktif olan
// ---------------------------------------------------------------------------
app.get('/providers', apiKeyGuard, async (_req, res) => {
  const list = [];
  for (const [name, mod] of Object.entries(providerRegistry.providers)) {
    let configured = false;
    try {
      configured = await mod.isConfigured();
    } catch (_e) {
      configured = false;
    }
    list.push({ name, configured, active: name === providerRegistry.getProviderName() });
  }
  res.json({ ok: true, active: providerRegistry.getProviderName(), providers: list });
});

// ---------------------------------------------------------------------------
// POST /providers/select  ->  { "provider": "mock" }  (runtime degistirme)
// ---------------------------------------------------------------------------
app.post('/providers/select', apiKeyGuard, async (req, res) => {
  const requested = req.body && req.body.provider;
  const selected = providerRegistry.setProviderName(requested);
  if (!selected) {
    return sendError(
      res,
      400,
      'UNKNOWN_PROVIDER',
      `Bilinmeyen saglayici: ${requested}`,
      `Gecerli: ${providerRegistry.listProviders().join(', ')}`,
    );
  }
  const mod = providerRegistry.getProvider();
  const configured = await mod.isConfigured().catch(() => false);
  log('info', 'Saglayici degistirildi.', { provider: selected, configured });
  res.json({ ok: true, active: selected, configured });
});


// ---------------------------------------------------------------------------
// GET /debug/signer  ->  imza motoru teshisi
// ---------------------------------------------------------------------------
//  NE YAPAR
//    1. Imza stratejisini cozer (client -> pool -> derive -> none).
//    2. Uretilen URL'i ve parametreleri (maskeli) gosterir.
//    3. ?probe=1   -> URL'den gercekten bayt geliyor mu, OLCER.
//    4. ?compare=1 -> hem IMZASIZ hem IMZALI URL'i olcup yan yana koyar.
//                     (imza gercekten fark yaratiyor mu sorusunun kaniti)
//
//  Query:
//    ?id=<clipId>        klip id (audiopipe sablonu icin)
//    ?url=<https://...>  dogrudan URL (allowlist gecerli)
//    ?spec=...           .env'deki SIGNER_SPEC'i gecici olarak ez (debug)
//    ?secret=...         gecici secret (yanitta/logda GORUNMEZ)
//    ?probe=1            bayt olcumu yap
//    ?compare=1          imzasiz + imzali karsilastirma
//    ?bytes=65536        probe okuma siniri (max 4 MB)
//    ?put=1              cozulen parametreleri havuza yaz
//    ?clear=1            havuzu bosalt
// ---------------------------------------------------------------------------
app.get('/debug/signer', apiKeyGuard, async (req, res) => {
  const startedAt = Date.now();
  try {
    const clipId = String(req.query.id || req.query.clip_id || '').trim();
    if (clipId && !/^[A-Za-z0-9_-]{8,64}$/.test(clipId)) {
      return sendError(res, 400, 'INVALID_ID', 'Gecersiz klip id formati.');
    }

    const specOverride = typeof req.query.spec === 'string' && req.query.spec.trim() ? req.query.spec.trim() : '';
    const secretOverride = typeof req.query.secret === 'string' && req.query.secret ? req.query.secret : undefined;

    if (envBool(req.query.clear, false) && CONFIG.signerPoolEnabled) signaturePool.clear();

    // --- Temel URL (parametresiz) ---
    let baseUrl = null;
    if (typeof req.query.url === 'string' && req.query.url.trim()) {
      const direct = isAllowedDownloadUrl(req.query.url.trim());
      if (!direct.ok) return sendError(res, 403, 'URL_NOT_ALLOWED', direct.reason);
      baseUrl = direct.url;
    } else if (clipId) {
      baseUrl = fillUrlTemplate(CONFIG.audiopipeUrlTemplate, clipId, req);
    } else {
      return sendError(res, 400, 'MISSING_TARGET', 'En az bir ?id= veya ?url= gerekli.');
    }

    // --- Strateji cozumu ---
    const resolution = await resolveSignature(clipId || 'debug', req, {
      spec: specOverride || undefined,
      secret: secretOverride,
    });

    const signedUrl = Object.keys(resolution.params).length
      ? signer.buildSignedUrl(baseUrl, resolution.params)
      : baseUrl;

    if (envBool(req.query.put, false) && CONFIG.signerPoolEnabled && Object.keys(resolution.params).length) {
      signaturePool.put(clipId || 'debug', resolution.params, {
        source: 'debug',
        ttlMs: envInt(req.query.ttl, CONFIG.signerPoolTtlMs),
      });
    }

    // --- Olcum (opsiyonel) ---
    const wantProbe = envBool(req.query.probe, false) || envBool(req.query.compare, false);
    let probe = null;
    let probeUnsigned = null;

    if (wantProbe) {
      const check = isAllowedDownloadUrl(signedUrl);
      if (!check.ok) return sendError(res, 403, 'URL_NOT_ALLOWED', check.reason);

      const probeOpts = { maxBytes: envInt(req.query.bytes, 65536), timeoutMs: envInt(req.query.timeout, 15000), req };
      probe = await probeUpstreamBytes(check.url, probeOpts);

      if (envBool(req.query.compare, false) && signedUrl !== baseUrl) {
        const baseCheck = isAllowedDownloadUrl(baseUrl);
        if (baseCheck.ok) probeUnsigned = await probeUpstreamBytes(baseCheck.url, probeOpts);
      }
    }

    return res.json({
      ok: true,
      clip_id: clipId || null,
      signer: signerStatus(),
      derivers: Object.keys(signer.DERIVERS),
      resolution: {
        strategy: resolution.strategy,
        from_pool: resolution.from_pool,
        params_keys: Object.keys(resolution.params),
        params_redacted: signer.redactParams(resolution.params),
        errors: resolution.errors,
        url: signer.redactUrl(signedUrl),
        url_unsigned_redacted: signer.redactUrl(baseUrl),
        changed: signedUrl !== baseUrl,
      },
      probe,
      probe_unsigned: probeUnsigned,
      comparison:
        probe && probeUnsigned
          ? {
              signed_bytes: probe.bytes_read,
              unsigned_bytes: probeUnsigned.bytes_read,
              delta_bytes: probe.bytes_read - probeUnsigned.bytes_read,
              verdict:
                probe.bytes_read > probeUnsigned.bytes_read
                  ? 'IMZA FARK YARATIYOR: imzali URL daha fazla bayt dondurdu.'
                  : probe.bytes_read === probeUnsigned.bytes_read
                    ? 'IMZA FARK YARATMIYOR: iki URL ayni miktarda bayt dondurdu.'
                    : 'IMZA FARK YARATMIYOR (ters): imzasiz URL daha fazla bayt dondurdu.',
            }
          : null,
      re_findings: signer.RE_FINDINGS,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (err) {
    if (err.status && err.code) return sendError(res, err.status, err.code, err.message, err.detail);
    return sendError(res, 500, 'SIGNER_DEBUG_FAILED', 'Imza teshisi basarisiz.', err.message);
  }
});

// ---------------------------------------------------------------------------
// POST /debug/signer/pool   ->  havuza elle imza parametresi ekle
// ---------------------------------------------------------------------------
//  body: { clip_id: "...", params: { sig: "...", expires: "..." }, ttl_ms: 120000 }
//  Tarayicidan yakalanan gercek bir imza buraya yazilir; proxy onu kullanir
//  ve TTL boyunca yeniden uretmez.
// ---------------------------------------------------------------------------
app.post('/debug/signer/pool', apiKeyGuard, (req, res) => {
  if (!CONFIG.signerEnabled || !CONFIG.signerPoolEnabled) {
    return sendError(res, 503, 'SIGNER_DISABLED', 'Imza havuzu kapali (SIGNER_ENABLED / SIGNER_POOL_ENABLED).');
  }
  const body = req.body || {};
  const clipId = String(body.clip_id || body.id || '').trim();
  const params = body.params;

  if (!clipId) return sendError(res, 400, 'INVALID_ID', 'clip_id zorunlu.');
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return sendError(res, 400, 'INVALID_PARAMS', 'params nesnesi zorunlu.');
  }
  if (Object.keys(params).length > 12) {
    return sendError(res, 400, 'TOO_MANY_PARAMS', 'En fazla 12 parametre.');
  }

  const clean = {};
  for (const [k, v] of Object.entries(params)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) continue;
    if (v === undefined || v === null) continue;
    clean[k] = String(v).slice(0, 2048);
  }
  if (!Object.keys(clean).length) {
    return sendError(res, 400, 'INVALID_PARAMS', 'Gecerli parametre yok.');
  }

  signaturePool.put(clipId, clean, { source: 'api', ttlMs: envInt(body.ttl_ms, CONFIG.signerPoolTtlMs) });
  return res.json({
    ok: true,
    clip_id: clipId,
    params_keys: Object.keys(clean),
    ttl_ms: envInt(body.ttl_ms, CONFIG.signerPoolTtlMs),
    pool: signaturePool.stats_(),
  });
});

// ---------------------------------------------------------------------------
// DELETE /debug/signer/pool[?key=...]   ->  havuzdan kayit sil / temizle
// ---------------------------------------------------------------------------
app.delete('/debug/signer/pool', apiKeyGuard, (req, res) => {
  const key = String(req.query.key || '').trim();
  if (key) {
    const removed = signaturePool.delete(key);
    return res.json({ ok: true, removed, key });
  }
  signaturePool.clear();
  return res.json({ ok: true, cleared: true });
});

// ---------------------------------------------------------------------------
// GET /debug/tls  ->  upstream TLS parmak izini olcer (JA3/JA4 + cipher)
// ---------------------------------------------------------------------------
//  Query:
//    ?url=https://tls.peet.ws/api/all   (varsayilan) - parmak izi servisi
//    ?profile=none                      - Chrome profili kapali (A/B testi)
// ---------------------------------------------------------------------------
app.get('/debug/tls', apiKeyGuard, async (req, res) => {
  try {
    const target = typeof req.query.url === 'string' && req.query.url.trim()
      ? req.query.url.trim()
      : 'https://tls.peet.ws/api/all';
    const check = isAllowedDownloadUrl(target);
    if (!check.ok) return sendError(res, 403, 'URL_NOT_ALLOWED', check.reason);

    const useChrome = req.query.profile !== 'none';
    const agent = useChrome ? getUpstreamAgent() : undefined;

    const startedAt = Date.now();
    const r = await axios.get(check.url, {
      timeout: 20000,
      httpsAgent: agent,
      proxy: false,
      headers: { 'User-Agent': CONFIG.upstreamUserAgent || BROWSER_UA, Accept: '*/*' },
      validateStatus: () => true,
    });

    const d = r.data || {};
    return res.json({
      ok: true,
      profile: useChrome ? 'chrome-like' : 'node-default',
      elapsed_ms: Date.now() - startedAt,
      tls: {
        version: d.tls && d.tls.tls_version_negotiated,
        ja3_hash: d.tls && d.tls.ja3_hash,
        ja3: d.tls && d.tls.ja3,
        ja4: d.tls && d.tls.ja4,
        cipher_suite: d.tls && d.tls.cipher_suite,
        alpn: d.tls && d.tls.alpn_protocol,
        extensions: d.tls && d.tls.extensions,
      },
      http2: d.http2 ? { akamai_fingerprint: d.http2.akamai_fingerprint } : null,
      note:
        'Node, TLS uzanti sirasini ve GREASE degerlerini kontrol edemez; ' +
        'bu yuzden chrome-like profil JA3 hashini Chrome ile birebir esitlemez.',
    });
  } catch (err) {
    return sendError(res, 502, 'TLS_PROBE_FAILED', 'TLS olcumu basarisiz.', err.message);
  }
});


// ---------------------------------------------------------------------------
// API ANAHTARI YONETIMI  (siteden anahtar uretimi)
// ---------------------------------------------------------------------------
//  GET    /keys          -> anahtar listesi (maskeli; tam anahtar ASLA donmez)
//  POST   /keys          -> yeni anahtar uretir  { "name": "telefon" }
//                           Yanitta anahtar YALNIZCA BIR KEZ doner.
//  DELETE /keys/:id      -> anahtari iptal eder
//  POST   /keys/:id/revoke
//
//  YETKI
//  -----
//    - .env anahtarlari (ALLOWED_API_KEYS) ve ADMIN_KEY  -> yonetici
//    - siteden uretilen "admin" anahtarlar               -> yonetici
//    - siteden uretilen "client" anahtarlar              -> uretemez (403)
//    - hic anahtar yoksa ilk uretim serbesttir (bootstrap)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// /keys — API Anahtari Yonetimi (Herkese Acik & Serbest Uretim)
// ---------------------------------------------------------------------------
app.get('/keys', (_req, res) => {
  return res.json({
    ok: true,
    keys: keyStore.list(),
    store: keyStore.stats_(),
  });
});

app.post('/keys', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();

  try {
    const { record, key } = keyStore.create(name, 'client');
    log('info', 'Yeni API anahtari uretildi.', { id: record.id, name: record.name, role: record.role });
    return res.status(201).json({
      ok: true,
      key,
      warning: 'Bu anahtar yalnizca BIR KEZ gosterilir. Simdi kopyalayin.',
      record,
      store: keyStore.stats_(),
    });
  } catch (err) {
    const status = err.code === 'KEY_LIMIT_REACHED' ? 409 : err.code === 'KEY_STORE_DISABLED' ? 503 : 500;
    return sendError(res, status, err.code || 'KEY_CREATE_FAILED', 'Anahtar uretilemedi.', err.message);
  }
});

app.delete('/keys/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  const removed = keyStore.remove(id);
  if (!removed) return sendError(res, 404, 'KEY_NOT_FOUND', `Anahtar bulunamadi: ${id}`);
  log('info', 'API anahtari iptal edildi.', { id });
  return res.json({ ok: true, revoked: true, id, store: keyStore.stats_() });
});

app.post('/keys/:id/revoke', (req, res) => {
  const id = String(req.params.id || '').trim();
  const ok = keyStore.revoke(id);
  if (!ok) return sendError(res, 404, 'KEY_NOT_FOUND', `Anahtar bulunamadi: ${id}`);
  return res.json({ ok: true, revoked: true, id, store: keyStore.stats_() });
});

// ---------------------------------------------------------------------------
// GET /download/info  ->  URL on izlemesi (boyut, tip, Range destegi, dosya adi)
// ---------------------------------------------------------------------------
//  Kendi indirme servisimizin "once bak sonra indir" adimi. Govdeyi INDIRMEZ;
//  yalnizca HEAD (olmazsa Range: bytes=0-0) atar.
//
//    ?url=https://...     allowlist gecerli
//
//  Yanit: { ok, status, content_type, content_length, accept_ranges, filename,
//           final_url, elapsed_ms }
// ---------------------------------------------------------------------------
app.get('/download/info', apiKeyGuard, async (req, res) => {
  const raw = typeof req.query.url === 'string' ? req.query.url.trim() : '';
  if (!raw) return sendError(res, 400, 'MISSING_TARGET', '?url=<https://...> gerekli.');

  const check = isAllowedDownloadUrl(raw);
  if (!check.ok) return sendError(res, 403, 'URL_NOT_ALLOWED', `Adres reddedildi: ${check.reason}`);

  const startedAt = Date.now();
  const headers = buildStreamUpstreamHeaders(req, null);
  delete headers.Range;

  let r;
  try {
    r = await axios({
      method: 'head',
      url: check.url,
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers,
      httpsAgent: getUpstreamAgent(),
      proxy: false,
    });
    // Bazi sunucular HEAD'i desteklemez -> 0-0 araligi ile dene
    if (r.status === 405 || r.status === 501 || !r.headers['content-length']) {
      r = await axios({
        method: 'get',
        url: check.url,
        timeout: 20000,
        maxRedirects: 5,
        responseType: 'stream',
        validateStatus: () => true,
        headers: { ...headers, Range: 'bytes=0-0' },
        httpsAgent: getUpstreamAgent(),
        proxy: false,
      });
      if (r.data && typeof r.data.destroy === 'function') r.data.destroy();
    }
  } catch (err) {
    return sendError(res, 502, 'HEAD_FAILED', 'Adres on izlemesi basarisiz.', err.message);
  }

  const ct = r.headers['content-type'] || null;
  const extGuess = ct && ct.includes('mpeg') ? 'mp3' : ct && ct.includes('mp4') ? 'm4a' : ct && ct.includes('wav') ? 'wav' : 'bin';
  const cr = r.headers['content-range'];

  return res.json({
    ok: true,
    status: r.status,
    content_type: ct,
    // Range fallback'te Content-Length "1" olur; toplam boyut Content-Range'den gelir.
    content_length: cr && cr.includes('/') ? cr.split('/')[1] : r.headers['content-length'] || null,
    accept_ranges: r.headers['accept-ranges'] || (r.status === 206 ? 'bytes' : null),
    last_modified: r.headers['last-modified'] || null,
    filename: deriveFilenameFromUrl(check.url, extGuess),
    final_url: String(r.request && r.request.res && r.request.res.responseUrl ? r.request.res.responseUrl : check.url).slice(0, 300),
    elapsed_ms: Date.now() - startedAt,
  });
});

// ---------------------------------------------------------------------------
// WEB DASHBOARD  (public/ -> http://host/)
// ---------------------------------------------------------------------------
//  Statik dosyalar API rotalarindan SONRA mount edilir; boylece /stream gibi
//  yollar golgelenmez. Onbellek: 1 saat (kucuk tek sayfa).
// ---------------------------------------------------------------------------
app.use(
  express.static(CONFIG.publicDir, {
    index: 'index.html',
    maxAge: '1h',
    etag: true,
    fallthrough: true,
  }),
);

// ---------------------------------------------------------------------------
// 404 + global hata yakalayici
// ---------------------------------------------------------------------------
app.use((req, res) => sendError(res, 404, 'NOT_FOUND', `${req.method} ${req.path} bulunamadi.`));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log('error', 'Express hata yakalayici.', err && err.message);
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Gecersiz JSON govdesi.');
  }
  return sendError(res, 500, 'INTERNAL_ERROR', 'Sunucu hatasi.');
});

// ============================================================================
// 6. ARKA PLAN GOREVI (KEEP-ALIVE) + BASLATMA
// ============================================================================

let keepAliveTimer = null;

/**
 * Oturumu sicak tutan dongu:
 *   1) Clerk oturumuna "touch" at,
 *   2) access token'i zorla yenile.
 * Hata olsa bile dongu devam eder (Render uykuya dalsa da servis ayaga kalkar).
 */
async function keepAliveTick() {
  if (accountPool && accountPool.size() > 0) {
    try {
      await accountPool.keepAliveAll({
        clerkBaseUrl: CONFIG.clerkBaseUrl,
        clerkJsVersion: CONFIG.clerkJsVersion,
        requestTimeoutMs: CONFIG.requestTimeoutMs,
        refreshBeforeExpiryMs: CONFIG.refreshBeforeExpiryMs,
        userAgent: BROWSER_UA,
        log,
      });
    } catch (err) {
      log('error', 'Havuz keep-alive turu basarisiz.', sanitizeMessage(err.message));
    }
    return;
  }

  if (!CONFIG.refreshToken) {
    log('warn', 'Keep-alive atlandi: SUNO_REFRESH_TOKEN yok.');
    return;
  }
  try {
    if (authState.sessionId) await touchSession(authState.sessionId);
    await refreshAccessToken(true);
  } catch (err) {
    log('error', 'Keep-alive turu basarisiz.', sanitizeMessage(err.message));
  }
}

function startKeepAlive() {
  if (keepAliveTimer) return;

  // Acilista bir kez calistir (ilk token'i hemen al), ardindan periyodik devam et.
  keepAliveTick();

  keepAliveTimer = setInterval(keepAliveTick, CONFIG.keepAliveIntervalMs);
  // Node'un bu timer yuzunden kapanmasini engelleme: unref() ile event loop'u serbest birak.
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();

  log('info', `Keep-alive baslatildi: her ${Math.round(CONFIG.keepAliveIntervalMs / 60000)} dakikada bir.`);
}

// Render "PORT" env'ini zorunlu tutar -> 0.0.0.0 dinlenmeli.
const server = app.listen(CONFIG.port, '0.0.0.0', () => {
  log('info', `Suno Beat Proxy dinleniyor: http://0.0.0.0:${CONFIG.port}`);
  log('info', `Suno API: ${CONFIG.sunoApiBase}${CONFIG.generatePath}`);
  log('info', `Clerk: ${CONFIG.clerkBaseUrl} (js v${CONFIG.clerkJsVersion})`);
  if (!CONFIG.allowedApiKeys.length && !CONFIG.adminKey && keyStore.activeCount() === 0) {
    log('warn', 'Hic API anahtari yok -> koruma KAPALI. Panelden anahtar uretin (POST /keys).');
  } else {
    log('info', 'API anahtari korumasi aktif.', {
      envKeys: CONFIG.allowedApiKeys.length,
      adminKey: Boolean(CONFIG.adminKey),
      storeKeys: keyStore.activeCount(),
    });
  }
  startKeepAlive();
});

// ---- Graceful shutdown (Render deploy/restart) ----
function shutdown(signal) {
  log('info', `${signal} alindi, kapatiliyor...`);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  server.close(() => process.exit(0));
  // 8 sn icinde kapanmazsa zorla cik.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Beklenmeyen hatalarda process'in sessizce olmesini engelle.
process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', sanitizeMessage(reason && reason.message ? reason.message : reason));
});
process.on('uncaughtException', (err) => {
  log('error', 'uncaughtException', sanitizeMessage(err && err.message));
});

module.exports = { app, server };
