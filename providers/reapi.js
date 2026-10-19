'use strict';

/**
 * REAPI (Suno V6) SAGLAYICISI
 * ===========================
 * reapi.ai, Suno V6/V6-Mini/V6-Wild modellerini **kendi altyapisiyla** sunan
 * bir gateway. Biten sesi kendi deposunda barindiriyor, yani kalici ve
 * indirilebilir bir URL veriyor. Suno'nun free planindaki "indirme kilidi"
 * sorunu burada yok: dosya gercekten var.
 *
 * NEDEN BU SAGLAYICI
 * ------------------
 *  - Suno oturumu/cerezi/token'i ile ugrasmaya gerek yok (kalici Bearer key).
 *  - Cikti: 2 tam track, her biri ses URL'si + sure + style ile.
 *  - Odeme istek basina (~$0.066 / 2 track). Aylik abonelik yok.
 *
 * AKIS
 * ----
 *   POST {BASE}/api/v1/audio/generations      -> { id: taskId }
 *   GET  {BASE}/api/v1/tasks/{taskId}         -> { status, output.tracks:[{...}] }
 *   track.audio_url  -> baytlar cekilir, bellekte tutulur
 *   /download?id=... -> kendi indirme sistemimizden servis (Range destekli)
 *
 * ORTAM DEGISKENLERI
 * ------------------
 *   AUDIO_PROVIDER=reapi
 *   REAPI_API_KEY=...                 (https://reapi.ai/settings/apikeys)
 *   REAPI_BASE_URL=https://reapi.ai   (varsayilan)
 *   REAPI_MODEL=suno-music
 *   REAPI_VERSION=V6                  (V6 | V6_MINI | V6_WILD)
 *   REAPI_CUSTOM_MODE=false
 *   REAPI_INSTRUMENTAL=true           (vokal istemiyorsan)
 *   REAPI_MAX_CLIPS=3                 RAM'de tutulacak parca
 *   REAPI_TTL_MINUTES=45
 */

const axios = require('axios');
const { ProviderError, sleep, slugify } = require('./base');

function apiKey() {
  return String(process.env.REAPI_API_KEY || '').trim();
}
function base() {
  return String(process.env.REAPI_BASE_URL || 'https://reapi.ai').replace(/\/+$/, '');
}
function version() {
  return String(process.env.REAPI_VERSION || 'V6').trim().toUpperCase();
}

const TTL_MS = Math.max(5, Number(process.env.REAPI_TTL_MINUTES || 45)) * 60 * 1000;
const MAX_CLIPS = Math.max(1, Number(process.env.REAPI_MAX_CLIPS || 3));

/** id bicimi: <taskId>__<index>  (tek istekten 2 track donebiliyor) */
function makeId(taskId, index) {
  return `${taskId}__${index}`;
}
function parseId(clipId) {
  const m = String(clipId || '').match(/^([A-Za-z0-9_-]+)__(\d+)$/);
  if (m) return { taskId: m[1], index: Number(m[2]) };
  return { taskId: String(clipId || ''), index: 0 };
}

/** Bellek deposu: indirilen ses baytlari (URL'ler kalici olsa da tek noktadan servis). */
const store = new Map();

function evict() {
  const now = Date.now();
  for (const [id, rec] of store) if (now - rec.createdAt > TTL_MS) store.delete(id);
  while (store.size > MAX_CLIPS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

function headers() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function requireKey() {
  if (!apiKey()) {
    throw new ProviderError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'REAPI_API_KEY tanimli degil.',
      'https://reapi.ai/settings/apikeys adresinden anahtar alip .env dosyasina ekleyin.',
    );
  }
}

/** Durum eslemesi. */
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(v)) return 'complete';
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected'].includes(v)) return 'error';
  if (['processing', 'running', 'generating', 'in_progress'].includes(v)) return 'generating';
  return 'queued';
}

/** Task cevabindan track listesini cikar (farkli alan adlarina toleransli). */
function tracksOf(task) {
  const out = task && task.output;
  if (!out) return [];
  if (Array.isArray(out.tracks)) return out.tracks;
  if (Array.isArray(out)) return out;
  if (out.audio_url || out.audioUrl) return [out];
  return [];
}

function trackAudioUrl(t) {
  return (
    t.audio_url ||
    t.audioUrl ||
    t.url ||
    t.mp3_url ||
    t.file_url ||
    (t.audio && (t.audio.url || t.audio_url)) ||
    null
  );
}

async function fetchTask(taskId) {
  requireKey();
  const { data } = await axios.get(`${base()}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: headers(),
    timeout: 30000,
    validateStatus: () => true,
  });
  if (data && data.error) {
    throw new ProviderError(502, 'REAPI_ERROR', 'reapi hata dondurdu.', JSON.stringify(data.error).slice(0, 300));
  }
  return data;
}

module.exports = {
  name: 'reapi',

  async isConfigured() {
    return Boolean(apiKey());
  },

  /**
   * Uretim baslat. Donen clip_ids: <taskId>__0, <taskId>__1
   */
  async generate({ prompt, tags, title, instrumental, model, extra }) {
    requireKey();

    const body = {
      model: String(process.env.REAPI_MODEL || 'suno-music'),
      version: version(),
      custom_mode: String(process.env.REAPI_CUSTOM_MODE || 'false') === 'true',
      instrumental:
        typeof instrumental === 'boolean'
          ? instrumental
          : String(process.env.REAPI_INSTRUMENTAL || 'true') === 'true',
      prompt: tags ? `${prompt}, ${tags}` : String(prompt || ''),
    };
    if (title && body.custom_mode) body.title = title;
    if (extra && typeof extra === 'object') Object.assign(body, extra);

    const { data } = await axios.post(`${base()}/api/v1/audio/generations`, body, {
      headers: headers(),
      timeout: 60000,
      validateStatus: () => true,
    });

    if (data && data.error) {
      const code = Number(data.error.code || data.status) || 502;
      const msg = data.error.message || JSON.stringify(data.error).slice(0, 300);
      const looksAuth = /invalid api key|unauthorized|invalid token|missing.*key/i.test(msg);
      if (code === 401 || looksAuth) {
        throw new ProviderError(502, 'PROVIDER_AUTH_FAILED', 'reapi anahtari gecersiz (401).', msg);
      }
      if (code === 402) {
        throw new ProviderError(402, 'PROVIDER_INSUFFICIENT_CREDIT', 'reapi bakiyesi yetersiz (402).', {
          billing_url: `${base()}/settings/credits`,
          upstream: msg,
        });
      }
      throw new ProviderError(502, 'REAPI_ERROR', 'reapi istegi reddetti.', msg);
    }

    const taskId = (data && (data.id || data.task_id || data.taskId)) || null;
    if (!taskId) {
      throw new ProviderError(502, 'REAPI_NO_TASK_ID', 'Task id donmedi.', JSON.stringify(data || {}).slice(0, 300));
    }

    // Iki track beklenir; ilk yanitta tracks varsa sayisini kullan.
    const tracks = tracksOf(data);
    const count = tracks.length > 0 ? tracks.length : 2;
    const ids = Array.from({ length: count }, (_, i) => makeId(taskId, i));

    return {
      clip_ids: ids,
      clips: ids.map((id, i) => ({
        id,
        status: 'queued',
        is_complete: false,
        is_error: false,
        title: title || slugify(String(prompt || 'beat').split(',')[0], 'beat'),
        tags: tags || null,
        prompt: String(prompt || ''),
        duration_seconds: null,
        model: `${body.model}:${body.version}`,
        created_at: new Date().toISOString(),
        image_url: (tracks[i] && (tracks[i].image_url || tracks[i].imageUrl)) || null,
        audio_url: null,
        download_url: `/download?id=${encodeURIComponent(id)}`,
        stream_url: `/stream/${encodeURIComponent(id)}`,
      })),
      raw: data,
    };
  },

  async getTrack(clipId) {
    requireKey();
    const { taskId, index } = parseId(clipId);

    let task;
    try {
      task = await fetchTask(taskId);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    if (!task) return null;

    const status = mapStatus(task.status || (task.output && task.output.status));
    const tracks = tracksOf(task);
    const t = tracks[index] || null;
    const audioUrl = t ? trackAudioUrl(t) : null;

    return {
      id: clipId,
      status,
      is_complete: status === 'complete',
      is_error: status === 'error',
      title: (t && (t.title || t.name)) || task.title || slugify(taskId, 'beat'),
      tags: (t && (t.style || t.tags)) || task.style || null,
      prompt: (t && (t.lyrics || t.prompt)) || null,
      duration_seconds: (t && (t.duration || t.duration_seconds)) || null,
      model: `${task.model || 'suno-music'}:${version()}`,
      created_at: task.created_at || new Date().toISOString(),
      image_url: (t && (t.image_url || t.imageUrl)) || null,
      audio_url: audioUrl,
      download_url: audioUrl ? `/download?id=${encodeURIComponent(clipId)}` : null,
      stream_url: `/stream/${encodeURIComponent(clipId)}`,
      // reapi dosyayi kendi deposunda barindiriyor: indirme kilidi yok.
      is_download_unlocked: status === 'complete',
      download_blocked_reason: status === 'error' ? (task.error || 'task failed') : null,
      task_error: task.error || null,
      tracks_total: tracks.length,
    };
  },

  /**
   * Kendi indirme sistemimiz: sesi bayt olarak cek ve bellekte tut.
   * (Kalici URL'yi disariya vermiyoruz; her sey tek noktadan geciyor.)
   */
  async getAudioBuffer(clipId) {
    const cached = store.get(clipId);
    if (cached) return { buffer: cached.buffer, mime: cached.mime, filename: cached.filename };

    const clip = await this.getTrack(clipId);
    if (!clip || !clip.audio_url) return null;

    const { data, headers: resHeaders } = await axios.get(clip.audio_url, {
      responseType: 'arraybuffer',
      timeout: 180000,
      maxContentLength: 60 * 1024 * 1024,
    });

    const buffer = Buffer.from(data);
    if (!buffer.length) return null;

    const mime = (resHeaders && resHeaders['content-type']) || 'audio/mpeg';
    const rec = {
      buffer,
      mime,
      filename: `${slugify(clip.title, 'beat')}.mp3`,
      createdAt: Date.now(),
    };
    store.set(clipId, rec);
    evict();
    return { buffer: rec.buffer, mime: rec.mime, filename: rec.filename };
  },

  /** URL tabanli kaynak (dogrudan proxy) — allowlist'e takilmamasi icin kullanmiyoruz. */
  async getAudioSource() {
    return null;
  },

  async waitForCompletion(clipId, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    let clip = await this.getTrack(clipId);
    while (clip && !clip.is_complete && !clip.is_error && Date.now() < deadline) {
      await sleep(4000);
      clip = await this.getTrack(clipId);
    }
    return clip;
  },

  storeStats() {
    let bytes = 0;
    for (const rec of store.values()) bytes += rec.buffer.length;
    return { clips: store.size, bytes, maxClips: MAX_CLIPS, ttlMinutes: TTL_MS / 60000 };
  },
};
