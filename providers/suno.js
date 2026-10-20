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

    // ---------------------------------------------------------------------
    // 0) CAPTCHA  (Suno v6 uretim dogrulamasi)
    // ---------------------------------------------------------------------
    // Suno, uretim isteginde { token, token_provider } bekliyor. Yoksa:
    //   422 {"error_type":"token_validation_failed",
    //        "detail":"We couldn't verify your request."}
    // Bu mesaj JWT'yi suclu gosteriyor ama sorun eksik captcha cozumu.
    let captchaInfo = { required: false, token: null, provider: null, source: 'skipped' };
    if (typeof ctx.getCaptchaToken === 'function') {
      captchaInfo = await ctx.getCaptchaToken();
    }
    if (captchaInfo.required && !captchaInfo.token) {
      throw new ProviderError(
        428,
        'CAPTCHA_REQUIRED',
        'Suno uretim icin captcha dogrulamasi istiyor; cozum saglanamadi. ' +
          'SUNO_CAPTCHA_TOKEN (elle) veya CAPTCHA_SOLVER + CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY tanimlayin.',
        JSON.stringify({
          check: '/api/c/check',
          ctype: ctx.captchaType || 'generation',
          required: true,
          preferred_provider: captchaInfo.preferred || null,
          source: captchaInfo.source,
          hint:
            'Suno web bundle kaniti: tarayici once POST /api/c/check {ctype:"generation"} yapar, ' +
            '"required" ise generate govdesine token + token_provider ekler.',
        })
      );
    }
    if (ctx.log && captchaInfo.required) {
      ctx.log('info', `[suno] captcha cozuldu (kaynak: ${captchaInfo.source}).`);
    }

    const buildPayload = (cap) => {
      const p = {
        prompt,
        tags: tags || '',
        title: title || '',
        make_instrumental: typeof instrumental === 'boolean' ? instrumental : ctx.defaultInstrumental,
        mv: model || ctx.defaultModel,
        generation_type: 'TEXT',
        ...(extra && typeof extra === 'object' ? extra : {}),
      };
      if (cap && cap.token) {
        p.token = cap.token;
        if (cap.provider !== null && cap.provider !== undefined) p.token_provider = cap.provider;
      }
      return p;
    };

    const payload = buildPayload(captchaInfo);

    // Captcha reddedilirse (cozum suresi dolmus / gecersiz) bir kez yeniden coz.
    let captchaRearmed = false;
    const callGenerate = async (account) => {
      try {
        return await ctx.sunoRequest('post', ctx.generatePath, payload, { account });
      } catch (err) {
        const text = String((err && (err.detail || err.message)) || '');
        const captchaRejected = err.status === 422 && /verify your request|captcha/i.test(text);
        if (captchaRejected && !captchaRearmed && typeof ctx.getCaptchaToken === 'function') {
          captchaRearmed = true;
          const fresh = await ctx.getCaptchaToken({ force: true });
          if (fresh && fresh.token) {
            Object.assign(payload, buildPayload(fresh));
            captchaInfo = fresh;
            if (ctx.log) ctx.log('warn', '[suno] captcha reddedildi; yeni cozumle tekrar deneniyor.');
            return ctx.sunoRequest('post', ctx.generatePath, payload, { account });
          }
        }
        throw err;
      }
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
          response = await callGenerate(account);
          break;
        } catch (err) {
          const errText = String((err && (err.detail || err.message)) || '');
          const isExhausted = ctx.isCreditExhaustedError && ctx.isCreditExhaustedError(err);
          const isDeadSession = /clerk oturumu bulunamadi/i.test(errText);

          // Captcha kaynakli 422: hesabi "tukendi" diye isaretlemek YANLIS.
          // (Eski kod bunu token hatasi sayip tum havuzu kilitliyordu.)
          const isCaptchaRejected = err.status === 422 && /verify your request|captcha/i.test(errText);
          if (isCaptchaRejected) {
            lastError = err;
            break; // diger modeli denemek anlamsiz; hesap saglam
          }

          const isTokenRejected =
            err.status === 401 ||
            err.status === 422 ||
            err.isAuthError ||
            err.code === 'AUTH_ERROR' ||
            err.code === 'SESSION_EXPIRED' ||
            /token reddi|token_validation_failed|verify your request/i.test(
              String(err.message || err.detail || '')
            );

          if (isExhausted) {
            lastError = err;
            if (pool && account) {
              pool.markAccountExhausted(account, err.detail || err.message || 'Kredi tukendi');
            }
            break; // Bu hesabi atla, siradaki hesaba gec
          }

          if (isDeadSession) {
            lastError = err;
            if (account) {
              account.lastError = 'Clerk oturumu bulunamadi; suno.com uzerinden yeni cookie alin.';
              account.sessionId = null;
            }
            break; // Siradaki hesaba gec
          }

          if (isTokenRejected) {
            lastError = err;
            if (pool && account) {
              // 60 saniyelik kisa mola ver, 24 saat kitleme
              pool.markAccountExhausted(account, err.detail || err.message || 'Token dogrulama reddi', 60000);
            }
            break; // Siradaki hesaba gec
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

      if (lastError && (!response || (!response.clips && !response.data && !Array.isArray(response)))) {
        const remaining = pool ? pool.getAvailableAccounts().length : 0;
        if (ctx.log) {
          ctx.log(
            'warn',
            `[AccountPool] ${account ? account.id : 'hesap'} uretim basarisiz. Kalan aktif hesap: ${remaining}.`
          );
        }
        if (remaining > 0) {
          continue; // Siradaki hesaba gec ve tekrar dene
        }

        const lastText = String((lastError && (lastError.detail || lastError.message)) || '');
        if (lastError && lastError.status === 422 && /verify your request|captcha/i.test(lastText)) {
          throw new ProviderError(
            428,
            'CAPTCHA_REQUIRED',
            "Suno uretim istegini captcha dogrulamasi olmadan kabul etmiyor (422 \"couldn't verify your request\"). " +
              'SUNO_CAPTCHA_TOKEN veya CAPTCHA_SOLVER (capsolver/2captcha) tanimlayin.',
            lastText
          );
        }

        const isExhausted = ctx.isCreditExhaustedError && ctx.isCreditExhaustedError(lastError);
        if (isExhausted) {
          throw new ProviderError(
            402,
            'ALL_ACCOUNTS_EXHAUSTED',
            'Havuzdaki tum Suno hesaplarinin gunluk limitleri tukendi.',
            lastError.detail || lastError.message
          );
        } else {
          throw new ProviderError(
            lastError.status || 422,
            lastError.code || 'TOKEN_VALIDATION_FAILED',
            `Suno oturum/token dogrulamasi basarisiz: ${lastError.detail || lastError.message || 'Lutfen suno.com uzerinde oturumunuzu acin.'}`,
            lastError.detail || lastError.message
          );
        }
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

    // Dongu deneme sinirina takildi (remaining>0 ama hesap kalmadi) — hatayi
    // oldugu gibi sizdirmek yerine anlamli bir ProviderError'a cevir.
    if (lastError) {
      const lastText = String(lastError.detail || lastError.message || '');
      if (lastError.status === 422 && /verify your request|captcha/i.test(lastText)) {
        throw new ProviderError(
          428,
          'CAPTCHA_REQUIRED',
          "Suno uretim istegini captcha dogrulamasi olmadan kabul etmiyor (422 \"couldn't verify your request\"). " +
            'SUNO_CAPTCHA_TOKEN veya CAPTCHA_SOLVER (capsolver/2captcha) tanimlayin.',
          lastText
        );
      }
      if (ctx.isCreditExhaustedError && ctx.isCreditExhaustedError(lastError)) {
        throw new ProviderError(
          402,
          'ALL_ACCOUNTS_EXHAUSTED',
          'Havuzdaki tum Suno hesaplarinin gunluk limitleri tukendi.',
          lastText
        );
      }
      throw new ProviderError(
        lastError.status || 502,
        lastError.code || 'SUNO_ERROR',
        `Suno uretim hatasi: ${lastText || 'bilinmeyen hata'}`,
        lastText
      );
    }
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
