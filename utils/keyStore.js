'use strict';

/**
 * ============================================================================
 *  utils/keyStore.js  —  CALISMA ANINDA API ANAHTARI URETIMI / DEPOSU
 * ============================================================================
 *
 *  NE YAPAR
 *  --------
 *  Dashboard'dan ("siteden") yeni API anahtari uretir, listeler, iptal eder ve
 *  gelen isteklerdeki anahtari dogrular.
 *
 *  GUVENLIK MODELI
 *  ---------------
 *  - Anahtarin KENDISI saklanmaz: yalnizca SHA-256 ozeti + gorunen onek
 *    (`sk_ab12…`) tutulur. Depo ele gecirse bile anahtarlar geri uretilemez.
 *  - Anahtar formati:  sk_<43 karakter base64url>  (~256 bit entropi)
 *  - Karsilastirma sabit zamanlidir (ozet uzerinden, Map lookup).
 *  - `role`: "admin" anahtarlar yeni anahtar uretebilir; "client" uretemez.
 *    Ilk uretilen anahtar otomatik olarak "admin" olur (bootstrap).
 *
 *  KALICILIK (persistence)
 *  -----------------------
 *  - `KEY_STORE_FILE` bos  -> yalnizca bellek (process olunce kaybolur)
 *  - `KEY_STORE_FILE=/data/keys.json` -> JSON dosyasina yazilir (atomik)
 *
 *  Render notu: ucretsiz planda disk GECICIDIR — dosya restart'ta kalir,
 *  yeni deploy'da sifirlanir. Kalici kayit icin Render Disk + KEY_STORE_FILE.
 *
 *  KAPSAM: bu modul yalnizca kimlik dogrulama verisi tutar; ses/DRM ile ilgisi
 *  yoktur.
 * ============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'sk_';
const MAX_KEYS = 200;

/** Sabit zamanli, uzunluk sizdirmayan karsilastirma. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_e) {
    return false;
  }
}

/** Ham anahtarin depoda tutulan ozeti. */
function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/** Yeni anahtar uretir: sk_ + 32 bayt base64url. */
function generateKey() {
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

class KeyStore {
  /**
   * @param {object} opts
   * @param {string} opts.file      JSON dosya yolu ('' -> bellek only)
   * @param {number} opts.maxKeys   ust sinir
   * @param {boolean} opts.enabled
   */
  constructor(opts = {}) {
    this.file = opts.file ? path.resolve(opts.file) : '';
    this.maxKeys = opts.maxKeys || MAX_KEYS;
    this.enabled = opts.enabled !== false;

    /** @type {Map<string, object>} hash -> kayit */
    this.byHash = new Map();
    /** @type {Map<string, string>} id -> hash */
    this.idToHash = new Map();

    this.stats = { created: 0, revoked: 0, verifications: 0, hits: 0, rejected: 0 };
    this.load();
  }

  // -------------------------------------------------------------------------
  //  Kalicilik
  // -------------------------------------------------------------------------
  load() {
    if (!this.file) return this;
    try {
      if (!fs.existsSync(this.file)) return this;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.keys || [];
      for (const rec of list) {
        if (!rec || !rec.hash || !rec.id) continue;
        this.byHash.set(rec.hash, rec);
        this.idToHash.set(rec.id, rec.hash);
      }
      if (this.byHash.size) {
        process.stdout.write(`[keyStore] ${this.byHash.size} anahtar diskten yuklendi.\n`);
      }
    } catch (err) {
      process.stdout.write(`[keyStore] dosya okunamadi: ${err.message}\n`);
    }
    return this;
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const list = Array.from(this.byHash.values());
      const tmp = `${this.file}.tmp`;
      // 0600: dosya yalnizca servis kullanicisi tarafindan okunur
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, keys: list }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      process.stdout.write(`[keyStore] yazilamadi: ${err.message}\n`);
    }
  }

  // -------------------------------------------------------------------------
  //  CRUD
  // -------------------------------------------------------------------------
  /** @returns {{ record: object, key: string|null }} key yalnizca burada, tek sefer doner */
  create(name, role = 'client') {
    if (!this.enabled) {
      const err = new Error('Anahtar deposu kapali (KEY_STORE_ENABLED=false).');
      err.code = 'KEY_STORE_DISABLED';
      throw err;
    }
    if (this.byHash.size >= this.maxKeys) {
      const err = new Error(`Anahtar siniri asildi (${this.maxKeys}).`);
      err.code = 'KEY_LIMIT_REACHED';
      throw err;
    }

    const finalRole = role === 'admin' ? 'admin' : 'client';
    const key = generateKey();
    const record = {
      id: crypto.randomUUID(),
      hash: hashKey(key),
      prefix: key.slice(0, 8),
      name: String(name || '').trim().slice(0, 60) || 'isimsiz',
      role: finalRole,
      created_at: new Date().toISOString(),
      last_used_at: null,
      uses: 0,
      revoked: false,
    };

    this.byHash.set(record.hash, record);
    this.idToHash.set(record.id, record.hash);
    this.stats.created += 1;
    this.persist();

    return { record: this.publicRecord(record), key };
  }

  /** Diske/loga yazilabilecek guvenli kayit (hash ve tam anahtar YOK). */
  publicRecord(rec) {
    return {
      id: rec.id,
      name: rec.name,
      prefix: `${rec.prefix}…`,
      role: rec.role,
      created_at: rec.created_at,
      last_used_at: rec.last_used_at,
      uses: rec.uses,
      revoked: rec.revoked,
    };
  }

  list() {
    return Array.from(this.byHash.values())
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map((r) => this.publicRecord(r));
  }

  get(id) {
    const hash = this.idToHash.get(String(id));
    return hash ? this.byHash.get(hash) : null;
  }

  revoke(id) {
    const rec = this.get(id);
    if (!rec) return false;
    rec.revoked = true;
    this.stats.revoked += 1;
    this.persist();
    return true;
  }

  /** Idempotent: kaydi kalici siler. */
  remove(id) {
    const hash = this.idToHash.get(String(id));
    if (!hash) return false;
    const rec = this.byHash.get(hash);
    if (rec) rec.revoked = true;
    this.byHash.delete(hash);
    this.idToHash.delete(String(id));
    this.persist();
    return true;
  }

  // -------------------------------------------------------------------------
  //  Dogrulama
  // -------------------------------------------------------------------------
  /**
   * Ham anahtari dogrular.
   * @returns {null | { role: string, id: string, name: string }}
   */
  verify(rawKey) {
    this.stats.verifications += 1;
    const provided = String(rawKey || '').trim();
    if (!provided || !provided.startsWith(PREFIX)) {
      this.stats.rejected += 1;
      return null;
    }

    const hash = hashKey(provided);
    const rec = this.byHash.get(hash);
    if (!rec || rec.revoked) {
      this.stats.rejected += 1;
      return null;
    }

    // Sabit zamanli teyit (Map lookup zaten hash esitligi; yine de acik kontrol)
    if (!safeEqual(rec.hash, hash)) {
      this.stats.rejected += 1;
      return null;
    }

    rec.last_used_at = new Date().toISOString();
    rec.uses = (rec.uses || 0) + 1;
    this.stats.hits += 1;
    // Her istekte diske yazmiyoruz (IO maliyeti); 25 kullanimda bir senkron.
    if (rec.uses % 25 === 0) this.persist();

    return { role: rec.role, id: rec.id, name: rec.name };
  }

  /** Aktif (iptal edilmemis) anahtar sayisi. */
  activeCount() {
    let n = 0;
    for (const rec of this.byHash.values()) if (!rec.revoked) n += 1;
    return n;
  }

  /** /health icin ozet (sir yok). */
  stats_() {
    const keys = this.list();
    return {
      enabled: this.enabled,
      persistent: Boolean(this.file),
      file: this.file ? path.basename(this.file) : null,
      total: keys.length,
      active: keys.filter((k) => !k.revoked).length,
      admins: keys.filter((k) => k.role === 'admin' && !k.revoked).length,
      counters: { ...this.stats },
    };
  }
}

module.exports = { KeyStore, hashKey, generateKey, PREFIX };
