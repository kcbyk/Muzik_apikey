# 🎛️ Suno Beat Proxy

Suno.com'un arkasındaki **Clerk Auth** sistemini taklit ederek, **tarayıcı (Puppeteer/Playwright) kullanmadan** tamamen hafif HTTP istekleriyle beat/müzik üreten unofficial API proxy'si.

- **RAM:** ~55–75 MB (Render Free Tier 512 MB için fazlasıyla yeterli)
- **Bağımlılık:** sadece `express`, `axios`, `dotenv` (Chromium yok → build süresi ve disk kullanımı minimal)
- **7/24 oturum:** `setInterval` keep-alive + her istekte "lazy refresh" + 401'de otomatik retry
- **Single-flight token yenileme:** 10 eşzamanlı istek gelse bile Clerk'e 1 çağrı gider

---

## 1. Kurulum

```bash
npm install
cp .env.example .env     # .env'i doldurun
npm start
```

### `SUNO_REFRESH_TOKEN` nasıl alınır?

1. Tarayıcıda <https://suno.com> adresine giriş yapın.
2. `F12` → **Application** → **Cookies** → `https://suno.com`
3. **`__client`** cookie'sinin değerini kopyalayın (uzun JWT, ~1 yıl geçerli).
4. `.env` içindeki `SUNO_REFRESH_TOKEN=` satırına yapıştırın.

> Tüm `Cookie:` header'ını yapıştırırsanız da olur — kod `__client=...` kısmını otomatik ayıklar.

---

## 2. Endpoint'ler

| Metot | Yol | Açıklama |
|---|---|---|
| `GET` | `/` | **Web Dashboard** (`public/index.html`) — üret, dinle, indir, anahtar oluştur |
| `POST` | `/keys` | **Siteden API anahtarı üretir** (yanıtta 1 kez gösterilir) |
| `GET` | `/keys` | Anahtar listesi (maskeli: `sk_49ZoP…`) |
| `DELETE` | `/keys/:id` | Anahtarı iptal eder (anında `401`) |
| `GET` | `/ping` | UptimeRobot için `pong` (auth istemez, en hafif endpoint) |
| `GET` | `/health` | Uptime, bellek, token TTL, son hata |
| `POST` | `/auth/refresh` | Token'i manuel yeniler (kurtarma/debug) |
| `POST` | `/auth/token` | Çalışırken taze JWT yapıştır (**imza doğrulamalı**, redeploy gerekmez) |
| `GET` | `/token/verify` | JWT imzasını Suno JWKS anahtarlarıyla doğrular |
| `POST` | `/generate-beat` | Beat/müzik üretir |
| `GET` | `/clips?ids=a,b,c` | Klip durumlarını sorgular (ham Suno yanıtı) |
| `GET` | `/track/:id` | **Tek klip durumu + şarkı bilgisi** (`?wait=true` ile bekler) |
| `GET` | `/health` (handshake durumu) | son handshake sonucu, session id, milestone'lar |
| `GET` | `/providers` | Aktif sağlayıcı + yapılandırma durumu |
| `POST` | `/providers/select` | Runtime sağlayıcı değiştirme `{ "provider": "mock" }` |
| `GET` | `/debug/signer` | **İmza motoru teşhisi** — strateji, üretilen URL, `?probe=1` bayt ölçümü, `?compare=1` imzalı/imzasız A/B |
| `POST` | `/debug/signer/pool` | Havuza elle imza parametresi ekle `{ clip_id, params, ttl_ms }` |
| `DELETE` | `/debug/signer/pool` | Havuzdan kayıt sil (`?key=`) veya tümünü temizle |
| `GET` | `/debug/tls` | **TLS parmak izi ölçümü** — JA3/JA4/cipher (profil A/B) |
| `GET` | `/debug/stream/:id` | **Teşhis** — upstream status, bayt sayısı, magic byte, header'lar |
| `GET` | `/download` | **Akış köprüsü** — `?id=` / `?url=`, `?mode=stream`, `?format=mp3` (SSRF korumalı) |
| `GET` | `/stream/:id` | **Tarayıcı dostu ses akışı** — `<audio src>` için drop-in, ffmpeg ile MP3'e çevirir |

### `POST /generate-beat`

```bash
curl -X POST https://SENIN-SERVIS.onrender.com/generate-beat \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "prompt": "Hard trap beat, 140bpm, dark piano melody, 808 slides, no vocals",
    "make_instrumental": true
  }'
```

Opsiyonel alanlar:

| Alan | Tip | Varsayılan |
|---|---|---|
| `tags` | string | `""` |
| `title` | string | `""` |
| `model` | string | `chirp-v4` (`SUNO_MODEL` env) |
| `wait` | boolean | `false` — `true` ise klip `complete` olana kadar bekler |
| `waitTimeoutMs` | number | `180000` (max 300000) |
| `extra` | object | `{}` — Suno payload'ına olduğu gibi eklenir |

**Yanıt:**

```json
{
  "ok": true,
  "request": { "prompt": "...", "make_instrumental": true, "model": "chirp-v4" },
  "clip_ids": ["b7c1..."],
  "clips": [ { "id": "b7c1...", "status": "submitted", "...": "..." } ],
  "waited": false,
  "wait_timed_out": false,
  "suno": { "...": "Suno'nun ham yanıtı" }
}
```

**Hata formatı** (her zaman aynı zarf):

```json
{ "ok": false, "error": { "code": "SUNO_AUTH_FAILED", "message": "...", "detail": "..." } }
```

| Kod | HTTP | Anlamı |
|---|---|---|
| `INVALID_PROMPT` | 400 | `prompt` boş / 2000+ karakter |
| `UNAUTHORIZED` | 401 | `API_KEY` hatalı/eksik |
| `SUNO_AUTH_FAILED` | 502 | `__client` süresi dolmuş ya da `browser-token` gerekiyor |
| `INSUFFICIENT_CREDITS_OR_FORBIDDEN` | 402 | Kredi bitti |
| `RATE_LIMITED` | 429 | Suno rate limit |
| `UPSTREAM_TIMEOUT` | 504 | Suno 30 sn içinde yanıt vermedi |

---

## 3. Token yaşam döngüsü (nasıl 7/24 ayakta kalıyor?)

```
            __client cookie (env)
                     │
        ┌────────────▼─────────────┐
        │ GET  clerk/v1/client     │  → session_id + last_active_token.jwt
        │ POST .../sessions/{id}/  │  → taze JWT (Bearer)
        │        tokens            │
        │ POST .../sessions/{id}/  │  → oturumu "aktif" işaretle
        │        touch             │
        └────────────┬─────────────┘
                     │
   setInterval(15 dk) │  + her istekte "exp - 5 dk" kontrolü
                     ▼
        studio-api.prod.suno.com/api/generate/v2/
```

- **Keep-alive:** açılışta 1 kez + her `KEEPALIVE_INTERVAL_MS` (15 dk) bir `touch` + `tokens`.
- **Lazy refresh:** token süresi bitmeye 5 dk kaldıysa istek öncesi yenilenir → kullanıcı asla "expired token" görmez.
- **Retry-on-401:** Suno 401/403 dönerse token zorla yenilenip istek **1 kez** tekrar edilir.
- **Session id eskimesi:** `tokens` çağrısı patlarsa session id Clerk'ten yeniden çözülür, ardından `last_active_token.jwt` fallback'i devreye girer.

---

## 4. Render Free Tier'a deploy

1. Repoyu GitHub'a push edin.
2. Render → **New → Web Service** → repoyu seçin.
3. Ayarlar:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. **Environment** sekmesinde şunları ekleyin:
   - `SUNO_REFRESH_TOKEN` (**zorunlu**, Secret olarak)
   - `API_KEY` (önerilir — servisi herkese açık bırakmayın)
   - `NODE_ENV=production`
   - `NODE_OPTIONS=--max-old-space-size=384` (512 MB instance'ta güvenli tavan; opsiyonel)
5. **UptimeRobot:** HTTP(s) monitor → `https://SENIN-SERVIS.onrender.com/ping` → 5 dakikada bir.
   Render free instance'ları **15 dk hareketsizlikte uykuya** girer; `/ping` bunu engeller.
   > Not: Render free tier'da aylık 750 instance-saat sınırı vardır; 7/24 çalıştırmak bunu tek servisle doldurur.

`render.yaml` dosyası da hazır — **Blueprint** olarak bağlarsanız servis otomatik oluşur.

---

## 5. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `SUNO_AUTH_FAILED` | `__client` cookie'si eskimiş → tarayıcıdan yenisini alın. |
| `401` + `browser-token` uyarısı | DevTools → `generate` isteğinin header'larından `browser-token` ve `device-id` değerlerini `.env`'e ekleyin. |
| `404` / `405` generate'de | `SUNO_GENERATE_PATH`'i `/api/generate/v2-web/` olarak değiştirin. |
| Clerk 403 | `CLERK_BASE_URL=https://auth.suno.com` deneyin. |
| `402` | Suno krediniz bitti (ücretsiz hesaplarda günlük limit var). |
| UptimeRobot 502 | Render uyanıyor; ilk istekte 30–60 sn gecikme normaldir. |

---

## 6. Yasal uyarı

Bu proje **Suno ile ilişkili değildir**, resmi bir API değildir. Suno Hizmet Şartları'nı (ToS) ihlal edebilir; hesabınızın askıya alınmasına yol açabilir. Yalnızca **kendi hesabınızla**, kişisel/araştırma amaçlı kullanın ve riski üstlenin. Ticari bir üründe kullanacaksanız Suno'nun resmi partner/API programını bekleyin.

---

## 7. 🔬 Reverse-engineering notları (canlı doğrulanmış, 2026-10)

Suno'nun web bundle'ı (`/_next/static/immutable/chunks/2uv-qdm-0aanh.js`) incelenerek
kimlik doğrulama katmanının tamamı çıkarıldı:

```js
// Browser-Token üretimi (her istekte yeniden hesaplanır):
const r = JSON.stringify({ token: btoa(JSON.stringify({ timestamp: Date.now() })) });
headers["Browser-Token"] = r;              // {"token":"eyJ0aW1lc3RhbXAiOj...=="}

// Cihaz kimliği: suno_device_id cookie'sinden
headers["Device-Id"] = getCookie("suno_device_id");

// Yetkilendirme: Clerk'in canlı oturum token'ı (60 dk ömürlü)
headers["Authorization"] = `Bearer ${await clerk.session.getToken()}`;
```

> ⚠️ `Browser-Token` değeri **düz base64 değil**, içinde base64 taşıyan bir JSON
> string'idir. Düz base64 göndermek 401 ile sonuçlanır.

### Doğrulanan uç noktalar

| Uç nokta | Durum |
|---|---|
| `GET studio-api.prod.suno.com/api/session/` | 200 (auth gerektirmez — canlılık testi için kullanılabilir) |
| `GET /api/profiles/<handle>` | 200 (public) |
| `GET /api/feed/v2`, `/api/billing/info/`, `POST /api/generate/v2/` | 401 (Bearer zorunlu) |
| `studio-api.suno.ai` | 503 Service Suspended (kullanımdan kaldırıldı) |
| `clerk.suno.com/v1/client/sessions/{sid}/tokens` | `__client` cookie'si olmadan **403 client_not_found** |

### Neden 401?

`__session` cookie'sindeki JWT süresi dolmamış olsa bile (`exp` +56 dk) Suno onu
reddetti. Suno'nun API'si token'ı **istek anında Clerk'ten alınmış** olarak görüyor;
bu yüzden ya `__client` cookie'si (otomatik yenileme) ya da taze bir
`await window.Clerk.session.getToken()` çıktısı gerekiyor.

### Token imza doğrulaması (`/token/verify`)

Servis, yapıştırılan JWT'yi Suno'nun `auth.suno.com/.well-known/jwks.json`
anahtarlarıyla doğrular (JWKS 1 saat cache'lenir → ek bellek/istek yok).
Kopyalama sırasında bozulmuş bir token `TOKEN_SIGNATURE_INVALID` ile anında
reddedilir; böylece bozuk token'la Suno'ya gidip 401 yemezsin.

```bash
# yerel doğrulama (sunucu çalıştırmadan)
node tools/verify-token.js --file token.txt

# servis üzerinden
curl "https://SERVIS.onrender.com/token/verify?token=eyJ..."
```

Örnek çıktı:

```json
{ "signatureValid": true, "expired": false, "expiresInSeconds": 2981,
  "sessionId": "session_c4e0...", "handle": "steadfastballade585", "length": 1629 }
```

---

## 8. 🎧 CANLI TEST SONUÇLARI (19 Ekim 2026 — gerçek üretim)

Servis uçtan uca çalıştı: token → generate → poll → tamamlanmış klipler.

### Doğrulanan gerçek API sözleşmesi

| Alan | Değer |
|---|---|
| Host | `https://studio-api-prod.suno.com` (tire ile; `studio-api.prod…` de aynı backend) |
| Generate | `POST /api/generate/v2-web/` |
| Feed / durum | `GET /api/feed/v2?ids=<clip_id,...>` |
| Billing | `GET /api/billing/info/` |
| Auth | `Authorization: Bearer <Clerk JWT>` + `Browser-Token` + `Device-Id` |

### Model yetkileri (Free plan)

| Model | Sonuç |
|---|---|
| `chirp-v3-5` | ✅ **200** — çalışıyor |
| `chirp-v4`, `chirp-v4-5`, `chirp-bluejay`, `chirp-fenix` | ❌ 403 `permission_denied` ("Upgrade your plan") |

Kod artık `MODEL_FALLBACK` zinciriyle bunu otomatik yönetiyor: model reddedilirse
sıradaki denenir, hepsi reddedilirse anlamlı `403 MODEL_NOT_AVAILABLE` döner.

### Örnek çıktı (canlı)

```json
{ "ok": true,
  "clip_ids": ["afaea7cd-…", "3f6bb972-…", "fcab18f8-…", "a563be56-…"],
  "clips": [{ "id": "afaea7cd-…", "status": "submitted",
              "song_url": "https://suno.com/song/afaea7cd-…" }] }
```

~15 saniye sonra 4 klip de `complete` oldu (40–75 sn, enstrumantal, drift/dark/145bpm).

### Notlar

- Ücretsiz hesapta `audio_url` alanı `/api/forbidden` döner → **doğrudan MP3 indirme yok**,
  dinleme `https://suno.com/song/<id>` üzerinden yapılır. (Pro planda CDN linki gelir.)
- Ücretsiz plan isteği başına **4 klip** üretir (2 değil), günlük kota ~300 kredi.
- `Device-Id` zorunlu değil gibi görünüyor; `Browser-Token` ise zorunlu.
- Art arda hızlı isteklerde `429 Too many requests` gelir → kredi değil, rate-limit.

---

## 9. 🔁 Polling ve indirme uç noktaları

### `GET /track/:id` — durum sorgulama

`/generate-beat` anında `submitted` döner; ses birkaç saniye sonra hazır olur.
Bu uç nokta klibi `feed/v2` üzerinden sorgular ve **normalize edilmiş** bir nesne döner.

```bash
curl "https://SERVIS.onrender.com/track/afaea7cd-244b-4b00-9a5b-93152f74d285"
curl "https://SERVIS.onrender.com/track/afaea7cd-...?wait=true&waitTimeoutMs=120000"
```

```json
{ "ok": true,
  "track": {
    "id": "afaea7cd-…", "status": "complete", "is_complete": true, "is_error": false,
    "title": "Proxy Test", "tags": "drill, dark, 145bpm",
    "prompt": "Dark drill beat, 145bpm, sliding 808 bass…",
    "duration_seconds": 54.72, "model": "chirp-hawk",
    "created_at": "2026-10-19T03:20:36.156Z",
    "image_url": "https://cdn2.suno.ai/image_….jpeg",
    "song_url": "https://suno.com/song/afaea7cd-…",
    "audio_url": null,
    "download_url": "/download?id=afaea7cd-…",
    "stream_url": null,
    "download_blocked_reason": "Suno ucretsiz planda indirilebilir MP3 vermiyor…"
  },
  "waited": false, "wait_timed_out": false }
```

| Parametre | Etki |
|---|---|
| `?wait=true` | `complete`/`error` olana kadar 4 sn arayla poll eder |
| `?waitTimeoutMs=` | Bekleme üst sınırı (varsayılan 120000, max 300000) |
| `?raw=1` | Suno'nun ham klip nesnesini de ekler |

Durumlar: `submitted` → `queued` → `streaming` → `complete` (veya `error`).

### `GET /download` — akış köprüsü

```bash
# Klip id'si ile (gerçek audio_url'yi sunucu çözer)
curl -OJ "https://SERVIS.onrender.com/download?id=<clip_id>"

# Doğrudan URL ile (allowlist zorunlu)
curl -OJ "https://SERVIS.onrender.com/download?url=https://cdn1.suno.ai/xxxx.mp3"

# Tarayıcıda oynat (attachment yerine inline)
curl "…/download?id=<clip_id>&inline=1"

# Dosya adını override et
curl -OJ "…/download?url=…&filename=midnight-808.mp3"
```

**Özellikler**

- `responseType: 'stream'` + `upstream.data.pipe(res)` → **dosya belleğe alınmaz** (512 MB için kritik)
- `Content-Type`, `Content-Length`, `Content-Disposition` otomatik aktarılır
- `Access-Control-Allow-Origin` + `Expose-Headers` → frontend `fetch` ile indirebilir
- İstemci bağlantıyı keserse upstream stream de kapatılır (socket sızıntısı yok)
- `HEAD /download` destekli

### 🔒 SSRF koruması (önemli)

`?url=` parametresi sunucunun iç ağa erişmesini engelleyecek şekilde kilitli:

| Saldırı denemesi | Sonuç |
|---|---|
| `http://169.254.169.254/latest/meta-data/` | **403** (şema https değil) |
| `https://127.0.0.1/x` | **403** (IP literal) |
| `http://localhost:6379/` | **403** |
| `https://evil.com/x.mp3` | **403** (allowlist) |
| `https://suno.ai.evil.com/x` | **403** (suffix hilesi engellendi) |
| `file:///etc/passwd` | **403** |

Ek olarak **redirect hedefi de** aynı kontrolden geçer (open-redirect ile atlatma engeli).
Allowlist `DOWNLOAD_ALLOWED_HOSTS` ile genişletilir — `*` **kullanmayın**.

### ⚠️ Ücretsiz plan sınırı

Free planda Suno `audio_url` yerine `https://…/api/forbidden` döndürüyor; `audiopipe.suno.ai`
ise şifreli veri veriyor (web player client-side çözüyor). Bu yüzden:

- `GET /download?id=<free_clip>` → **409 `NO_DOWNLOADABLE_AUDIO`** (açıklayıcı mesajla)
- `GET /download?url=<gerçek CDN mp3>` → **çalışır** (Pro planda `audio_url` gerçek link olur)
- Görseller (`image_url`) her planda indirilebilir — test edildi: 14.193 baytlık geçerli JPEG aktarıldı.

Dinleme her planda `https://suno.com/song/<id>` üzerinden yapılabilir.

---

## 10. 🌉 Stream Bridge (FFmpeg) — mimari ve sınırlar

### Akış hattı

```
            ┌──────────────────────────────────────────────┐
istemci ───▶│ GET /stream/:id?format=mp3                   │
            │   veya /download?id=…&mode=stream            │
            └───────────────┬──────────────────────────────┘
                            │
                  1) feed'den klip çöz (audio_url)
                            │
              ┌─────────────┴─────────────┐
              │ audio_url gerçek mi?      │
              └──────┬─────────────┬──────┘
             evet    │             │  hayır (/api/forbidden)
                     ▼             ▼
       2) axios stream      409 NO_DOWNLOADABLE_AUDIO
          (responseType:stream)   + plan açıklaması
                     │
       3) ENABLE_TRANSCODE && format=mp3 ?
                     │
          ┌──────────┴──────────┐
         evet                 hayır
          │                     │
   ffmpeg (pipe:0→pipe:1)   doğrudan pipe
          │                     │
          └──────────┬──────────┘
                     ▼
              res (chunked)
```

### FFmpeg komutu

```js
spawn(ffmpegPath, [
  '-hide_banner','-loglevel','error','-nostdin',
  '-i','pipe:0','-vn','-map_metadata','-1',
  '-acodec','libmp3lame','-b:a','128k','-f','mp3','pipe:1'
])
```

`ffmpeg-static` (76 MB, **disk**) npm ile gelir; `FFMPEG_PATH` ile override edilebilir.
Yoksa servis çökmez — `X-Transcode: none` ile passthrough'a düşer.

### Bellek ve temizlik garantileri

| Garanti | Nasıl |
|---|---|
| Dosya belleğe alınmaz | `responseType: 'stream'` + `upstream.pipe(ffmpeg.stdin)` + `ffmpeg.stdout.pipe(res)` |
| Backpressure korunur | Node `pipe()` otomatik uygular, `data` event'i dinlenmez |
| İstemci iptalinde süreç kapanır | `res.on('close') → cleanup()` |
| Zombie süreç yok | `SIGTERM` → 2 sn sonra `SIGKILL` |
| Socket sızıntısı yok | upstream stream `destroy()` + idempotent `cleanup()` |
| ffmpeg yoksa | graceful passthrough, 502 `TRANSCODER_UNAVAILABLE` sadece spawn hatasında |

**Canlı test sonuçları**

| Test | Sonuç |
|---|---|
| 264 KB WAV → `?format=mp3` | 200, **48.527 bayt**, `ID3` magic ✅ |
| `X-Transcode` başlığı | `ffmpeg:mp3` |
| Transcode'suz istek | `X-Transcode: none`, 264 KB, `audio/x-wav` |
| 10 MB kaynak, 1.5 sn'de iptal | **0 ffmpeg süreci sızdı** (5 sn sonra da 0) |
| Transcode sırasında RSS | **76 MB** (512 MB limitinin %15'i) |
| `/stream/<free_clip>` | 409 `NO_DOWNLOADABLE_AUDIO` |

### ⚠️ Neden ücretsiz plan sesi çözülmüyor

Suno ücretsiz planda sesi **DRM ile** koruyor. Bundle'dan çıkarılan şema:

```js
guestKey = AES-GCM.importKey(SHA256(guestToken))          // lisans sunucusundan
ctrKey   = AES-GCM.decrypt(blob, iv=blob[0..12], AAD=guestToken, key=guestKey)
plain    = AES-CTR.decrypt(stream, counter=iv+blockIndex, length=128)
```

`audiopipe.suno.ai`'nin döndürdüğü `eb2a1935…` verisi şifreli; **FFmpeg bunu
çözemez** (MP3/WebM magic yok → "Invalid data found"). `ffmpeg` bir transcode
aracıdır, DRM çözücü değildir.

Bu katmanı aşan kod **bilerek eklenmedi**: içerik korumasını kırmak
(DMCA §1201 / 5846 m.72) ayrı bir hukuki ihlaldir ve ToS ihlalini ağırlaştırır.
Ayrıca Suno algoritmayı değiştirdiğinde kırılır.

**Pro/Pro+ hesapta** `audio_url` gerçek CDN linki olur → `/stream/:id` ve
`/download` **hiçbir kod değişikliği olmadan** çalışır.

### Meşru alternatifler

| İhtiyaç | Çözüm |
|---|---|
| Kendi uygulamanda programatik beat | Suno Pro (~$8–10/ay) → bu servis aynen çalışır |
| Ücretsiz + ticari kullanım | Replicate (MusicGen/Metamusic), Stability Audio, ElevenLabs Music, Mubert — hepsi resmî API |
| Provider değişebilir mimari | `/generate-beat` + `/track` arayüzünü koruyup arka ucu değiştir (aşağıdaki not) |

> İpucu: `/generate-beat` ve `/track/:id` zaten provider-agnostik bir sözleşme
> sunuyor (`clip_ids`, `status`, `song_url`). Suno'yu bırakıp resmî API'li bir
> sağlayıcıya geçersen yalnızca `sunoRequest()` katmanını değiştirmen yeterli;
> uygulama tarafında hiçbir şey değişmez.

---

## 11. 🔧 Transform tabanlı akış + HTTP Range desteği

Ücretsiz plan sesi **çözülmüyor** (bkz. §10 — DRM katmanı bilerek aşılmıyor).
Bu bölüm, akış altyapısının kendisini anlatır: saf Node.js `stream.Transform`,
üçüncü parti binary yok, bellek sabit.

### `ByteRangeTransform`

Bazı upstream'ler (örn. `audiopipe`) `Range` başlığını **yok sayar** ve her zaman
`200 + tam gövde` döner. Tarayıcı ise `<audio>` ile seek ederken `Range` ister.
`ByteRangeTransform` tam gövdeyi indirirken istenen bayt aralığını ayıklar:

```js
class ByteRangeTransform extends Transform {
  _transform(chunk, _enc, cb) {
    // yalnızca sayaç tutulur; chunk subarray ile dilimlenir, kopya yok
    const localStart = Math.max(0, this.start - chunkStart);
    const localEnd   = this.end === null ? chunk.length - 1
                                         : Math.min(chunk.length - 1, this.end - chunkStart);
    if (localEnd >= localStart) {
      this.push(chunk.subarray(localStart, localEnd + 1));   // ← doğrudan push
    }
    if (this.end !== null && chunkStart + localEnd >= this.end) this.emit('range:done');
    cb();
  }
}
```

- `this.push()` yalnızca istenen aralıkta çağrılır → **backpressure korunur**
- Aradaki baytlar okunur ama aktarılmaz → RAM'de birikme yok
- `range:done` event'i upstream'i erken kapatır (gereksiz indirme yok)

### `/download` ve `/stream` davranış matrisi

| Durum | Davranış |
|---|---|
| Range yok | `200` + tam gövde, `Accept-Ranges: bytes` |
| Range var, upstream **destekliyor** (206) | `206` + upstream'in `Content-Range`'i aynen geçirilir |
| Range var, upstream **yok sayıyor** (200) | `206` + `ByteRangeTransform` ile sunucu tarafı dilimleme |
| `bytes=-N` (son N bayt) | `206` + `Content-Range: bytes …/total` |
| `bytes=X-` (X ≥ boyut) | `416` + `Content-Range: bytes */total` |

### Canlı test sonuçları (524.288 baytlık kaynak, upstream Range'i yok sayıyor)

| İstek | Yanıt | Doğrulama |
|---|---|---|
| (Range yok) | `200`, 524.288 bayt | — |
| `bytes=1000-1999` | `206`, 1.000 bayt | `cmp` ile **bayt bayt aynı** ✅ |
| `bytes=-100` | `206`, 100 bayt, `bytes 524188-524287/524288` | ✅ |
| `bytes=600000-` | `416`, `bytes */524288` | ✅ |
| Upstream 206 destekliyorsa | `206` + upstream `Content-Range` geçirildi | ✅ |
| İstemci iptali | upstream socket kapatıldı, süreç sızıntısı yok | ✅ |

**Bellek:** 60 MB RSS (istek sırasında da sabit — dosya boyutuyla artmaz).

### Neden `SunoAudioDecryptor` yok

`audiopipe`'tan gelen baytlar AES-CTR ile şifreli; anahtar `SHA256(guestToken)`'dan
türetilip lisans sunucusundan AES-GCM ile sarılıyor. Bir `Transform` içinde bunu
çözmek **teknik olarak mümkün** — ama yaptığı şey DRM aşmak olur; Playwright ile
aynı sonuca çıkar. Bu proje o katmanı içermiyor (§10'daki gerekçe).

`ByteRangeTransform` gibi bileşenler ise sağlayıcıdan bağımsız: Pro hesapta,
Replicate'te veya herhangi bir resmî API'de aynen çalışır.

---

## 12. 🌐 Transparent proxy modu

`/stream/:id` ve `/download?id=` artık plan kontrolü yapmıyor. Kaynak çözümü:

```
audio_url gerçek CDN linki  ->  mode=cdn          (transcode opsiyonel)
audio_url = /api/forbidden  ->  mode=transparent  (AUDIOPIPE_URL_TEMPLATE)
```

**Transparent modda sunucu tek bayt değiştirmez:** kriptografi yok, transform yok,
transcode yok. `upstream.pipe(res)` + Range desteği. Yanıtta `X-Proxy-Mode: transparent`
başlığı görünür. `Content-Type`, `Content-Length`, `Content-Range` upstream'den geçer.

```bash
curl -D - "https://SERVIS.onrender.com/stream/<clip_id>"
# HTTP/2 200
# content-type: audio/mp3
# accept-ranges: bytes
# x-proxy-mode: transparent
# x-transcode: none
```

### Ölçüm (2026-10-19)

| Zaman | `audiopipe` gövdesi |
|---|---|
| 03:24 UTC | 1.283.573 bayt (şifreli blok) |
| 03:52–03:54 UTC | **0 bayt** (tüm kliplerde, auth'lu/auth'suz, mp3/webm/range fark etmeksizin) |

Yani proxy hattı doğru çalışıyor (`200`, `audio/mp3`, `X-Proxy-Mode: transparent`)
ancak upstream şu an boş gövde döndürüyor. Sebep istemci tarafında değil; Suno'nun
`audiopipe` servisi item başına imzalı/oturum bağlı bir akış veriyor gibi görünüyor.
`AUDIOPIPE_URL_TEMPLATE` ile parametreler değiştirilebilir.

---

## 13. 🔍 Header/cookie forwarding + teşhis

### Forwarding

`/stream`, `/download` ve `/debug/stream` upstream'e şu başlıkları gönderir:

| Başlık | Kaynak |
|---|---|
| `User-Agent` | `UPSTREAM_USER_AGENT` veya dahili Chrome UA |
| `Origin` / `Referer` | `UPSTREAM_ORIGIN` / `UPSTREAM_REFERER` |
| `Cookie` | `SUNO_COOKIE_JAR` (ham) → yoksa `__session` + `__client` + `suno_device_id` |
| `Browser-Token` | her istekte yeniden üretilir |
| `Device-Id` | `SUNO_DEVICE_ID` |
| `Range` | **istemciden aynen** |
| `Accept-Language`, `Sec-Fetch-*` | sabit tarayıcı değerleri |

### `GET /debug/stream/:id`

Akışı istemciye göndermez; bağlanıp ilk N baytı okur ve raporlar.

```bash
curl "https://SERVIS.onrender.com/debug/stream/<clip_id>?bytes=65536"
curl "https://SERVIS.onrender.com/debug/stream/<clip_id>?skipCookie=1"   # A/B
curl "https://SERVIS.onrender.com/debug/stream/<clip_id>?download=1"     # ham baytları indir
```

Rapor: `upstream.status`, `content_type`, `content_length`, `content_range`,
`request_headers_sent` (cookie isimleri, değerler gizli), `body.bytes_read`,
`first_16_bytes_hex`, `detected_format` (`ID3/MP3`, `MPEG-frame/MP3`, `WebM/Matroska`,
`opaque`, `EMPTY`), `diagnosis`.

### Boş yanıt davranışı

Üç ayrı durum ayrı raporlanır:

| Durum | HTTP | Kod | Başlık |
|---|---|---|---|
| `Content-Length: 0` | 502 | `UPSTREAM_EMPTY` | `X-Upstream-Status: 200-empty` |
| Bağlandı, hiç bayt gelmedi | 502 | `UPSTREAM_EMPTY` + teşhis | `X-Upstream-Status: 200-empty` |
| 8 sn veri yok | 504 | `UPSTREAM_STALLED` | `X-Upstream-Status: 200-stalled` |

Bunun için `peekFirstChunk()` ilk chunk'ı **başlıklar gönderilmeden önce** dikizler,
chunk'ı `unshift()` ile geri koyar. Böylece hatasız durumda akış hiç bozulmaz
(regresyon testi: 200 KB dosya → `200`, 200.000 bayt, `ID3` ✅; `Range` → `206` ✅).

### A/B ölçümü (2026-10-19, 04:00 UTC)

Hipotez: "0 bayt, cookie/header forward edilmediği için."

| Deney | Cookie | bytes_read |
|---|---|---|
| A — tam header seti | `__session`, `suno_device_id` | **0** |
| B — `?skipCookie=1` | yok | **0** |
| C — 6 çerezlik tam jar | `__session`, `__client_uat`, `suno_device_id`, `suno_session_recoverable`, `has_logged_in_before`, `__obref` | **0** |

Üç durumda da `upstream status = 200`, `content-type: audio/mp3`, `bytes_read = 0`.
Yani boş gövde **header/cookie eksikliğinden kaynaklanmıyor**; upstream servis tarafı
aynı anda hem 1.283.573 bayt (03:24) hem 0 bayt (03:52+) döndürebiliyor.
`SUNO_COOKIE_JAR` desteği yine de eklendi — elinde imzalı bir URL/cookie varsa
`AUDIOPIPE_URL_TEMPLATE` ve bu değişkenle test edebilirsin.

---

## 14. 🤝 Session handshake (akis öncesi adım)

`/stream/:id` ve `/download?id=` artık akıştan önce iki adım çalıştırıyor:

```
1) GET  /api/user/get_user_session_id/        -> { session_id }
2) POST /api/gen/{id}/listen_milestone        -> { milestone: "5s" | "30s" | "60s" }
```

Sonuç `X-Handshake` başlığında: `ok` · `partial` · `failed` · `disabled`.
**Akışı asla bloklamaz** — hata olursa loglanır, pass-through devam eder.
`session_id` upstream başlıklarına `X-Session-Id` olarak eklenir.

Ayarlar: `ENABLE_SESSION_HANDSHAKE`, `HANDSHAKE_MILESTONES=5s,30s`, `HANDSHAKE_TIMEOUT_MS`.
Durum `/health` → `handshake` bloğunda.

### Canlı doğrulama (2026-10-19, 04:15 UTC)

| Adım | Sonuç |
|---|---|
| `GET /api/user/get_user_session_id/` | **200**, auth'suz çalışıyor, 64 karakterlik hex |
| `POST /api/gen/<id>/listen_milestone` `{"milestone":"5s"}` | **200** `null` |
| `{"milestone":"30s"}` / `{"milestone":"60s"}` | **200** `null` |
| Geçersiz şema (`{"milestone":15}`, `{"spec":{…}}`) | 422 — beklenen literal: `'5s' \| '30s' \| '60s'` |

**Handshake sonrası akış ölçümü:** `audiopipe` hâlâ **0 bayt** (mp3 ve webm'de).

| Deneme | bytes |
|---|---|
| handshake öncesi | 0 |
| `session_id` alındıktan sonra | 0 |
| `session_id` query param olarak | 0 |
| `Cookie: suno_session_id=…` | 0 |
| 5s + 30s + 60s milestone tetiklendikten sonra | 0 |

Kaynak kodda bu iki çağrının rolü: `get_user_session_id` **analytics session id**
için (`"Error in extending analytics session id"`), `listen_milestone` ise
`timeupdate` olayında **telemetri** için çağrılıyor (`emitListenMilestone`).
Yani akış yetkisi vermiyorlar; handshake eklendi ve gözlemlenebilir hale geldi,
ancak 0 bayt davranışını değiştirmedi.

---

## 15. 🔐 TLS parmak izi (JA3/JA4) profili

### Ne yapıldı

`CHROME_TLS_PROFILE=true` iken upstream istekleri özel bir `https.Agent` üzerinden gider:

```js
new https.Agent({
  keepAlive: true, maxSockets: 32, maxFreeSockets: 8,
  minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
  ciphers: CHROME_CIPHER_SUITES,          // Chrome 126 sırasıyla, 15 suite
  ecdhCurve: 'X25519:P-256:P-384',
  ALPNProtocols: ['http/1.1'],            // axios http/1.1 konuşuyor
  honorCipherOrder: true,
  secureOptions: SSL_OP_NO_RENEGOTIATION | SSL_OP_NO_COMPRESSION,
});
```

### Ölçüm (`GET /debug/tls`, 2026-10-19 04:22 UTC)

| Profil | JA3 hash | JA4 |
|---|---|---|
| `node-default` | `0cce74b0d9b7f8528fb2181588d23793` | `t13d5910_a33745022dd6_1f22a2ca17c4` |
| `chrome-like` | `c1c467bd8e4cc80dd23c43d18a6fe952` | `t13d1611h1_1711a4c0508c_1f22a2ca17c4` |
| Gerçek Chrome 126 (referans) | farklı | farklı |

Cipher sırası Chrome ile **birebir aynı** (`4865-4866-4867-49195-49199-…`),
ama JA3 hash'i eşleşmiyor. Sebep:

| Bileşen | Node ile kontrol edilebilir mi? |
|---|---|
| Cipher suite listesi + sırası | ✅ evet |
| TLS sürüm aralığı | ✅ evet |
| ECDH eğrileri | ✅ evet |
| ALPN | ✅ evet |
| **TLS uzantı sırası** | ❌ OpenSSL belirler |
| **GREASE değerleri** | ❌ eklenemiyor |
| **HTTP/2 SETTINGS çerçevesi** | ❌ ayrı istemci gerekir |

Yani Node yerleşikleriyle *kısmi* parmak izi değişimi mümkün; **tam Chrome
impersonation** için `curl-impersonate`, `uTLS` veya `cycletls` gibi ek ikili
gerekir — ki bunlar senin "harici ağır binary yok" kısıtına aykırı.

### Hipotez testi: TLS fingerprint mi?

| Kanıt | Sonuç |
|---|---|
| Aynı Node TLS yığını 03:24'te | **1.283.573 bayt** aldı |
| chrome-like profil ile `audiopipe` | **0 bayt** |
| `node-default` profille `audiopipe` | **0 bayt** |
| Yanıt imzası | `200` + `server: uvicorn` + `content-type: audio/mp3` |

Cloudflare'in JA3/JA4 engeli tipik olarak `403` + challenge HTML üretir. Burada
origin sunucusu (`uvicorn`) `200` dönüyor ve gövde boş — yani istek edge katmanından
geçmiş. Ayrıca aynı TLS yığını 40 dakika önce 1,28 MB almıştı; parmak izi engeli
olsaydı o zaman da engellerdi.

**Sonuç:** İki TLS profili de aynı sonucu verdi (0 bayt). Profil yine de eklendi:
bazı WAF'lerde cipher/ALPN uyumsuzluğu gerçek sorun çıkarır ve maliyeti sıfır
(+0 MB bellek, RSS 57 MB).

---

## 16. 🧩 Multi-Provider mimarisi

`AUDIO_PROVIDER=suno|replicate|elevenlabs|mock` — sözleşme (`/generate-beat`,
`/track/:id`, `/stream/:id`, `/download`) **hiç değişmez**, istemcide sıfır değişiklik.

```
providers/
├── base.js        # sözleşme + ProviderError + yardımcılar
├── index.js       # registry (getProvider / setProviderName)
├── suno.js        # mevcut Suno mantığını sarar (init(ctx) ile iç fonksiyonları alır)
├── replicate.js   # meta/musicgen — resmi API, indirilebilir ses
├── elevenlabs.js  # /v1/music — resmi API, indirilebilir MP3 (bellek içi LRU)
└── mock.js        # API anahtarı olmadan test (gerçek WAV üretir)
```

### Sözleşme

```js
provider.isConfigured()                        -> boolean
provider.generate({prompt,tags,title,instrumental,model,extra})
                                               -> { clip_ids, clips, raw }
provider.getTrack(clipId)                      -> normalized clip | null
provider.getAudioSource(clipOrId)              -> { url, source, transparent } | null
provider.beforeStream?.(clipId)                -> (yalnızca Suno: handshake)
```

`internal://` URL'i döndüren sağlayıcılar (mock, elevenlabs) için ses
**bellekten** Range destekli akıtılır (`pipeInternalAudio`), dosya sistemi kullanılmaz.

### Uçtan uca test (mock, API anahtarı yok)

| Adım | Sonuç |
|---|---|
| `GET /providers` | `mock` aktif, `configured: true` |
| `POST /generate-beat` | `200`, `provider: mock`, `clip_ids: [...]` |
| `GET /track/:id` | `generating` → `?wait=true` → `complete` |
| `GET /stream/:id` | `200`, **529.244 bayt**, `audio/wav`, `RIFF` ✅ |
| `Range: bytes=1000-1999` | `206`, 1.000 bayt, `Content-Range: bytes 1000-1999/529244` ✅ |
| `GET /download?id=` | `200`, 529.244 bayt, `X-Proxy-Mode: internal:mock` ✅ |
| `POST /providers/select` | runtime değişim ✅ |

### Resmî API kullanımı

**Replicate**
```bash
AUDIO_PROVIDER=replicate
REPLICATE_API_TOKEN=r8_...
REPLICATE_MODEL=meta/musicgen
REPLICATE_DURATION=30
```
`POST /v1/predictions` → poll → `output` CDN URL'i → `/stream` doğrudan akıtır
(`audio_url` gerçek olduğu için indirme %100 çalışır).

**ElevenLabs Music**
```bash
AUDIO_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_MUSIC_LENGTH_MS=30000
```
Ses üretildiği anda belleğe alınır (LRU, `ELEVENLABS_MAX_CACHE_MB`, varsayılan 32 MB)
ve `/stream/:id` bellekten akıtır.

---

## 17. 🔗 Dinamik imzalı URL kabulü

`AUDIOPIPE_URL_TEMPLATE` artık istemciden gelen parametreleri kabul ediyor:

```bash
# 1) Şablonda yer tutucu
AUDIOPIPE_URL_TEMPLATE=https://audiopipe.suno.ai/?item_id={id}&sig={sig}&expires={expires}

# 2) İstemci parametreleri gönderir — proxy iletir
curl ".../stream/<clip_id>?sig=abc123&expires=1792384000"

# 3) Şablonda yeri yoksa da bilinen imza parametreleri otomatik eklenir:
#    sig, signature, expires, exp, expiry, token, t, ts, key, hmac,
#    nonce, policy, kid, session_id, sessionId, stream_id
```

Alternatif olarak istemci **tam imzalı URL**'i doğrudan verebilir (allowlist'e tabi):

```bash
curl ".../stream/<clip_id>?audio_url=https://audiopipe.suno.ai/?item_id=...&sig=..."
curl ".../stream/<clip_id>" -H "X-Audio-Url: https://audiopipe.suno.ai/?item_id=...&sig=..."
```

Doğrulama (gerçek çıktı):

| Girdi | Sonuç URL |
|---|---|
| `{sig}`+`{expires}` + query | `?item_id=CLIP-ID&sig=abc123&expires=1792384000` |
| `sig` yok | `?item_id=CLIP-ID&sig=&expires=1792384000` (boş bırakılır) |
| bilinmeyen anahtar | yok sayılır (sadece allowlist anahtarları eklenir) |

SSRF koruması tüm bu yollarda geçerli: yalnızca `DOWNLOAD_ALLOWED_HOSTS` + `*.suno.ai`.

---

## 18. 🧬 İmza motoru + Token Cache Pool (RE katmanı)

> **Bu bölümün özeti:** Statik RE, Suno'nun mevcut web bundle'ında audiopipe URL'sini
> **imzalayan bir kod olmadığını** gösterdi. Yine de istenen imza altyapısı kuruldu:
> üç strateji (`client` → `pool` → `derive`), TTL'li token havuzu ve `/debug/signer`
> ölçüm endpoint'i. Ölçüm sonucu: **imza eklemek bayt sayısını değiştirmiyor.**

### 18.1 Ne kuruldu

| Dosya | Satır | Görev |
|---|---|---|
| `utils/signer.js` | ~430 | Strateji motoru + spec dili + türetim fonksiyonları + RE özeti |
| `utils/signerPool.js` | ~250 | TTL'li token cache pool (LRU, single-flight, arka plan tazeleme) |
| `utils/reAnalyzer.js` | ~330 | Statik RE tarayıcısı (bundle'da imza izi arar) |
| `tools/scan-signer.js` | ~90 | Canlı/dizin taraması → `re/frontend-signature-analysis.json` |
| `tools/test-signer.js` | ~230 | 26 birim testi (`node tools/test-signer.js`) |
| `re/frontend-signature-analysis.json` | — | **Ölçüm çıktısı** (60 chunk, 3.7 MB, canlı) |

### 18.2 Strateji zinciri (`resolveAudioSource` içinde)

```
1. client  → istemci imzası      ?sig=...&expires=...   veya   X-Sign-Params: {"sig":"..."}
2. pool    → token cache havuzu  (TTL içinde taze kayıt)
3. derive  → SIGNER_SPEC         matematiksel türetim (varsayılan KAPALI)
4. none    → parametresiz şablon (eski davranış)
```

Yanıt başlıkları: `X-Sign-Strategy: client|pool|derive|none`, `X-Sign-Params: sig,ts,expires`.

### 18.3 Spec dili (`SIGNER_SPEC`)

```bash
# .env
SIGNER_ENABLED=true
SIGNER_SECRET=degistir-beni
SIGNER_SPEC='sig=hmac_sha256_hex({id}|{ts},{secret});ts={ts};expires={ts_plus:300}'
SIGNER_POOL_ENABLED=true
SIGNER_POOL_TTL_MS=120000
SIGNER_REFRESH_MS=30000
```

**Token'lar:** `{id}` `{ts}` `{ts_ms}` `{ts_plus:N}` `{nonce}` `{secret}` `{cookie:AD}` `{query:AD}` `{header:AD}` `{env:DEGISKEN}`

**Fonksiyonlar:** `sha256_hex` `sha256_b64url` `sha1_hex` `md5_hex` `md5_b64url`
`hmac_sha256_hex` `hmac_sha256_b64url` `hmac_sha1_hex` `b64` `b64url` `hex` `urlenc`
`upper` `lower` `unix` `unix_ms` `uuid` `nonce`

İç içe çağrı destekli: `sig=upper(sha256_hex({id}))`.

### 18.4 `/debug/signer`

```bash
# 1) Sadece strateji + üretilen URL (ağa çıkmaz)
curl ".../debug/signer?id=<clip_id>"

# 2) Gerçekten bayt akıyor mu? (ölçüm)
curl ".../debug/signer?id=<clip_id>&probe=1&bytes=65536"

# 3) A/B: imzalı vs imzasız — "imza fark yaratıyor mu?"
curl --get ".../debug/signer" \
     --data-urlencode 'url=https://audiopipe.suno.ai/?item_id=<id>&format=mp3&encoded=true' \
     --data-urlencode 'spec=sig=hmac_sha256_hex({id}|{ts},{secret});ts={ts}' \
     -d compare=1 -d probe=1
```

Yanıt (kısaltılmış):

```json
{
  "resolution": {
    "strategy": "derive",
    "params_keys": ["sig", "ts", "expires"],
    "params_redacted": { "sig": "4c0820…(64)", "expires": "1792384969" },
    "url": "https://audiopipe.suno.ai/?item_id=…&sig=4c0820…&ts=…&expires=…",
    "changed": true
  },
  "probe":          { "status": 200, "content_type": "audio/mp3", "bytes_read": 0, "empty": true },
  "probe_unsigned": { "status": 200, "content_type": "audio/mp3", "bytes_read": 0, "empty": true },
  "comparison": { "delta_bytes": 0, "verdict": "İMZA FARK YARATMIYOR…" }
}
```

Havuz yönetimi:

```bash
# Tarayıcıdan yakalanan GERÇEK imzayı havuza koy (proxy TTL boyunca kullanır)
curl -X POST ".../debug/signer/pool" -H 'Content-Type: application/json' \
  -d '{"clip_id":"<id>","params":{"sig":"…","expires":"…"},"ttl_ms":120000}'

curl -X DELETE ".../debug/signer/pool?key=<clip_id>"
curl -X DELETE ".../debug/signer/pool"          # tümünü temizle
```

### 18.5 Statik RE: ölçülen gerçekler

`node tools/scan-signer.js` (canlı, 60 chunk / 3.7 MB) çıktısı:

| Bulgu | Adet | Yorum |
|---|---|---|
| `url_searchparams` | 20 | URL kurulumu — imza değil |
| `aws_sigv4` | 6 | **AWS S3 presign** (yanlış pozitif) |
| `drm_aes` | 5 | AES-CTR / AES-GCM içerik şifreleme |
| `audiopipe_ref` | 3 | audiopipe referansı |
| `drm_guest_token` | 2 | anonim oynatma lisans token'ı (`glt`) |
| `sw_passthrough` | 1 | Service Worker URL builder |
| `drm_license` | 1 | `POST /api/mango/rights` |
| `sig_query` / `signature_key` / `expires_param` | **0** | **Akış URL'sinde imza parametresi YOK** |

Bulunan tek HMAC zinciri (`3wl712nemn6-u.js`) AWS SigV4'tür; audiopipe ile ilgisi yok.

**İstemcinin gerçek akış yolu** (`3w1p_8p7q7ofo.js`):

```js
// Service Worker passthrough — sadece 3 parametre, imza yok:
`${SW_BASE}/passthrough?contentId=<id>&src=<encryptedUrl>&contentType=clip`
```

**Şifreleme/anahtar yolu** (`1jho8g9y2zlb7.js` + `2t885o10jddmu.js`):

```js
POST /api/mango/rights  { content_params: { content_id, content_type } }  ->  { key, iv, glt }
AES-GCM(key = SHA-256(glt), iv = ilk 12 bayt, aad = content_id)  ->  AES-CTR anahtarı  ->  içerik
```

Yani eksik olan şey **imza değil, çözme anahtarı**. Bu depo kapsamı gereği (bkz. §12,
§7 kararları) içerik çözme/DRM katmanı **kod tabanına dahil edilmemiştir**; proxy
baytları bit-birebir aktarır.

### 18.6 Ölçüm sonuçları (19 Ekim 2026, canlı)

| Test | Sonuç |
|---|---|
| `node tools/test-signer.js` | **26 OK / 0 FAIL** |
| `node tools/scan-signer.js` (canlı, 60 chunk) | `IMZA IZI YOK` |
| `audiopipe` imzasız `probe` | `200`, `audio/mp3`, **0 bayt**, 5.08 s |
| `audiopipe` imzalı `probe` (HMAC spec) | `200`, `audio/mp3`, **0 bayt**, 5.19 s |
| `comparison.delta_bytes` | **0** → imza fark yaratmıyor |
| `pool` stratejisi (elle `PUT`) | `strategy: "pool"`, TTL içinde hit ✅ |
| `client` stratejisi (query + `X-Sign-Params`) | `strategy: "client"` ✅ |
| `/stream` dış kaynak + `derive` | `200`, **200 000 bayt** birebir, `X-Sign-Strategy: derive` ✅ |
| `/stream` Range | `206`, 100 bayt ✅ |
| Bellek (RSS) | **~60 MB** |

> **Not:** `probe` ölçümü, imzanın bayt sayısını değiştirmediğini *ölçerek* gösterir.
> Yani "0 bayt = imza eksikliği" hipotezi de (önceki cookie/TLS/handshake hipotezleri
> gibi) ölçümle **çürütülmüştür**. Kalan iki olasılık: (a) ücretsiz planda CDN/audiopipe
> erişimi kapalı, (b) klip medyası lisans ucu olmadan sunulmuyor.

### 18.7 Kapsam sınırı

Bu katman **yalnızca HTTP istek parametresi üretir**. İçerik şifresi çözme, AES
anahtarı üretme, DRM lisansı taklidi veya tarayıcı otomasyonu (Playwright/Chromium)
**yoktur**. `derive` stratejisi keşfedilmiş bir algoritma değil, **hipotez test
aracıdır**: spec'i siz doldurursunuz, `/debug/signer?compare=1` sonucu ölçer.

---

## 19. 🔐 API anahtarı + Web Dashboard + Render dağıtımı

### 19.1 API anahtarı katmanı

Korunan uçlar: `/generate-beat`, `/clips`, `/track/:id`, `/stream/:id`, `/download`,
`/providers`, `/providers/select`, `/auth/*`, `/debug/*`.
Açık uçlar: `/ping` (health check), `/health`, `/` (dashboard dosyaları).

Anahtar üç yoldan biriyle verilebilir:

```bash
curl -H "x-api-key: anahtar"          .../generate-beat
curl ".../stream/<id>?api_key=anahtar"          # <audio src> header gönderemez
curl -H "Authorization: Bearer anahtar" .../download?id=<id>
```

`.env`:

```bash
ALLOWED_API_KEYS=anahtar1,anahtar2      # virgülle ayrılmış liste
API_KEY=eski-tek-anahtar                # geriye uyumluluk (opsiyonel)
API_KEY_REQUIRED=false                  # true -> liste boşsa bile 401
```

Davranış:

| Durum | Sonuç |
|---|---|
| Anahtar doğru (3 yoldan biri) | istek geçer |
| Anahtar yok / yanlış | **`401 UNAUTHORIZED`** |
| `ALLOWED_API_KEYS` boş + `API_KEY_REQUIRED=false` | açık mod + başlangıçta uyarı |
| `ALLOWED_API_KEYS` boş + `API_KEY_REQUIRED=true` | **`401`** (sıkı mod) |

Karşılaştırma `crypto.timingSafeEqual` ile yapılır (zamanlama sızıntısı yok);
geçersiz denemeler ön eki maskelenerek loglanır (`abcd…`).

### 19.2 Web Dashboard (`public/index.html`)

Tek dosya, **harici bağımlılık yok** (CDN/font/script yok — 19 KB, inline CSS/JS).

- API anahtarı `localStorage`'da tutulur, isteklere `x-api-key` olarak eklenir;
  `<audio>` ve indirme linkleri `?api_key=` kullanır (header gönderemezler).
- İstem/tarz/başlık + enstrümantal anahtarı ile `/generate-beat`.
- Üretim sonrası `/track/:id` 3 sn'de bir yoklanır (60 deneme ≈ 3 dk).
- Tamamlanan parçalar `<audio controls>` ile çalınır, `⬇ MP3 indir` ile `/download`.
- Parça listesi `localStorage`'da kalır; sayfa yenilenince kaybolmaz.
- "Bağlantıyı test et" `/providers` çağırır → anahtar geçerliliğini anında gösterir.
- İstek/yanıt günlüğü açılır panelde (`<details>`).

### 19.3 Render dağıtımı

**Canlı servis:** https://muzik-apikey.onrender.com
(`ALLOWED_API_KEYS` panelden tanımlı; anahtarı Render > Environment bölümünden
görüp değiştirebilirsin. Ücretsiz planda 15 dk hareketsizlikte uykuya geçer.)

`render.yaml` blueprint olarak hazır: `plan: free`, `region: frankfurt`,
`buildCommand: npm install --omit=dev`, `startCommand: npm start`,
`healthCheckPath: /ping`, `autoDeploy: true`, `NODE_OPTIONS=--max-old-space-size=384`.

Panelden girilecek sırlar (`sync: false`): `SUNO_REFRESH_TOKEN`, `ALLOWED_API_KEYS`.

`PORT` ortam değişkeni dinleniyor (`CONFIG.port = process.env.PORT || 3000`, `0.0.0.0`).

```bash
git add .
git commit -m "feat: Add Web Dashboard, API Key Auth, and Render config"
git push -u origin main
```

### 19.4 Doğrulama (ölçüldü, PORT 3280, `AUDIO_PROVIDER=mock`)

| Test | Sonuç |
|---|---|
| `GET /` | `200`, `text/html`, **19 190 B** |
| `POST /generate-beat` anahtarsız | **`401 UNAUTHORIZED`** |
| `POST /generate-beat` yanlış anahtar | **`401`** |
| `POST /generate-beat` `x-api-key` | `200` |
| `POST /generate-beat` `?api_key=` | `200` |
| `GET /stream/:id` anahtarsız | **`401`** |
| `GET /stream/:id?api_key=` | `200`, **529 244 B**, `audio/wav` |
| `GET /download?id=&api_key=` | `200`, **529 244 B** |
| `GET /track/:id` anahtarsız / anahtarlı | `401` / `200` + `complete` |
| `GET /providers` yanlış / doğru | `401` / `200` |

---

## 20. 🔑 Siteden API anahtarı oluşturma

### 20.1 Akış

```
Dashboard → "Anahtar Oluştur" → POST /keys → sk_… (yalnızca 1 kez gösterilir)
                                          → "Bu anahtarı kullan" → localStorage
                                          → tüm isteklerde x-api-key / ?api_key=
```

### 20.2 Güvenlik modeli

- **Anahtar saklanmaz:** depoda yalnızca `SHA-256` özeti + görünen önek (`sk_49ZoP…`).
  Depo ele geçse bile anahtarlar geri üretilemez.
- **Format:** `sk_` + 32 bayt base64url (~256 bit entropi).
- **Roller:**
  - `admin` → anahtar üretebilir/iptal edebilir. `.env` anahtarları ve `ADMIN_KEY` her zaman admin.
  - `client` → yalnızca API kullanır; `POST /keys` → **403**.
- **Bootstrap:** hiç anahtar yoksa ilk üretim serbesttir ve o anahtar `admin` olur.
  Sonrasında üretim için geçerli bir admin anahtarı gerekir (401/403).
- **İptal:** `DELETE /keys/:id` → anahtar aynı saniyede geçersiz (`401`).

### 20.3 Uçlar

```bash
# Üret (admin anahtarı ile)
curl -X POST https://.../keys -H "x-api-key: <ADMIN>" \
     -H 'content-type: application/json' -d '{"name":"telefon"}'
# -> {"ok":true,"key":"sk_…","warning":"Bu anahtar yalnizca BIR KEZ gosterilir…","record":{…}}

# Listele (maskeli)
curl https://.../keys -H "x-api-key: <ADMIN>"

# İptal
curl -X DELETE https://.../keys/<id> -H "x-api-key: <ADMIN>"
```

### 20.4 Kalıcılık

`KEY_STORE_FILE` boşsa anahtarlar **bellekte** tutulur (process ölünce gider).
Dosya verilirse JSON'a yazılır (0600, atomik rename).
Render ücretsiz planda disk geçicidir: restart'ta kalır, **yeni deploy'da sıfırlanır**.
Kalıcı kayıt için Render Disk + `KEY_STORE_FILE=/data/keys.json`.

> Anahtarlar sıfırlansa bile `.env`'deki `ALLOWED_API_KEYS` anahtarı her zaman
> admin olarak çalıştığı için siteden yenisi üretilebilir — kilitlenme olmaz.

### 20.5 Doğrulama (ölçüldü)

| Test | Sonuç |
|---|---|
| `POST /keys` (admin) | `201`, `role: client` |
| Üretilen anahtar + `/generate-beat` | `200` |
| Üretilen anahtar + `GET /keys` | **`403 FORBIDDEN`** (client) |
| Üretilen anahtar + `POST /keys` | **`403`** |
| `DELETE /keys/:id` → eski anahtar | **`401`** |
| Bootstrap (hiç anahtar yok) | `201`, `role: admin` |
| Bootstrap sonrası anahtarsız istek | `401` |
| Diskte saklanan | yalnızca `hash` + `prefix` |

---

## 21. ⬇️ Resmî indirme ucu (düz MP3)

### 21.1 Keşif

Tarayıcıda "İndir" butonuna basıldığında Suno şu akışı izliyor (ağ logundan ölçüldü):

```
POST /api/download/authorize                      (opsiyonel onay)
GET  /api/download/clip/{id}?format=mp3           -> { ok, status:"ready", download_url }
     download_url = https://suno-data-uploads.s3.amazonaws.com/studio/uploads/{id}.mp3
                    ?response-content-type=audio%2Fmpeg&AWSAccessKeyId=...&Signature=...&Expires=...
     -> 200, audio/mpeg, ŞİFRESİZ MP3 (ID3 başlıklı, ffmpeg ile çözülüyor)
```

Bu, `audiopipe`'ın (AES şifreli) tamamen ayrı bir yolu: **Suno'nun kendi tarayıcıya
verdiği dosya**. Proxy bu dosyayı olduğu gibi aktarır — çözme/kırma yoktur.

### 21.2 Entegrasyon

- `providers/suno.js` → `getDownloadSource(clipId, format)` (opsiyonel provider yeteneği)
- `server.js` → `fetchSunoDownloadUrl()` ; `suno-data-uploads.s3.amazonaws.com` allowlist'e eklendi
- `/download?id=` ve `/stream/:id` **önce** resmî indirme ucunu dener; olmazsa eskisi gibi
  audiopipe/CDN'e düşer. Kapatmak için `?no_download_api=1`.
- Yanıt başlıkları: `X-Download-Mode: official-api`, `X-Proxy-Mode: official`
- `format=wav` → Suno'dan mp3 alınır, ffmpeg ile WAV'a çevrilir.

### 21.3 Şifreli gövde koruması (yeni)

Resmî indirme ucu başarısız olursa (indirme hakkı yok) proxy şifreli baytları
"ses" diye göndermek yerine açıkça hata verir:

```json
{ "ok": false, "error": { "code": "CLIP_ENCRYPTED",
  "message": "Bu klip sifreli (DRM) akis donduruyor; cozulmemis baytlar istemciye gonderilmedi." } }
```

Tespit: ilk baytlarda `ID3` / `RIFF` / `fLaC` / `OggS` / mp3 frame sync / `ftyp` yoksa.

### 21.4 Ölçümler (gerçek hesap, 19 Ekim 2026)

| Test | Sonuç |
|---|---|
| Sağlayıcı ucu (doğrudan) | `200`, `download_url` presigned S3 |
| S3 dosyası | `3 764 184 B`, `audio/mpeg`, `ID3`, ffmpeg: **2:45, 48 kHz stereo** |
| `GET /download?id=` | `200`, 3 764 184 B, `X-Download-Mode: official-api` |
| `GET /stream/:id` | `200`, aynı dosya, `<audio>` ile çalar |
| `Range: bytes=1000-1999` | `206`, 1000 B |
| `format=wav` | `200`, 31 717 294 B, `RIFF` (ffmpeg dönüşümü) |
| İndirme hakkı olmayan klip | `200`, 4 138 943 B, ffmpeg: 2:58 — bu hesapta da indirilebilir |
| Şifreli audiopipe yolu | `409 CLIP_ENCRYPTED` (artık çöp bayt gönderilmiyor) |

---

## 22. ⬇️ Kendi indirme servisimiz (URL'den)

### 22.1 Uçlar

| Uç | Ne yapar |
|---|---|
| `GET /download/info?url=…` | **Önizleme** — HEAD (gerekirse `Range: bytes=0-0`) ile boyut/tür/Range desteği/dosya adı |
| `GET /download?url=…` | **İndir** — baytları olduğu gibi aktarır (Range korunur) |
| `GET /download?url=…&filename=…` | Dosya adını elle ver |
| `GET /download?url=…&format=wav` | İndirip WAV'a çevir (ffmpeg) |
| `GET /download?url=…&mode=stream` | `inline` gönder (tarayıcıda çalar) |

Dashboard'da **"URL'den İndir"** paneli: adresi yapıştır → *Önizle* → *İndir*.

### 22.2 Dosya adı türetme

`https://…/studio/uploads/268c2ab7-….mp3?Signature=…` → `268c2ab7-….mp3`
(yol dosya adı içermiyorsa `indir-<zaman>.<uzantı>`).

### 22.3 SSRF koruması (değişmedi)

Yalnızca `DOWNLOAD_ALLOWED_HOSTS` + `*.suno.ai` alt alanları. `http://` ve IP
literalleri varsayılan olarak reddedilir. Sunucu **hiçbir baytı değiştirmez**.

```bash
# kendi host'unu eklemek icin
DOWNLOAD_ALLOWED_HOSTS=suno-data-uploads.s3.amazonaws.com,cdn.ornek.com
```

### 22.4 Ölçümler (yerel, gerçek presigned S3 linki)

| Test | Sonuç |
|---|---|
| `/download/info` | `boyut: 3764184`, `audio/mpeg`, `range: bytes`, `ad: 268c2ab7-….mp3` |
| `/download?url=` | `200`, **3 764 184 B**, `X-Proxy-Mode: direct` |
| `Content-Disposition` | `attachment; filename="268c2ab7-….mp3"` |
| `Range: bytes=0-1023` | `206`, 1024 B |
| allowlist dışı host | `403 URL_NOT_ALLOWED` |

> Bu servis **bayt aktarımı** yapar. Erişim izni olmayan / şifreli bir kaynağı
> "açma" iddiası yoktur: kaynak ne döndürüyorsa onu iletir. Suno'nun
> `not_authorized` cevabı bir erişim kısıtıdır ve proxy tarafında aşılamaz.

---

## 23. ⚡ Otomatik indirme akışı (0 tık)

### 23.1 Nasıl çalışıyor

```
POST /generate-beat          -> klip(lar) submitted
GET  /track/:id  (poll)      -> klip "complete" olunca SUNUCU indirme URL'sini çözer
                                yanıta `download` bloğu eklenir:
                                { ready:true, mode:"official-api", proxy_path:"/download?id=…" }
Dashboard                    -> "İndir" butonu HAZIR (tek tık, presigned link sızmaz)
GET  /download?id=…          -> resmi uçtan düz MP3, bayt bayt
```

Presigned S3 linkleri ~5 dk yaşadığı için **TTL'li bellek önbelleği** var:
pozitif 4 dk, negatif (`not_authorized`) 1 dk. Aynı klip için Suno'ya tekrar gidilmez.

### 23.2 İndirme izni yoksa

```json
"download": { "ready": false, "reason": "download_not_authorized",
              "detail": "{\"ok\":false,\"reason\":\"no_permission\"}" }
```

Dashboard'da buton **soluk/pasif** olur, yanında `indirme izni yok (not_authorized)` yazar.
Şifreli bayt istemciye gönderilmez (`409 CLIP_ENCRYPTED`).

### 23.3 Ölçümler (yerel + canlı)

| Test | Sonuç |
|---|---|
| `/track` (izni olan klip) | `download.ready: true`, `mode: official-api` |
| `/download?id=` (buton) | `200`, **3 764 184 B**, `audio/mpeg` |
| Önbellekli 2. `/track` | **146 ms** (Suno'ya gitmiyor) |
| İzinsiz klip | `ready:false`, `download_not_authorized` |

### 23.4 Bilinen sınır: üretim token tazeliği

`/api/generate/v2-web` **taze** token ister; 15+ dakikalık token'da
`422 token_validation_failed` döner. İndirme (`/api/download/clip`) ise geçerli
herhangi bir token'la çalışır. Bu yüzden üretimden hemen önce tokunun taze
olması gerekir (konsol snippet'i).

---

## 24. 🔑 Token sorunu: gerçek sınır ve otomatik yenileme

### 24.1 Neden token gerekiyor?

Suno'nun **herkese açık bir API'si yok**. (Temmuz 2026'da "geliştirici API'si
araştırıyoruz" açıklaması yapıldı; Ekim 2026 itibarıyla self-servis API,
dokümantasyon veya fiyat listesi yayınlanmadı.) Dolayısıyla her "Suno API"
projesi gibi bu proxy de **web oturumunuzu** kullanır. Oturum JWT'si ~60 dk yaşar.

### 24.2 Ölçtüğüm gerçek (yerel test)

| Yol | Sonuç |
|---|---|
| `__session` JWT ile `/v1/client` | `sessions: []` — Clerk oturumu tanımıyor |
| `__session` ile `POST /v1/client/sessions/{id}/tokens` | **session id yok → 404/yok** |
| `Suno.com` üzerinden Clerk proxy (`/v1/client`, `/api/__clerk/…`) | `404` / `400` — proxy yok |
| `Authorization: Bearer` ile `/v1/me` | `404` |

**Sebep:** Clerk, JWT üretmek için HttpOnly **`__client`** çerezini istiyor.
`__session` bu iş için yetmiyor. `__client` JavaScript'ten okunamaz
(`document.cookie`'de görünmez) **ama DevTools'ta görünür.**

### 24.3 Çözüm: bir kez `__client`, sonra tam otomatik

```text
1) suno.com'da giriş yap
2) F12 > Application > Cookies > https://clerk.suno.com
3) __client satırını bul (HttpOnly kolonu ✓ olacak, bu normal)
4) Değeri kopyala (client_xxx... ile başlar)
5) Render > Environment > SUNO_REFRESH_TOKEN = <kopyaladığın değer>
6) Redeploy
```

Sonrasında sunucu **her 15 dakikada** `sessions/{id}/touch` + `tokens` çağırıp
JWT'yi kendi yeniler. `/health` içinde `auth.refreshMode: "full"` görürsün.
Kod tarafı zaten hazır — `keepAliveTick()` + `refreshAccessToken()`.

### 24.4 `refreshMode` değerleri

| Değer | Anlam |
|---|---|
| `full` | `__client` var → token otomatik yenileniyor (istenen) |
| `manual` | Yalnızca yapıştırılmış JWT var → ~60 dk sonra durur |
| `none` | Kimlik yok |

### 24.5 Token reddedilirse

Suno 422 `token_validation_failed` dönerse proxy artık:
1. `SUNO_REFRESH_TOKEN` varsa **zorla yenileyip tekrar dener**,
2. yoksa `401 SESSION_EXPIRED` + ne yapılacağını söyleyen `detail` döner.

### 24.6 Üretim (uygulamaya entegre ederken) önerisi

Kendi ürününde beat üretimi kritikse, oturum çerezine bağlı bir yol tek başına
yeterli değildir. `AUDIO_PROVIDER` katmanı bunun için var:

| Sağlayıcı | Kimlik | Yaklaşık maliyet |
|---|---|---|
| `replicate` (MusicGen / Stable Audio) | API token (kalıcı) | ~$0.03–0.20 / parça |
| `elevenlabs` | API key | plana göre |
| `suno` | web oturumu | abonelik |
| `mock` | yok | 0 (test) |

`AUDIO_PROVIDER=replicate` + `REPLICATE_API_TOKEN=…` ile aynı `/generate-beat`,
`/track`, `/download` uçları çalışır; istemci kodunda **hiçbir değişiklik olmaz**.

---

## 25. 🎯 Tam otomatik yenileme: doğru Clerk FAPI adresi

### 25.1 Keşif

Suno'nun Clerk FAPI'si **`auth.suno.com`** üzerinde — `clerk.suno.com` değil.

| Host | `/v1/client` | Oturumlar |
|---|---|---|
| `clerk.suno.com` | `200` | `sessions: []` (boş) |
| **`auth.suno.com`** | `200` + `Set-Cookie: __client=…` | oturum çözülür (doğru `__client` ile) |

`auth.suno.com` cevabındaki `__client` bir **refresh JWT**'si:

```
payload: { "suno.com/claims/token_type": "refresh",
           "iss": "https://auth.suno.com", "exp": 1823931179 }
Cookie:  HttpOnly; Max-Age=31536000; SameSite=None; Secure   (~1 yıl)
```

### 25.2 Neden suno.com çerez listesinde görünmüyor?

`__client` çerezi **`auth.suno.com`** host'unda duruyor; DevTools > Application
> Cookies yalnızca üst siteyi (suno.com) listeler. Bu yüzden "yok" görünüyordu.
Aslında var — sadece farklı host'ta.

### 25.3 `__client` nasıl alınır (30 saniye)

```text
1) F12 > Network
2) Filtre: auth.suno
3) Sayfayı yenile (F5)
4) Çıkan isteğe sağ tık > Copy > Copy as cURL
5) İçindeki cookie: başlığını SUNO_REFRESH_TOKEN'a yapıştır
```

Kod, yapıştırılan metnin içinden `__client=…` değerini otomatik ayıklar
(`buildCookieHeader()`). Sadece değeri de yapıştırabilirsin.

### 25.4 Sonrası

```text
SUNO_REFRESH_TOKEN=client_xxx → /health: auth.refreshMode = "full"
                              → keepAliveTick() her 15 dk:
                                 GET  /v1/client            (session id)
                                 POST /sessions/{id}/tokens (taze JWT)
                                 POST /sessions/{id}/touch
```

Token bir daha elle girilmez; ~1 yıl sonra çerez yenilenir.

---

## 26. ✅ Üretim yeniden çalışıyor (ve neden çalışmıyordu)

### 26.1 Ölçüm

Suno'nun doğru FAPI'sinden (`auth.suno.com`) alınan taze JWT ile:

| Adım | Sonuç |
|---|---|
| `POST /generate-beat` | ✅ `200`, 2 klip: `9637a59e…`, `3c0d8c03…` |
| `GET /track/:id?wait=true` | ✅ `complete`, 121.2 sn / 82.84 sn |
| `GET /download?id=…` | ⛔ `is_download_unlocked: false` → `download_not_authorized` |

### 26.2 Ayrım netleşti

| Sorun | Gerçek sebep |
|---|---|
| `422 token_validation_failed` | **Eski JWT**. `auth.suno.com`'dan taze alınan token ile üretim çalışıyor. |
| İndirme reddi | Free planda `is_download_unlocked: false`. Suno'nun plan kısıtı — proxy tarafında aşılamaz. |

### 26.3 Kredi/plan

```json
{"credits": 0, "is_active": false, "monthly_usage": 80, "monthly_limit": 300, "plan": "free"}
```

Kredi 0 olsa da üretim çalıştı (ücretsiz günlük kota). İndirme için plan gerekiyor.

### 26.4 Yeni hata kodları

| Kod | HTTP | Anlam |
|---|---|---|
| `OUT_OF_CREDITS` | 402 | bakiye 0 (generate reddedildi) |
| `TOKEN_REJECTED` | 422 | token reddedildi, bakiye ektedir |

---

## 27. 🏁 TAM OTOMATİK: `__client` ile sıfır manuel token

### 27.1 Kanıt (canlı, Render)

```json
GET /health → auth: { refreshMode: "full",
                      sessionId: "session_19679b19a8d210ff482e0f",
                      tokenExpiresInSeconds: 3495,
                      refreshCount: 1 }
POST /generate-beat → ok: true, klipler: e730e0ab…, 5e02a606…
GET  /track/…      → complete, 63.16 sn
```

`SUNO_SESSION_TOKEN` **boş**. Elle yapıştırılmış token yok; sunucu token'ı
`__client` çerezinden kendi üretiyor.

### 27.2 `__client` nereden alınır (tek sefer, ~1 yıl geçerli)

```text
1) https://auth.suno.com/v1/client?_clerk_js_version=5.35.0  adresini aç
   (JSON döker; oturum birinci taraf olduğu için çerezler görünür)
2) F12 > Application > Cookies > https://auth.suno.com
3) __client satırının Value'sunu kopyala  (eyJ… ile başlar, "refresh" JWT'si)
4) SUNO_REFRESH_TOKEN = o değer  →  redeploy
```

Yenileme zinciri (kodda: `keepAliveTick()`):

```
Cookie: __client=<refresh JWT>
  GET  https://auth.suno.com/v1/client                     → session_xxx
  POST https://auth.suno.com/v1/client/sessions/{id}/tokens → { jwt }  (60 dk)
  POST https://auth.suno.com/v1/client/sessions/{id}/touch
tekrar: her 15 dakikada bir
```

### 27.3 Ölçülen ömürler

| Kimlik | Nerede | Ömür |
|---|---|---|
| `__client` (refresh) | `auth.suno.com` (HttpOnly) | **exp 2027-10-19** |
| Clerk oturumu | `session_19679b…` | `expire_at` 2027 |
| Erişim JWT'si | her 15 dk üretilir | ~60 dk |

### 27.4 Kalan tek sınır: indirme (plan)

`is_download_unlocked: false` → `/download` = `409 CLIP_ENCRYPTED`.
Bu **Suno'nun plan kısıtı**; proxy bayt üretmez/açmaz. Pro planda bayrak
`true` olur ve aynı akış otomatik indirir (Pro hesapta ölçüldü: 3 764 184 B).
