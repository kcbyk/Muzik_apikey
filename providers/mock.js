'use strict';

/**
 * MOCK PROVIDER  (test / CI icin)
 * ==============================
 * Gercek API cagrisi yapmaz; sozlesmeyi uygular ve gecerli bir WAV uretir.
 * Amac: `AUDIO_PROVIDER=mock` ile /generate-beat -> /track -> /stream hattini
 * API anahtari olmadan uctan uca dogrulamak.
 *
 * Uretilen ses: iki notali basit bir sine (44.1 kHz, 16-bit mono WAV).
 */

const crypto = require('crypto');
const { sleep } = require('./base');

const clips = new Map(); // id -> { meta, createdAt, readyAt }

function buildWav({ seconds, freqA, freqB, sampleRate = 44100 }) {
  const total = Math.floor(sampleRate * seconds);
  const dataSize = total * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    // 8 saniyede bir nota degistir (808 benzeri basit bir melodi)
    const freq = Math.floor(t / 8) % 2 === 0 ? freqA : freqB;
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 4);
    buf.writeInt16LE(Math.round(9000 * env * Math.sin(2 * Math.PI * freq * t)), 44 + i * 2);
  }
  return buf;
}

function toClip(record) {
  const ready = Date.now() >= record.readyAt;
  return {
    id: record.id,
    status: ready ? 'complete' : 'generating',
    is_complete: ready,
    is_error: false,
    title: record.meta.title,
    tags: record.meta.tags,
    prompt: record.meta.prompt,
    duration_seconds: record.meta.seconds,
    model: 'mock-sine',
    created_at: record.createdAt,
    image_url: null,
    song_url: null,
    audio_url: ready ? `/stream/${record.id}` : null,
    download_url: `/download?id=${record.id}`,
    stream_url: ready ? `/stream/${record.id}` : null,
    download_blocked_reason: null,
  };
}

module.exports = {
  name: 'mock',

  async isConfigured() {
    return true;
  },

  async generate({ prompt, tags, title }) {
    // Gercek saglayicilardaki gecikmeyi taklit et
    await sleep(400);

    const id = crypto.randomUUID();
    const seconds = Math.min(Math.max(Number.parseInt(process.env.MOCK_DURATION_SECONDS || '6', 10) || 6, 1), 30);

    const record = {
      id,
      createdAt: new Date().toISOString(),
      readyAt: Date.now() + 1500, // 1.5 sn sonra "complete"
      meta: {
        title: title || 'mock beat',
        tags: tags || 'mock, test',
        prompt,
        seconds,
        freqA: 55,
        freqB: 73.4,
      },
    };
    clips.set(id, record);

    return { clip_ids: [id], clips: [toClip(record)], raw: { provider: 'mock' } };
  },

  async getTrack(clipId) {
    const record = clips.get(clipId);
    return record ? toClip(record) : null;
  },

  async getAudioSource(clipOrId) {
    const id = typeof clipOrId === 'string' ? clipOrId : clipOrId && clipOrId.id;
    const record = clips.get(id);
    if (!record) return null;
    return { url: `internal://mock/${id}`, source: 'mock', transparent: false, internal: true };
  },

  /** Route katmani bu kayittan WAV uretir. */
  render(clipId) {
    const record = clips.get(clipId);
    if (!record) return null;
    const buffer = buildWav({
      seconds: record.meta.seconds,
      freqA: record.meta.freqA,
      freqB: record.meta.freqB,
    });
    return { buffer, contentType: 'audio/wav' };
  },
};
