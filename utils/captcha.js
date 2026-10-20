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
  turnstile: ['0x4AAAAAABd64Cd9aq5C--VE', '0x4AAAAAABtnpJo7aKMs9JLQ', '0x4AAAAAADI7xDNyj-3LcIbi'],
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

/** Yapilandirilmis cozum servisi var mi? */
function solverName() {
  const forced = String(process.env.CAPTCHA_SOLVER || '').trim().toLowerCase();
  if (forced === 'capsolver' || forced === '2captcha') return forced;
  if (forced === 'none' || forced === 'off' || forced === '') {
    // otomatik algila
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
      const token =
        solver === 'capsolver' ? await solveWithCapSolver(p, sitekey) : await solveWith2Captcha(p, sitekey);
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

  const manual = String(process.env.SUNO_CAPTCHA_TOKEN || '').trim();
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

  // 2) Elle verilmis cozum
  if (manual) {
    return { required: true, token: manual, provider: version, source: 'env' };
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
  solverName,
  siteKeyFor,
  DEFAULT_SITEKEYS,
  VERSION_MAP,
};
