'use strict';

const axios = require('axios');

/**
 * UTC gece yarisi (00:05 UTC) zaman damgasini hesaplar.
 * Suno ucretsiz gunluk kredileri her gun 00:00 UTC'de yenilenir.
 */
function getNextMidnightUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 5, 0, 0); // 00:05 UTC (5 dk pay)
  return d.getTime();
}

/**
 * JWT payload'ini (base64url) cozer.
 */
function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_err) {
    return null;
  }
}

function getTokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return 0;
  return payload.exp * 1000;
}

function cleanTokenString(val) {
  if (!val || typeof val !== 'string') return '';
  let str = val.trim();
  // Tirnaklari temizle
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.slice(1, -1).trim();
  }
  if (str.startsWith('Bearer ')) {
    str = str.slice(7).trim();
  }
  // Cookie basligindan __client veya __session ayikla
  if (str.includes('__client=')) {
    const m = str.match(/__client=([^;]+)/);
    if (m) str = m[1].trim();
  } else if (str.includes('__session=')) {
    const m = str.match(/__session=([^;]+)/);
    if (m) str = m[1].trim();
  }
  return str;
}

/**
 * Tek bir Suno / Clerk hesabini temsil eder.
 */
class SunoAccount {
  constructor(index, refreshToken) {
    this.index = index;
    this.id = `account_${index}`;
    this.refreshToken = cleanTokenString(refreshToken);
    this.sessionId = null;
    this.accessToken = null;
    this.expiresAt = 0;
    this.lastRefreshAt = 0;
    this.refreshCount = 0;
    this.lastError = null;
    this.inFlight = null;
    this.tokenType = 'refresh';
    this.email = null;
    this.handle = null;

    // Eger verilen token bir JWT ise (__session veya hazir token)
    const payload = decodeJwtPayload(this.refreshToken);
    if (payload) {
      this.tokenType = payload['suno.com/claims/token_type'] || 'refresh';
      this.email = payload['suno.com/claims/email'] || payload['https://suno.ai/claims/email'] || null;
      this.handle = payload['suno/handle'] || null;
      if (payload.sid) this.sessionId = payload.sid;
      if (payload.exp) {
        this.expiresAt = payload.exp * 1000;
      }
      if (this.tokenType === 'access') {
        this.accessToken = this.refreshToken;
      }
    }

    // Limit ve kullanim durumu
    this.isExhausted = false;
    this.exhaustedReason = null;
    this.exhaustedUntil = 0;
    this.totalGenerated = 0;
    this.credits = null;
  }

  buildCookieHeader() {
    if (this.tokenType === 'access') {
      return `__session=${this.accessToken || this.refreshToken}`;
    }
    return `__client=${this.refreshToken}`;
  }

  isAvailable() {
    if (!this.isExhausted) return true;
    // Sure dolduysa otomatik sifirla
    if (Date.now() >= this.exhaustedUntil) {
      this.isExhausted = false;
      this.exhaustedReason = null;
      this.exhaustedUntil = 0;
      return true;
    }
    return false;
  }

  markExhausted(reason = 'Kredi tukendi', durationMs = null) {
    this.isExhausted = true;
    this.exhaustedReason = String(reason || 'Kredi tukendi').slice(0, 300);
    this.exhaustedUntil = durationMs ? Date.now() + durationMs : getNextMidnightUtc();
  }

  resetExhaustion() {
    this.isExhausted = false;
    this.exhaustedReason = null;
    this.exhaustedUntil = 0;
  }

  async fetchClerkClient(options) {
    const { clerkBaseUrl, clerkJsVersion, requestTimeoutMs, userAgent } = options;
    const url = `${clerkBaseUrl}/v1/client?_clerk_js_version=${encodeURIComponent(clerkJsVersion)}`;

    const { data } = await axios.get(url, {
      timeout: requestTimeoutMs,
      headers: {
        Cookie: this.buildCookieHeader(),
        Accept: '*/*',
        'User-Agent': userAgent,
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const client = data && (data.response || data);
    const sessions = Array.isArray(client && client.sessions) ? client.sessions : [];

    if (!sessions.length) {
      throw new Error(
        `Clerk oturumu bulunamadi (${this.id}). __client suresi dolmus olabilir; suno.com uzerinden yeni cookie alin.`
      );
    }

    const activeSession =
      sessions.find((s) => s && s.status === 'active') ||
      sessions.find((s) => s && s.id === client.last_active_session_id) ||
      sessions[0];

    return {
      sessionId: activeSession.id,
      fallbackJwt: (activeSession.last_active_token && activeSession.last_active_token.jwt) || null,
    };
  }

  async requestSessionToken(sessionId, options) {
    const { clerkBaseUrl, clerkJsVersion, requestTimeoutMs, userAgent } = options;
    const url =
      `${clerkBaseUrl}/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens` +
      `?_clerk_js_version=${encodeURIComponent(clerkJsVersion)}`;

    const { data } = await axios.post(url, null, {
      timeout: requestTimeoutMs,
      headers: {
        Cookie: this.buildCookieHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '0',
        Accept: '*/*',
        'User-Agent': userAgent,
        Origin: 'https://suno.com',
        Referer: 'https://suno.com/',
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const jwt = data && (data.jwt || (data.response && data.response.jwt));
    if (!jwt) {
      throw new Error(`Clerk token yanitinda jwt alani yok (${this.id}).`);
    }
    return jwt;
  }

  async touchSession(options) {
    if (!this.sessionId) return;
    const { clerkBaseUrl, clerkJsVersion, requestTimeoutMs, userAgent, log } = options;
    const url =
      `${clerkBaseUrl}/v1/client/sessions/${encodeURIComponent(this.sessionId)}/touch` +
      `?_clerk_js_version=${encodeURIComponent(clerkJsVersion)}`;

    try {
      await axios.post(url, null, {
        timeout: requestTimeoutMs,
        headers: {
          Cookie: this.buildCookieHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': '0',
          Accept: '*/*',
          'User-Agent': userAgent,
          Origin: 'https://suno.com',
          Referer: 'https://suno.com/',
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (log) log('debug', `Clerk session/touch basarili (${this.id}).`, { sessionId: this.sessionId });
    } catch (err) {
      if (log) log('warn', `Clerk session/touch basarisiz (${this.id})`, err.message);
    }
  }

  async refreshAccessToken(force = false, options = {}) {
    const now = Date.now();
    const refreshBeforeExpiryMs = options.refreshBeforeExpiryMs || 5 * 60 * 1000;
    const stillValid = this.accessToken && (this.expiresAt === 0 || this.expiresAt - refreshBeforeExpiryMs > now);
    if (!force && stillValid) return this.accessToken;

    if (this.tokenType === 'access') {
      if (this.accessToken && (this.expiresAt === 0 || this.expiresAt > now)) {
        return this.accessToken;
      }
    }

    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const startedAt = Date.now();
      try {
        if (!this.sessionId) {
          const { sessionId, fallbackJwt } = await this.fetchClerkClient(options);
          this.sessionId = sessionId;
          if (fallbackJwt) {
            this.accessToken = fallbackJwt;
            this.expiresAt = getTokenExpiryMs(fallbackJwt);
          }
        }

        let jwt;
        try {
          jwt = await this.requestSessionToken(this.sessionId, options);
        } catch (tokenErr) {
          const { sessionId, fallbackJwt } = await this.fetchClerkClient(options);
          this.sessionId = sessionId;
          try {
            jwt = await this.requestSessionToken(sessionId, options);
          } catch (retryErr) {
            if (fallbackJwt) {
              jwt = fallbackJwt;
            } else {
              throw retryErr;
            }
          }
        }

        this.accessToken = jwt;
        this.expiresAt = getTokenExpiryMs(jwt);
        this.lastRefreshAt = Date.now();
        this.lastError = null;
        this.refreshCount += 1;

        if (options.log) {
          options.log('info', `Access token yenilendi (${this.id}).`, {
            sessionId: this.sessionId,
            tookMs: Date.now() - startedAt,
          });
        }
        return jwt;
      } catch (err) {
        this.lastError = err.message;
        if (options.log) options.log('error', `Token yenileme basarisiz (${this.id}).`, err.message);
        throw err;
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }

  async getValidToken(options = {}) {
    const now = Date.now();
    const refreshBeforeExpiryMs = options.refreshBeforeExpiryMs || 5 * 60 * 1000;
    const hasToken = Boolean(this.accessToken);
    const expiringSoon = this.expiresAt !== 0 && this.expiresAt - refreshBeforeExpiryMs <= now;

    if (hasToken && !expiringSoon) return this.accessToken;
    return this.refreshAccessToken(!hasToken, options);
  }

  toSafeSummary() {
    return {
      id: this.id,
      index: this.index,
      email: this.email || null,
      handle: this.handle || null,
      tokenType: this.tokenType,
      isAvailable: this.isAvailable(),
      isExhausted: this.isExhausted,
      exhaustedReason: this.exhaustedReason,
      exhaustedUntil: this.exhaustedUntil ? new Date(this.exhaustedUntil).toISOString() : null,
      hasSession: Boolean(this.sessionId),
      hasToken: Boolean(this.accessToken),
      tokenExpiresInSeconds: this.expiresAt ? Math.max(0, Math.round((this.expiresAt - Date.now()) / 1000)) : null,
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      refreshCount: this.refreshCount,
      totalGenerated: this.totalGenerated,
      lastError: this.lastError,
    };
  }
}

/**
 * Coklu hesap yonetim havuzu (Account Pool).
 */
class AccountPool {
  constructor(tokens = [], strategy = 'fallback') {
    this.accounts = [];
    this.strategy = strategy; // 'fallback' | 'round-robin'
    this.roundRobinIndex = 0;
    this.clipAccountMap = new Map(); // clipId -> accountId (max 500)

    this.initTokens(tokens);
  }

  initTokens(tokens) {
    this.accounts = [];
    const seen = new Set();
    let idx = 1;

    for (const raw of tokens) {
      const clean = cleanTokenString(raw);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        this.accounts.push(new SunoAccount(idx++, clean));
      }
    }
  }

  size() {
    return this.accounts.length;
  }

  getAvailableAccounts() {
    return this.accounts.filter((a) => a.isAvailable());
  }

  hasAvailableAccount() {
    return this.getAvailableAccounts().length > 0;
  }

  getActiveAccount() {
    if (!this.accounts.length) return null;

    const available = this.getAvailableAccounts();
    if (!available.length) {
      // Hic uygun hesap yoksa ilk hesabi dondur (en azindan istek denenebilsin)
      return this.accounts[0];
    }

    if (this.strategy === 'round-robin') {
      const account = available[this.roundRobinIndex % available.length];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
      return account;
    }

    // 'fallback' modu (varsayilan): Limit bitmedigi surece ilk uygun hesabi kullan
    return available[0];
  }

  getAccountById(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  markAccountExhausted(accountOrId, reason) {
    const act = typeof accountOrId === 'string' ? this.getAccountById(accountOrId) : accountOrId;
    if (act) {
      act.markExhausted(reason);
    }
  }

  resetAllExhausted() {
    for (const a of this.accounts) {
      a.resetExhaustion();
    }
  }

  recordClipAccount(clipId, accountId) {
    if (!clipId || !accountId) return;
    if (this.clipAccountMap.size > 500) {
      const firstKey = this.clipAccountMap.keys().next().value;
      this.clipAccountMap.delete(firstKey);
    }
    this.clipAccountMap.set(clipId, accountId);
  }

  getAccountForClip(clipId) {
    if (!clipId) return this.getActiveAccount();
    const accountId = this.clipAccountMap.get(clipId);
    if (accountId) {
      const act = this.getAccountById(accountId);
      if (act) return act;
    }
    return this.getActiveAccount();
  }

  async keepAliveAll(options) {
    for (const act of this.accounts) {
      try {
        if (act.sessionId) await act.touchSession(options);
        await act.refreshAccessToken(true, options);
      } catch (err) {
        if (options.log) options.log('warn', `Keep-alive hesap uyarisi (${act.id}):`, err.message);
      }
    }
  }

  getStatus() {
    const available = this.getAvailableAccounts();
    const activeAccount = this.getActiveAccount();
    return {
      strategy: this.strategy,
      totalAccounts: this.accounts.length,
      availableAccounts: available.length,
      exhaustedAccounts: this.accounts.length - available.length,
      activeAccountId: activeAccount ? activeAccount.id : null,
      accounts: this.accounts.map((a) => a.toSafeSummary()),
    };
  }
}

/**
 * Ortam degiskenlerinden tum hesap token'larini toplar.
 * Desteklenen bicimler:
 * 1) SUNO_REFRESH_TOKENS: "token1,token2,token3" veya JSON dizisi '["tok1","tok2"]'
 * 2) SUNO_REFRESH_TOKEN_1, SUNO_REFRESH_TOKEN_2, ... SUNO_REFRESH_TOKEN_20
 * 3) SUNO_REFRESH_TOKEN (klasik tek token)
 */
function parseTokensFromEnv(env = process.env) {
  const tokens = [];

  // 1) SUNO_REFRESH_TOKENS
  if (env.SUNO_REFRESH_TOKENS) {
    const raw = String(env.SUNO_REFRESH_TOKENS).trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) tokens.push(...arr);
      } catch (_e) {
        // parse hatasi ise normal ayir
        tokens.push(...raw.split(/[\r\n,]+/));
      }
    } else {
      tokens.push(...raw.split(/[\r\n,]+/));
    }
  }

  // 2) SUNO_REFRESH_TOKEN_1 .. SUNO_REFRESH_TOKEN_20
  for (let i = 1; i <= 20; i++) {
    const key = `SUNO_REFRESH_TOKEN_${i}`;
    if (env[key]) tokens.push(...String(env[key]).trim().split(/[\r\n,]+/));
  }

  // 3) SUNO_REFRESH_TOKEN (tekli veya coklu fallback)
  if (env.SUNO_REFRESH_TOKEN) {
    tokens.push(...String(env.SUNO_REFRESH_TOKEN).trim().split(/[\r\n,]+/));
  }

  // Temizle ve tekillestir
  const unique = [];
  const seen = new Set();
  for (const t of tokens) {
    const cleaned = cleanTokenString(t);
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      unique.push(cleaned);
    }
  }

  return unique;
}

/**
 * Hatanin kredi veya gunluk limit yetersizliginden kaynaklanip kaynaklanmadigini belirler.
 */
function isCreditExhaustedError(err) {
  if (!err) return false;
  if (err.status === 402) return true;
  const str = (
    String(err.message || '') +
    ' ' +
    String(err.detail || '') +
    ' ' +
    String(err.code || '') +
    ' ' +
    JSON.stringify(err.responseData || {})
  ).toLowerCase();

  return (
    str.includes('insufficient_credits') ||
    str.includes('insufficient credits') ||
    str.includes('credits_depleted') ||
    str.includes('credit limit') ||
    str.includes('daily limit') ||
    str.includes('out of credits') ||
    str.includes('payment required') ||
    str.includes('not enough credits') ||
    str.includes('credits: 0') ||
    str.includes('quota_exceeded') ||
    str.includes('free tier limit')
  );
}

module.exports = {
  SunoAccount,
  AccountPool,
  parseTokensFromEnv,
  isCreditExhaustedError,
  getNextMidnightUtc,
  cleanTokenString,
};
