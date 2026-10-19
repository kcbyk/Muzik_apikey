'use strict';

/**
 * SUNO PROVIDER ADAPTORU
 * ======================
 * Mevcut Suno mantigini (Clerk token, generate/v2-web, feed/v2, audiopipe)
 * provider sozlesmesine sarar. server.js icindeki hazir fonksiyonlari
 * `init(ctx)` ile alir; boylece kod tekrar edilmez.
 */

const { ProviderError } = require('./base');

let ctx = null;

module.exports = {
  name: 'suno',

  /** server.js kendi ic fonksiyonlarini enjekte eder. */
  init(context) {
    ctx = context;
  },

  async isConfigured() {
    return Boolean(ctx && (ctx.hasRefreshToken || ctx.hasSessionToken));
  },

  async generate({ prompt, tags, title, instrumental, model, extra }) {
    if (!ctx) throw new ProviderError(500, 'PROVIDER_NOT_INITIALIZED', 'Suno adaptoru hazir degil.');

    const payload = {
      prompt,
      tags: tags || '',
      title: title || '',
      make_instrumental: typeof instrumental === 'boolean' ? instrumental : ctx.defaultInstrumental,
      mv: model || ctx.defaultModel,
      generation_type: 'TEXT',
      ...(extra && typeof extra === 'object' ? extra : {}),
    };

    // Model yetkisi yoksa fallback zinciri (ucretsiz plan yalnizca chirp-v3-5)
    const models = [payload.mv, ...ctx.modelFallback.filter((m) => m !== payload.mv)];
    let response;
    const tried = [];

    for (const mv of models) {
      payload.mv = mv;
      tried.push(mv);
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await ctx.sunoRequest('post', ctx.generatePath, payload);
        break;
      } catch (err) {
        const denied =
          err.status === 403 && /access to this model|permission_denied/i.test(String(err.detail || ''));
        if (!denied) throw err;
        if (mv === models[models.length - 1]) {
          throw new ProviderError(
            403,
            'MODEL_NOT_AVAILABLE',
            'Bu hesapta kullanilabilir model bulunamadi.',
            `${tried.join(', ')} -> permission_denied`,
          );
        }
      }
    }

    const clips = Array.isArray(response)
      ? response
      : (response && (response.clips || response.data)) || [];
    const clipIds = clips.map((c) => c && (c.id || c.clip_id)).filter(Boolean);

    return { clip_ids: clipIds, clips: clips.map((c) => ctx.normalizeClip(c)).filter(Boolean), raw: response };
  },

  async getTrack(clipId) {
    const clip = await ctx.fetchClip(clipId);
    return clip ? ctx.normalizeClip(clip) : null;
  },

  async getAudioSource(clipOrId) {
    const clip = typeof clipOrId === 'string' ? await ctx.fetchClip(clipOrId) : clipOrId;
    if (!clip) return null;
    // audio_url gercek CDN linkiyse onu kullan; degilse audiopipe sablonu.
    return ctx.resolveAudioSource(clip);
  },

  /** Suno'ya ozgu: akis oncesi handshake (analytics session + listen_milestone). */
  async beforeStream(clipId) {
    if (!ctx || !ctx.runStreamHandshake) return null;
    return ctx.runStreamHandshake(clipId);
  },
};
