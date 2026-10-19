'use strict';

const crypto = require('crypto');

class MangoDecrypter {
  constructor() {
    this.cache = new Map(); // clipId -> { key, iv, expiresAt }
  }

  async getKeys(clipId) {
    if (!clipId) return null;
    const now = Date.now();
    if (this.cache.has(clipId)) {
      const cached = this.cache.get(clipId);
      if (cached.expiresAt > now) {
        return cached;
      }
      this.cache.delete(clipId);
    }

    try {
      const resp = await fetch('https://studio-api-prod.suno.com/api/mango/rights', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({
          content_params: {
            content_id: clipId,
            content_type: 'clip',
          },
        }),
      });

      if (!resp.ok) return null;
      const rights = await resp.json();
      if (!rights || !rights.glt || !rights.key || !rights.iv) {
        return null;
      }

      const gcmKey = crypto.createHash('sha256').update(rights.glt).digest();

      function decryptGcm(b64) {
        const buf = Buffer.from(b64, 'base64');
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(buf.length - 16);
        const ciphertext = buf.subarray(12, buf.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', gcmKey, iv);
        decipher.setAAD(Buffer.from(clipId, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      }

      const key = decryptGcm(rights.key);
      const iv = decryptGcm(rights.iv);

      const result = { key, iv, expiresAt: now + 3600 * 1000 };
      this.cache.set(clipId, result);
      return result;
    } catch (_err) {
      return null;
    }
  }

  async createDecipher(clipId) {
    const keys = await this.getKeys(clipId);
    if (!keys) return null;
    return crypto.createDecipheriv('aes-128-ctr', keys.key, keys.iv);
  }
}

module.exports = new MangoDecrypter();
