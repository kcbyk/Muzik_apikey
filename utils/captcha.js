'use strict';

/**
 * SUNO URETIM CAPTCHA COZUMU
 * ==========================
 *
 * KANIT (suno.com web bundle'i, 20 Eki 2026)
 * ------------------------------------------
 * Tarayici, uretimden ONCE su cagriyi yapiyor:
 *
 *     POST /api/c/check   { ctype: "generation" }
 *       -> { required: true|false, captcha_version: <sayi> }
 *
 * `required === true` ise ekranda Turnstile/hCaptcha widget'i mount edilip
 * token aliniyor ve generate govdesine su iki alan ekleniyor:
 *
 *     { ..., token: "<captcha cozumu>", token_provider: <captcha_version> }
 *
 * Proxy bu iki alani hic gondermedigi icin Suno:
 *
 *     422 {"error_type":"token_validation_failed",
 *          "detail":"We couldn't verify your request. Please refresh the page and try again.",
 *          "retryable":false}
 *
 * donduruyor. Mesaj "token" dedigi icin JWT hatasi saniliyor; **aslinda JWT
 * degil, eksik captcha cozumu**. Bu yuzden token'i yenilemek hicbir ise
 * yaramiyor (feed/download calisiyor, sadece generate reddediliyor).
 *
 * COZUM SIRASI
 * ------------
 *   1) SUNO_CAPTCHA_TOKEN  : elle alinmis cozum (kisa omurlu, test icin)
 *   2) CAPTCHA_SOLVER     : capsolver | 2captcha  (otomatik cozum servisi)
 *   3) hicbiri yoksa      : CAPTCHA_REQUIRED hatasi (net mesaj, yaniltmiyor)
 */

const axios = require('axios');

/* ---------------------------------------------------------------------------
 * Suno'nun bundle'indan cikarilan site anahtarlari
 * ------------------------------------------------------------------------- */
const DEFAULT_SITEKEYS = {
  // 0x4AAAAAADI7xDNyj-3LcIbi = NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY_GEN
  //   (suno.com bundle'i: SITE_KEY_GEN = "uretim" captcha'si -> dogru olan bu)
  // 0x4AAAAAABd64Cd9aq5C--VE = genel SITE_KEY
  // 0x4AAAAAABtnpJo7aKMs9JLQ = SITE_KEY_AUTH (giris)
  turnstile: ['0x4AAAAAADI7xDNyj-3LcIbi', '0x4AAAAAABd64Cd9aq5C--VE', '0x4AAAAAABtnpJo7aKMs9JLQ'],
  hcaptcha: ['client-DaZjubWc7zwnZ5o2EEJhqt4UYRzYRoUuHbTQcIH9Ybq'],
};

const SOLVER_TIMEOUT_MS = Number(process.env.CAPTCHA_SOLVER_TIMEOUT_MS || 120000);
const SOLVER_POLL_MS = Number(process.env.CAPTCHA_SOLVER_POLL_MS || 2500);

/** "0:hcaptcha,1:turnstile" -> { 0:'hcaptcha', 1:'turnstile' } */
function parseVersionMap(raw) {
  const map = {};
  // Suno 20 Eki 2026 itibariyla captcha_version: 2 donduruyor (Turnstile).
  String(raw || '0:hcaptcha,1:turnstile,2:turnstile')
    .split(',')
    .forEach((pair) => {
      const [k, v] = pair.split(':').map((s) => (s || '').trim());
      if (k !== '' && v) map[Number(k)] = v.toLowerCase();
    });
  return map;
}

const VERSION_MAP = parseVersionMap(process.env.SUNO_CAPTCHA_VERSION_MAP);

/* ---------------------------------------------------------------------------
 * Calisma zamaninda elle verilen cozum (POST /auth/captcha-token)
 * Turnstile/hCaptcha cozumleri tek kullanimlik ve ~2-5 dk omurludur.
 * ------------------------------------------------------------------------- */
let runtimeToken = null; // { token, provider, expiresAt, source }

function setRuntimeToken(token, provider = null, ttlSeconds = 300) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('token bos olamaz');
  const ttl = Math.max(10, Math.min(3600, Number(ttlSeconds) || 300));
  runtimeToken = {
    token: clean,
    provider,
    expiresAt: Date.now() + ttl * 1000,
    source: 'runtime',
  };
  return { ...runtimeToken, token: `${clean.slice(0, 8)}...` };
}

function getRuntimeToken() {
  if (!runtimeToken) return null;
  if (Date.now() >= runtimeToken.expiresAt) {
    runtimeToken = null;
    return null;
  }
  return runtimeToken;
}

function clearRuntimeToken() {
  runtimeToken = null;
}

/** Yapilandirilmis cozum servisi var mi? */
function solverName() {
  const forced = String(process.env.CAPTCHA_SOLVER || '').trim().toLowerCase();
  if (forced === 'peak' || forced === 'peakfo' || forced === 'peak.fo') return 'peak';
  if (forced === 'capsolver' || forced === '2captcha') return forced;
  if (forced === 'none' || forced === 'off' || forced === '') {
    // otomatik algila (peak oncelikli: en hizli + en ekonomik)
    if (peakKeys().length > 0) return 'peak';
    if (String(process.env.CAPSOLVER_API_KEY || '').trim()) return 'capsolver';
    if (String(process.env.TWOCAPTCHA_API_KEY || '').trim()) return '2captcha';
  }
  return null;
}

function siteKeyFor(provider) {
  const envKey =
    provider === 'turnstile'
      ? process.env.SUNO_TURNSTILE_SITEKEY
      : process.env.SUNO_HCAPTCHA_SITEKEY;
  if (String(envKey || '').trim()) return String(envKey).trim();
  const list = DEFAULT_SITEKEYS[provider] || [];
  return list[0] || '';
}

function pageUrl() {
  return String(process.env.SUNO_CAPTCHA_PAGE_URL || 'https://suno.com/create').trim();
}

/* ---------------------------------------------------------------------------
 * Cozum servisleri
 * ------------------------------------------------------------------------- */

async function solveWithCapSolver(provider, sitekey) {
  const clientKey = String(process.env.CAPSOLVER_API_KEY || '').trim();
  if (!clientKey) throw new Error('CAPSOLVER_API_KEY bos');

  const taskType =
    provider === 'turnstile' ? 'AntiTurnstileTaskProxyLess' : 'HCaptchaTaskProxyLess';

  const create = await axios.post(
    'https://api.capsolver.com/createTask',
    {
      clientKey,
      task: {
        type: taskType,
        websiteURL: pageUrl(),
        websiteKey: sitekey,
        ...(provider === 'hcaptcha' ? { isInvisible: false } : {}),
      },
    },
    { timeout: 30000, validateStatus: () => true }
  );

  if (!create.data || create.data.errorId) {
    throw new Error(`CapSolver createTask: ${JSON.stringify(create.data).slice(0, 300)}`);
  }
  const taskId = create.data.taskId;
  if (!taskId) throw new Error('CapSolver taskId alinamadi');

  const deadline = Date.now() + SOLVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, SOLVER_POLL_MS));
    // eslint-disable-next-line no-await-in-loop
    const res = await axios.post(
      'https://api.capsolver.com/getTaskResult',
      { clientKey, taskId },
      { timeout: 30000, validateStatus: () => true }
    );
    const d = res.data || {};
    if (d.errorId) throw new Error(`CapSolver getTaskResult: ${JSON.stringify(d).slice(0, 300)}`);
    if (d.status === 'ready' && d.solution && d.solution.token) return d.solution.token;
  }
  throw new Error('CapSolver zaman asimi');
}

/* ---------------------------------------------------------------------------
 * peak.fo — Cloudflare Turnstile cozucusu (COKLU ANAHTAR DESTEKLI)
 * ---------------------------------------------------------------------------
 * POST https://api.peak.fo/solve
 *   { task_type: "TurnstileTaskProxyLess", sitekey, url }
 *   -> { success: true, data: { token: "0.xxx" } }
 * Auth: X-API-Key: pk_...
 *
 * ANAHTAR EKLEME (virgul / yeni satir / noktali virgul ile):
 *   PEAK_API_KEYS=pk_aaa,pk_bbb,pk_ccc
 *   PEAK_API_KEY=pk_aaa          (tek anahtar icin geriye uyumlu)
 *   PEAK_API_KEY_1=pk_aaa        (numarali varyant, _2 .. _10)
 *
 * Anahtar sirasiyla denenir: bakiye bitmis / gecersiz / hata veren anahtar
 * atlanip bir sonrakine gecilir. Hepsi biterse son hata firlatilir.
 * ------------------------------------------------------------------------- */

/** Ham metni anahtar listesine cevirir (virgul, noktali virgul, yeni satir). */
function parseKeyList(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Tanimli tum peak anahtarlari (tekrarsiz, sira korunur). */
function peakKeys() {
  const out = [];
  const push = (v) => {
    for (const k of parseKeyList(v)) if (!out.includes(k)) out.push(k);
  };
  push(process.env.PEAK_API_KEYS);
  push(process.env.PEAK_API_KEY);
  for (let i = 1; i <= 10; i += 1) push(process.env[`PEAK_API_KEY_${i}`]);
  return out;
}

/** Loglarda anahtari maskele: pk_dc14...e361a */
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 12) return `${s.slice(0, 4)}...`;
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

/** Anahtar basi durum (teshis icin). */
const peakKeyState = new Map(); // key -> { failures, lastError, lastUsedAt, exhaustedUntil }

/** Anahtar durumlarini (sogutma/sayac) sifirla. */
function resetPeakState() {
  peakKeyState.clear();
}

function peakKeyStatus() {
  return peakKeys().map((k, i) => {
    const st = peakKeyState.get(k) || {};
    return {
      index: i,
      key: maskKey(k),
      failures: st.failures || 0,
      lastError: st.lastError || null,
      lastUsedAt: st.lastUsedAt ? new Date(st.lastUsedAt).toISOString() : null,
      coolingDown: Boolean(st.cooldownUntil && Date.now() < st.cooldownUntil),
    };
  });
}

/** Bakiye/anahtar hatasi mi? (diger anahtara gec) */
function isKeyLevelFailure(status, data) {
  if (status === 401 || status === 403 || status === 402) return true;
  const txt = JSON.stringify(data || {}).toLowerCase();
  return /insufficient|balance|quota|unauthorized|invalid api key|exceeded/.test(txt);
}

/**
 * Tek anahtarla cozum dener.
 * @returns {Promise<{token:string}>}
 */
async function peakSolveOnce(apiKey, provider, sitekey, log) {
  const base = String(process.env.PEAK_BASE_URL || 'https://api.peak.fo').replace(/\/+$/, '');
  const target = pageUrl();
  const url = target.endsWith('/') ? target : `${target}/`;

  if (provider !== 'turnstile') {
    throw new Error(`peak.fo ${provider} desteklemiyor (yalnizca turnstile)`);
  }

  const proxy = String(process.env.PEAK_PROXY || '').trim();
  const body = {
    task_type: proxy ? 'turnstiletask' : 'TurnstileTaskProxyLess',
    sitekey,
    url,
  };
  if (proxy) body.proxy = proxy;

  const action = String(process.env.SUNO_TURNSTILE_ACTION || '').trim();
  if (action) body.action = action;
  const cdata = String(process.env.SUNO_TURNSTILE_CDATA || '').trim();
  if (cdata) body.cdata = cdata;

  const res = await axios.post(`${base}/solve`, body, {
    timeout: SOLVER_TIMEOUT_MS,
    validateStatus: () => true,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
  });

  const d = res.data || {};
  if (res.status !== 200 || d.success !== true) {
    const err = new Error(`peak.fo ${res.status}: ${JSON.stringify(d).slice(0, 200)}`);
    err.status = res.status;
    err.keyLevel = isKeyLevelFailure(res.status, d);
    throw err;
  }
  const token = d.data && d.data.token;
  if (!token) throw new Error('peak.fo token dondurmedi');
  return { token };
}

/** Coklu anahtar: sirayla dene, key-level hatada sonrakine gec. */
async function solveWithPeak(provider, sitekey, log) {
  const keys = peakKeys();
  if (!keys.length) throw new Error('PEAK_API_KEY(S) bos');

  const errors = [];
  // Sogumada olmayanlari one al
  const ordered = keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => {
      const ca = peakKeyState.get(a.k)?.cooldownUntil || 0;
      const cb = peakKeyState.get(b.k)?.cooldownUntil || 0;
      const na = ca > Date.now() ? 1 : 0;
      const nb = cb > Date.now() ? 1 : 0;
      return na - nb || a.i - b.i;
    });

  for (let n = 0; n < ordered.length; n += 1) {
    const { k, i } = ordered[n];
    try {
      if (log) log('info', `[captcha] peak anahtar #${i + 1}/${keys.length} (${maskKey(k)}) deneniyor...`);
      const { token } = await peakSolveOnce(k, provider, sitekey, log);
      const st = peakKeyState.get(k) || {};
      peakKeyState.set(k, { ...st, failures: 0, lastError: null, lastUsedAt: Date.now(), cooldownUntil: 0 });
      if (log) log('info', `[captcha] peak anahtar #${i + 1} basarili.`);
      return token;
    } catch (err) {
      const st = peakKeyState.get(k) || {};
      peakKeyState.set(k, {
        ...st,
        failures: (st.failures || 0) + 1,
        lastError: err.message,
        lastUsedAt: Date.now(),
        // key-level hatada 90 sn sogut, ag hatasinda 15 sn
        cooldownUntil: Date.now() + (err.keyLevel ? 90000 : 15000),
      });
      errors.push(`#${i + 1} ${maskKey(k)}: ${err.message}`);
      if (log) log('warn', `[captcha] peak anahtar #${i + 1} basarisiz: ${err.message}`);
      if (!err.keyLevel) continue; // ag hatasi -> digerini de dene
    }
  }

  throw new Error(`peak.fo: ${keys.length} anahtarin hepsi basarisiz -> ${errors.join(' | ')}`);
}

/** peak.fo bakiye sorgusu — TUM anahtarlar icin. */
async function peakBalance(log) {
  const keys = peakKeys();
  if (!keys.length) return null;
  const base = String(process.env.PEAK_BASE_URL || 'https://api.peak.fo').replace(/\/+$/, '');
  const out = [];
  let total = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await axios.get(`${base}/balance`, {
        timeout: 20000,
        validateStatus: () => true,
        headers: { 'X-API-Key': k },
      });
      const d = res.data || {};
      const bal = d.data && typeof d.data.balance === 'number' ? d.data.balance : null;
      if (bal !== null) total += bal;
      out.push({ index: i, key: maskKey(k), ok: d.success === true, data: d.data || null });
    } catch (err) {
      out.push({ index: i, key: maskKey(k), ok: false, error: err.message });
    }
  }
  return { count: keys.length, total_balance: Number(total.toFixed(4)), keys: out };
}

async function solveWith2Captcha(provider, sitekey) {
  const key = String(process.env.TWOCAPTCHA_API_KEY || '').trim();
  if (!key) throw new Error('TWOCAPTCHA_API_KEY bos');

  const method = provider === 'turnstile' ? 'turnstile' : 'hcaptcha';

  const inRes = await axios.post(
    'https://2captcha.com/in.php',
    new URLSearchParams({
      key,
      method,
      sitekey,
      pageurl: pageUrl(),
      json: '1',
    }).toString(),
    {
      timeout: 30000,
      validateStatus: () => true,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  const inData = inRes.data || {};
  if (Number(inData.status) !== 1) {
    throw new Error(`2captcha in.php: ${JSON.stringify(inData).slice(0, 300)}`);
  }
  const taskId = inData.request;

  const deadline = Date.now() + SOLVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, SOLVER_POLL_MS));
    // eslint-disable-next-line no-await-in-loop
    const res = await axios.get('https://2captcha.com/res.php', {
      params: { key, action: 'get', id: taskId, json: '1' },
      timeout: 30000,
      validateStatus: () => true,
    });
    const d = res.data || {};
    if (Number(d.status) === 1 && d.request) return String(d.request);
    if (d.request && d.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha res.php: ${JSON.stringify(d).slice(0, 300)}`);
    }
  }
  throw new Error('2captcha zaman asimi');
}

/**
 * Verilen tipte captcha cozer. Once tercih edilen saglayiciyi dener,
 * basarisiz olursa digerine duser (Suno da aynen boyle yapiyor).
 */
async function solve(provider, log) {
  const order = provider === 'hcaptcha' ? ['hcaptcha', 'turnstile'] : ['turnstile', 'hcaptcha'];
  const solver = solverName();
  if (!solver) return null;

  let lastErr = null;
  for (const p of order) {
    const sitekey = siteKeyFor(p);
    if (!sitekey) continue;
    try {
      if (log) log('info', `[captcha] ${solver} ile ${p} cozuluyor...`, { sitekey });
      let token;
      if (solver === 'peak') token = await solveWithPeak(p, sitekey, log);
      else if (solver === 'capsolver') token = await solveWithCapSolver(p, sitekey);
      else token = await solveWith2Captcha(p, sitekey);
      if (log) log('info', `[captcha] ${p} cozuldu (${String(token).length} karakter).`);
      return { token, provider: p, sitekey };
    } catch (err) {
      lastErr = err;
      if (log) log('warn', `[captcha] ${p} basarisiz: ${err.message}`);
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/* ---------------------------------------------------------------------------
 * Ana giris noktasi
 * ------------------------------------------------------------------------- */

/**
 * @param {object} p
 * @param {(method:string, path:string, body?:object) => Promise<any>} p.sunoRequest
 * @param {boolean} [p.force]  onbellegi yok say
 * @param {Function} [p.log]
 * @returns {Promise<{required:boolean, token:string|null, provider:any, source:string}>}
 */
async function getCaptchaToken({ sunoRequest, force = false, log } = {}) {
  const checkPath = String(process.env.SUNO_CAPTCHA_CHECK_PATH || '/api/c/check').trim();
  const ctype = String(process.env.SUNO_CAPTCHA_CTYPE || 'generation').trim();
  const enabled = String(process.env.SUNO_CAPTCHA_ENABLED || 'true').toLowerCase() !== 'false';

  const runtime = getRuntimeToken();
  const manual = runtime ? runtime.token : String(process.env.SUNO_CAPTCHA_TOKEN || '').trim();
  const manualProvider = runtime ? runtime.provider : null;
  if (!enabled) {
    return { required: false, token: manual || null, provider: null, source: manual ? 'env' : 'disabled' };
  }

  // 1) /api/c/check
  let required = null;
  let version = null;
  try {
    const data = await sunoRequest('post', checkPath, { ctype });
    required = Boolean(data && data.required);
    version = data && data.captcha_version;
    if (log) log('info', `[captcha] /api/c/check -> required=${required} version=${version}`);
  } catch (err) {
    // Tarayici da hata durumunda "gerekli" varsayiyor (fail-closed).
    required = true;
    if (log) log('warn', `[captcha] /api/c/check basarisiz, gerekli varsayildi: ${err.message}`);
  }

  if (required === false) {
    return { required: false, token: manual || null, provider: null, source: manual ? 'env' : 'not-required' };
  }

  // 2) Elle verilmis cozum (once runtime, sonra env)
  if (manual) {
    return {
      required: true,
      token: manual,
      provider: manualProvider !== null && manualProvider !== undefined ? manualProvider : version,
      source: runtime ? 'runtime' : 'env',
    };
  }

  // 3) Otomatik cozum
  const preferred =
    String(process.env.SUNO_CAPTCHA_PROVIDER || '').trim().toLowerCase() ||
    VERSION_MAP[Number(version)] ||
    'turnstile';

  if (!solverName()) {
    return { required: true, token: null, provider: version, source: 'unavailable', preferred };
  }

  const solved = await solve(preferred, log);
  if (!solved) {
    return { required: true, token: null, provider: version, source: 'unavailable', preferred };
  }
  return {
    required: true,
    token: solved.token,
    // Suno tarayicisi token_provider alanina captcha_version degerini yaziyor.
    provider: version !== null && version !== undefined ? version : solved.provider,
    source: 'solver',
    solved_provider: solved.provider,
  };
}

module.exports = {
  getCaptchaToken,
  peakBalance,
  peakKeys,
  peakKeyStatus,
  resetPeakState,
  parseKeyList,
  maskKey,
  setRuntimeToken,
  getRuntimeToken,
  clearRuntimeToken,
  solverName,
  siteKeyFor,
  DEFAULT_SITEKEYS,
  VERSION_MAP,
};
