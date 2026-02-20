import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
const PORT = 3000;

// Proxy for .m3u8 playlists
app.get('/proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing url parameter');

  try {
    const response = await axios.get(url, {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/"
      }
    });

    const base = url.substring(0, url.lastIndexOf('/') + 1);
    const playlist = response.data.replace(
      /^(?!#)([^\r\n]+)$/gm,
      (line: string) => {
        if (line.startsWith('http') || line.startsWith('#')) return line;
        return `/segment?base=${encodeURIComponent(base)}&file=${encodeURIComponent(line)}`;
      }
    );

    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (err: any) {
    console.error('Error fetching playlist:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// Proxy for .ts segments
app.get('/segment', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { base, file } = req.query;
  if (!base || !file || typeof base !== 'string' || typeof file !== 'string') return res.status(400).send('Missing base or file parameter');

  const segmentUrl = base + file;
  try {
    const response = await axios.get(segmentUrl, {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/"
      },
      responseType: 'stream'
    });

    res.status(response.status);
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
    response.data.pipe(res);
  } catch (err: any) {
    console.error('Error fetching segment:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// Download route for entire HLS video
app.get('/api/download', async (req, res) => {
  const { url, filename } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing url');

  try {
    // 1. Fetch the playlist
    const response = await axios.get(url, {
      headers: { "Referer": "https://appx-play.akamai.net.in/" }
    });
    const playlist = response.data;
    
    // 2. Extract segment URLs
    const base = url.substring(0, url.lastIndexOf('/') + 1);
    const lines = playlist.split('\n');
    const segments = lines.filter((line: string) => line.trim() && !line.startsWith('#'));

    if (segments.length === 0) {
      return res.status(404).send('No segments found in playlist');
    }

    // 3. Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${filename || 'video'}.ts"`);
    res.setHeader('Content-Type', 'video/mp2t');

    // 4. Stream segments sequentially
    for (const segment of segments) {
      const segmentUrl = segment.startsWith('http') ? segment : base + segment;
      try {
        const segRes = await axios.get(segmentUrl, {
          headers: { "Referer": "https://appx-play.akamai.net.in/" },
          responseType: 'stream',
          timeout: 10000
        });
        
        await new Promise((resolve, reject) => {
          segRes.data.pipe(res, { end: false });
          segRes.data.on('end', resolve);
          segRes.data.on('error', reject);
        });
      } catch (segErr: any) {
        console.warn(`Failed to fetch segment ${segmentUrl}:`, segErr.message);
        // Continue with next segment if one fails, or handle as needed
      }
    }
    res.end();
  } catch (err: any) {
    console.error('Download error:', err.message);
    if (!res.headersSent) res.status(500).send('Download failed: ' + err.message);
  }
});

// PDF routes
app.get('/pdf', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing url parameter');

  try {
    const forwardHeaders: any = {
      accept: req.headers.accept || 'application/pdf,application/octet-stream,*/*',
      referer: 'https://appx-play.akamai.net.in/',
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    };

    if (req.headers.range) {
      forwardHeaders.Range = req.headers.range;
    }

    const upstream = await axios.get(url, {
      headers: forwardHeaders,
      responseType: 'stream',
      validateStatus: status => status < 400
    });

    res.status(upstream.status);
    const incomingHeaders = upstream.headers || {};
    res.setHeader('content-type', incomingHeaders['content-type'] || 'application/pdf');
    if (incomingHeaders['content-length']) res.setHeader('content-length', incomingHeaders['content-length']);
    if (incomingHeaders['accept-ranges']) res.setHeader('accept-ranges', incomingHeaders['accept-ranges']);
    if (incomingHeaders['content-range']) res.setHeader('content-range', incomingHeaders['content-range']);
    res.setHeader('content-disposition', 'inline; filename="document.pdf"');
    upstream.data.pipe(res);
  } catch (err: any) {
    console.error('Error fetching PDF:', err.message || err);
    res.status(500).send('Proxy error: ' + (err.message || 'unknown error'));
  }
});

app.get('/pdf-viewer', async (req, res) => {
  const { url, dl = '0' } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).send('Missing url parameter');

  try {
    if (dl === '1') {
      const upstream = await axios.get(url, {
        headers: {
          referer: 'https://appx-play.akamai.net.in/',
          'user-agent': req.headers['user-agent'] || 'Mozilla/5.0'
        },
        responseType: 'stream'
      });

      res.setHeader('content-type', upstream.headers['content-type'] || 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="document_${Date.now()}.pdf"`);
      upstream.data.pipe(res);
      return;
    }

    const encodedUrl = encodeURIComponent(url);
    
    const viewerHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Snow PDF Viewer</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; height: 100vh; display: flex; flex-direction: column; }
    .toolbar { background: rgba(20,20,20,0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid rgba(255,255,255,0.1); padding: 12px 20px; display: flex; align-items: center; gap: 15px; color: white; }
    .toolbar button { background: transparent; border: none; color: rgba(255,255,255,0.7); width: 36px; height: 36px; border-radius: 8px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; font-size: 16px; }
    .toolbar button:hover { background: rgba(255,255,255,0.1); color: white; }
    .toolbar .spacer { flex-grow: 1; }
    .toolbar .page-info { font-size: 13px; color: rgba(255,255,255,0.5); padding: 0 10px; }
    .toolbar .download-btn { background: #2a2a2a; width: auto; padding: 0 16px; border-radius: 8px; color: white; }
    .toolbar .download-btn:hover { background: #3a3a3a; }
    .viewer-container { flex: 1; overflow: auto; position: relative; background: #1a1a1a; display: flex; justify-content: center; align-items: flex-start; padding: 20px; }
    #pdf-viewer { box-shadow: 0 5px 20px rgba(0,0,0,0.5); border-radius: 4px; max-width: 100%; }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: white; font-size: 14px; background: rgba(0,0,0,0.7); padding: 12px 24px; border-radius: 30px; border: 1px solid rgba(255,255,255,0.1); }
    .zoom-controls { display: flex; align-items: center; gap: 5px; background: rgba(255,255,255,0.05); padding: 3px; border-radius: 8px; }
    .zoom-controls button { width: 32px; height: 32px; }
    #zoom-reset { width: auto; padding: 0 12px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="prev-page"><i class="fas fa-chevron-left"></i></button>
    <button id="next-page"><i class="fas fa-chevron-right"></i></button>
    <span class="page-info">Page <span id="page-num">1</span> of <span id="page-count">0</span></span>
    
    <div class="zoom-controls">
      <button id="zoom-out"><i class="fas fa-search-minus"></i></button>
      <button id="zoom-reset">100%</button>
      <button id="zoom-in"><i class="fas fa-search-plus"></i></button>
    </div>
    
    <div class="spacer"></div>
    
    <button class="download-btn" id="download"><i class="fas fa-download"></i> Download</button>
  </div>
  
  <div class="viewer-container">
    <div class="loading">Loading PDF...</div>
    <canvas id="pdf-viewer"></canvas>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js"></script>
  <script>
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    
    let pdfDoc = null, pageNum = 1, pageRendering = false, pageNumPending = null, scale = 1.0;
    const canvas = document.getElementById('pdf-viewer');
    const ctx = canvas.getContext('2d');
    
    function initPDFViewer() {
      const pdfUrl = decodeURIComponent("${encodedUrl}");
      
      const loadingTask = pdfjsLib.getDocument({
        url: '/pdf?url=' + encodeURIComponent(pdfUrl),
        withCredentials: false,
        httpHeaders: { 'Referer': 'https://appx-play.akamai.net.in/', 'User-Agent': navigator.userAgent }
      });
      
      loadingTask.promise.then(function(pdf) {
        pdfDoc = pdf;
        document.getElementById('page-count').textContent = pdf.numPages;
        renderPage(pageNum);
      }).catch(function(err) {
        document.querySelector('.loading').innerHTML = 'Error loading PDF';
      });
    }
    
    function renderPage(num) {
      pageRendering = true;
      document.querySelector('.loading').style.display = 'block';
      
      const dpr = window.devicePixelRatio || 1;
      const container = canvas.parentElement;
      
      pdfDoc.getPage(num).then(function(page) {
        const viewport = page.getViewport({ scale: 1.0 });
        const containerWidth = container.clientWidth - 40;
        const containerHeight = container.clientHeight - 40;
        
        scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height, 2.0);
        if (scale < 0.5) scale = 0.5;
        
        const scaledViewport = page.getViewport({ scale: scale * dpr });
        
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        canvas.style.width = (scaledViewport.width / dpr) + 'px';
        canvas.style.height = (scaledViewport.height / dpr) + 'px';
        
        const renderContext = {
          canvasContext: ctx,
          viewport: scaledViewport
        };
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        const renderTask = page.render(renderContext);
        renderTask.promise.then(function() {
          pageRendering = false;
          document.querySelector('.loading').style.display = 'none';
          if (pageNumPending !== null) {
            renderPage(pageNumPending);
            pageNumPending = null;
          }
        });
      });
      
      document.getElementById('page-num').textContent = num;
      document.getElementById('zoom-reset').textContent = Math.round(scale * 100) + '%';
    }

    function queueRenderPage(num) {
      if (pageRendering) pageNumPending = num;
      else renderPage(num);
    }
    
    function prevPage() { if (pageNum <= 1) return; pageNum--; queueRenderPage(pageNum); }
    function nextPage() { if (pageNum >= pdfDoc.numPages) return; pageNum++; queueRenderPage(pageNum); }
    function zoomIn() { scale = Math.min(scale * 1.2, 3.0); queueRenderPage(pageNum); }
    function zoomOut() { scale = Math.max(scale / 1.2, 0.5); queueRenderPage(pageNum); }
    function zoomReset() { scale = 1.0; queueRenderPage(pageNum); }
    
    document.getElementById('prev-page').addEventListener('click', prevPage);
    document.getElementById('next-page').addEventListener('click', nextPage);
    document.getElementById('zoom-in').addEventListener('click', zoomIn);
    document.getElementById('zoom-out').addEventListener('click', zoomOut);
    document.getElementById('zoom-reset').addEventListener('click', zoomReset);
    document.getElementById('download').addEventListener('click', () => {
      window.location.href = window.location.pathname + '?url=${encodedUrl}&dl=1';
    });
    
    window.addEventListener('load', initPDFViewer);
    window.addEventListener('resize', () => { if (pdfDoc) queueRenderPage(pageNum); });
  </script>
</body>
</html>\`;

    res.setHeader('content-type', 'text/html');
    res.send(viewerHTML);
  } catch (err) {
    res.status(500).send('Error loading PDF viewer');
  }
});

// SNOW PLAYER - Professional Minimalist UI
app.get('/player', (req, res) => {
  const { url } = req.query;
  
  if (!url || typeof url !== 'string') {
    return res.status(400).send(\`
      <html>
        <body style="background:#0a0a0a;color:white;display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial;">
          <h1 style="font-weight:300;">Missing URL parameter - /player?url=STREAM_URL</h1>
        </body>
      </html>
    \`);
  }

  const html = \`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>SNOW PLAYER - Professional Video Player</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #000;
      overflow: hidden;
    }

    #player-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #000;
    }

    #video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    /* Loading Animation - Minimal */
    #loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: rgba(255,255,255,0.9);
      z-index: 10;
    }

    .loader {
      width: 40px;
      height: 40px;
      margin: 0 auto 16px;
      border: 2px solid rgba(255,255,255,0.1);
      border-top: 2px solid #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    #loading span {
      font-size: 13px;
      font-weight: 400;
      letter-spacing: 1px;
      text-transform: uppercase;
      opacity: 0.7;
    }

    /* Controls - Ultra Clean */
    .controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 40px 24px 20px;
      background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
      transition: opacity 0.3s ease;
      opacity: 1;
      z-index: 5;
    }

    .controls.hidden {
      opacity: 0;
      pointer-events: none;
    }

    /* Progress Bar - Minimal */
    .progress-container {
      width: 100%;
      height: 3px;
      background: rgba(255,255,255,0.15);
      cursor: pointer;
      position: relative;
      margin-bottom: 18px;
      border-radius: 0;
    }

    #progress-bar {
      height: 100%;
      background: #fff;
      width: 0%;
      position: relative;
      z-index: 2;
      transition: width 0.1s linear;
    }

    #buffer-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: rgba(255,255,255,0.3);
      width: 0%;
      z-index: 1;
    }

    #progress-handle {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 10px;
      height: 10px;
      background: #fff;
      border-radius: 50%;
      z-index: 10;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }

    .progress-container:hover #progress-handle {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.2);
    }

    /* Main Controls Row */
    .main-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .left-controls, .right-controls {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    /* Control Buttons - Minimal */
    .control-btn {
      background: transparent;
      border: none;
      color: rgba(255,255,255,0.8);
      width: 36px;
      height: 36px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      transition: all 0.2s;
    }

    .control-btn:hover {
      color: #fff;
      background: rgba(255,255,255,0.1);
    }

    .control-btn:active {
      transform: scale(0.95);
    }

    /* Play Button - Accent */
    #play-btn {
      background: rgba(255,255,255,0.1);
      color: #fff;
      width: 40px;
      height: 40px;
      font-size: 20px;
    }

    #play-btn:hover {
      background: rgba(255,255,255,0.2);
    }

    /* Skip Buttons */
    .skip-btn {
      font-size: 16px;
      position: relative;
    }

    /* Time Display */
    .time-display {
      font-size: 13px;
      font-weight: 400;
      color: rgba(255,255,255,0.7);
      letter-spacing: 0.3px;
      background: rgba(0,0,0,0.3);
      padding: 4px 10px;
      border-radius: 12px;
    }

    /* Volume Control - Minimal */
    .volume-container {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #volume-slider {
      width: 70px;
      height: 3px;
      -webkit-appearance: none;
      background: rgba(255,255,255,0.2);
      border-radius: 0;
      outline: none;
    }

    #volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 10px;
      height: 10px;
      background: #fff;
      border-radius: 50%;
      cursor: pointer;
      transition: transform 0.2s;
    }

    #volume-slider::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }

    /* Settings Menu */
    .settings-menu {
      position: relative;
    }

    .settings-dropdown {
      position: absolute;
      bottom: 45px;
      right: 0;
      background: rgba(20,20,20,0.95);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 8px;
      padding: 4px 0;
      width: 140px;
      border: 1px solid rgba(255,255,255,0.1);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: all 0.2s;
      box-shadow: 0 5px 20px rgba(0,0,0,0.5);
    }

    .settings-menu.active .settings-dropdown {
      opacity: 1;
      transform: translateY(0);
      pointer-events: all;
    }

    .settings-item {
      padding: 10px 16px;
      cursor: pointer;
      color: rgba(255,255,255,0.7);
      font-size: 13px;
      transition: all 0.2s;
      text-align: left;
    }

    .settings-item:hover {
      background: rgba(255,255,255,0.1);
      color: #fff;
    }

    .settings-item.selected {
      color: #fff;
      background: rgba(255,255,255,0.05);
    }

    /* Quality Badge */
    .quality-badge {
      position: absolute;
      top: 20px;
      left: 20px;
      background: rgba(0,0,0,0.5);
      color: rgba(255,255,255,0.8);
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0.5px;
      border: 1px solid rgba(255,255,255,0.1);
      z-index: 10;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .quality-badge.visible {
      opacity: 1;
    }

    /* Fullscreen Button */
    #fullscreen-btn {
      font-size: 18px;
    }

    /* Mobile Optimizations */
    @media (max-width: 768px) {
      .controls { padding: 30px 16px 16px; }
      .left-controls { gap: 12px; }
      .right-controls { gap: 12px; }
      .control-btn { width: 32px; height: 32px; font-size: 16px; }
      #play-btn { width: 36px; height: 36px; }
      .time-display { font-size: 12px; padding: 3px 8px; }
      #volume-slider { width: 50px; }
    }
  </style>
</head>
<body>
  <div id="player-container">
    <video id="video" playsinline></video>
    
    <div id="loading">
      <div class="loader"></div>
      <span>SNOW PLAYER</span>
    </div>

    <div class="quality-badge" id="quality-badge">
      <i class="fas fa-hd"></i> AUTO
    </div>
    
    <div class="controls">
      <div class="progress-container">
        <div id="buffer-bar"></div>
        <div id="progress-bar"></div>
        <div id="progress-handle"></div>
      </div>
      
      <div class="main-controls">
        <div class="left-controls">
          <button class="control-btn" id="play-btn">
            <i class="fas fa-play"></i>
          </button>
          
          <button class="control-btn skip-btn" id="rewind-btn">
            <i class="fas fa-undo-alt"></i>
          </button>
          
          <button class="control-btn skip-btn" id="forward-btn">
            <i class="fas fa-redo-alt"></i>
          </button>
          
          <div class="volume-container">
            <button class="control-btn" id="volume-btn">
              <i class="fas fa-volume-up"></i>
            </button>
            <input type="range" id="volume-slider" min="0" max="1" step="0.01" value="1">
          </div>
          
          <div class="time-display" id="time-display">0:00 / 0:00</div>
        </div>
        
        <div class="right-controls">
          <button class="control-btn" id="download-video-btn" title="Download Entire Video">
            <i class="fas fa-download"></i>
          </button>

          <div class="settings-menu" id="settings-menu">
            <button class="control-btn" id="settings-btn">
              <i class="fas fa-cog"></i>
            </button>
            <div class="settings-dropdown" id="settings-dropdown">
              <div class="settings-item selected" data-speed="1">Normal</div>
              <div class="settings-item" data-speed="1.25">1.25x</div>
              <div class="settings-item" data-speed="1.5">1.5x</div>
              <div class="settings-item" data-speed="1.75">1.75x</div>
              <div class="settings-item" data-speed="2">2x</div>
              <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
              <div class="settings-item" data-speed="0.5">0.5x</div>
              <div class="settings-item" data-speed="0.75">0.75x</div>
            </div>
          </div>
          
          <button class="control-btn" id="fullscreen-btn">
            <i class="fas fa-expand"></i>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      // DOM Elements
      const video = document.getElementById('video');
      const loading = document.getElementById('loading');
      const playBtn = document.getElementById('play-btn');
      const rewindBtn = document.getElementById('rewind-btn');
      const forwardBtn = document.getElementById('forward-btn');
      const volumeBtn = document.getElementById('volume-btn');
      const volumeSlider = document.getElementById('volume-slider');
      const fullscreenBtn = document.getElementById('fullscreen-btn');
      const settingsBtn = document.getElementById('settings-btn');
      const settingsMenu = document.getElementById('settings-menu');
      const settingsDropdown = document.getElementById('settings-dropdown');
      const progressContainer = document.querySelector('.progress-container');
      const progressBar = document.getElementById('progress-bar');
      const bufferBar = document.getElementById('buffer-bar');
      const progressHandle = document.getElementById('progress-handle');
      const timeDisplay = document.getElementById('time-display');
      const playerContainer = document.getElementById('player-container');
      const controls = document.querySelector('.controls');
      const qualityBadge = document.getElementById('quality-badge');
      const downloadVideoBtn = document.getElementById('download-video-btn');
      
      // State
      let hls;
      let hideControlsTimeout;
      let isSettingsOpen = false;
      let isFullscreen = false;
      let isDragging = false;
      let hideQualityBadgeTimeout;
      
      const url = new URLSearchParams(window.location.search).get('url');
      
      // Initialize Player
      function initPlayer() {
        if (!url) {
          showError('Missing stream URL');
          return;
        }
        
        if (Hls.isSupported()) {
          hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            maxBufferSize: 30 * 1000 * 1000,
            maxBufferHole: 0.5,
            lowLatencyMode: true
          });
          
          hls.loadSource('/proxy?url=' + encodeURIComponent(url));
          hls.attachMedia(video);
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            loading.style.display = 'none';
            video.play().catch(() => {
              showError('Click to play', true);
            });
            initVolume();
            showControls();
            
            // Show quality info
            const levels = hls.levels;
            if (levels && levels.length > 0) {
              const maxHeight = Math.max(...levels.map(l => l.height || 0));
              if (maxHeight >= 1080) qualityBadge.innerHTML = '<i class="fas fa-4k"></i> 4K';
              else if (maxHeight >= 720) qualityBadge.innerHTML = '<i class="fas fa-hd"></i> HD';
              else qualityBadge.innerHTML = '<i class="fas fa-sd"></i> SD';
              showQualityBadge();
            }
          });
          
          hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            const level = hls.levels[data.level];
            if (level) {
              const height = level.height || 0;
              if (height >= 1080) qualityBadge.innerHTML = '<i class="fas fa-4k"></i> 4K';
              else if (height >= 720) qualityBadge.innerHTML = '<i class="fas fa-hd"></i> HD';
              else qualityBadge.innerHTML = '<i class="fas fa-sd"></i> SD';
              showQualityBadge();
            }
          });
          
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                hls.startLoad();
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
              }
            }
          });
          
          hls.on(Hls.Events.FRAG_BUFFERED, () => {
            updateBufferBar();
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = '/proxy?url=' + encodeURIComponent(url);
          video.addEventListener('loadedmetadata', () => {
            loading.style.display = 'none';
            video.play().catch(() => {
              showError('Click to play', true);
            });
            initVolume();
            showControls();
          });
        } else {
          showError('HLS not supported');
        }
        
        // Video event listeners
        video.addEventListener('timeupdate', updateProgress);
        video.addEventListener('progress', updateBufferBar);
        video.addEventListener('play', () => {
          playBtn.innerHTML = '<i class="fas fa-pause"></i>';
        });
        video.addEventListener('pause', () => {
          playBtn.innerHTML = '<i class="fas fa-play"></i>';
        });
        video.addEventListener('volumechange', updateVolumeIcon);
        video.addEventListener('ended', () => {
          playBtn.innerHTML = '<i class="fas fa-redo"></i>';
        });
      }
      
      function showError(message, clickable = false) {
        loading.innerHTML = \`
          <div class="loader"></div>
          <span>\${message}</span>
        \`;
        if (clickable) {
          loading.style.cursor = 'pointer';
          loading.onclick = () => {
            video.play();
            loading.style.display = 'none';
          };
        }
      }
      
      function showQualityBadge() {
        qualityBadge.classList.add('visible');
        clearTimeout(hideQualityBadgeTimeout);
        hideQualityBadgeTimeout = setTimeout(() => {
          qualityBadge.classList.remove('visible');
        }, 2000);
      }
      
      function initVolume() {
        const savedVolume = localStorage.getItem('playerVolume');
        const savedMuted = localStorage.getItem('playerMuted');
  
        if (savedVolume !== null) {
          video.volume = parseFloat(savedVolume);
          volumeSlider.value = video.volume;
        }
  
        if (savedMuted === 'true') {
          video.muted = true;
          volumeBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
          volumeSlider.value = 0;
        } else {
          updateVolumeIcon();
        }
      }
      
      function updateVolumeIcon() {
        if (video.muted || video.volume === 0) {
          volumeBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
        } else if (video.volume < 0.5) {
          volumeBtn.innerHTML = '<i class="fas fa-volume-down"></i>';
        } else {
          volumeBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
        }
      }
      
      function showControls() {
        controls.classList.remove('hidden');
        resetHideControlsTimer();
      }
      
      function hideControls() {
        if (!video.paused && !isSettingsOpen) {
          controls.classList.add('hidden');
        }
      }
      
      function resetHideControlsTimer() {
        clearTimeout(hideControlsTimeout);
        hideControlsTimeout = setTimeout(hideControls, 3000);
      }
      
      // Progress Functions
      function updateProgress() {
        if (!isDragging && !isNaN(video.duration)) {
          const percent = (video.currentTime / video.duration) * 100;
          progressBar.style.width = percent + '%';
          progressHandle.style.left = percent + '%';
          timeDisplay.textContent = 
            formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
        }
      }
      
      function updateBufferBar() {
        if (video.buffered.length > 0) {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          const duration = video.duration;
          if (duration > 0) {
            const bufferPercent = (bufferedEnd / duration) * 100;
            bufferBar.style.width = bufferPercent + '%';
          }
        }
      }
      
      function seekToPosition(clientX) {
        const rect = progressContainer.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const percent = pos * 100;
        progressBar.style.width = percent + '%';
        progressHandle.style.left = percent + '%';
        if (!isNaN(video.duration)) {
          video.currentTime = pos * video.duration;
        }
      }
      
      // Event Listeners
      playerContainer.addEventListener('mousemove', showControls);
      playerContainer.addEventListener('touchstart', showControls);
      
      playerContainer.addEventListener('click', (e) => {
        if (e.target === playerContainer || e.target === video) {
          if (controls.classList.contains('hidden')) {
            showControls();
          } else {
            hideControls();
          }
        }
      });
      
      // Progress Bar Controls
      progressContainer.addEventListener('mousedown', (e) => {
        isDragging = true;
        seekToPosition(e.clientX);
        showControls();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (isDragging) {
          seekToPosition(e.clientX);
        }
      });
      
      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
      
      progressContainer.addEventListener('touchstart', (e) => {
        isDragging = true;
        seekToPosition(e.touches[0].clientX);
        showControls();
      });
      
      document.addEventListener('touchmove', (e) => {
        if (isDragging) {
          seekToPosition(e.touches[0].clientX);
        }
      });
      
      document.addEventListener('touchend', () => {
        isDragging = false;
      });
      
      // Play Button
      playBtn.addEventListener('click', () => {
        if (video.paused) {
          video.play();
        } else {
          video.pause();
        }
        showControls();
      });
      
      // Skip Buttons
      rewindBtn.addEventListener('click', () => {
        video.currentTime = Math.max(0, video.currentTime - 10);
        showControls();
      });
      
      forwardBtn.addEventListener('click', () => {
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
        showControls();
      });
      
      // Volume Controls
      volumeBtn.addEventListener('click', () => {
        if (video.muted) {
          video.muted = false;
          volumeSlider.value = video.volume;
        } else {
          video.muted = true;
          volumeSlider.value = 0;
        }
        localStorage.setItem('playerMuted', video.muted);
        updateVolumeIcon();
        showControls();
      });
      
      volumeSlider.addEventListener('input', (e) => {
        video.volume = parseFloat(e.target.value);
        if (video.volume > 0) {
          video.muted = false;
          localStorage.setItem('playerMuted', false);
        }
        localStorage.setItem('playerVolume', video.volume);
        updateVolumeIcon();
        showControls();
      });
      
      // Settings Menu
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isSettingsOpen = !isSettingsOpen;
        settingsMenu.classList.toggle('active', isSettingsOpen);
        showControls();
      });
      
      document.addEventListener('click', (e) => {
        if (isSettingsOpen && !settingsDropdown.contains(e.target)) {
          isSettingsOpen = false;
          settingsMenu.classList.remove('active');
        }
      });
      
      settingsDropdown.querySelectorAll('.settings-item').forEach(item => {
        item.addEventListener('click', () => {
          const speed = parseFloat(item.dataset.speed);
          video.playbackRate = speed;
          settingsDropdown.querySelectorAll('.settings-item').forEach(i => {
            i.classList.remove('selected');
          });
          item.classList.add('selected');
          showControls();
        });
      });
      
      // FULLSCREEN FUNCTION - Click triggers fullscreen
      fullscreenBtn.addEventListener('click', toggleFullscreen);
      
      function toggleFullscreen() {
        if (!isFullscreen) {
          if (playerContainer.requestFullscreen) {
            playerContainer.requestFullscreen();
          } else if (playerContainer.webkitRequestFullscreen) {
            playerContainer.webkitRequestFullscreen();
          } else if (playerContainer.msRequestFullscreen) {
            playerContainer.msRequestFullscreen();
          }
          fullscreenBtn.innerHTML = '<i class="fas fa-compress"></i>';
        } else {
          if (document.exitFullscreen) {
            document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
          }
          fullscreenBtn.innerHTML = '<i class="fas fa-expand"></i>';
        }
        showControls();
      }
      
      // Listen for fullscreen change
      document.addEventListener('fullscreenchange', () => {
        isFullscreen = !!document.fullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<i class="fas fa-compress"></i>' : 
          '<i class="fas fa-expand"></i>';
      });
      
      document.addEventListener('webkitfullscreenchange', () => {
        isFullscreen = !!document.webkitFullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<i class="fas fa-compress"></i>' : 
          '<i class="fas fa-expand"></i>';
      });
      
      document.addEventListener('msfullscreenchange', () => {
        isFullscreen = !!document.msFullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<i class="fas fa-compress"></i>' : 
          '<i class="fas fa-expand"></i>';
      });
      
      // Double-click video for fullscreen
      video.addEventListener('dblclick', toggleFullscreen);
      
      // Download Button
      downloadVideoBtn.addEventListener('click', () => {
        const downloadUrl = '/api/download?url=' + encodeURIComponent(url) + '&filename=video_' + Date.now();
        window.open(downloadUrl, '_blank');
      });

      // Format Time
      function formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hrs > 0) {
          return hrs + ':' + 
                 (mins < 10 ? '0' : '') + mins + ':' + 
                 (secs < 10 ? '0' : '') + secs;
        } else {
          return mins + ':' + (secs < 10 ? '0' : '') + secs;
        }
      }
      
      // Keyboard Controls
      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;
        
        switch(e.key.toLowerCase()) {
          case ' ':
          case 'k':
            e.preventDefault();
            playBtn.click();
            break;
          case 'arrowleft':
            rewindBtn.click();
            break;
          case 'arrowright':
            forwardBtn.click();
            break;
          case 'arrowup':
            e.preventDefault();
            video.volume = Math.min(1, video.volume + 0.1);
            volumeSlider.value = video.volume;
            volumeSlider.dispatchEvent(new Event('input'));
            break;
          case 'arrowdown':
            e.preventDefault();
            video.volume = Math.max(0, video.volume - 0.1);
            volumeSlider.value = video.volume;
            volumeSlider.dispatchEvent(new Event('input'));
            break;
          case 'm':
            volumeBtn.click();
            break;
          case 'f':
            toggleFullscreen();
            break;
        }
      });
      
      // Initialize
      initPlayer();
    });
  </script>
</body>
</html>`;
  res.send(html);
});

// Vite middleware for development
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
});
app.use(vite.middlewares);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
