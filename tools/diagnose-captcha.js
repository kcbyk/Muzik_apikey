'use strict';

/**
 * tools/diagnose-captcha.js
 * =========================
 * Suno uretiminin neden 422 "We couldn't verify your request" dondurdugunu
 * KESIN olarak teshis eder.
 *
 * Kullanim:
 *   SUNO_REFRESH_TOKEN='__client degeri' node tools/diagnose-captcha.js
 *   node tools/diagnose-captcha.js 'client_xxx'
 *
 * Ne yapar?
 *   1) __client cookie'sinden taze Clerk JWT uretir (auth.suno.com)
 *   2) POST /api/c/check  { ctype: "generation" }  -> required?
 *   3) Generate istegini captcha'siz dener -> gercek hata kodunu yazar
 *   4) Sonucu yorumlar
 */

const axios = require('axios');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CLERK = 'https://auth.suno.com';
const STUDIO = 'https://studio-api-prod.suno.com';
const JS_VER = '5.35.0';

function clean(raw) {
  let s = String(raw || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('Bearer ')) s = s.slice(7).trim();
  const m = s.match(/__client=([^;]+)/) || s.match(/__session=([^;]+)/);
  return m ? m[1].trim() : s;
}

function decodeJwt(t) {
  try {
    const p = String(t).split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_e) {
    return null;
  }
}

function headers(jwt) {
  const inner = JSON.stringify({ timestamp: Date.now() });
  return {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': UA,
    Origin: 'https://suno.com',
    Referer: 'https://suno.com/',
    'Browser-Token': JSON.stringify({ token: Buffer.from(inner, 'utf8').toString('base64') }),
    'Device-Id': process.env.SUNO_DEVICE_ID || '3a88a09b-67a8-4224-aa61-55dbdd04c8f0',
  };
}

async function main() {
  const raw = process.argv[2] || process.env.SUNO_REFRESH_TOKEN || '';
  if (!raw) {
    console.error('Kullanim: SUNO_REFRESH_TOKEN=... node tools/diagnose-captcha.js');
    process.exit(1);
  }
  const cookie = clean(raw);
  const payload = decodeJwt(cookie);
  console.log('='.repeat(66));
  console.log('SUNO URETIM CAPTCHA TESHISI');
  console.log('='.repeat(66));
  if (payload) {
    console.log('cookie token_type :', payload['suno.com/claims/token_type'] || '(yok)');
    console.log('cookie exp        :', payload.exp ? new Date(payload.exp * 1000).toISOString() : '(yok)');
  }

  // --- 1) Taze JWT ---------------------------------------------------------
  console.log('\n[1] auth.suno.com/v1/client ...');
  let jwt = null;
  let sessionId = null;
  try {
    const r = await axios.get(`${CLERK}/v1/client?_clerk_js_version=${JS_VER}`, {
      headers: { Cookie: `__client=${cookie}`, 'User-Agent': UA, Accept: '*/*' },
      timeout: 20000,
      validateStatus: () => true,
    });
    const client = (r.data && (r.data.response || r.data)) || {};
    const sessions = Array.isArray(client.sessions) ? client.sessions : [];
    console.log(`    HTTP ${r.status} | oturum sayisi: ${sessions.length}`);
    if (!sessions.length) {
      console.log('    ⛔ __client gecersiz / oturum yok. Yeni cookie alin (auth.suno.com).');
      process.exit(2);
    }
    sessionId = (sessions.find((s) => s && s.status === 'active') || sessions[0]).id;
    console.log('    sessionId:', sessionId);
  } catch (e) {
    console.log('    HATA:', e.message);
    process.exit(2);
  }

  try {
    const r = await axios.post(
      `${CLERK}/v1/client/sessions/${sessionId}/tokens?_clerk_js_version=${JS_VER}`,
      {},
      {
        headers: { Cookie: `__client=${cookie}`, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 20000,
        validateStatus: () => true,
      }
    );
    jwt = r.data && r.data.jwt;
    console.log(`    token HTTP ${r.status} | JWT ${jwt ? 'alindi' : 'YOK'}`);
    const p = jwt ? decodeJwt(jwt) : null;
    if (p && p.exp) console.log('    JWT exp:', new Date(p.exp * 1000).toISOString());
  } catch (e) {
    console.log('    token HATA:', e.message);
    process.exit(2);
  }
  if (!jwt) process.exit(2);

  // --- 2) /api/c/check -----------------------------------------------------
  console.log('\n[2] POST /api/c/check { ctype: "generation" } ...');
  let required = null;
  let version = null;
  try {
    const r = await axios.post(
      `${STUDIO}/api/c/check`,
      { ctype: 'generation' },
      { headers: headers(jwt), timeout: 30000, validateStatus: () => true }
    );
    console.log(`    HTTP ${r.status}`, JSON.stringify(r.data));
    if (r.data) {
      required = r.data.required;
      version = r.data.captcha_version;
    }
  } catch (e) {
    console.log('    HATA:', e.message);
  }

  // --- 3) Captcha'siz generate --------------------------------------------
  console.log('\n[3] Captcha token OLMADAN generate denemesi ...');
  let genStatus = null;
  let genData = null;
  try {
    const r = await axios.post(
      `${STUDIO}/api/generate/v2-web/`,
      {
        prompt: 'diagnostic test',
        tags: '',
        title: 'diagnostic',
        make_instrumental: true,
        mv: 'chirp-goose',
        generation_type: 'TEXT',
      },
      { headers: headers(jwt), timeout: 60000, validateStatus: () => true }
    );
    genStatus = r.status;
    genData = r.data;
    console.log(`    HTTP ${r.status}`, JSON.stringify(r.data).slice(0, 400));
  } catch (e) {
    console.log('    HATA:', e.message);
  }

  // --- 4) Yorum ------------------------------------------------------------
  console.log('\n' + '='.repeat(66));
  console.log('YORUM');
  console.log('='.repeat(66));
  if (genStatus === 200 || genStatus === 201) {
    console.log('✅ Captcha GEREKMIYOR. Uretim bu hesapta calisiyor.');
  } else if (genStatus === 401) {
    console.log('⛔ 401 Unauthorized -> JWT/oturum sorunu. Yeni __client alin.');
  } else if (genStatus === 422) {
    const txt = JSON.stringify(genData || {});
    if (/verify your request|captcha/i.test(txt)) {
      console.log('🎯 TESHIS: CAPTCHA ZORUNLU.');
      console.log('   /api/c/check -> required:', required, '| captcha_version:', version);
      console.log('   JWT GECERLI (401 degil, 422). Sorun kimlik degil, eksik captcha cozumu.');
      console.log('   Cozum: SUNO_CAPTCHA_TOKEN (elle) veya CAPTCHA_SOLVER=capsolver + CAPSOLVER_API_KEY');
    } else {
      console.log('   422 ama captcha metni yok. Yaniti inceleyin:', txt.slice(0, 300));
    }
  } else if (genStatus === 402 || genStatus === 403) {
    console.log(`   ${genStatus} -> kredi/plan/model yetkisi. CAPTCHA meselesi degil.`);
  } else {
    console.log('   Beklenmeyen durum:', genStatus, JSON.stringify(genData).slice(0, 300));
  }
  console.log('');
}

main().catch((e) => {
  console.error('Beklenmeyen hata:', e.message);
  process.exit(1);
});
