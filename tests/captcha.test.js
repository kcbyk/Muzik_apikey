'use strict';

/**
 * tests/captcha.test.js
 * ---------------------
 * Suno üretim captcha katmanının doğrulama testi.
 *   node tests/captcha.test.js
 */

const assert = require('assert');

process.env.SUNO_CAPTCHA_ENABLED = 'true';
delete process.env.SUNO_CAPTCHA_TOKEN;
delete process.env.CAPSOLVER_API_KEY;
delete process.env.TWOCAPTCHA_API_KEY;
delete process.env.CAPTCHA_SOLVER;

const captcha = require('../utils/captcha');
const sunoProvider = require('../providers/suno');

const results = [];
function check(name, fn) {
  return fn().then(
    () => {
      results.push(['PASS', name]);
      console.log(`  ✅ ${name}`);
    },
    (e) => {
      results.push(['FAIL', name, e.message]);
      console.log(`  ❌ ${name}: ${e.message}`);
    }
  );
}

(async () => {
  console.log('\n=== 1) /api/c/check yanıtlarına göre davranış ===');

  await check('required:false -> token istenmez, hata yok', async () => {
    const fake = async (method, path, body) => {
      assert.strictEqual(path, '/api/c/check');
      assert.deepStrictEqual(body, { ctype: 'generation' });
      return { required: false, captcha_version: 1 };
    };
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.required, false);
    assert.strictEqual(r.token, null);
    assert.strictEqual(r.source, 'not-required');
  });

  await check('required:true + çözücü yok -> token null, CAPTCHA_REQUIRED', async () => {
    const fake = async () => ({ required: true, captcha_version: 1 });
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.token, null);
    assert.strictEqual(r.source, 'unavailable');
    assert.strictEqual(r.preferred, 'turnstile');
  });

  await check('gerekli + SUNO_CAPTCHA_TOKEN -> elle çözüm kullanılır', async () => {
    process.env.SUNO_CAPTCHA_TOKEN = 'MANUAL_TOKEN_123';
    const fake = async () => ({ required: true, captcha_version: 1 });
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.token, 'MANUAL_TOKEN_123');
    assert.strictEqual(r.source, 'env');
    delete process.env.SUNO_CAPTCHA_TOKEN;
  });

  await check('/api/c/check hata verirse fail-closed (gerekli varsayar)', async () => {
    const fake = async () => {
      const e = new Error('network');
      e.status = 500;
      throw e;
    };
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.required, true);
  });

  console.log('\n=== 2) Sürüm → sağlayıcı eşlemesi ===');
  await check('captcha_version=1 -> turnstile', async () => {
    const fake = async () => ({ required: true, captcha_version: 1 });
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.preferred, 'turnstile');
  });
  await check('captcha_version=0 -> hcaptcha', async () => {
    const fake = async () => ({ required: true, captcha_version: 0 });
    const r = await captcha.getCaptchaToken({ sunoRequest: fake });
    assert.strictEqual(r.preferred, 'hcaptcha');
  });

  console.log('\n=== 3) provider/suno.js — gövdeye token enjeksiyonu ===');

  await check('captcha çözülünce generate gövdesine token + token_provider eklenir', async () => {
    process.env.SUNO_CAPTCHA_TOKEN = 'SOLVED_TOKEN';
    let sentBody = null;
    sunoProvider.init({
      async getCaptchaToken() {
        return { required: true, token: 'SOLVED_TOKEN', provider: 1, source: 'env' };
      },
      sunoRequest: async (method, path, body) => {
        sentBody = body;
        return { clips: [{ id: 'clip_1', status: 'queued' }] };
      },
      generatePath: '/api/generate/v2-web/',
      modelFallback: ['chirp-goose'],
      defaultModel: 'chirp-goose',
      defaultInstrumental: true,
      normalizeClip: (c) => c,
      accountPool: { size: () => 0, getAvailableAccounts: () => [], getActiveAccount: () => null },
      isCreditExhaustedError: () => false,
      log: () => {},
    });
    const out = await sunoProvider.generate({ prompt: 'test', title: 'T', instrumental: true });
    assert.deepStrictEqual(out.clip_ids, ['clip_1']);
    assert.strictEqual(sentBody.token, 'SOLVED_TOKEN');
    assert.strictEqual(sentBody.token_provider, 1);
    delete process.env.SUNO_CAPTCHA_TOKEN;
  });

  await check('captcha çözülemezse CAPTCHA_REQUIRED (428) fırlatır, istek atmaz', async () => {
    let called = false;
    sunoProvider.init({
      async getCaptchaToken() {
        return { required: true, token: null, provider: 1, source: 'unavailable', preferred: 'turnstile' };
      },
      sunoRequest: async () => {
        called = true;
        return { clips: [] };
      },
      generatePath: '/api/generate/v2-web/',
      modelFallback: ['chirp-goose'],
      defaultModel: 'chirp-goose',
      defaultInstrumental: true,
      normalizeClip: (c) => c,
      accountPool: { size: () => 0, getAvailableAccounts: () => [], getActiveAccount: () => null },
      isCreditExhaustedError: () => false,
      log: () => {},
    });
    let err = null;
    try {
      await sunoProvider.generate({ prompt: 'x' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'hata bekleniyordu');
    assert.strictEqual(err.code, 'CAPTCHA_REQUIRED');
    assert.strictEqual(err.status, 428);
    assert.strictEqual(called, false, 'upstream çağrısı yapılmamalı');
  });

  await check('captcha gerekmiyorsa token alanları gönderilmez', async () => {
    let sentBody = null;
    sunoProvider.init({
      async getCaptchaToken() {
        return { required: false, token: null, provider: null, source: 'not-required' };
      },
      sunoRequest: async (m, p, body) => {
        sentBody = body;
        return { clips: [{ id: 'c2' }] };
      },
      generatePath: '/g',
      modelFallback: ['chirp-goose'],
      defaultModel: 'chirp-goose',
      defaultInstrumental: true,
      normalizeClip: (c) => c,
      accountPool: { size: () => 0, getAvailableAccounts: () => [], getActiveAccount: () => null },
      isCreditExhaustedError: () => false,
      log: () => {},
    });
    await sunoProvider.generate({ prompt: 'x' });
    assert.strictEqual('token' in sentBody, false);
    assert.strictEqual('token_provider' in sentBody, false);
  });

  await check('422 "couldn\'t verify" -> hesap exhausted işaretlenmez', async () => {
    let marked = 0;
    sunoProvider.init({
      async getCaptchaToken() {
        return { required: false, token: null, provider: null, source: 'not-required' };
      },
      sunoRequest: async () => {
        const e = new Error('Suno API hatasi (HTTP 422)');
        e.status = 422;
        e.detail =
          '{"status_code":422,"detail":"We couldn\'t verify your request. Please refresh the page and try again.","error_type":"token_validation_failed"}';
        throw e;
      },
      generatePath: '/g',
      modelFallback: ['chirp-goose'],
      defaultModel: 'chirp-goose',
      defaultInstrumental: true,
      normalizeClip: (c) => c,
      accountPool: {
        size: () => 1,
        getAvailableAccounts: () => [{ id: 'account_1' }],
        getActiveAccount: () => ({ id: 'account_1' }),
        markAccountExhausted: () => {
          marked += 1;
        },
      },
      isCreditExhaustedError: () => false,
      log: () => {},
    });
    let err = null;
    try {
      await sunoProvider.generate({ prompt: 'x' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'hata bekleniyordu');
    assert.strictEqual(err.code, 'CAPTCHA_REQUIRED');
    assert.strictEqual(marked, 0, 'hesap exhausted işaretlenmemeli');
  });

  console.log('\n=== SONUÇ ===');
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`${results.length - failed.length}/${results.length} test geçti.`);
  if (failed.length) {
    console.log('\nBaşarısızlar:');
    failed.forEach((f) => console.log(`  - ${f[1]}: ${f[2]}`));
    process.exit(1);
  }
})();
