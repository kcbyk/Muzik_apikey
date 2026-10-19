'use strict';

/**
 * tools/test-signer.js
 * ----------------------------------------------------------------------------
 *  utils/signer.js + utils/signerPool.js icin birim testleri.
 *  Calistirma:  node tools/test-signer.js
 *  Cikti: her kontrol icin [OK]/[FAIL] ve sonda ozet. Exit code 1 = hata.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const assert = require('assert');
const signer = require('../utils/signer');
const { SignerPool } = require('../utils/signerPool');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`[OK]   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`[FAIL] ${name} -> ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`[OK]   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`[FAIL] ${name} -> ${err.message}`);
  }
}

const CLIP = 'afaea7cd-244b-4b00-9a5b-93152f74d285';
const NOW = 1792384000000; // sabit zaman -> deterministik test

// ---------------------------------------------------------------------------
// 1. SPEC PARSER
// ---------------------------------------------------------------------------
check('parseSpec: gecerli atamalar', () => {
  const p = signer.parseSpec('sig=hmac_sha256_hex({id},{secret});ts={ts}');
  assert.strictEqual(p.ok, true);
  assert.deepStrictEqual(p.assignments.map((a) => a.key), ['sig', 'ts']);
});

check('parseSpec: bos spec -> atama yok', () => {
  const p = signer.parseSpec('');
  assert.strictEqual(p.assignments.length, 0);
});

check('parseSpec: bozuk atama hata dondurur (throw etmez)', () => {
  const p = signer.parseSpec('burada-esittir-yok');
  assert.strictEqual(p.ok, false);
  assert.ok(p.errors.length > 0);
});

check('parseSpec: 12 parametre siniri', () => {
  const spec = Array.from({ length: 20 }, (_v, i) => `p${i}=${i}`).join(';');
  const p = signer.parseSpec(spec);
  assert.ok(p.assignments.length <= 12);
});

// ---------------------------------------------------------------------------
// 2. TURETIM DOGRULUGU
// ---------------------------------------------------------------------------
check('deriveParams: hmac_sha256_hex Node crypto ile birebir', () => {
  const r = signer.deriveParams('sig=hmac_sha256_hex({id}|{ts},{secret});ts={ts};expires={ts_plus:300}', {
    clipId: CLIP,
    now: NOW,
    secret: 'topsecret',
  });
  const expected = crypto.createHmac('sha256', 'topsecret').update(`${CLIP}|1792384000`).digest('hex');
  assert.strictEqual(r.params.sig, expected);
  assert.strictEqual(r.params.ts, '1792384000');
  assert.strictEqual(r.params.expires, '1792384300');
});

check('deriveParams: sha256_hex / md5_hex dogru', () => {
  const r = signer.deriveParams('a=sha256_hex({id});b=md5_hex({id})', { clipId: CLIP, now: NOW });
  assert.strictEqual(r.params.a, crypto.createHash('sha256').update(CLIP).digest('hex'));
  assert.strictEqual(r.params.b, crypto.createHash('md5').update(CLIP).digest('hex'));
});

check('deriveParams: ic ice fonksiyon (upper(sha256_hex(...)))', () => {
  const r = signer.deriveParams('k=upper(sha256_hex({id}))', { clipId: CLIP, now: NOW });
  assert.strictEqual(r.params.k, crypto.createHash('sha256').update(CLIP).digest('hex').toUpperCase());
});

check('deriveParams: tirnakli literal', () => {
  const r = signer.deriveParams("v='sabit-deger'", { clipId: CLIP });
  assert.strictEqual(r.params.v, 'sabit-deger');
});

check('deriveParams: cookie token', () => {
  const r = signer.deriveParams('c={cookie:__client}', {
    clipId: CLIP,
    cookieHeader: '__client=abc.def.ghi; suno_device_id=xyz',
  });
  assert.strictEqual(r.params.c, 'abc.def.ghi');
});

check('deriveParams: query token (istemciden gelen deger)', () => {
  const r = signer.deriveParams('q={query:sig}', { clipId: CLIP, query: { sig: 'gelen-imza' } });
  assert.strictEqual(r.params.q, 'gelen-imza');
});

check('deriveParams: bilinmeyen token -> bos string (URL bozulmaz)', () => {
  const r = signer.deriveParams('z={bilinmeyen}', { clipId: CLIP });
  assert.strictEqual(r.params.z, '');
});

check('deriveParams: hatali fonksiyon -> errors, throw yok', () => {
  const r = signer.deriveParams('x=olmayan_fn({id})', { clipId: CLIP });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /Bilinmeyen fonksiyon/.test(e)));
});

check('deriveParams: eksik arguman yakalanir', () => {
  const r = signer.deriveParams('x=hmac_sha256_hex({id})', { clipId: CLIP });
  assert.strictEqual(r.ok, false);
});

check('deriveParams: bos spec -> params bos', () => {
  const r = signer.deriveParams('', { clipId: CLIP });
  assert.deepStrictEqual(r.params, {});
  assert.strictEqual(r.empty, true);
});

check('deriveParams: 2048 bayt deger siniri', () => {
  const r = signer.deriveParams('big=sha256_hex({env:PATH})', { clipId: CLIP });
  assert.ok(String(r.params.big).length <= 2048);
});

// ---------------------------------------------------------------------------
// 3. URL INSAASI / MASKELEME
// ---------------------------------------------------------------------------
check('buildSignedUrl: parametreleri ekler, mevcutlari ezer', () => {
  const u = signer.buildSignedUrl('https://audiopipe.suno.ai/?item_id=abc&format=mp3', {
    item_id: 'abc',
    sig: 'deadbeef',
    expires: '1792384300',
  });
  assert.ok(u.includes('sig=deadbeef'));
  assert.ok(u.includes('expires=1792384300'));
  assert.ok(u.includes('format=mp3'));
});

check('buildSignedUrl: bos deger atlanir', () => {
  const u = signer.buildSignedUrl('https://x.test/?a=1', { sig: '', b: null });
  assert.ok(!u.includes('sig='));
  assert.ok(!u.includes('b='));
});

check('buildSignedUrl: gecersiz URL -> aynen doner', () => {
  assert.strictEqual(signer.buildSignedUrl('not a url', { a: 1 }), 'not a url');
});

check('redactUrl: imza degeri kisaltilir', () => {
  const r = signer.redactUrl('https://x.test/?sig=abcdef123456&id=1');
  assert.ok(!r.includes('abcdef123456'));
  assert.ok(r.includes('id=1'));
});

check('redactParams: sig/token maskelenir, expires gorunur', () => {
  const r = signer.redactParams({ sig: 'abcdef123456', expires: '1792384300' });
  assert.ok(r.sig.length < 20);
  assert.strictEqual(r.expires, '1792384300');
});

// ---------------------------------------------------------------------------
// 4. TOKEN CACHE POOL
// ---------------------------------------------------------------------------
async function poolTests() {
  await checkAsync('pool: put/get ve stats', async () => {
    const pool = new SignerPool({ ttlMs: 10000, max: 10 });
    pool.put('clip:1', { sig: 'a' }, { source: 'test' });
    assert.deepStrictEqual(pool.get('clip:1'), { sig: 'a' });
    const s = pool.stats_();
    assert.strictEqual(s.size, 1);
    assert.strictEqual(s.counters.hits, 1);
  });

  await checkAsync('pool: TTL dolunca kayit dusuyor', async () => {
    const pool = new SignerPool({ ttlMs: 5 });
    pool.put('clip:2', { sig: 'b' });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(pool.get('clip:2'), null);
    assert.strictEqual(pool.stats_().counters.expired, 1);
  });

  await checkAsync('pool: single-flight (es zamanli 20 istek -> 1 tazeleme)', async () => {
    let calls = 0;
    const pool = new SignerPool({ ttlMs: 5000 });
    pool.setRefresher(async (key) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { sig: `sig-for-${key}` };
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => pool.getOrRefresh('clip:3')));
    assert.strictEqual(calls, 1);
    assert.ok(results.every((r) => r && r.sig === 'sig-for-clip:3'));
  });

  await checkAsync('pool: refresher hata verirse null (throw yok)', async () => {
    const pool = new SignerPool({ ttlMs: 1000 });
    pool.setRefresher(async () => {
      throw new Error('upstream down');
    });
    const r = await pool.getOrRefresh('clip:4');
    assert.strictEqual(r, null);
    assert.strictEqual(pool.stats_().counters.refresh_failures, 1);
  });

  await checkAsync('pool: max siniri -> LRU tahliye', async () => {
    const pool = new SignerPool({ ttlMs: 60000, max: 3 });
    for (let i = 0; i < 6; i += 1) {
      pool.put(`k${i}`, { sig: `v${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }
    const s = pool.stats_();
    assert.strictEqual(s.size, 3);
    assert.ok(s.counters.evictions >= 3);
  });

  await checkAsync('pool: sweep + clear', async () => {
    const pool = new SignerPool({ ttlMs: 5 });
    pool.put('a', { sig: '1' });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(await pool.sweep(), 1);
    pool.put('b', { sig: '2' });
    pool.clear();
    assert.strictEqual(pool.stats_().size, 0);
  });
}

(async () => {
  await poolTests();
  console.log(`\nToplam: ${pass} OK, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})();
