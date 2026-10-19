'use strict';

/**
 * GEMINI WEB SAGLAYICISI (deneysel)
 * =================================
 * gemini.google.com'un **ic (resmi olmayan) RPC ucunu** kullanarak muzik uretir.
 * Mantik Suno saglayicisiyla ayni: kullanicinin kendi oturum cerezleri + ic uc.
 *
 * NEDEN BOYLE
 * -----------
 * Lyria'nin resmi API'si ucretli ($0.04 / 30 sn, $0.08 / tam sarki, free tier yok).
 * Gemini **web uygulamasinda** ise ucretsiz ve MP3 indirmeye izin veriyor.
 * Bu saglayici, web oturumunu kullanarak ayni ciktiyi programatik alir.
 *
 * RISKLER (net soyluyorum)
 * ------------------------
 *  1) Resmi olmayan uc: Google haber vermeden degistirebilir.
 *  2) `__Secure-1PSIDTS` cerezi birkac dakikada bir doner -> otomatik tazeleme
 *     olmadan oturum duser (asagida refresh akisi var).
 *  3) Google'in kullanim sartlarina aykiri olabilir; kendi hesabin, kendi riskin.
 *  4) Anti-bot: cok hizli istek 429 / captcha getirir.
 *
 * ORTAM DEGISKENLERI
 * ------------------
 *   AUDIO_PROVIDER=gemini-web
 *   GEMINI_WEB_COOKIES=__Secure-1PSID=...; __Secure-1PSIDTS=...; ...   (tam cookie)
 *   GEMINI_WEB_REQUEST_TEMPLATE=/path/req.json   (yakalanmis istek sablonu — en guvenilir)
 *   GEMINI_WEB_MODEL=gemini-music                 (varsayilan)
 *   GEMINI_WEB_PROMPT_FIELD=input                 (sablon icinde metnin bulundugu alan)
 *
 * NASIL KURTARILIR (onerilen)
 * ---------------------------
 *  1) gemini.google.com'da muzik uret
 *  2) F12 > Network > "music" veya "BardChatUi" filtrele
 *  3) Istegi sag tik > Copy as cURL  (ya da "Copy as fetch")
 *  4) Icerigini GEMINI_WEB_REQUEST_TEMPLATE olarak kaydet
 *  Boylece payload tahmin etmiyoruz; gercek istegi birebir tekrarliyoruz.
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { ProviderError, slugify } = require('./base');

const BASE = 'https://gemini.google.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const TTL_MS = Math.max(5, Number(process.env.GOOGLE_AUDIO_TTL_MINUTES || 60)) * 60 * 1000;
const MAX_CLIPS = Math.max(1, Number(process.env.GOOGLE_AUDIO_MAX_CLIPS || 6));

/** Bellek deposu (Suno/Google saglayicilarindaki ile ayni mantik). */
const store = new Map();

function cookies() {
  const raw = String(process.env.GEMINI_WEB_COOKIES || '').trim();
  if (raw) return raw;
  const psid = String(process.env.GEMINI_WEB_1PSID || '').trim();
  const psidts = String(process.env.GEMINI_WEB_1PSIDTS || '').trim();
  if (!psid) return '';
  return `__Secure-1PSID=${psid}${psidts ? `; __Secure-1PSIDTS=${psidts}` : ''}`;
}

function evict() {
  const now = Date.now();
  for (const [id, rec] of store) if (now - rec.createdAt > TTL_MS) store.delete(id);
  while (store.size > MAX_CLIPS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/**
 * XSRF / SNlM0e ("at") tokenini al.
 * gemini.google.com/app HTML'i icinde "SNlM0e":"..." ve "cfb2h":"..." olarak gecer.
 */
async function bootstrap() {
  const ck = cookies();
  if (!ck) {
    throw new ProviderError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'GEMINI_WEB_COOKIES tanimli degil.',
      'gemini.google.com > F12 > Application > Cookies > __Secure-1PSID / __Secure-1PSIDTS degerlerini ekle.',
    );
  }

  const { data, status } = await axios.get(`${BASE}/app`, {
    headers: { Cookie: ck, 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    timeout: 30000,
    validateStatus: () => true,
    maxRedirects: 0,
  });

  if (status >= 300 && status < 400) {
    throw new ProviderError(401, 'GEMINI_WEB_SESSION_EXPIRED', 'Gemini oturumu gecersiz (redirect).',
      'Cerezleri tazele: gemini.google.com > Application > Cookies.');
  }
  if (status !== 200) {
    throw new ProviderError(502, 'GEMINI_WEB_BOOTSTRAP_FAILED', `Gemini /app ${status} dondurdu.`);
  }

  const html = String(data || '');
  const at = (html.match(/"SNlM0e":"([^"]+)"/) || [])[1];
  const bl = (html.match(/"cfb2h":"([^"]+)"/) || [])[1];
  const fsid = (html.match(/"FdrFJe":"([^"]+)"/) || [])[1];

  if (!at) {
    throw new ProviderError(401, 'GEMINI_WEB_NO_XSRF',
      'XSRF tokeni bulunamadi (oturum dusmus olabilir).', 'Cerezleri tazeleyip tekrar dene.');
  }
  return { at, bl, fsid };
}

/**
 * Yakalanmis bir "Copy as cURL (bash)" metnini ayristir.
 * Desteklenen: curl 'URL' -H 'k: v' --data-raw '...'  |  -X POST
 * Donen: { method, url, headers, body }
 */
function parseCurl(text) {
  const src = String(text || '');
  const joinContinuations = src.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const urlMatch = joinContinuations.match(/curl\s+(?:-X\s+\w+\s+)?['"]?(https?:\/\/[^'"\s]+)['"]?/);
  if (!urlMatch) return null;
  const url = urlMatch[1];

  const methodMatch = joinContinuations.match(/-X\s+(\w+)/);
  const method = (methodMatch ? methodMatch[1] : 'POST').toUpperCase();

  const headers = {};
  const headerRe = /-H\s+(['"])([^'"]*?)\1/g;
  let m;
  while ((m = headerRe.exec(joinContinuations))) {
    const raw = m[2];
    const idx = raw.indexOf(':');
    if (idx > 0) headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }

  let body = null;
  const bodyMatch =
    joinContinuations.match(/--data-raw\s+(['"])([\s\S]*?)\1/) ||
    joinContinuations.match(/--data(?:-binary)?\s+(['"])([\s\S]*?)\1/);
  if (bodyMatch) body = bodyMatch[2];

  return { method, url, headers, body };
}

/**
 * CALISMA ANINDA GELEN SABLON
 * ---------------------------
 * Konsol snippet'i yakaladigi istegi POST /auth/gemini-template ile gonderir;
 * burada bellege alinir (dosya/redeploy gerekmez).
 */
let runtimeTemplate = null;

function setTemplate(tpl) {
  if (!tpl || typeof tpl !== 'object' || !tpl.url) return null;
  runtimeTemplate = {
    url: String(tpl.url),
    method: String(tpl.method || 'POST').toUpperCase(),
    headers: tpl.headers && typeof tpl.headers === 'object' ? tpl.headers : {},
    body: typeof tpl.body === 'string' ? tpl.body : '',
    capturedPrompt: typeof tpl.capturedPrompt === 'string' ? tpl.capturedPrompt : '',
    responseSample: typeof tpl.responseSample === 'string' ? tpl.responseSample.slice(0, 5000) : '',
    capturedAt: Date.now(),
  };
  return runtimeTemplate;
}

function getTemplateInfo() {
  if (!runtimeTemplate) return null;
  return {
    url: runtimeTemplate.url.slice(0, 160),
    method: runtimeTemplate.method,
    headerCount: Object.keys(runtimeTemplate.headers).length,
    bodyLength: runtimeTemplate.body.length,
    capturedPrompt: runtimeTemplate.capturedPrompt,
    capturedAt: new Date(runtimeTemplate.capturedAt).toISOString(),
    responseSampleLength: runtimeTemplate.responseSample.length,
  };
}

/** Sablonu bellekteki kayittan, dosyadan (JSON veya ham cURL) yukle. */
function loadTemplate() {
  if (runtimeTemplate) return runtimeTemplate;
  const p = String(process.env.GEMINI_WEB_REQUEST_TEMPLATE || process.env.GEMINI_WEB_CURL_FILE || '').trim();
  if (!p || !fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (_e) {
      return null;
    }
  }
  return parseCurl(raw);
}

/**
 * Yakalanmis istek sablonunu (Copy as cURL / fetch) tekrar oynat.
 * Sablon icindeki prompt metni GEMINI_WEB_PROMPT_PLACEHOLDER ile degistirilir.
 */
async function replayTemplate(prompt) {
  let tpl;
  try {
    tpl = loadTemplate();
  } catch (err) {
    throw new ProviderError(500, 'GEMINI_WEB_TEMPLATE_INVALID', 'Istek sablonu okunamadi.', err.message);
  }
  if (!tpl || !tpl.url) return null;

  // Prompt degistirme: once __PROMPT__ yer tutucusu, yoksa yakalanan prompt metni.
  let body = String(tpl.body || '');
  const placeholder = String(process.env.GEMINI_WEB_PROMPT_PLACEHOLDER || '__PROMPT__');
  const captured = String(process.env.GEMINI_WEB_CAPTURED_PROMPT || '').trim();

  if (body.includes(placeholder)) {
    body = body.split(placeholder).join(encodeURIComponent(prompt));
  } else if (captured) {
    const enc = encodeURIComponent(captured);
    body = body.split(enc).join(encodeURIComponent(prompt));
    body = body.split(captured).join(prompt);
    body = body.split(encodeURIComponent(JSON.stringify(captured)).replace(/%22/gi, '%22'))
               .join(encodeURIComponent(JSON.stringify(prompt)));
  }

  // Sablonun kendi Cookie basligi varsa onu kullan, yoksa env cerezleri.
  const headers = { ...(tpl.headers || {}) };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'cookie')) headers.Cookie = cookies();

  const { data } = await axios.request({
    method: tpl.method || 'POST',
    url: tpl.url,
    headers,
    data: body,
    timeout: Math.max(60000, Number(process.env.GOOGLE_TIMEOUT_MS || 240000)),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: (x) => x,
  });

  return { raw: typeof data === 'string' ? data : JSON.stringify(data) };
}

/** Ham cevaptan base64 ses cikar (ID3/RIFF imzasi arayarak). */
function extractAudio(raw) {
  const text = String(raw || '');

  // 1) Dogrudan base64 bloklar (uzun: >20 KB)
  const b64s = text.match(/[A-Za-z0-9+/]{20000,}={0,2}/g) || [];
  for (const b of b64s) {
    try {
      const buf = Buffer.from(b, 'base64');
      if (buf.length < 8000) continue;
      const magic = buf.subarray(0, 4).toString('latin1');
      if (magic.startsWith('ID3') || magic.startsWith('RIFF') || magic === 'OggS' || buf[0] === 0xff) {
        return { buffer: buf, mime: magic.startsWith('RIFF') ? 'audio/wav' : 'audio/mpeg' };
      }
    } catch (_e) { /* devam */ }
  }

  // 2) JSON icinde "data":"<base64>" alanlari
  const m = text.match(/"data"\s*:\s*"([A-Za-z0-9+/=]{8000,})"/);
  if (m) {
    try {
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 8000) return { buffer: buf, mime: 'audio/mpeg' };
    } catch (_e) { /* devam */ }
  }

  // 3) googleusercontent ses URL'si (indirilebilir)
  const url = text.match(/https:\/\/[a-z0-9.-]*googleusercontent\.com\/[^"\\ ]+\.(?:mp3|wav|m4a)/i);
  if (url) return { url: url[0] };

  return null;
}

/**
 * Genel StreamGenerate denemesi (sablon yoksa).
 * Not: Gemini'nin ic payload yapisi zamanla degisiyor; sablon modu daha guvenilir.
 */
async function streamGenerate(prompt, { at, bl, fsid }) {
  const model = String(process.env.GEMINI_WEB_MODEL || 'gemini-music').trim();
  const inner = JSON.stringify([prompt, 0, null, null, null, null, 0]);
  const fReq = JSON.stringify([[null, inner]]);

  const params = new URLSearchParams({
    rpcids: 'assistant.lamda.BardFrontendService/StreamGenerate',
    'source-path': '/app',
    bl: bl || '',
    'f.sid': fsid || '',
    hl: 'en',
    _reqid: String(Math.floor(Math.random() * 900000) + 100000),
    rt: 'c',
  });

  const body = new URLSearchParams({ 'f.req': fReq, at }).toString();

  const { data } = await axios.post(`${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`, body, {
    headers: {
      Cookie: cookies(),
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'X-Same-Domain': '1',
      Origin: BASE,
      Referer: `${BASE}/app`,
      'X-Gemini-Model': model,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: Math.max(60000, Number(process.env.GOOGLE_TIMEOUT_MS || 240000)),
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: (x) => x,
  });

  return { raw: typeof data === 'string' ? data : JSON.stringify(data) };
}

async function produce(prompt) {
  // 1) Sablon modu (onerilen)
  const replayed = await replayTemplate(prompt);
  const raw = replayed ? replayed.raw : (await (async () => {
    const boot = await bootstrap();
    return (await streamGenerate(prompt, boot)).raw;
  })());

  const audio = extractAudio(raw);
  if (!audio) {
    throw new ProviderError(
      502,
      'GEMINI_WEB_NO_AUDIO',
      'Cevapta ses bulunamadi.',
      'Sablon modunu kullan (GEMINI_WEB_REQUEST_TEMPLATE) veya cikti yapisini guncelle. Ham cevap: ' +
        String(raw || '').slice(0, 300),
    );
  }
  return audio;
}

function toClip(rec) {
  if (!rec) return null;
  return {
    id: rec.id,
    status: 'complete',
    is_complete: true,
    is_error: false,
    title: rec.title,
    tags: rec.tags || null,
    prompt: rec.prompt,
    duration_seconds: rec.durationSeconds,
    model: process.env.GEMINI_WEB_MODEL || 'gemini-music',
    created_at: new Date(rec.createdAt).toISOString(),
    image_url: null,
    audio_url: `/download?id=${rec.id}`,
    download_url: `/download?id=${rec.id}`,
    stream_url: `/stream/${rec.id}`,
    is_download_unlocked: true,
    download_blocked_reason: null,
  };
}

module.exports = {
  name: 'gemini-web',

  async isConfigured() {
    return Boolean(cookies());
  },

  async generate({ prompt, tags, title, instrumental }) {
    const fullPrompt = [String(prompt || '').trim(), tags ? String(tags).trim() : '', instrumental ? 'Instrumental only.' : '']
      .filter(Boolean)
      .join('. ');
    if (!fullPrompt) throw new ProviderError(400, 'MISSING_PROMPT', 'prompt zorunlu.');

    const audio = await produce(fullPrompt);
    evict();

    let rec;
    if (audio.buffer) {
      // Sure tahmini ~128 kbps
      const durationSeconds = Math.max(1, Math.round(audio.buffer.length / 16000));
      rec = {
        id: crypto.randomUUID(),
        buffer: audio.buffer,
        mime: audio.mime || 'audio/mpeg',
        prompt: fullPrompt,
        title: title || slugify(String(prompt || 'beat').split(',')[0], 'beat'),
        tags: tags || null,
        durationSeconds,
        createdAt: Date.now(),
      };
    } else {
      // Uzak URL: baytlari hemen cek (disariya URL sizdirmamak icin)
      const { data } = await axios.get(audio.url, {
        headers: { Cookie: cookies(), 'User-Agent': UA },
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: 40 * 1024 * 1024,
      });
      const buf = Buffer.from(data);
      rec = {
        id: crypto.randomUUID(),
        buffer: buf,
        mime: 'audio/mpeg',
        prompt: fullPrompt,
        title: title || slugify(String(prompt || 'beat').split(',')[0], 'beat'),
        tags: tags || null,
        durationSeconds: Math.max(1, Math.round(buf.length / 16000)),
        createdAt: Date.now(),
      };
    }

    store.set(rec.id, rec);
    evict();
    return { clip_ids: [rec.id], clips: [toClip(rec)] };
  },

  async getTrack(clipId) {
    return toClip(store.get(clipId));
  },

  async getAudioBuffer(clipId) {
    const rec = store.get(clipId);
    if (!rec) return null;
    return { buffer: rec.buffer, mime: rec.mime, filename: `${slugify(rec.title, 'beat')}.mp3` };
  },

  async getAudioSource() {
    return null;
  },

  setTemplate,
  getTemplateInfo,

  storeStats() {
    let bytes = 0;
    for (const rec of store.values()) bytes += rec.buffer.length;
    return { clips: store.size, bytes, maxClips: MAX_CLIPS, ttlMinutes: TTL_MS / 60000 };
  },
};
