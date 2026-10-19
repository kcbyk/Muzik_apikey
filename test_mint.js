const axios = require('axios');
const { getEnvVars } = require('./render_manager');

async function testWithServerTime() {
  const vars = await getEnvVars();
  const tVar = vars.find(v => v.envVar.key === 'SUNO_REFRESH_TOKEN');
  const tokens = tVar.envVar.value.split(',');
  const token = tokens[3]; // account 4

  const clerkRes = await axios.get('https://auth.suno.com/v1/client?_clerk_js_version=5.35.0', {
    headers: { 'Cookie': '__client=' + token, 'User-Agent': 'Mozilla/5.0' }
  });
  const session = clerkRes.data.response.sessions[0];
  const tokenRes = await axios.post(`https://auth.suno.com/v1/client/sessions/${session.id}/tokens?_clerk_js_version=5.35.0`, {}, {
    headers: { 'Cookie': '__client=' + token, 'User-Agent': 'Mozilla/5.0' }
  });
  const jwt = tokenRes.data.jwt;

  // 1. Get Suno server time from response header
  const billingRes = await axios.get('https://studio-api.prod.suno.com/api/billing/info/', {
    headers: { 'Authorization': 'Bearer ' + jwt, 'User-Agent': 'Mozilla/5.0' }
  });
  const serverTime = new Date(billingRes.headers['date']).getTime();
  console.log('Suno Server Time (ms):', serverTime);

  // Test various timestamp offsets: serverTime, serverTime + 1000, Date.now()
  const tests = [
    { name: 'Suno serverTime', time: serverTime },
    { name: 'Suno serverTime + 2s', time: serverTime + 2000 },
    { name: 'No Browser-Token header', time: null }
  ];

  for (const t of tests) {
    console.log(`\nTesting: ${t.name}`);
    const headers = {
      'Authorization': 'Bearer ' + jwt,
      'Content-Type': 'application/json',
      'Device-Id': '3a88a09b-67a8-4224-aa61-55dbdd04c8f0',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Origin': 'https://suno.com',
      'Referer': 'https://suno.com/'
    };
    if (t.time !== null) {
      const inner = JSON.stringify({ timestamp: t.time });
      headers['Browser-Token'] = JSON.stringify({ token: Buffer.from(inner, 'utf8').toString('base64') });
    }

    try {
      const res = await axios.post('https://studio-api.prod.suno.com/api/generate/v2-web/', {
        prompt: 'test beat',
        make_instrumental: true,
        mv: 'chirp-goose',
        generation_type: 'TEXT'
      }, { headers });
      console.log('SUCCESS! Clips:', res.data.clips.map(c => c.id));
      return;
    } catch (e) {
      console.log('FAIL:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message);
    }
  }
}

testWithServerTime();
