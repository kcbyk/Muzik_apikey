/**
 * SUNO TOKEN YAKALAYICI  —  Konsola yapıştır, çalışır.
 * -----------------------------------------------------------------------
 * Neden: Suno artık `window.Clerk`'i global'e koymuyor (Clerk, Next.js
 * bundle'ı içinde private). Bu yüzden token'ı doğrudan okuyamıyoruz;
 * bunun yerine Suno'nun kendi isteklerinden Bearer header'ını yakalıyoruz.
 *
 * KULLANIM
 * 1. https://suno.com sayfasında F12 → Console
 * 2. Aşağıdaki kodun TAMAMINI yapıştır, Enter
 * 3. Sayfada gez (Create / Library / bir şarkı aç) — token otomatik yakalanır
 * 4. Konsola:  copy(window.__sunoToken)
 * 5. Bana yapıştır veya servise gönder:
 *      POST /auth/token   { "token": "eyJ..." }
 *
 * NOT: Sayfayı YENİLEME. Yenilersen kanca silinir, tekrar yapıştırman gerekir.
 */
(() => {
  const REPORT = (t) => {
    window.__sunoToken = t;
    console.log(
      `%c✅ TOKEN YAKALANDI (${t.length} karakter)`,
      'color:#16c60c;font-weight:bold;font-size:13px',
    );
    console.log('%cKopyala →  copy(window.__sunoToken)', 'color:#0af');
  };

  const grabHeaders = (h) => {
    if (!h) return;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const v = h.get('authorization');
        if (v && /^Bearer\s+eyJ/.test(v)) REPORT(v.slice(7));
        return;
      }
      if (Array.isArray(h)) {
        for (const pair of h) {
          if (Array.isArray(pair) && String(pair[0]).toLowerCase() === 'authorization') {
            const v = String(pair[1]);
            if (/^Bearer\s+eyJ/.test(v)) REPORT(v.slice(7));
          }
        }
        return;
      }
      if (typeof h === 'object') {
        for (const k of Object.keys(h)) {
          if (k.toLowerCase() === 'authorization') {
            const v = String(h[k]);
            if (/^Bearer\s+eyJ/.test(v)) REPORT(v.slice(7));
          }
        }
      }
    } catch (_e) {}
  };

  // --- fetch kancası ---
  if (!window.__sunoFetchHooked) {
    window.__sunoFetchHooked = true;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        grabHeaders(init && init.headers);
        grabHeaders(input && input.headers);
      } catch (_e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // --- XMLHttpRequest kancası (bazı SDK'lar bunu kullanır) ---
  if (!window.__sunoXhrHooked) {
    window.__sunoXhrHooked = true;
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try {
        if (String(k).toLowerCase() === 'authorization' && /^Bearer\s+eyJ/.test(String(v))) {
          REPORT(String(v).slice(7));
        }
      } catch (_e) {}
      return origSet.apply(this, arguments);
    };
  }

  console.log(
    '%c🎣 Kanca kuruldu.',
    'color:#16c60c;font-weight:bold',
    '\nŞimdi sayfada gez (Create / Library / bir şarkı aç). Token otomatik yakalanacak.' +
      '\nYakalandıktan sonra:  copy(window.__sunoToken)',
  );
})();
