'use strict';

/**
 * AUDIO PROVIDER CONTRACT
 * =======================
 * Her saglayici adaptoru su sozlesmeyi uygular. `/generate-beat`, `/track/:id`,
 * `/stream/:id` ve `/download` route'lari yalnizca bu arayuzu bilir; boylece
 * istemci uygulamasinda hicbir degisiklik olmadan saglayici degistirilebilir.
 *
 *   name: string
 *
 *   async isConfigured(): Promise<boolean>
 *        Gerekli API anahtarlari var mi?
 *
 *   async generate({ prompt, tags, title, instrumental, model, extra }):
 *        Promise<{ clip_ids: string[], clips: Clip[], raw?: any }>
 *
 *   async getTrack(clipId): Promise<Clip | null>
 *
 *   async getAudioSource(clipOrId):
 *        Promise<{ url: string, source: string, transparent: boolean } | null>
 *        url = istemciye akitilacak/dosya olarak verilecek ses adresi.
 *        null  = bu saglayici ses dosyasi sunmuyor.
 *
 *   Clip (normalize edilmis):
 *   {
 *     id, status, is_complete, is_error, title, tags, prompt,
 *     duration_seconds, model, created_at, image_url,
 *     song_url, audio_url, download_url, stream_url
 *   }
 *
 * status: 'submitted' | 'queued' | 'generating' | 'complete' | 'error'
 */

/** Saglayici kaynakli hatalar icin tasiyici (route katmani status'e cevirir). */
class ProviderError extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Saat gecikmesi (polling araligi) - saglayicidan bagimsiz. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Basit UUID benzeri kimlik ureticisi (mock/test saglayicilari icin). */
function newId(prefix = '') {
  const crypto = require('crypto');
  const id = crypto.randomUUID();
  return prefix ? `${prefix}-${id}` : id;
}

/** Ortak metin temizligi (dosya adi uretmek icin). */
function slugify(text, fallback = 'audio') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

module.exports = { ProviderError, sleep, newId, slugify };
