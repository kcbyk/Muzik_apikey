'use strict';

/**
 * REPLICATE PROVIDER ADAPTORU  (resmi API, indirilebilir ses)
 * =========================================================
 * Model: meta/musicgen  (veya REPLICATE_MODEL ile baska bir muzik modeli)
 *
 * Gerekli env:
 *   REPLICATE_API_TOKEN=r8_...
 *   REPLICATE_MODEL=meta/musicgen            (opsiyonel)
 *   REPLICATE_MODEL_VERSION=...              (opsiyonel; bos ise modelden cozulur)
 *   REPLICATE_TIMEOUT_MS=180000              (opsiyonel)
 *
 * Akis:
 *   POST https://api.replicate.com/v1/predictions      -> { id, status }
 *   GET  .../v1/predictions/{id}                       -> status + output (ses URL'i)
 *   output genelde https://replicate.delivery/...wav|mp3  -> dogrudan indirilebilir
 *
 * Not: Replicate cikisi genelde WAV'dir; /stream ve /download `?format=mp3`
 * ile ffmpeg uzerinden MP3'e cevirir (opsiyonel, kuruluysa).
 */

const axios = require('axios');
const { ProviderError, sleep, slugify } = require('./base');

const API = 'https://api.replicate.com/v1';

function token() {
  return (process.env.REPLICATE_API_TOKEN || '').trim();
}

function modelSlug() {
  return (process.env.REPLICATE_MODEL || 'meta/musicgen').trim();
}

/** Modelin son version id'sini cozer (predictions icin gerekli). */
async function resolveVersion() {
  if (process.env.REPLICATE_MODEL_VERSION) return process.env.REPLICATE_MODEL_VERSION.trim();

  const slug = modelSlug();
  const [owner, name] = slug.split('/');
  const { data } = await axios.get(`${API}/models/${owner}/${name}`, {
    headers: { Authorization: `Token ${token()}` },
    timeout: 20000,
  });
  const version = data && data.latest_version && data.latest_version.id;
  if (!version) {
    throw new ProviderError(502, 'REPLICATE_VERSION_MISSING', 'Model version id cozulemedi.', slug);
  }
  return version;
}

/** Replicate cikisini tek bir ses URL'ine indirger. */
function pickOutputUrl(output) {
  if (!output) return null;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const found = output.find((o) => typeof o === 'string' && /^https?:\/\//.test(o));
    return found || null;
  }
  if (typeof output === 'object') {
    for (const key of ['audio', 'audio_url', 'url', 'output']) {
      if (typeof output[key] === 'string') return output[key];
    }
  }
  return null;
}

/** Replicate tahminini normalize edilmis klip nesnesine cevirir. */
function toClip(prediction) {
  if (!prediction || !prediction.id) return null;

  const statusMap = {
    starting: 'queued',
    processing: 'generating',
    succeeded: 'complete',
    failed: 'error',
    canceled: 'error',
  };
  const status = statusMap[prediction.status] || 'queued';
  const audioUrl = status === 'complete' ? pickOutputUrl(prediction.output) : null;

  const input = prediction.input || {};
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const duration = typeof input.duration === 'number' ? input.duration : null;

  return {
    id: prediction.id,
    status,
    is_complete: status === 'complete',
    is_error: status === 'error',
    title: prompt ? slugify(prompt.split(',')[0], 'beat') : 'beat',
    tags: typeof input.tags === 'string' ? input.tags : null,
    prompt: prompt || null,
    duration_seconds: duration,
    model: modelSlug(),
    created_at: prediction.created_at || null,
    image_url: null,
    song_url: audioUrl,
    audio_url: audioUrl,
    download_url: `/download?id=${prediction.id}`,
    stream_url: audioUrl ? `/stream/${prediction.id}` : null,
    download_blocked_reason: status === 'complete' && !audioUrl ? 'Model cikti URL uretmedi.' : null,
  };
}

module.exports = {
  name: 'replicate',

  async isConfigured() {
    return Boolean(token());
  },

  async generate({ prompt, tags, title, instrumental, model, extra }) {
    if (!token()) {
      throw new ProviderError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        'REPLICATE_API_TOKEN tanimli degil.',
        'https://replicate.com/account/api-tokens adresinden token alip .env dosyasina ekleyin.',
      );
    }

    const version = await resolveVersion();

    // meta/musicgen girdileri: prompt, duration, ...
    const input = {
      prompt: tags ? `${prompt}, ${tags}` : prompt,
      duration: Number(process.env.REPLICATE_DURATION || 30),
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    if (title) input.title = title;
    if (model) input.model_version = model;

    let data;
    try {
      ({ data } = await axios.post(
        `${API}/predictions`,
        { version, input },
        {
          headers: { Authorization: `Token ${token()}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      ));
    } catch (err) {
      const detail = err.response ? JSON.stringify(err.response.data).slice(0, 400) : err.message;
      throw new ProviderError(502, 'REPLICATE_REQUEST_FAILED', 'Replicate istegi basarisiz.', detail);
    }

    return { clip_ids: data && data.id ? [data.id] : [], clips: [toClip(data)].filter(Boolean), raw: data };
  },

  async getTrack(clipId) {
    if (!token()) return null;
    try {
      const { data } = await axios.get(`${API}/predictions/${clipId}`, {
        headers: { Authorization: `Token ${token()}` },
        timeout: 20000,
      });
      return toClip(data);
    } catch (err) {
      if (err.response && err.response.status === 404) return null;
      throw new ProviderError(502, 'REPLICATE_FETCH_FAILED', 'Tahmin durumu alinamadi.', err.message);
    }
  },

  async getAudioSource(clipOrId) {
    const clip = typeof clipOrId === 'string' ? await this.getTrack(clipOrId) : clipOrId;
    if (!clip || !clip.audio_url) return null;
    return { url: clip.audio_url, source: 'replicate', transparent: false };
  },

  /** Tahmin bitene kadar bekle (route katmani `?wait=true` icin kullanabilir). */
  async waitForCompletion(clipId, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    let clip = await this.getTrack(clipId);
    while (clip && !clip.is_complete && !clip.is_error && Date.now() < deadline) {
      await sleep(3000);
      clip = await this.getTrack(clipId);
    }
    return clip;
  },

  /** Route katmani icin yardimci: slug uretimi (dosya adi). */
  slugify,
};
