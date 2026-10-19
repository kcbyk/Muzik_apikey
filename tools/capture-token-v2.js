/**
 * SUNO TOKEN YAKALAYICI v2 — "sadece ÇALIŞAN token'ı yakala"
 * -----------------------------------------------------------------------
 * v1'den farkı: her isteğin HTTP durumunu da izler ve token'ı YALNIZCA
 * gerçekten 200 dönen bir studio-api isteğinden kaydeder. Böylece Suno'nun
 * elinde bayat/geçersiz bir token olsa bile onu kapmayız.
 *
 * KULLANIM
 * 1. suno.com → F12 → Console → bu kodun TAMAMINI yapıştır → Enter
 * 2. Sayfada gez: Library / Create / bir şarkı aç (ağ trafiği olsun)
 * 3. Konsolda yeşil "✅ GEÇERLİ TOKEN" satırını gör
 * 4. copy(window.__sunoToken)  → bana yapıştır
 *
 * Sayfayı YENİLEME (kanca silinir).
 */
(() => {
  const STATE = { ok: null, lastStatuses: [] };
  window.__sunoState = STATE;

  const storeToken = (token, url, status) => {
    window.__sunoToken = token;
    window.__sunoTokenSource = { url, status };
    console.log(
      `%c✅ GEÇERLİ TOKEN YAKALANDI — ${token.length} karakter (HTTP ${status})`,
      'color:#16c60c;font-weight:bold;font-size:13px',
    );
    console.log('%c  Kaynak:', 'color:#16c60c', url);
    console.log('%c  Kopyala →  copy(window.__sunoToken)', 'color:#0af;font-weight:bold');
  };

  const noteStatus = (url, status) => {
    STATE.lastStatuses.push({ url, status });
    if (STATE.lastStatuses.length > 40) STATE.lastStatuses.shift();
    const bad = status >= 400 && /studio-api/.test(url);
    const icon = bad ? '🔴' : '🟢';
    const color = bad ? 'color:#e33' : 'color:#888';
    console.log(`%c${icon} ${status} ${url}`, color);
  };

  const extractBearer = (h) => {
    try {
      if (!h) return null;
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const v = h.get('authorization');
        return v && /^Bearer\s+eyJ/.test(v) ? v.slice(7) : null;
      }
      if (Array.isArray(h)) {
        for (const p of h) {
          if (Array.isArray(p) && String(p[0]).toLowerCase() === 'authorization') {
            const v = String(p[1]);
            if (/^Bearer\s+eyJ/.test(v)) return v.slice(7);
          }
        }
        return null;
      }
      if (typeof h === 'object') {
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'authorization') {
            const v = String(h[k]);
            if (/^Bearer\s+eyJ/.test(v)) return v.slice(7);
          }
        }
      }
    } catch (_e) {}
    return null;
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const token = extractBearer(init && init.headers) || extractBearer(input && input.headers);
    const p = origFetch.apply(this, arguments);
    p.then((res) => {
      noteStatus(url, res.status);
      // Sadece BASARILI yanitlarin token'ini sakla
      if (token && res.status === 200 && /studio-api/.test(url)) storeToken(token, url, res.status);
    }).catch(() => {});
    return p;
  };

  console.log(
    "%c🎣 v2 kanca kuruldu — sadece HTTP 200 dönen isteklerin token'ı kaydedilecek.",
    'color:#16c60c;font-weight:bold',
  );
  console.log(
    '%cŞimdi Library / Create sayfasında gez. Sonra: copy(window.__sunoToken)',
    'color:#0af',
  );
  console.log(
    '%cTüm isteklerin durumunu görmek için:  console.table(window.__sunoState.lastStatuses)',
    'color:#888',
  );
})();
