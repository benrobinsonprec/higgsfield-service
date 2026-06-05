const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const HIGGSFIELD_API = 'https://fnf.higgsfield.ai';
const HIGGSFIELD_AUTH = 'https://fnf-device-auth.higgsfield.ai';

let accessToken = null;
let tokenExpiry = 0;
let currentRefreshToken = process.env.HIGGSFIELD_REFRESH_TOKEN;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry - 60000) return accessToken;
  const res = await axios.post(`${HIGGSFIELD_AUTH}/token`, {
    refresh_token: currentRefreshToken
  });
  accessToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  if (res.data.refresh_token) {
    currentRefreshToken = res.data.refresh_token;
    console.log('Refresh token updated in memory');
  }
  return accessToken;
}

// Proactively refresh every 5 days to keep refresh token alive
setInterval(async () => {
  try {
    await getAccessToken();
    console.log('Proactive token refresh complete');
  } catch (err) {
    console.error('Proactive refresh failed:', err.message);
  }
}, 5 * 24 * 60 * 60 * 1000);

async function createJob(token, prompt) {
  const res = await axios.post(`${HIGGSFIELD_API}/agents/jobs`, {
    job_set_type: 'cinematic_studio_video_v2',
    params: { prompt, duration: 10, aspect_ratio: '16:9' }
  }, { headers: { Authorization: `Bearer ${token}` } });
  return res.data[0];
}

async function waitForJob(token, jobId) {
  const start = Date.now();
  while (Date.now() - start < 600000) {
    const res = await axios.get(`${HIGGSFIELD_API}/agents/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const job = res.data;
    if (job.status === 'completed') return job.result_url;
    if (job.status === 'failed') throw new Error(`Job ${jobId} failed`);
    await new Promise(r => setTimeout(r, 8000));
  }
  throw new Error('Job timed out after 10 minutes');
}

async function processVideo(videoId, prompts, audioUrl, callbackUrl) {
  try {
    const token = await getAccessToken();
    console.log(`[${videoId}] Creating ${prompts.length} Higgsfield jobs...`);
    const jobIds = await Promise.all(prompts.map(p => createJob(token, p)));
    console.log(`[${videoId}] Jobs created: ${jobIds.join(', ')}`);
    const clipUrls = await Promise.all(jobIds.map(id => waitForJob(token, id).catch(() => null)));
    console.log(`[${videoId}] All clips complete`);

    const payload = { video_id: videoId, audio_url: audioUrl };
    clipUrls.forEach((url, i) => { payload[`clip_${i + 1}_url`] = url; });
    await axios.post(callbackUrl, payload);
    console.log(`[${videoId}] Callback sent to Zapier`);
  } catch (err) {
    console.error(`[${videoId}] Error:`, err.message);
    await axios.post(callbackUrl, { video_id: videoId, error: err.message }).catch(() => {});
  }
}

app.post('/generate', async (req, res) => {
  const { video_id, prompts, audio_url, callback_url } = req.body;
  if (!video_id || !prompts || !callback_url) {
    return res.status(400).json({ error: 'Missing: video_id, prompts, callback_url' });
  }
  res.json({ status: 'processing', video_id, jobs: prompts.length });
  processVideo(video_id, prompts, audio_url, callback_url).catch(console.error);
});

app.get('/reauth', async (req, res) => {
  try {
    const response = await axios.post(`${HIGGSFIELD_AUTH}/authorize`, {});
    const { device_code, verification_uri, expires_in } = response.data;
    res.json({
      message: 'Visit the URL below and log in, then call /reauth/complete with the device_code',
      verification_uri,
      device_code,
      expires_in_seconds: expires_in
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/reauth/complete', async (req, res) => {
  const { device_code } = req.query;
  if (!device_code) return res.status(400).json({ error: 'Missing device_code' });
  try {
    const response = await axios.post(`${HIGGSFIELD_AUTH}/token`, { device_code });
    const { access_token, refresh_token, expires_in } = response.data;
    accessToken = access_token;
    tokenExpiry = Date.now() + (expires_in * 1000);
    res.json({
      message: 'Success! Copy the refresh_token below and update HIGGSFIELD_REFRESH_TOKEN in Railway.',
      refresh_token,
      expires_in_days: 7
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Higgsfield service on port ${PORT}`));
