'use strict';

/**
 * tests/peak-keys.test.js
 * -----------------------
 * peak.fo coklu anahtar: parse, sirali deneme, failover, sogutma.
 *   node tests/peak-keys.test.js
 */

const assert = require('assert');
const path = require('path');

// axios'u taklit et (ag cagrisi yok)
const Module = require('module');
const origLoad = Module._load;
const calls = [];
let behaviour = {};

Module._load = function (request, parent, isMain) {
  if (request === 'axios') {
    return {
      post: async (url, body, opts) => {
        const key = (opts && opts.headers && opts.headers['X-API-Key']) || '?';
        calls.push({ url, body, key });
        const b = behaviour[key] || {};
        if (b.throw) throw new Error(b.throw);
        return { status: b.status || 200, data: b.data || {} };
      },
      get: async (url, opts) => {
        const key = (opts && opts.headers && opts.headers['X-API-Key']) || '?';
        const b = behaviour[key] || {};
        return { status: 200, data: b.balance || { success: true, data: { balance: 0 } } };
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const captcha = require('../utils/captcha');

const ok = (token) => ({ status: 200, data: { success: true, data: { token } } });
const bad = (msg) => ({ status: 401, data: { success: false, error: msg || 'unauthorized' } });

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log(`  ✅ ${name}`);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function reset(env, beh) {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('PEAK_')) delete process.env[k];
  }
  Object.assign(process.env, env);
  behaviour = beh || {};
  calls.length = 0;
  captcha.resetPeakState();
}

(async () => {
  console.log('\n=== 1) Virgülle ayrılmış liste ayrıştırma ===');

  await check('virgül + boşluk + yeni satır + noktalı virgül', async () => {
    const list = captcha.parseKeyList('pk_a, pk_b;\npk_c  pk_d');
    assert.deepStrictEqual(list, ['pk_a', 'pk_b', 'pk_c', 'pk_d']);
  });

  await test_keys();
})();

async function test_keys() {
  console.log('\n=== 2) PEAK_API_KEYS (çoğul) okuma ===');

  await check('PEAK_API_KEYS virgüllü -> 3 anahtar', async () => {
    reset({ PEAK_API_KEYS: 'pk_aaa,pk_bbb,pk_ccc' });
    assert.deepStrictEqual(captcha.peakKeys(), ['pk_aaa', 'pk_bbb', 'pk_ccc']);
  });

  await check('PEAK_API_KEY (tekil) hâlâ çalışıyor', async () => {
    reset({ PEAK_API_KEY: 'pk_solo' });
    assert.deepStrictEqual(captcha.peakKeys(), ['pk_solo']);
  });

  await check('PEAK_API_KEY_1..3 numaralı varyant', async () => {
    reset({ PEAK_API_KEY_1: 'pk_1', PEAK_API_KEY_2: 'pk_2', PEAK_API_KEY_3: 'pk_3' });
    assert.deepStrictEqual(captcha.peakKeys(), ['pk_1', 'pk_2', 'pk_3']);
  });

  await check('tekrarlar temizleniyor, sıra korunuyor', async () => {
    reset({ PEAK_API_KEYS: 'pk_a,pk_b,pk_a', PEAK_API_KEY: 'pk_b' });
    assert.deepStrictEqual(captcha.peakKeys(), ['pk_a', 'pk_b']);
  });

  await check('boş env -> 0 anahtar', async () => {
    reset({});
    assert.deepStrictEqual(captcha.peakKeys(), []);
  });

  await check('maskeleme anahtarı sızdırmıyor', async () => {
    const m = captcha.maskKey('pk_dc1452d9472fbcfc9a8cd6ebc54dd358e1eab49c1d4e361a');
    assert.ok(!m.includes('d9472fbcfc'), 'ortası gizlenmeli');
    assert.ok(m.startsWith('pk_dc14'));
    assert.ok(m.endsWith('361a'));
  });

  console.log('\n=== 3) Sıralı deneme / failover ===');

  await check('ilk anahtar çalışırsa diğerlerine hiç gidilmez', async () => {
    reset({ PEAK_API_KEYS: 'pk_a,pk_b,pk_c' }, { pk_a: ok('TOKEN_A') });
    const t = await captcha.getCaptchaToken({
      sunoRequest: async () => ({ required: true, captcha_version: 2 }),
    });
    assert.strictEqual(t.token, 'TOKEN_A');
    assert.strictEqual(calls.length, 1, 'tek çağrı bekleniyordu');
    assert.strictEqual(calls[0].key, 'pk_a');
  });

  await check('1. anahtar 401 -> 2. anahtara geçer', async () => {
    reset(
      { PEAK_API_KEYS: 'pk_a,pk_b' },
      { pk_a: bad('invalid api key'), pk_b: ok('TOKEN_B') }
    );
    const t = await captcha.getCaptchaToken({
      sunoRequest: async () => ({ required: true, captcha_version: 2 }),
    });
    assert.strictEqual(t.token, 'TOKEN_B');
    assert.deepStrictEqual(calls.map((c) => c.key), ['pk_a', 'pk_b']);
  });

  await check('1+2 bakiye bitti -> 3. çalışır', async () => {
    reset(
      { PEAK_API_KEYS: 'pk_a,pk_b,pk_c' },
      {
        pk_a: { status: 200, data: { success: false, error: 'insufficient balance' } },
        pk_b: { status: 402, data: { success: false, error: 'payment required' } },
        pk_c: ok('TOKEN_C'),
      }
    );
    const t = await captcha.getCaptchaToken({
      sunoRequest: async () => ({ required: true, captcha_version: 2 }),
    });
    assert.strictEqual(t.token, 'TOKEN_C');
    assert.deepStrictEqual(calls.map((c) => c.key), ['pk_a', 'pk_b', 'pk_c']);
  });

  await check('ağ hatası (throw) -> sonrakine geçer', async () => {
    reset({ PEAK_API_KEYS: 'pk_a,pk_b' }, { pk_a: { throw: 'ECONNRESET' }, pk_b: ok('T') });
    const t = await captcha.getCaptchaToken({
      sunoRequest: async () => ({ required: true, captcha_version: 2 }),
    });
    assert.strictEqual(t.token, 'T');
  });

  await check('HEPSİ başarısız -> anlamlı hata', async () => {
    reset(
      { PEAK_API_KEYS: 'pk_a,pk_b' },
      { pk_a: bad('bad'), pk_b: bad('also bad') }
    );
    let err = null;
    try {
      await captcha.getCaptchaToken({
        sunoRequest: async () => ({ required: true, captcha_version: 2 }),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'hata bekleniyordu');
    assert.ok(/hepsi basarisiz/.test(err.message), err.message);
    assert.ok(/pk_a/.test(err.message) && /pk_b/.test(err.message), 'iki anahtar da raporda olmalı');
  });

  await check('sadece 1 anahtar ve o da bozuk -> hata', async () => {
    reset({ PEAK_API_KEY: 'pk_only' }, { pk_only: bad() });
    let err = null;
    try {
      await captcha.getCaptchaToken({
        sunoRequest: async () => ({ required: true, captcha_version: 2 }),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err && /hepsi basarisiz/.test(err.message));
  });

  console.log('\n=== 4) Sıralama: soğumadaki anahtar sona atılır ===');
  await check('401 alan anahtar 2. istekte en sona düşer', async () => {
    reset({ PEAK_API_KEYS: 'pk_bad,pk_good' }, { pk_bad: bad(), pk_good: ok('T1') });
    const suno = async () => ({ required: true, captcha_version: 2 });
    await captcha.getCaptchaToken({ sunoRequest: suno }); // pk_bad patlar, pk_good çalışır
    const before = calls.length;
    calls.length = 0;
    // Simdi pk_good'u boz, sadece pk_bad kaldi -> sogumada oldugu icin once pk_bad yine denenir ama sirasi degisir
    behaviour = { pk_good: ok('T2'), pk_bad: bad() };
    const t = await captcha.getCaptchaToken({ sunoRequest: suno });
    assert.strictEqual(t.token, 'T2');
    assert.strictEqual(calls[0].key, 'pk_good', 'saglikli anahtar once denenmeli');
  });

  console.log('\n=== 5) Bakiye: tüm anahtarlar toplanıyor ===');
  await check('3 anahtarın bakiyesi toplanır', async () => {
    reset(
      { PEAK_API_KEYS: 'pk_a,pk_b,pk_c' },
      {
        pk_a: { balance: { success: true, data: { balance: 1.5 } } },
        pk_b: { balance: { success: true, data: { balance: 2.25 } } },
        pk_c: { balance: { success: true, data: { balance: 0.9 } } },
      }
    );
    const b = await captcha.peakBalance();
    assert.strictEqual(b.count, 3);
    assert.strictEqual(b.total_balance, 4.65);
    assert.strictEqual(b.keys.length, 3);
  });

  console.log('\n=== SONUÇ ===');
  const failed = results.filter((r) => r[0] === 'FAIL');
  console.log(`${results.length - failed.length}/${results.length} test geçti.`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - ${f[1]}: ${f[2]}`));
    process.exit(1);
  }
}
