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

    const pool = ctx.accountPool;
    const initialPoolSize = pool && pool.size() > 0 ? pool.getAvailableAccounts().length : 1;
    const maxAttempts = Math.max(1, initialPoolSize);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const account = pool && pool.size() > 0 ? pool.getActiveAccount() : null;

      // Model yetkisi yoksa fallback zinciri (ucretsiz plan yalnizca chirp-v3-5)
      const models = [payload.mv, ...ctx.modelFallback.filter((m) => m !== payload.mv)];
      let response;
      const tried = [];
      let creditExhausted = false;

      for (const mv of models) {
        payload.mv = mv;
        tried.push(mv);
        try {
          // eslint-disable-next-line no-await-in-loop
          response = await ctx.sunoRequest('post', ctx.generatePath, payload, { account });
          break;
        } catch (err) {
          const isExhausted = ctx.isCreditExhaustedError && ctx.isCreditExhaustedError(err);
          const isAuthFailed =
            err.status === 401 ||
            err.isAuthError ||
            err.code === 'AUTH_ERROR' ||
            err.code === 'SESSION_EXPIRED' ||
            /clerk oturumu bulunamadi|token reddi/i.test(String(err.message || err.detail || ''));

          if (isExhausted || isAuthFailed) {
            creditExhausted = true;
            lastError = err;
            break; // Bu hesabi atla, siradaki hesaba gec
          }

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

      if (creditExhausted) {
        if (pool && account) {
          pool.markAccountExhausted(account, lastError.detail || lastError.message || 'Kredi tukendi');
          const remaining = pool.getAvailableAccounts().length;
          if (ctx.log) {
            ctx.log(
              'warn',
              `[AccountPool] ${account.id} hesabi limit/kredi tukendi. Kalan aktif hesap: ${remaining}. Sonraki hesaba devrediliyor...`
            );
          }
          if (remaining > 0) {
            continue; // Siradaki hesaba gec ve tekrar dene
          }
        }
        throw new ProviderError(
          402,
          'ALL_ACCOUNTS_EXHAUSTED',
          'Havuzdaki tum Suno hesaplarinin gunluk limitleri tukendi.',
          lastError ? (lastError.detail || lastError.message) : undefined
        );
      }

      const clips = Array.isArray(response)
        ? response
        : (response && (response.clips || response.data)) || [];
      const clipIds = clips.map((c) => c && (c.id || c.clip_id)).filter(Boolean);

      if (pool && account) {
        account.totalGenerated += 1;
        clips.forEach((c) => {
          const id = c && (c.id || c.clip_id);
          if (id) pool.recordClipAccount(id, account.id);
        });
      }

      return { clip_ids: clipIds, clips: clips.map((c) => ctx.normalizeClip(c)).filter(Boolean), raw: response };
    }

    if (lastError) throw lastError;
    throw new ProviderError(500, 'GENERATE_FAILED', 'Uretim yapilamadi.');
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

  /**
   * Suno'nun RESMI indirme ucu (tarayicidaki "Indir" butonuyla ayni akis).
   *   GET /api/download/clip/{id}?format=mp3  ->  { download_url, status }
   * download_url presigned S3 linkidir, duz MP3 dondurur.
   * Indirme hakki olmayan kliplerde null doner (cagiran taraf normal akisa duser).
   */
  async getDownloadSource(clipOrId, format = 'mp3') {
    if (!ctx || !ctx.fetchDownloadUrl) return null;
    const clipId = typeof clipOrId === 'string' ? clipOrId : clipOrId && clipOrId.id;
    if (!clipId) return null;
    const result = await ctx.fetchDownloadUrl(clipId, format);
    if (!result) return null;
    return {
      url: result.url,
      source: 'suno-official-download',
      transparent: true,
      format: result.format,
      status: result.status,
    };
  },

  /** Suno'ya ozgu: akis oncesi handshake (analytics session + listen_milestone). */
  async beforeStream(clipId) {
    if (!ctx || !ctx.runStreamHandshake) return null;
    return ctx.runStreamHandshake(clipId);
  },
};
