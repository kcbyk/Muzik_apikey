'use strict';

/**
 * ELEVENLABS MUSIC PROVIDER ADAPTORU  (resmi API, indirilebilir ses)
 * =================================================================
 * Gerekli env:
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_MUSIC_LENGTH_MS=30000        (opsiyonel, 10000-300000)
 *   ELEVENLABS_MODEL=music_v1               (opsiyonel)
 *
 * Akis:
 *   POST https://api.elevenlabs.io/v1/music          -> ses baytlari (audio/mpeg)
 *   POST https://api.elevenlabs.io/v1/music/detailed -> kompozisyon plani (JSON)
 *
 * Bu adaptor, uretilen sesi sunucuda kisa sureli bir bellege (bellek ici, LRU)
 * alir ve `/stream/:id` / `/download?id=` bu kayittan akitir. Boylece frontend
 * sozlesmesi Suno ile birebir ayni kalir.
 *
 * NOT: Ses verisi RAM'de tutulur; varsayilan limit ELEVENLABS_MAX_CACHE_MB (32 MB).
 *      Render 512 MB sinirinda guvenli kalmak icin eski kayitlar atilir.
 */

const axios = require('axios');
const crypto = require('crypto');
const { ProviderError, slugify } = require('./base');

const API = 'https://api.elevenlabs.io/v1';

/** Bellek ici kayit: id -> { buffer, contentType, meta, createdAt } */
const store = new Map();

function apiKey() {
  return (process.env.ELEVENLABS_API_KEY || '').trim();
}

function maxCacheBytes() {
  const mb = Number.parseInt(process.env.ELEVENLABS_MAX_CACHE_MB || '32', 10);
  return (Number.isFinite(mb) ? mb : 32) * 1024 * 1024;
}

/** Toplam bellek kullanimini sinirla (en eski kayitlari at). */
function evictIfNeeded() {
  let total = 0;
  for (const item of store.values()) total += item.buffer.length;

  const limit = maxCacheBytes();
  while (total > limit && store.size > 0) {
    const oldestKey = store.keys().next().value;
    total -= store.get(oldestKey).buffer.length;
    store.delete(oldestKey);
  }
}

function toClip(record) {
  const { id, meta, buffer } = record;
  return {
    id,
    status: 'complete',
    is_complete: true,
    is_error: false,
    title: meta.title || 'beat',
    tags: meta.tags || null,
    prompt: meta.prompt || null,
    duration_seconds: meta.durationSeconds || null,
    model: meta.model || 'elevenlabs-music',
    created_at: record.createdAt,
    image_url: null,
    song_url: null,
    audio_url: `/stream/${id}`, // kendi endpoint'imiz
    download_url: `/download?id=${id}`,
    stream_url: `/stream/${id}`,
    download_blocked_reason: null,
    _bytes: buffer.length,
  };
}

module.exports = {
  name: 'elevenlabs',

  async isConfigured() {
    return Boolean(apiKey());
  },

  async generate({ prompt, tags, title }) {
    if (!apiKey()) {
      throw new ProviderError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'ELEVENLABS_API_KEY tanimli degil.',
        'https://elevenlabs.io/app/settings/api-keys adresinden anahtar alip .env dosyasina ekleyin.',
      );
    }

    const musicLengthMs = Math.min(
      Math.max(Number.parseInt(process.env.ELEVENLABS_MUSIC_LENGTH_MS || '30000', 10) || 30000, 10000),
      300000,
    );

    let response;
    try {
      response = await axios.post(
        `${API}/music`,
        {
          prompt: tags ? `${prompt}. Style: ${tags}` : prompt,
          music_length_ms: musicLengthMs,
          model_id: process.env.ELEVENLABS_MODEL || 'music_v1',
        },
        {
          headers: {
            'xi-api-key': apiKey(),
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          responseType: 'arraybuffer',
          timeout: 180000,
          maxBodyLength: 64 * 1024 * 1024,
          validateStatus: () => true,
        },
      );
    } catch (err) {
      throw new ProviderError(502, 'ELEVENLABS_REQUEST_FAILED', 'ElevenLabs istegi basarisiz.', err.message);
    }

    if (response.status !== 200) {
      const detail = Buffer.from(response.data || '').toString('utf8').slice(0, 400);
      throw new ProviderError(
        response.status === 401 ? 502 : response.status,
        'ELEVENLABS_REQUEST_FAILED',
        `ElevenLabs HTTP ${response.status}`,
        detail,
      );
    }

    const buffer = Buffer.from(response.data);
    if (!buffer.length) {
      throw new ProviderError(502, 'PROVIDER_EMPTY_OUTPUT', 'ElevenLabs bos govde dondurdu.');
    }

    const id = crypto.randomUUID();
    store.set(id, {
      id,
      buffer,
      contentType: response.headers['content-type'] || 'audio/mpeg',
      meta: {
        title: title || slugify(prompt, 'beat'),
        tags: tags || null,
        prompt,
        durationSeconds: Math.round(musicLengthMs / 1000),
        model: process.env.ELEVENLABS_MODEL || 'music_v1',
      },
      createdAt: new Date().toISOString(),
    });
    evictIfNeeded();

    const record = store.get(id);
    return {
      clip_ids: [id],
      clips: [toClip(record)],
      raw: { bytes: buffer.length, contentType: record.contentType },
    };
  },

  async getTrack(clipId) {
    const record = store.get(clipId);
    return record ? toClip(record) : null;
  },

  async getAudioSource(clipOrId) {
    const id = typeof clipOrId === 'string' ? clipOrId : clipOrId && clipOrId.id;
    const record = store.get(id);
    if (!record) return null;
    // Kaynak sunucu icinde: /internal/provider-audio/:id uzerinden akitilir
    return { url: `internal://elevenlabs/${id}`, source: 'elevenlabs', transparent: false, internal: true };
  },

  /** Route katmani icin: bellek ici kayda erisim. */
  getRecord(clipId) {
    return store.get(clipId) || null;
  },

  /** Test/teshis icin kayit sayisi ve toplam bayt. */
  stats() {
    let bytes = 0;
    for (const r of store.values()) bytes += r.buffer.length;
    return { records: store.size, bytes, limitBytes: maxCacheBytes() };
  },
};
