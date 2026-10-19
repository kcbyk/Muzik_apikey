'use strict';

/**
 * ============================================================================
 *  utils/signerPool.js  —  TOKEN CACHE POOL (dinamik imza parametresi havuzu)
 * ============================================================================
 *
 *  NE YAPAR
 *  --------
 *  Imza parametreleri (sig / expires / token ...) genelde KISA OMURLUDUR
 *  (30-300 sn). Her istekte yeniden uretmek yerine:
 *
 *    - parametre setini klip id'sine gore bellege alir (TTL'li),
 *    - suresi dolmak uzere olanlari ARKA PLANDA tazeler,
 *    - ayni klip icin es zamanli 100 istek gelse bile TEK tazeleme yapar
 *      (single-flight),
 *    - TTL doldugunda kaydi siler ve `stale` olarak isaretler.
 *
 *  BELLEK
 *  ------
 *  Her kayit ~200-400 bayt. 500 kayit ~150 KB. Render Free Tier icin
 *  sorun degil; yine de `max` siniri ve LRU tahliye vardir.
 *
 *  KAPSAM
 *  ------
 *  Havuz yalnizca REQUEST PARAMETRELERI tutar. Cerezler (__client /
 *  __session) saklanmaz; tazeleme aninda .env / istek baglamindan okunur.
 *  Icerik cozme anahtari bu havuzun konusu degildir.
 * ============================================================================
 */

class SignerPool {
  /**
   * @param {object} opts
   * @param {number} opts.ttlMs      varsayilan kayit omru (ms)
   * @param {number} opts.max        maksimum kayit sayisi
   * @param {number} opts.refreshMs  arka plan tazeleme periyodu (0 = kapali)
   * @param {number} opts.refreshAhead Oran: TTL'in son %kacinda tazelensin (0.25 = %25)
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || 120000;
    this.max = opts.max || 500;
    this.refreshMs = opts.refreshMs || 0;
    this.refreshAhead = opts.refreshAhead === undefined ? 0.25 : opts.refreshAhead;

    /** @type {Map<string, {params:object, expiresAt:number, createdAt:number, source:string, hits:number}>} */
    this.store = new Map();
    /** @type {Map<string, Promise<object|null>>} */
    this.inflight = new Map();
    /** @type {null | ((key:string) => Promise<object|null>)} */
    this.refresher = null;

    this.timer = null;
    this.stats = {
      puts: 0,
      hits: 0,
      misses: 0,
      expired: 0,
      evictions: 0,
      refreshes: 0,
      refresh_failures: 0,
    };
  }

  /** Tazeleme fonksiyonunu baglar. fn(key) -> params|null */
  setRefresher(fn) {
    this.refresher = typeof fn === 'function' ? fn : null;
    return this;
  }

  /** Kaydi yazar. params bos ise yazmaz. */
  put(key, params, opts = {}) {
    if (!key || !params || Object.keys(params).length === 0) return false;
    const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : this.ttlMs;
    const now = Date.now();

    if (this.store.size >= this.max && !this.store.has(key)) {
      // LRU: en eski createdAt kaydini at
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.store) {
        if (v.createdAt < oldestAt) {
          oldestAt = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.store.delete(oldestKey);
        this.stats.evictions += 1;
      }
    }

    this.store.set(key, {
      params: { ...params },
      createdAt: now,
      expiresAt: now + ttl,
      source: opts.source || 'manual',
      ttlMs: ttl,
      hits: 0,
    });
    this.stats.puts += 1;
    return true;
  }

  /** Gecersiz kaydi siler, gecerli kaydi dondurur. */
  get(key, now = Date.now()) {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      this.stats.expired += 1;
      this.stats.misses += 1;
      return null;
    }
    entry.hits += 1;
    this.stats.hits += 1;
    return { ...entry.params };
  }

  /**
   * Kaydi getirir; yoksa (ve refresher varsa) TEK seferlik tazeler.
   * @returns {Promise<object|null>}
   */
  async getOrRefresh(key, now = Date.now()) {
    const hit = this.get(key, now);
    if (hit) return hit;
    if (!this.refresher) return null;

    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = (async () => {
      try {
        const params = await this.refresher(key);
        this.stats.refreshes += 1;
        if (params && Object.keys(params).length) {
          this.put(key, params, { source: 'refresh' });
          return { ...params };
        }
        this.stats.refresh_failures += 1;
        return null;
      } catch (_e) {
        this.stats.refresh_failures += 1;
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.inflight.clear();
    return true;
  }

  /** Suresi dolmus kayitlari temizler; tazelenebilecekleri tazeler. */
  async sweep(now = Date.now()) {
    let removed = 0;
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) {
        this.store.delete(k);
        this.stats.expired += 1;
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Arka plan dongusu: (a) suresi dolanlari temizler,
   * (b) TTL'in son `refreshAhead` dilimine girenleri tazeler.
   * Tek `setInterval` kullanir ve `unref()` ile process'i tutmaz.
   */
  start() {
    if (this.timer || this.refreshMs <= 0) return this;
    this.timer = setInterval(() => {
      const now = Date.now();
      const soon = [];
      for (const [k, v] of this.store) {
        if (v.expiresAt <= now) {
          this.store.delete(k);
          this.stats.expired += 1;
        } else if (v.ttlMs && v.expiresAt - now <= v.ttlMs * this.refreshAhead) {
          soon.push(k);
        }
      }
      if (!this.refresher || soon.length === 0) return;
      for (const k of soon.slice(0, 25)) {
        // es zamanli tazelemeyi sinirla (bellek/CPU)
        this.getOrRefresh(k).catch(() => {});
      }
    }, this.refreshMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** Raporlama (sir sizdirmaz: yalnizca anahtarlar ve meta veri). */
  stats_() {
    const now = Date.now();
    const entries = [];
    for (const [k, v] of this.store) {
      entries.push({
        key: k,
        source: v.source,
        age_ms: now - v.createdAt,
        ttl_ms: v.ttlMs,
        expires_in_ms: v.expiresAt - now,
        params: Object.keys(v.params),
        hits: v.hits,
      });
    }
    return {
      enabled: this.refreshMs > 0 || this.store.size > 0 || !!this.refresher,
      size: this.store.size,
      max: this.max,
      default_ttl_ms: this.ttlMs,
      refresh_interval_ms: this.refreshMs,
      refresher_attached: !!this.refresher,
      inflight: this.inflight.size,
      counters: { ...this.stats },
      entries: entries.sort((a, b) => b.age_ms - a.age_ms).slice(0, 50),
    };
  }
}

module.exports = { SignerPool };
