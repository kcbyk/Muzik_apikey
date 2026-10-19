'use strict';

/**
 * GOOGLE LYRIA SAGLAYICISI
 * ========================
 * Google'in resmi Gemini API'si uzerinden muzik uretir.
 *
 *   Model      : lyria-3.5             (tam sarki, ~2-3 dk)
 *                lyria-3-clip-preview  (sabit 30 sn klip)
 *   Uc nokta   : POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   Kimlik     : x-goog-api-key: $GEMINI_API_KEY
 *   Cikti      : interaction.output_audio.data  ->  base64 MP3
 *
 * NEDEN BU SAGLAYICI
 * ------------------
 * Suno'nun aksine Lyria, sesi **dogrudan base64 MP3 olarak** verir. DRM yok,
 * presigned URL yok, indirme kilidi yok. Cikan baytlari bellekte tutup
 * /download ve /stream uclarindan kendi indirme sistemimizden servis ediyoruz.
 *
 * ORTAM DEGISKENLERI
 * ------------------
 *   AUDIO_PROVIDER=google
 *   GEMINI_API_KEY=...                 (AI Studio'dan ucretsiz olusturulur)
 *   GEMINI_MUSIC_MODEL=lyria-3-clip-preview   (varsayilan; 30 sn, hizli)
 *   GEMINI_MUSIC_MODEL=lyria-3.5              (tam sarki)
 *   GOOGLE_AUDIO_TTL_MINUTES=60         bellekte tutma suresi
 *   GOOGLE_AUDIO_MAX_CLIPS=6            ayni anda tutulacak klip (RAM siniri)
 */

const axios = require('axios');
const crypto = require('crypto');
const { ProviderError, sleep, slugify } = require('./base');

const API = 'https://generativelanguage.googleapis.com/v1beta';

/** API anahtari. */
function apiKey() {
  return String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

/** Kullanilacak muzik modeli. */
function musicModel() {
  return String(process.env.GEMINI_MUSIC_MODEL || 'lyria-3-clip-preview').trim();
}

const TTL_MS = Math.max(5, Number(process.env.GOOGLE_AUDIO_TTL_MINUTES || 60)) * 60 * 1000;
const MAX_CLIPS = Math.max(1, Number(process.env.GOOGLE_AUDIO_MAX_CLIPS || 6));

/**
 * BELLEK DEPOSU
 * -------------
 * Lyria senkron cevap verdigi icin dosyayi diske yazmiyoruz; Render free tier
 * disk zaten gecici. Base64 -> Buffer olarak RAM'de tutup TTL + adet siniri
 * uyguluyoruz (512 MB butcesini korumak icin).
 */
const store = new Map(); // id -> { buffer, mime, prompt, title, createdAt, durationSeconds }

function evictIfNeeded() {
  const now = Date.now();
  for (const [id, rec] of store) {
    if (now - rec.createdAt > TTL_MS) store.delete(id);
  }
  // Adet siniri: en eski kayitlari at (Map insertion order).
  while (store.size > MAX_CLIPS) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}

/** Toplam bellek kullanimi (teshis icin). */
function storeStats() {
  let bytes = 0;
  for (const rec of store.values()) bytes += rec.buffer.length;
  return { clips: store.size, bytes, maxClips: MAX_CLIPS, ttlMinutes: TTL_MS / 60000 };
}

/**
 * Tek bir uretim istegi.
 * Donen: { id, buffer, mime, lyrics, text }
 */
async function requestMusic(prompt) {
  if (!apiKey()) {
    throw new ProviderError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'GEMINI_API_KEY tanimli degil.',
      'https://aistudio.google.com/apikey adresinden ucretsiz anahtar alip .env dosyasina ekleyin.',
    );
  }

  let data;
  try {
    ({ data } = await axios.post(
      `${API}/interactions`,
      { model: musicModel(), input: prompt },
      {
        headers: {
          'x-goog-api-key': apiKey(),
          'Content-Type': 'application/json',
        },
        // Lyria 30 sn klip icin genelde 5-20 sn, tam sarki icin daha uzun.
        timeout: Math.max(30000, Number(process.env.GOOGLE_TIMEOUT_MS || 180000)),
        validateStatus: () => true,
      },
    ));
  } catch (err) {
    throw new ProviderError(502, 'GOOGLE_REQUEST_FAILED', 'Google istegi basarisiz.', err.message);
  }

  if (data && data.error) {
    const msg = data.error.message || JSON.stringify(data.error).slice(0, 300);
    const status = Number(data.error.code) || 502;
    throw new ProviderError(
      status === 429 ? 429 : 502,
      status === 429 ? 'PROVIDER_RATE_LIMITED' : 'GOOGLE_API_ERROR',
      'Google API hata dondurdu.',
      msg,
    );
  }

  const audio = data && data.output_audio;
  const b64 = audio && (audio.data || audio.inline_data || audio.inlineData && audio.inline_data.data);
  const raw = typeof b64 === 'string' ? b64 : (audio && audio.data);
  if (!raw) {
    throw new ProviderError(502, 'GOOGLE_NO_AUDIO', 'Yanitta ses verisi yok.', JSON.stringify(data || {}).slice(0, 300));
  }

  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) {
    throw new ProviderError(502, 'GOOGLE_EMPTY_AUDIO', 'Ses verisi bos.');
  }

  const mime = (audio && (audio.mime_type || audio.mimeType)) || 'audio/mpeg';

  // Sure tahmini: MP3 CBR ~128 kbps varsayimi (bilgi amacli).
  const durationSeconds = Math.max(1, Math.round(buffer.length / (128 * 1000 / 8)));

  return {
    id: crypto.randomUUID(),
    buffer,
    mime,
    durationSeconds,
    lyrics: data.output_text || null,
  };
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
    model: musicModel(),
    created_at: new Date(rec.createdAt).toISOString(),
    image_url: null,
    audio_url: `/download?id=${rec.id}`,
    download_url: `/download?id=${rec.id}`,
    stream_url: `/stream/${rec.id}`,
    // Lyria ciktisi dogrudan bizim depomuzda: indirme kilidi yok.
    is_download_unlocked: true,
    download_blocked_reason: null,
    lyrics: rec.lyrics || null,
  };
}

function buildPrompt({ prompt, tags, title, instrumental }) {
  const parts = [String(prompt || '').trim()];
  if (tags) parts.push(String(tags).trim());
  if (title) parts.push(`Title: ${String(title).trim()}`);
  if (instrumental) parts.push('Instrumental only, no vocals.');
  return parts.filter(Boolean).join('. ');
}

module.exports = {
  name: 'google',

  async isConfigured() {
    return Boolean(apiKey());
  },

  async generate({ prompt, tags, title, instrumental }) {
    const fullPrompt = buildPrompt({ prompt, tags, title, instrumental });
    if (!fullPrompt) {
      throw new ProviderError(400, 'MISSING_PROMPT', 'prompt zorunlu.');
    }

    const result = await requestMusic(fullPrompt);

    evictIfNeeded();

    const rec = {
      id: result.id,
      buffer: result.buffer,
      mime: result.mime,
      prompt: fullPrompt,
      title: title || slugify(String(prompt || 'beat').split(',')[0], 'beat'),
      tags: tags || null,
      lyrics: result.lyrics,
      durationSeconds: result.durationSeconds,
      createdAt: Date.now(),
    };
    store.set(rec.id, rec);
    evictIfNeeded();

    return { clip_ids: [rec.id], clips: [toClip(rec)] };
  },

  /** Klip tamamlandi (senkron uretim) — depoda varsa doner. */
  async getTrack(clipId) {
    return toClip(store.get(clipId));
  },

  /**
   * Kendi indirme sistemimiz icin: bellekten ses baytlari.
   * server.js /download ve /stream bu metodu gordugunde dogrudan servis eder.
   */
  async getAudioBuffer(clipId) {
    const rec = store.get(clipId);
    if (!rec) return null;
    return { buffer: rec.buffer, mime: rec.mime, filename: `${slugify(rec.title, 'beat')}.mp3` };
  },

  /** URL tabanli kaynak yok. */
  async getAudioSource() {
    return null;
  },

  storeStats,
};
