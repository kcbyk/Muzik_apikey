#!/usr/bin/env node
'use strict';

/**
 * Suno JWT dogrulama araci
 * ------------------------
 * Bir Suno __session / Clerk JWT'sinin GERCEK olup olmadigini, Suno'nun
 * kendi yayinladigi JWKS anahtarlariyla imza kontrolu yaparak soyler.
 *
 * Kullanim:
 *   node tools/verify-token.js "eyJhbGciOi..."
 *   node tools/verify-token.js --file token.txt
 *
 * Cikti: imza gecerli mi, kalan sure, sid, plan, kid.
 * Imza GECERSIZ cikarsa token kopyalama sirasinda bozulmustur (veya sahtedir);
 * Suno API'si de bu token'i 401 ile reddeder.
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function decode(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function verifyToken(token) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'JWT formati bozuk (3 parca bekleniyordu)' };
  }
  const [h, p, s] = parts;
  const header = decode(h);
  const payload = decode(p);

  const jwks = await getJson('https://auth.suno.com/.well-known/jwks.json');
  const candidates = jwks.keys.filter((k) => !header.kid || k.kid === header.kid);
  const list = candidates.length ? candidates : jwks.keys;

  let signatureValid = false;
  for (const jwk of list) {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      if (crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) {
        signatureValid = true;
        break;
      }
    } catch (_e) {
      /* anahtar okunamadi, digerini dene */
    }
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    valid: signatureValid && payload.exp > now,
    signatureValid,
    expired: payload.exp <= now,
    kid: header.kid,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    expiresInSeconds: payload.exp - now,
    sessionId: payload.sid,
    plan: payload.plan,
    handle: payload['suno/handle'],
    tokenType: payload['suno.com/claims/token_type'],
    length: String(token).trim().length,
  };
}

(async () => {
  const args = process.argv.slice(2);
  let token = '';
  if (args[0] === '--file' && args[1]) token = fs.readFileSync(args[1], 'utf8');
  else token = args.join(' ');

  if (!token.trim()) {
    console.error('Kullanim: node tools/verify-token.js "eyJ..." veya --file token.txt');
    process.exit(1);
  }

  try {
    const r = await verifyToken(token);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.valid ? 0 : 2);
  } catch (err) {
    console.error('Dogrulama hatasi:', err.message);
    process.exit(1);
  }
})();

module.exports = { verifyToken };
