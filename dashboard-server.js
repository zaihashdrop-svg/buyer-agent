const express = require('express');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

const PORT = 3003;
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/root/.hermes/scbz-public';
const OUTPUTS_DIR = path.join(PUBLIC_DIR, 'outputs');

// Create dirs
fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// ─── Serve public files ──────────────────────────────
app.use('/outputs', express.static(OUTPUTS_DIR, {
  setHeaders: (res, filePath) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
  }
}));

// ─── Grok xAI Helpers ────────────────────────────────
function getXaiKey() {
  try {
    const envPath = process.env.ENV_FILE || '/root/.openclaw/workspace/santa_clawz-private_agents/.env.santaclawz';
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/XAI_API_KEY=(.+)/);
    if (match) return match[1].trim().replace(/^"(.*)"$/, '$1');
  } catch {}
  return process.env.XAI_API_KEY || '';
}

function grokRequest(path, body, method) {
  method = method || (body && Object.keys(body).length > 0 ? 'POST' : 'GET');
  return new Promise((resolve, reject) => {
    const apiKey = getXaiKey();
    if (!apiKey) return reject(new Error('No XAI_API_KEY found'));
    const data = body && Object.keys(body).length > 0 ? JSON.stringify(body) : '';
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const opts = {
      hostname: 'api.x.ai', path, method, timeout: 180000,
      headers
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { timeout: 120000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', function () { this.destroy(); reject(new Error('Download timeout')); });
  });
}

// ─── POST /api/generate-image (MULTI-FILE) ───────────
app.post('/api/generate-image', async (req, res) => {
  try {
    const prompt = req.body.prompt || 'Generate an image';
    const jobId = req.body.jobId || `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const includeDescription = req.body.includeDescription !== false;

    console.log(`🎨 Image: "${prompt.slice(0, 60)}..."`);

    const gRes = await grokRequest('/v1/images/generations', {
      model: 'grok-imagine-image-quality',
      prompt,
      n: 1,
      response_format: 'b64_json'
    });

    if (!gRes.data?.data?.[0]) throw new Error('No image data: ' + JSON.stringify(gRes.data).slice(0, 300));

    const imgData = gRes.data.data[0];
    const b64 = imgData.b64_json;
    const jobDir = path.join(OUTPUTS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const ext = b64.startsWith('/9j') ? 'jpg' : 'png';
    const imgFilename = `generated_image.${ext}`;
    const imgFilePath = path.join(jobDir, imgFilename);
    fs.writeFileSync(imgFilePath, Buffer.from(b64, 'base64'));

    const imgSizeKB = (fs.statSync(imgFilePath).size / 1024).toFixed(1);
    console.log(`  ✅ Image saved: ${imgFilename} (${imgSizeKB} KB)`);

    let files = [{ name: imgFilename, local_path: imgFilePath, contentType: `image/${ext}` }];
    let outputText = `Image generated successfully. File: ${imgFilename}`;

    // Also generate a markdown description for multi-file delivery
    if (includeDescription) {
      try {
        const descBody = `Describe this image in markdown: explain what it shows, the artistic style, composition, colors, and mood. Write a caption and a detailed description section.

Prompt that generated this image: "${prompt}"`;
        const descRes = await grokRequest('/v1/chat/completions', {
          model: 'grok-2-1212',
          messages: [
            { role: 'system', content: 'You write markdown descriptions for images. Output ONLY markdown — no extra commentary.' },
            { role: 'user', content: descBody }
          ]
        });

        const description = descRes.data?.choices?.[0]?.message?.content || `# ${prompt}\n\nAI-generated image created via Grok.`;
        const descFilename = 'description.md';
        const descFilePath = path.join(jobDir, descFilename);
        fs.writeFileSync(descFilePath, description);
        console.log(`  ✅ Description saved: ${descFilename} (${(description.length / 1024).toFixed(1)} KB)`);
        files.push({ name: descFilename, local_path: descFilePath, contentType: 'text/markdown' });
        outputText += `\nDescription file included: ${descFilename}`;
      } catch (descErr) {
        console.warn(`  ⚠️ Description skipped: ${descErr.message}`);
        outputText += '\n(Description generation skipped)';
      }
    }

    res.json({
      status: 'completed',
      output_text: outputText,
      files
    });
  } catch (err) {
    console.error(`  ❌ Image error: ${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// ─── POST /api/generate-video ────────────────────────
app.post('/api/generate-video', async (req, res) => {
  try {
    const prompt = req.body.prompt || 'Generate a video';
    const jobId = req.body.jobId || `vid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    console.log(`🎬 Video: "${prompt.slice(0, 60)}..."`);

    // Submit generation
    const gRes = await grokRequest('/v1/videos/generations', {
      model: 'grok-imagine-video',
      prompt,
      n: 1
    });

    const generationId = gRes.data?.request_id;
    if (!generationId) throw new Error('No generation ID: ' + JSON.stringify(gRes.data).slice(0, 300));

    // Poll for completion (up to 2 min)
    let videoUrl = null;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await grokRequest(`/v1/videos/${generationId}`, {});
      if (pollRes.data?.status === 'done' && pollRes.data?.video?.url) {
        videoUrl = pollRes.data.video.url;
        break;
      }
      if (pollRes.data?.status === 'failed') throw new Error('Generation failed: ' + JSON.stringify(pollRes.data).slice(0, 300));
    }
    if (!videoUrl) throw new Error('Video generation timed out (120s)');

    // Download
    const videoBuf = await downloadFile(videoUrl);
    const jobDir = path.join(OUTPUTS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    const filename = 'generated_video.mp4';
    const filePath = path.join(jobDir, filename);
    fs.writeFileSync(filePath, videoBuf);

    console.log(`  ✅ Video saved: ${filename} (${(videoBuf.length / 1024 / 1024).toFixed(1)} MB)`);

    res.json({
      status: 'completed',
      output_text: `Video generated successfully. File: ${filename} (${(videoBuf.length / 1024).toFixed(0)} KB)`,
      files: [{ name: filename, local_path: filePath, contentType: 'video/mp4' }]
    });
  } catch (err) {
    console.error(`  ❌ Video error: ${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// ─── POST /api/generate (UNIFIED MULTI-FILE ENDPOINT) ──
// Accepts any task, auto-classifies, returns image+text or text-only
app.post('/api/generate', async (req, res) => {
  try {
    const prompt = req.body.prompt || 'Generate content';
    const jobId = req.body.jobId || `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const jobDir = path.join(OUTPUTS_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    console.log(`🔄 Unified generate: "${prompt.slice(0, 60)}..."`);

    // Classify: does this need an image?
    const needsImage = /image|picture|photo|generate|draw|create.*visual|illustration|art|graphic|design|poster|banner|logo|meme|visual|infographic/i.test(prompt);

    let files = [];
    let outputText = '';

    if (needsImage) {
      // Generate image first
      const gRes = await grokRequest('/v1/images/generations', {
        model: 'grok-imagine-image-quality',
        prompt,
        n: 1,
        response_format: 'b64_json'
      });

      if (gRes.data?.data?.[0]) {
        const imgData = gRes.data.data[0];
        const b64 = imgData.b64_json;
        const ext = b64.startsWith('/9j') ? 'jpg' : 'png';
        const imgFilename = `generated_image.${ext}`;
        const imgFilePath = path.join(jobDir, imgFilename);
        fs.writeFileSync(imgFilePath, Buffer.from(b64, 'base64'));
        files.push({ name: imgFilename, local_path: imgFilePath, contentType: `image/${ext}` });
        console.log(`  ✅ Image: ${imgFilename}`);
        outputText += `Image generated: ${imgFilename}\n`;
      }
    }

    // Always generate a text/markdown document as well
    // Use Grok to write a comprehensive markdown document about the task
    const sysMsg = needsImage
      ? 'You are an AI that writes detailed markdown documents. The user requested an image AND documentation. Write a comprehensive markdown document about the topic requested, including: an overview, key details, analysis, and a section describing the generated image. Output ONLY valid markdown.'
      : 'You are an AI that writes detailed markdown documents. Write a comprehensive markdown document addressing the user request. Include sections: Summary, Details, and Conclusion. Output ONLY valid markdown.';

    try {
      const docRes = await grokRequest('/v1/chat/completions', {
        model: 'grok-2-1212',
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: `Write a detailed markdown document about: ${prompt}` }
        ]
      });

      const docContent = docRes.data?.choices?.[0]?.message?.content || `# ${prompt}\n\nContent generated by AI.`;
      const docFilename = 'document.md';
      const docFilePath = path.join(jobDir, docFilename);
      fs.writeFileSync(docFilePath, docContent);
      files.push({ name: docFilename, local_path: docFilePath, contentType: 'text/markdown' });
      console.log(`  ✅ Document: ${docFilename} (${(docContent.length / 1024).toFixed(1)} KB)`);
      outputText += `Document created: ${docFilename} (${(docContent.length / 1024).toFixed(0)} KB)`;
    } catch (docErr) {
      console.warn(`  ⚠️ Document skipped: ${docErr.message}`);
      outputText += '\n(Document generation skipped)';
    }

    res.json({
      status: 'completed',
      output_text: outputText.trim(),
      files
    });
  } catch (err) {
    console.error(`  ❌ Generate error: ${err.message}`);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

// ─── GET /api/deliverables/:jobId ── get all deliverables for a job
app.get('/api/deliverables/:jobId', (req, res) => {
  const jobDir = path.join(OUTPUTS_DIR, req.params.jobId);
  if (!fs.existsSync(jobDir)) {
    return res.status(404).json({ error: 'Job not found' });
  }
  const entries = fs.readdirSync(jobDir).filter(f => fs.statSync(path.join(jobDir, f)).isFile());
  const files = entries.map(name => {
    const fpath = path.join(jobDir, name);
    const ext = path.extname(name).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json' };
    return {
      name,
      uri: `/outputs/${req.params.jobId}/${encodeURIComponent(name)}`,
      size: fs.statSync(fpath).size,
      contentType: mimeMap[ext] || 'application/octet-stream'
    };
  });
  res.json({ jobId: req.params.jobId, files });
});

// ─── Latest buyer-inbox image ─────────────────────────
app.get('/latest-image', (req, res) => {
  const inboxDir = '/root/buyer-inbox/deliveries';
  if (!fs.existsSync(inboxDir)) return res.status(404).json({ error: 'No inbox' });
  const dirs = fs.readdirSync(inboxDir).filter(d => fs.statSync(path.join(inboxDir, d)).isDirectory());
  const sorted = dirs.sort((a, b) => fs.statSync(path.join(inboxDir, b)).mtimeMs - fs.statSync(path.join(inboxDir, a)).mtimeMs);
  for (const d of sorted) {
    const files = fs.readdirSync(path.join(inboxDir, d));
    const img = files.find(f => /\.(jpe?g|png|webp|gif)$/i.test(f));
    if (img) {
      res.set('Access-Control-Allow-Origin', '*');
      return res.sendFile(path.join(inboxDir, d, img));
    }
  }
  res.status(404).json({ error: 'No images found' });
});

// ─── GET /latest-deliverables ── download ALL files from the latest job
app.get('/latest-deliverables', (req, res) => {
  const inboxDir = '/root/buyer-inbox/deliveries';
  if (!fs.existsSync(inboxDir)) return res.status(404).json({ error: 'No inbox' });
  const dirs = fs.readdirSync(inboxDir).filter(d => fs.statSync(path.join(inboxDir, d)).isDirectory());
  const sorted = dirs.sort((a, b) => fs.statSync(path.join(inboxDir, b)).mtimeMs - fs.statSync(path.join(inboxDir, a)).mtimeMs);
  if (sorted.length === 0) return res.status(404).json({ error: 'No deliveries' });

  const latestDir = path.join(inboxDir, sorted[0]);
  const files = fs.readdirSync(latestDir).filter(f => fs.statSync(path.join(latestDir, f)).isFile());

  // Return a JSON listing with individual download URLs
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const entries = files.map(name => ({
    name,
    url: `${baseUrl}/latest-file/${encodeURIComponent(name)}`,
    contentType: /\.(jpe?g|png|webp|gif)$/i.test(name) ? 'image/jpeg' : /\.md$/i.test(name) ? 'text/markdown' : /\.(txt|json)$/i.test(name) ? 'text/plain' : 'application/octet-stream',
    size: fs.statSync(path.join(latestDir, name)).size
  }));

  res.json({ deliveryId: sorted[0], files: entries });
});

// ─── GET /latest-file/:name ── download a specific file from the latest delivery
app.get('/latest-file/:name', (req, res) => {
  const inboxDir = '/root/buyer-inbox/deliveries';
  const dirs = fs.readdirSync(inboxDir).filter(d => fs.statSync(path.join(inboxDir, d)).isDirectory());
  const sorted = dirs.sort((a, b) => fs.statSync(path.join(inboxDir, b)).mtimeMs - fs.statSync(path.join(inboxDir, a)).mtimeMs);
  if (sorted.length === 0) return res.status(404).json({ error: 'No deliveries' });

  const filePath = path.join(inboxDir, sorted[0], req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.set('Access-Control-Allow-Origin', '*');
  res.sendFile(filePath);
});

// ─── Health ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), outputs: OUTPUTS_DIR });
});

app.get('/', (req, res) => {
  res.send('SCZ Dashboard — Multi-file generation\nPOST /api/generate-image  (image + description.md)\nPOST /api/generate       (auto-classify: image + markdown doc)\nPOST /api/generate-video (video only)\nGET  /latest-deliverables (download all files from latest job)\nGET  /latest-file/:name   (download specific file)\nGET  /api/deliverables/:jobId\nGET  /health\n');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 SCZ Dashboard v3 — Multi-File Delivery`);
  console.log(`   http://0.0.0.0:${PORT}`);
  console.log(`   POST /api/generate-image  → image.jpg + description.md`);
  console.log(`   POST /api/generate        → auto (image + document.md)`);
  console.log(`   GET  /latest-deliverables → all files from latest job`);
});
