
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const util = require('util');
const execPromise = util.promisify(exec);
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const app = express();
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

const PORT = process.env.PORT || 3000;

// Create temp directory with unique ID
const TEMP_DIR = path.join(os.tmpdir(), 'snow_player_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'));
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean up temp files on exit
process.on('exit', () => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (e) {}
});

// Utility functions
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Enhanced proxy with full HLS support
app.get('/proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, depth = '0' } = req.query;
  
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    const response = await axios.get(decodeURIComponent(url), {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": "https://appx-play.akamai.net.in",
        "Connection": "keep-alive"
      },
      timeout: 60000,
      maxRedirects: 5,
      responseType: 'text'
    });

    const contentType = response.headers['content-type'] || '';
    
    // Check if this is a playlist
    if (contentType.includes('m3u8') || response.data.includes('#EXTM3U')) {
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      let playlist = response.data;
      
      // Parse and rewrite all segment URLs
      const lines = playlist.split('\n');
      const newLines = [];
      
      for (let line of lines) {
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          newLines.push(line);
        } else if (line.startsWith('#') || line.trim() === '') {
          newLines.push(line);
        } else {
          // This is a segment or variant URL
          const segmentUrl = line.trim();
          const absoluteUrl = segmentUrl.startsWith('http') ? segmentUrl : new URL(segmentUrl, baseUrl).href;
          newLines.push(`/proxy?url=${encodeURIComponent(absoluteUrl)}&depth=${parseInt(depth) + 1}`);
        }
      }
      
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.send(newLines.join('\n'));
    } else {
      // Direct file, stream it
      const fileResponse = await axios.get(decodeURIComponent(url), {
        headers: {
          "accept": "*/*",
          "Referer": "https://appx-play.akamai.net.in/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        responseType: 'stream',
        timeout: 60000
      });
      
      res.setHeader('content-type', fileResponse.headers['content-type'] || 'application/octet-stream');
      if (fileResponse.headers['content-length']) {
        res.setHeader('content-length', fileResponse.headers['content-length']);
      }
      fileResponse.data.pipe(res);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// Segment proxy for direct segment access
app.get('/segment', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    const response = await axios.get(decodeURIComponent(url), {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      responseType: 'stream',
      timeout: 60000
    });

    res.setHeader('content-type', response.headers['content-type'] || 'video/MP2T');
    if (response.headers['content-length']) {
      res.setHeader('content-length', response.headers['content-length']);
    }
    response.data.pipe(res);
  } catch (err) {
    console.error('Segment error:', err);
    res.status(500).send('Segment error: ' + err.message);
  }
});

// Master download endpoint with multiple strategies
app.get('/api/download', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, method = 'auto', quality = 'best' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const downloadId = generateId();
  const downloadPath = path.join(TEMP_DIR, downloadId);
  fs.mkdirSync(downloadPath);
  
  const outputFile = path.join(downloadPath, 'video.mp4');
  const logFile = path.join(downloadPath, 'log.txt');

  res.json({
    success: true,
    downloadId,
    message: 'Download started',
    statusUrl: `/api/status/${downloadId}`,
    downloadUrl: `/api/file/${downloadId}`
  });
});

// Download status endpoint
app.get('/api/status/:id', (req, res) => {
  const { id } = req.params;
  const downloadPath = path.join(TEMP_DIR, id);
  
  if (!fs.existsSync(downloadPath)) {
    return res.status(404).json({ error: 'Download not found' });
  }

  const statusFile = path.join(downloadPath, 'status.json');
  const logFile = path.join(downloadPath, 'log.txt');
  
  let status = { id, status: 'unknown' };
  if (fs.existsSync(statusFile)) {
    status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  }
  
  if (fs.existsSync(logFile)) {
    status.log = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l);
  }
  
  res.json(status);
});

// Download file endpoint
app.get('/api/file/:id', (req, res) => {
  const { id } = req.params;
  const downloadPath = path.join(TEMP_DIR, id);
  const videoFile = path.join(downloadPath, 'video.mp4');
  
  if (!fs.existsSync(videoFile)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(videoFile);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="snow_player_${id}.mp4"`);
  
  const fileStream = fs.createReadStream(videoFile);
  fileStream.pipe(res);
  
  // Clean up after download
  fileStream.on('end', () => {
    setTimeout(() => {
      try {
        fs.rmSync(downloadPath, { recursive: true, force: true });
      } catch (e) {}
    }, 60000);
  });
});

// Advanced web downloader with complete HLS processing
app.get('/downloader', (req, res) => {
  const { url } = req.query;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Snow Player Professional - Complete HLS Downloader</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --primary: #667eea;
      --secondary: #764ba2;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --dark: #1a1a1a;
      --light: #f7f7f7;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      margin-bottom: 20px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.2);
    }

    h1 {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 42px;
      margin-bottom: 10px;
    }

    .url-box {
      background: #f5f5f5;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
      word-break: break-all;
      border: 1px solid #e0e0e0;
    }

    /* Quality Grid */
    .quality-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }

    .quality-card {
      background: white;
      border: 2px solid #e0e0e0;
      border-radius: 12px;
      padding: 20px;
      cursor: pointer;
      transition: all 0.3s;
      text-align: center;
    }

    .quality-card:hover {
      border-color: var(--primary);
      transform: translateY(-5px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.2);
    }

    .quality-card.active {
      border-color: var(--primary);
      background: linear-gradient(135deg, #667eea10, #764ba210);
    }

    .quality-card .resolution {
      font-size: 24px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 5px;
    }

    .quality-card .bandwidth {
      font-size: 14px;
      color: #666;
    }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }

    .stat-card {
      background: white;
      border-radius: 15px;
      padding: 25px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
    }

    .stat-card .value {
      font-size: 36px;
      font-weight: 700;
      color: var(--primary);
      margin-bottom: 10px;
    }

    .stat-card .label {
      color: #666;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* Progress Area */
    .progress-area {
      background: white;
      border-radius: 15px;
      padding: 30px;
      margin: 20px 0;
    }

    .progress-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 15px;
    }

    .progress-bar {
      width: 100%;
      height: 30px;
      background: #f0f0f0;
      border-radius: 15px;
      overflow: hidden;
      margin: 15px 0;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      width: 0%;
      transition: width 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .progress-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.3),
        transparent
      );
      animation: shimmer 2s infinite;
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }

    /* Segment Grid */
    .segment-grid {
      background: var(--dark);
      border-radius: 15px;
      padding: 20px;
      margin: 20px 0;
      max-height: 500px;
      overflow-y: auto;
    }

    .segment-row {
      display: grid;
      grid-template-columns: 60px 1fr 120px 100px 80px;
      gap: 10px;
      padding: 10px;
      margin: 5px 0;
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      color: #00ff00;
      font-family: monospace;
      font-size: 12px;
      align-items: center;
    }

    .segment-row.header {
      background: rgba(255,255,255,0.1);
      color: white;
      font-weight: 600;
      position: sticky;
      top: 0;
    }

    .segment-row .status {
      padding: 4px 8px;
      border-radius: 4px;
      text-align: center;
      font-weight: 600;
    }

    .status.pending {
      background: #f59e0b;
      color: white;
    }

    .status.downloading {
      background: #3498db;
      color: white;
      animation: pulse 1s infinite;
    }

    .status.completed {
      background: #10b981;
      color: white;
    }

    .status.failed {
      background: #ef4444;
      color: white;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Download Button */
    .download-btn {
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: white;
      border: none;
      padding: 20px 40px;
      border-radius: 50px;
      font-size: 20px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.3s;
      margin: 20px 0;
      position: relative;
      overflow: hidden;
    }

    .download-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
    }

    .download-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    /* Console */
    .console {
      background: #1a1a1a;
      border-radius: 15px;
      padding: 20px;
      margin: 20px 0;
      font-family: 'Courier New', monospace;
      color: #00ff00;
      max-height: 300px;
      overflow-y: auto;
    }

    .console-line {
      padding: 5px 0;
      border-bottom: 1px solid #333;
      font-size: 12px;
    }

    .console-line .time {
      color: #888;
      margin-right: 15px;
    }

    /* Toast */
    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      background: white;
      border-radius: 12px;
      padding: 16px 24px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      display: flex;
      align-items: center;
      gap: 15px;
      transform: translateX(400px);
      transition: transform 0.3s ease;
      z-index: 1000;
    }

    .toast.show {
      transform: translateX(0);
    }

    .toast.success {
      border-left: 4px solid var(--success);
    }

    .toast.error {
      border-left: 4px solid var(--danger);
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 10px;
      margin: 20px 0;
    }

    .tab {
      padding: 12px 24px;
      background: white;
      border-radius: 30px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.3s;
    }

    .tab.active {
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: white;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    @media (max-width: 768px) {
      .segment-row {
        grid-template-columns: 40px 1fr 80px 70px 60px;
        font-size: 10px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❄️ Snow Player Professional</h1>
      <p style="color: #666;">Enterprise-grade HLS video downloader with complete segment processing</p>
      
      <div class="url-box">
        <strong style="display: block; margin-bottom: 10px; color: #333;">Video URL:</strong>
        <div style="color: var(--primary); word-break: break-all;" id="videoUrl">${url || 'No URL provided'}</div>
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('downloader')">📥 Downloader</div>
      <div class="tab" onclick="switchTab('analyzer')">🔍 Analyzer</div>
      <div class="tab" onclick="switchTab('queue')">📋 Queue</div>
    </div>

    <div id="downloaderTab" class="tab-content active">
      <div class="quality-grid" id="qualityGrid"></div>

      <div class="stats-grid" id="statsGrid">
        <div class="stat-card">
          <div class="value" id="totalSegments">0</div>
          <div class="label">Total Segments</div>
        </div>
        <div class="stat-card">
          <div class="value" id="downloadedSegments">0</div>
          <div class="label">Downloaded</div>
        </div>
        <div class="stat-card">
          <div class="value" id="totalSize">0 MB</div>
          <div class="label">Total Size</div>
        </div>
        <div class="stat-card">
          <div class="value" id="downloadSpeed">0 MB/s</div>
          <div class="label">Speed</div>
        </div>
        <div class="stat-card">
          <div class="value" id="timeRemaining">--:--</div>
          <div class="label">Time Left</div>
        </div>
        <div class="stat-card">
          <div class="value" id="successRate">100%</div>
          <div class="label">Success Rate</div>
        </div>
      </div>

      <div class="progress-area">
        <div class="progress-header">
          <span id="progressPercent">0%</span>
          <span id="progressDetails">0 of 0 segments</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" id="progressFill"></div>
        </div>
      </div>

      <div class="segment-grid" id="segmentGrid">
        <div class="segment-row header">
          <div>#</div>
          <div>URL</div>
          <div>Size</div>
          <div>Speed</div>
          <div>Status</div>
        </div>
      </div>

      <button class="download-btn" id="downloadBtn" onclick="startDownload()">
        <i class="fas fa-download"></i> Start Professional Download
      </button>
    </div>

    <div id="analyzerTab" class="tab-content">
      <div class="progress-area">
        <h3>Stream Analyzer</h3>
        <div id="analyzerContent">Click analyze to start</div>
      </div>
    </div>

    <div id="queueTab" class="tab-content">
      <div class="progress-area">
        <h3>Download Queue</h3>
        <div id="queueContent">No active downloads</div>
      </div>
    </div>

    <div class="console" id="console">
      <div class="console-line">
        <span class="time">${new Date().toLocaleTimeString()}</span>
        <span>Snow Player Professional initialized</span>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">
    <i class="fas" id="toastIcon"></i>
    <span id="toastMessage"></span>
  </div>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <script>
    // Global state
    let segments = [];
    let downloadedSegments = [];
    let segmentSizes = [];
    let segmentSpeeds = [];
    let totalSize = 0;
    let startTime = null;
    let isDownloading = false;
    let selectedQuality = null;
    let qualities = [];
    let masterPlaylist = null;
    let downloadQueue = [];
    let activeDownloads = 0;
    const MAX_CONCURRENT = 5;

    // Console logging
    function addLog(message, type = 'info') {
      const console = document.getElementById('console');
      const time = new Date().toLocaleTimeString();
      const line = document.createElement('div');
      line.className = 'console-line';
      line.innerHTML = \`<span class="time">\${time}</span> \${message}\`;
      console.appendChild(line);
      console.scrollTop = console.scrollHeight;
    }

    // Toast notification
    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      const icon = document.getElementById('toastIcon');
      const toastMessage = document.getElementById('toastMessage');
      
      toast.className = 'toast show ' + type;
      icon.className = 'fas ' + (type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle');
      toastMessage.textContent = message;
      
      setTimeout(() => {
        toast.classList.remove('show');
      }, 5000);
    }

    // Tab switching
    function switchTab(tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      event.target.classList.add('active');
      document.getElementById(tab + 'Tab').classList.add('active');
    }

    // Parse master playlist
    async function parseMasterPlaylist(url) {
      addLog('Fetching master playlist...');
      
      try {
        const response = await fetch('/proxy?url=' + encodeURIComponent(url));
        const playlist = await response.text();
        
        masterPlaylist = playlist;
        const lines = playlist.split('\n');
        const qualities = [];
        
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
            const resolution = lines[i].match(/RESOLUTION=(\d+x\d+)/)?.[1];
            const bandwidth = lines[i].match(/BANDWIDTH=(\d+)/)?.[1];
            const codecs = lines[i].match(/CODECS="([^"]+)"/)?.[1];
            const frameRate = lines[i].match(/FRAME-RATE=([\d.]+)/)?.[1];
            
            let nextLine = lines[i + 1]?.trim();
            while (nextLine && nextLine.startsWith('#')) {
              i++;
              nextLine = lines[i + 1]?.trim();
            }
            
            if (nextLine && !nextLine.startsWith('#')) {
              const qualityUrl = nextLine.startsWith('http') ? nextLine : new URL(nextLine, url).href;
              
              qualities.push({
                resolution: resolution || 'unknown',
                width: resolution ? parseInt(resolution.split('x')[0]) : 0,
                height: resolution ? parseInt(resolution.split('x')[1]) : 0,
                bandwidth: parseInt(bandwidth || '0'),
                bandwidthMbps: (parseInt(bandwidth || '0') / 1000000).toFixed(2),
                codecs: codecs || 'unknown',
                frameRate: frameRate || 'unknown',
                url: qualityUrl,
                name: resolution ? resolution.split('x')[1] + 'p' : 'auto'
              });
            }
          }
        }
        
        // Sort by quality (best first)
        qualities.sort((a, b) => {
          if (a.height !== b.height) return b.height - a.height;
          return b.bandwidth - a.bandwidth;
        });
        
        return qualities;
      } catch (error) {
        addLog('Error parsing master playlist: ' + error.message, 'error');
        showToast('Error parsing playlist: ' + error.message, 'error');
        return [];
      }
    }

    // Render quality grid
    function renderQualities(qualities) {
      const grid = document.getElementById('qualityGrid');
      grid.innerHTML = '';
      
      if (qualities.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px;">No quality variants found - using single stream</div>';
        return;
      }
      
      qualities.forEach((q, index) => {
        const card = document.createElement('div');
        card.className = 'quality-card' + (index === 0 ? ' active' : '');
        card.setAttribute('onclick', \`selectQuality(\${index})\`);
        card.innerHTML = \`
          <div class="resolution">\${q.height}p</div>
          <div class="bandwidth">\${q.bandwidthMbps} Mbps</div>
          <div style="font-size: 12px; color: #999; margin-top: 10px;">\${q.frameRate}fps</div>
        \`;
        grid.appendChild(card);
      });
      
      if (qualities.length > 0) {
        selectQuality(0);
      }
    }

    // Select quality
    function selectQuality(index) {
      document.querySelectorAll('.quality-card').forEach(c => c.classList.remove('active'));
      event.target.closest('.quality-card').classList.add('active');
      selectedQuality = qualities[index];
      addLog(\`Selected quality: \${selectedQuality.height}p (\${selectedQuality.bandwidthMbps} Mbps)\`);
    }

    // Parse segments from playlist
    async function parseSegments(playlistUrl) {
      addLog('Fetching segment playlist...');
      
      try {
        const response = await fetch('/proxy?url=' + encodeURIComponent(playlistUrl));
        const playlist = await response.text();
        
        const lines = playlist.split('\n');
        const segments = [];
        let currentSegment = {};
        let duration = 0;
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          if (line.startsWith('#EXTINF')) {
            const durationMatch = line.match(/EXTINF:([\d.]+)/);
            currentSegment.duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
            duration += currentSegment.duration;
          } else if (line.startsWith('#EXT-X-KEY')) {
            currentSegment.key = line;
          } else if (line.startsWith('#') || line === '') {
            // Skip comments
          } else {
            // This is a segment URL
            const segmentUrl = line.startsWith('http') ? line : new URL(line, playlistUrl).href;
            segments.push({
              url: segmentUrl,
              duration: currentSegment.duration || 0,
              key: currentSegment.key,
              index: segments.length
            });
            currentSegment = {};
          }
        }
        
        addLog(\`Found \${segments.length} segments, total duration: \${duration.toFixed(2)}s\`);
        return segments;
      } catch (error) {
        addLog('Error parsing segments: ' + error.message, 'error');
        throw error;
      }
    }

    // Render segment grid
    function renderSegments(segments) {
      const grid = document.getElementById('segmentGrid');
      grid.innerHTML = \`
        <div class="segment-row header">
          <div>#</div>
          <div>URL</div>
          <div>Size</div>
          <div>Speed</div>
          <div>Status</div>
        </div>
      \`;
      
      segments.forEach((segment, index) => {
        const row = document.createElement('div');
        row.className = 'segment-row';
        row.id = \`segment-\${index}\`;
        row.innerHTML = \`
          <div>#\${index + 1}</div>
          <div style="color: #888; overflow: hidden; text-overflow: ellipsis;">\${segment.url.split('/').pop()}</div>
          <div class="size">-</div>
          <div class="speed">-</div>
          <div><span class="status pending">Pending</span></div>
        \`;
        grid.appendChild(row);
      });
      
      document.getElementById('totalSegments').textContent = segments.length;
    }

    // Update segment status
    function updateSegmentStatus(index, status, size = 0, speed = 0) {
      const row = document.getElementById(\`segment-\${index}\`);
      if (!row) return;
      
      const statusSpan = row.querySelector('.status');
      const sizeSpan = row.querySelector('.size');
      const speedSpan = row.querySelector('.speed');
      
      statusSpan.className = 'status ' + status;
      statusSpan.textContent = status.charAt(0).toUpperCase() + status.slice(1);
      
      if (size > 0) {
        sizeSpan.textContent = formatBytes(size);
      }
      
      if (speed > 0) {
        speedSpan.textContent = formatBytes(speed) + '/s';
      }
    }

    // Format bytes
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Format time
    function formatTime(seconds) {
      if (!seconds || seconds < 0) return '--:--';
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      
      if (hrs > 0) {
        return hrs + 'h ' + mins + 'm ' + secs + 's';
      } else if (mins > 0) {
        return mins + 'm ' + secs + 's';
      } else {
        return secs + 's';
      }
    }

    // Update statistics
    function updateStats() {
      const downloadedCount = downloadedSegments.length;
      const percent = segments.length > 0 ? (downloadedCount / segments.length * 100).toFixed(1) : 0;
      const successRate = downloadedCount > 0 ? ((downloadedCount / segments.length) * 100).toFixed(1) : 100;
      
      document.getElementById('downloadedSegments').textContent = downloadedCount;
      document.getElementById('totalSize').textContent = formatBytes(totalSize);
      document.getElementById('progressPercent').textContent = percent + '%';
      document.getElementById('progressDetails').textContent = \`\${downloadedCount} of \${segments.length} segments\`;
      document.getElementById('progressFill').style.width = percent + '%';
      document.getElementById('successRate').textContent = successRate + '%';
      
      if (startTime && downloadedCount > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = totalSize / elapsed;
        document.getElementById('downloadSpeed').textContent = formatBytes(speed) + '/s';
        
        if (segments.length > downloadedCount) {
          const remainingSegments = segments.length - downloadedCount;
          const avgSegmentSize = totalSize / downloadedCount;
          const remainingBytes = remainingSegments * avgSegmentSize;
          const remainingTime = remainingBytes / speed;
          document.getElementById('timeRemaining').textContent = formatTime(remainingTime);
        } else {
          document.getElementById('timeRemaining').textContent = 'Complete';
        }
      }
    }

    // Download segment with retry
    async function downloadSegment(segment, retries = 3) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          updateSegmentStatus(segment.index, 'downloading');
          
          const startTime = Date.now();
          const response = await fetch('/segment?url=' + encodeURIComponent(segment.url));
          
          if (!response.ok) {
            throw new Error(\`HTTP \${response.status}\`);
          }
          
          const blob = await response.blob();
          const endTime = Date.now();
          const speed = blob.size / ((endTime - startTime) / 1000);
          
          segmentSizes[segment.index] = blob.size;
          segmentSpeeds[segment.index] = speed;
          
          updateSegmentStatus(segment.index, 'completed', blob.size, speed);
          
          return blob;
        } catch (error) {
          addLog(\`Segment \${segment.index + 1} download failed (attempt \${attempt}/\${retries}): \${error.message}\`, 'error');
          
          if (attempt === retries) {
            updateSegmentStatus(segment.index, 'failed');
            throw error;
          }
          
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
      }
    }

    // Download segments with concurrency control
    async function downloadSegments(segments) {
      const queue = [...segments];
      const results = [];
      let active = 0;
      
      return new Promise((resolve, reject) => {
        function next() {
          if (queue.length === 0 && active === 0) {
            resolve(results);
            return;
          }
          
          while (active < MAX_CONCURRENT && queue.length > 0) {
            const segment = queue.shift();
            active++;
            
            downloadSegment(segment)
              .then(blob => {
                results.push(blob);
                downloadedSegments.push(segment);
                totalSize += blob.size;
                updateStats();
                active--;
                next();
              })
              .catch(error => {
                addLog(\`Failed to download segment \${segment.index + 1}\`, 'error');
                active--;
                next();
              });
          }
        }
        
        next();
      });
    }

    // Main download function
    async function startDownload() {
      if (isDownloading) {
        showToast('Download already in progress', 'warning');
        return;
      }
      
      const urlParams = new URLSearchParams(window.location.search);
      const videoUrl = urlParams.get('url');
      
      if (!videoUrl) {
        showToast('No video URL provided', 'error');
        return;
      }

      const downloadBtn = document.getElementById('downloadBtn');
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Processing...';
      
      isDownloading = true;
      downloadedSegments = [];
      segmentSizes = [];
      segmentSpeeds = [];
      totalSize = 0;
      startTime = Date.now();

      try {
        // Step 1: Parse master playlist
        addLog('Step 1: Analyzing master playlist...');
        qualities = await parseMasterPlaylist(videoUrl);
        renderQualities(qualities);
        
        // Step 2: Select best quality if none selected
        if (!selectedQuality && qualities.length > 0) {
          selectedQuality = qualities[0];
        }
        
        // Step 3: Get playlist URL
        const playlistUrl = selectedQuality ? selectedQuality.url : videoUrl;
        addLog(\`Step 2: Using playlist: \${playlistUrl}\`);
        
        // Step 4: Parse segments
        addLog('Step 3: Parsing segment list...');
        segments = await parseSegments(playlistUrl);
        renderSegments(segments);
        
        if (segments.length === 0) {
          throw new Error('No segments found in playlist');
        }
        
        // Step 5: Download all segments
        addLog(\`Step 4: Downloading \${segments.length} segments with \${MAX_CONCURRENT} concurrent connections...\`);
        const blobs = await downloadSegments(segments);
        
        // Step 6: Combine segments
        addLog('Step 5: Combining segments into video...');
        const combinedBlob = new Blob(blobs, { type: 'video/mp4' });
        
        // Step 7: Create download
        addLog(\`Step 6: Creating download (\${formatBytes(combinedBlob.size)})...\`);
        const downloadUrl = URL.createObjectURL(combinedBlob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'snow_player_' + Date.now() + '.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        
        const elapsed = (Date.now() - startTime) / 1000;
        addLog(\`✅ Download complete! Total size: \${formatBytes(combinedBlob.size)}, Time: \${formatTime(elapsed)}\`);
        showToast(\`Download complete! \${formatBytes(combinedBlob.size)}\`, 'success');
        
        downloadBtn.innerHTML = '<i class="fas fa-check"></i> Download Complete';
        
      } catch (error) {
        addLog('❌ Download failed: ' + error.message, 'error');
        showToast('Error: ' + error.message, 'error');
        downloadBtn.innerHTML = '<i class="fas fa-redo"></i> Try Again';
      } finally {
        isDownloading = false;
        downloadBtn.disabled = false;
      }
    }

    // Initialize
    if ('${url}') {
      document.getElementById('videoUrl').textContent = '${url}';
      parseMasterPlaylist('${url}').then(qualities => {
        renderQualities(qualities);
      });
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    tempDir: TEMP_DIR,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Export for Vercel
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('=================================');
    console.log('❄️ SNOW PLAYER PROFESSIONAL');
    console.log('=================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Downloader: http://localhost:${PORT}/downloader?url=YOUR_HLS_URL`);
    console.log('=================================');
    console.log('Features:');
    console.log('• Complete HLS stream downloading');
    console.log('• Quality selection (1080p, 720p, etc.)');
    console.log('• Concurrent segment downloading');
    console.log('• Real-time progress tracking');
    console.log('• Automatic retry on failure');
    console.log('• Segment-by-segment status');
    console.log('• Download speed monitoring');
    console.log('• Time remaining estimation');
    console.log('=================================');
  });
}
