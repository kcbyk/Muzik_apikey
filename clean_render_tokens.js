const axios = require('axios');
const { getEnvVars, triggerDeploy } = require('./render_manager');

const RENDER_API_KEY = 'rnd_XpckrqiWHM0RPD5YGZecGs0WD9mL';
const SERVICE_ID = 'srv-dbaqai49v7es739hdt6g';

async function cleanTokens() {
  console.log('1. Render ortam degiskenleri aliniyor...');
  const existingVars = await getEnvVars();

  const tokenVar = existingVars.find(v => v.envVar.key === 'SUNO_REFRESH_TOKEN');
  if (!tokenVar || !tokenVar.envVar.value) {
    console.log('SUNO_REFRESH_TOKEN bulunamadi.');
    return;
  }

  const rawTokens = tokenVar.envVar.value.split(',').map(t => t.trim()).filter(Boolean);
  console.log(`Havuzda toplam ${rawTokens.length} token var. Canlilik kontrol ediliyor...`);

  const liveTokens = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    try {
      const res = await axios.get('https://auth.suno.com/v1/client?_clerk_js_version=5.35.0', {
        headers: { Cookie: '__client=' + t, 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      });
      const sessions = (res.data && res.data.response && res.data.response.sessions) || [];
      if (sessions.length > 0) {
        console.log(`[Token ${i + 1}] CANLI! Session: ${sessions[0].id}`);
        if (!liveTokens.includes(t)) liveTokens.push(t);
      } else {
        console.log(`[Token ${i + 1}] OLU (sessions: 0) -> Siliniyor.`);
      }
    } catch (e) {
      console.log(`[Token ${i + 1}] HATA: ${e.message} -> Siliniyor.`);
    }
  }

  console.log(`\nTemizleme sonucu: ${liveTokens.length} canli token kaldi.`);
  if (liveTokens.length === 0) {
    console.log('UYARI: Hic canli token bulunamadi! Render guncellenmedi.');
    return;
  }

  const newTokensValue = liveTokens.join(',');
  const payloadMap = new Map();
  for (const item of existingVars) {
    payloadMap.set(item.envVar.key, item.envVar.value);
  }

  payloadMap.set('SUNO_REFRESH_TOKEN', newTokensValue);
  payloadMap.set('SUNO_REFRESH_TOKENS', newTokensValue);

  const payload = Array.from(payloadMap.entries()).map(([key, value]) => ({ key, value }));

  console.log('2. Render env guncelleniyor...');
  await axios.put(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, payload, {
    headers: {
      Authorization: 'Bearer ' + RENDER_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    }
  });

  console.log('3. Render yeniden baslatiliyor...');
  const deploy = await triggerDeploy();
  console.log('Deploy tetiklendi:', deploy.id, deploy.status);
}

cleanTokens().catch(e => console.error('Hata:', e.message));
