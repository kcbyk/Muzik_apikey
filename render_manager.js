const axios = require('axios');

const RENDER_API_KEY = 'rnd_XpckrqiWHM0RPD5YGZecGs0WD9mL';
const SERVICE_ID = 'srv-dbaqai49v7es739hdt6g';

function extractToken(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (str.includes('"jwt":')) {
    const m = str.match(/"jwt":\s*"([^"]+)"/);
    if (m) return m[1];
  }
  if (str.includes('__client=')) {
    const m = str.match(/__client=([^&\s]+)/);
    if (m) return m[1];
  }
  if (str.startsWith('eyJ')) {
    return str.replace(/^["']|["']$/g, '');
  }
  return str;
}

async function getEnvVars() {
  const res = await axios.get(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
    headers: {
      'Authorization': 'Bearer ' + RENDER_API_KEY,
      'Accept': 'application/json'
    }
  });
  return res.data;
}

async function triggerDeploy() {
  const res = await axios.post(`https://api.render.com/v1/services/${SERVICE_ID}/deploys`, {
    clearCache: 'do_not_clear'
  }, {
    headers: {
      'Authorization': 'Bearer ' + RENDER_API_KEY,
      'Content-Type': 'application/json'
    }
  });
  return res.data;
}

async function addTokens(tokensOrJsonList) {
  console.log('1. Render env degiskenleri aliniyor...');
  const existingVars = await getEnvVars();

  let currentTokenStr = '';
  const tokenVar = existingVars.find(v => v.envVar.key === 'SUNO_REFRESH_TOKEN' || v.envVar.key === 'SUNO_REFRESH_TOKENS');
  if (tokenVar) {
    currentTokenStr = tokenVar.envVar.value;
  }

  const tokenList = currentTokenStr ? currentTokenStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  console.log('Mevcut havuzdaki token sayisi:', tokenList.length);

  let added = 0;
  for (const raw of tokensOrJsonList) {
    const t = extractToken(raw);
    if (t && !tokenList.includes(t)) {
      tokenList.push(t);
      added++;
    }
  }

  if (added === 0) {
    console.log('Eklenecek yeni token bulunamadi (zaten havuzda mevcut).');
    return tokenList.length;
  }

  console.log(`${added} yeni token eklendi. Yeni toplam token: ${tokenList.length}`);
  const combinedTokens = tokenList.join(',');

  const payloadMap = new Map();
  for (const item of existingVars) {
    payloadMap.set(item.envVar.key, item.envVar.value);
  }

  payloadMap.set('SUNO_REFRESH_TOKEN', combinedTokens);
  payloadMap.set('SUNO_REFRESH_TOKENS', combinedTokens);

  const payload = Array.from(payloadMap.entries()).map(([key, value]) => ({ key, value }));

  console.log('2. Render env degiskenleri guncelleniyor...');
  await axios.put(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, payload, {
    headers: {
      'Authorization': 'Bearer ' + RENDER_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  console.log('3. Render yeniden baslatiliyor (deploy)...');
  const deployRes = await triggerDeploy();
  console.log('Deploy baslatildi:', deployRes.id, deployRes.status);
  return tokenList.length;
}

module.exports = {
  getEnvVars,
  triggerDeploy,
  addTokens,
  extractToken
};
