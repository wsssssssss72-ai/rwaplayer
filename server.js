const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
const PORT = process.env.PORT || 3000;

// Proxy for .m3u8 playlists
app.get('/proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

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
      (line) => {
        if (line.startsWith('http') || line.startsWith('#')) return line;
        return `/segment?base=${encodeURIComponent(base)}&file=${encodeURIComponent(line)}`;
      }
    );

    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (err) {
    console.error('Error fetching playlist:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// Proxy for .ts segments
app.get('/segment', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { base, file } = req.query;
  if (!base || !file) return res.status(400).send('Missing base or file parameter');

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
  } catch (err) {
    console.error('Error fetching segment:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// PDF routes
app.get('/pdf', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    const forwardHeaders = {
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
  } catch (err) {
    console.error('Error fetching PDF:', err.message || err);
    res.status(500).send('Proxy error: ' + (err.message || 'unknown error'));
  }
});

app.get('/pdf-viewer', async (req, res) => {
  const { url, dl = '0' } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

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
  <title>Mr. Kagra x RWA - PDF Viewer</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a1a; height: 100vh; display: flex; flex-direction: column; }
    .toolbar { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 12px 20px; display: flex; align-items: center; gap: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    .toolbar button { background: rgba(255,255,255,0.15); border: none; color: white; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; transition: all 0.3s; display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .toolbar button:hover { background: rgba(255,255,255,0.3); transform: scale(1.1); }
    .toolbar button:disabled { opacity: 0.3; cursor: not-allowed; transform: none; }
    .toolbar .spacer { flex-grow: 1; }
    .toolbar .page-info { font-size: 14px; font-weight: 500; padding: 0 10px; }
    .toolbar .download-btn { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); width: auto; padding: 0 20px; border-radius: 25px; }
    .viewer-container { flex: 1; overflow: auto; position: relative; background: #2d2d2d; display: flex; justify-content: center; align-items: flex-start; padding: 20px; }
    #pdf-viewer { box-shadow: 0 10px 40px rgba(0,0,0,0.4); border-radius: 8px; max-width: 100%; }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 40px; border-radius: 50px; font-size: 18px; box-shadow: 0 10px 30px rgba(102,126,234,0.4); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.05); } 100% { transform: translate(-50%, -50%) scale(1); } }
    .zoom-controls { display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,0.1); padding: 5px; border-radius: 30px; }
    .zoom-controls button { width: 35px; height: 35px; font-size: 16px; }
    #zoom-reset { width: auto; padding: 0 15px; border-radius: 20px; font-size: 14px; }
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
    
    class CustomPDFLoader {
      constructor(url) { this.url = url; }
      async getRange(begin, end) {
        const response = await fetch('/pdf?url=' + encodeURIComponent(this.url), {
          headers: { 'Range': 'bytes=' + begin + '-' + (end - 1), 'Referer': 'https://appx-play.akamai.net.in/' }
        });
        return new Uint8Array(await response.arrayBuffer());
      }
      async getData() {
        const response = await fetch('/pdf?url=' + encodeURIComponent(this.url), {
          headers: { 'Referer': 'https://appx-play.akamai.net.in/' }
        });
        return new Uint8Array(await response.arrayBuffer());
      }
    }
    
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
        document.querySelector('.loading').innerHTML = 'Error loading PDF. <button onclick="location.reload()" style="background:white;color:#667eea;border:none;padding:5px15px;border-radius:5px;margin-left:10px;">Retry</button>';
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
          viewport: scaledViewport,
          enableWebGL: true
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
</html>`;

    res.setHeader('content-type', 'text/html');
    res.send(viewerHTML);
  } catch (err) {
    res.status(500).send('Error loading PDF viewer');
  }
});

// PREMIUM UI PLAYER - Best UI Player Ever
app.get('/player', (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send(`
      <html>
        <body style="background:linear-gradient(135deg, #667eea 0%, #764ba2 100%);color:white;display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial;">
          <h1>Missing URL parameter - Usage: /player?url=STREAM_URL</h1>
        </body>
      </html>
    `);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Mr. Kagra x RWA - Premium Player</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #0a0a0a;
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

    /* Loading Animation */
    #loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      text-align: center;
      color: white;
      z-index: 10;
    }

    .loader {
      width: 80px;
      height: 80px;
      margin: 0 auto 20px;
      border: 4px solid rgba(255,255,255,0.1);
      border-top: 4px solid #ff2d55;
      border-right: 4px solid #ff6b6b;
      border-bottom: 4px solid #4ecdc4;
      border-left: 4px solid #45b7d1;
      border-radius: 50%;
      animation: spin 1.2s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    #loading span {
      font-size: 16px;
      font-weight: 500;
      background: linear-gradient(135deg, #ff2d55, #ff6b6b, #4ecdc4);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      animation: pulse 1.5s ease infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    /* Premium Controls */
    .controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 30px 20px 20px;
      background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.5), transparent);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-top: 1px solid rgba(255,255,255,0.1);
      transform: translateY(0);
      transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 5;
    }

    .controls.hidden {
      transform: translateY(100%);
    }

    /* Progress Bar */
    .progress-container {
      width: 100%;
      height: 6px;
      background: rgba(255,255,255,0.2);
      border-radius: 10px;
      cursor: pointer;
      position: relative;
      margin-bottom: 20px;
      overflow: visible;
    }

    #progress-bar {
      height: 100%;
      background: linear-gradient(90deg, #ff2d55, #ff6b6b, #4ecdc4, #45b7d1);
      border-radius: 10px;
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
      border-radius: 10px;
      width: 0%;
      z-index: 1;
    }

    #progress-handle {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 16px;
      height: 16px;
      background: white;
      border: 3px solid #ff2d55;
      border-radius: 50%;
      z-index: 10;
      pointer-events: none;
      box-shadow: 0 2px 10px rgba(255,45,85,0.5);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .progress-container:hover #progress-handle {
      transform: translate(-50%, -50%) scale(1.3);
      box-shadow: 0 0 20px rgba(255,45,85,0.8);
    }

    /* Main Controls Row */
    .main-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .left-controls, .right-controls {
      display: flex;
      align-items: center;
      gap: 15px;
    }

    /* Premium Buttons */
    .control-btn {
      background: rgba(255,255,255,0.1);
      border: none;
      color: white;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      overflow: hidden;
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      border: 1px solid rgba(255,255,255,0.1);
    }

    .control-btn::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      background: radial-gradient(circle, rgba(255,255,255,0.3) 0%, transparent 70%);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      transition: width 0.4s ease, height 0.4s ease;
    }

    .control-btn:hover::before {
      width: 150px;
      height: 150px;
    }

    .control-btn:hover {
      background: rgba(255,255,255,0.2);
      transform: scale(1.1);
      border-color: rgba(255,255,255,0.3);
    }

    .control-btn:active {
      transform: scale(0.95);
    }

    /* Skip Buttons */
    .skip-btn {
      position: relative;
    }

    .skip-btn::after {
      content: '10';
      position: absolute;
      top: -5px;
      right: -5px;
      font-size: 10px;
      font-weight: bold;
      background: linear-gradient(135deg, #ff2d55, #ff6b6b);
      color: white;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid white;
    }

    /* Time Display */
    .time-display {
      font-size: 14px;
      font-weight: 500;
      color: white;
      padding: 8px 15px;
      background: rgba(0,0,0,0.4);
      border-radius: 30px;
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      letter-spacing: 0.5px;
    }

    /* Volume Control */
    .volume-container {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(0,0,0,0.4);
      padding: 5px 15px 5px 10px;
      border-radius: 30px;
      border: 1px solid rgba(255,255,255,0.1);
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
    }

    #volume-slider {
      width: 80px;
      height: 4px;
      -webkit-appearance: none;
      background: linear-gradient(90deg, #4ecdc4 var(--volume-fill, 100%), rgba(255,255,255,0.2) var(--volume-fill, 100%));
      border-radius: 4px;
      outline: none;
    }

    #volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      background: white;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid #4ecdc4;
      transition: transform 0.2s;
      box-shadow: 0 2px 8px rgba(78,205,196,0.4);
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
      bottom: 50px;
      right: 0;
      background: rgba(20,20,20,0.95);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-radius: 16px;
      padding: 8px 0;
      width: 180px;
      border: 1px solid rgba(255,255,255,0.1);
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .settings-menu.active .settings-dropdown {
      opacity: 1;
      transform: translateY(0);
      pointer-events: all;
    }

    .settings-item {
      padding: 12px 20px;
      cursor: pointer;
      color: rgba(255,255,255,0.8);
      font-size: 14px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .settings-item:hover {
      background: rgba(255,255,255,0.1);
      color: white;
    }

    .settings-item.selected {
      color: #4ecdc4;
    }

    .settings-item.selected::after {
      content: '✓';
      font-size: 16px;
      color: #4ecdc4;
    }

    /* Lock Button */
    #lock-btn {
      position: absolute;
      top: 20px;
      right: 20px;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(255,215,0,0.3);
      color: gold;
      z-index: 10;
      opacity: 0;
      transition: opacity 0.3s;
    }

    #lock-btn.visible {
      opacity: 1;
    }

    #lock-btn:hover {
      background: rgba(0,0,0,0.7);
      border-color: gold;
    }

    /* Quality Indicator */
    .quality-badge {
      position: absolute;
      top: 20px;
      left: 20px;
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      color: white;
      padding: 8px 16px;
      border-radius: 30px;
      font-size: 13px;
      font-weight: 500;
      border: 1px solid rgba(255,255,255,0.1);
      z-index: 10;
      opacity: 0;
      transform: translateY(-10px);
      transition: all 0.3s;
    }

    .quality-badge.visible {
      opacity: 1;
      transform: translateY(0);
    }

    /* Mobile Optimizations */
    @media (max-width: 768px) {
      .controls { padding: 20px 15px 15px; }
      .left-controls { gap: 10px; }
      .right-controls { gap: 10px; }
      .control-btn { width: 40px; height: 40px; font-size: 18px; }
      .time-display { padding: 6px 12px; font-size: 13px; }
      .volume-container { padding: 3px 12px 3px 8px; }
      #volume-slider { width: 60px; }
      .settings-dropdown { width: 160px; }
    }
  </style>
</head>
<body>
  <div id="player-container">
    <video id="video" playsinline></video>
    
    <div id="loading">
      <div class="loader"></div>
      <span>PREMIUM STREAM LOADING...</span>
    </div>

    <div class="quality-badge" id="quality-badge">
      <i class="fas fa-hd"></i> AUTO
    </div>

    <button class="control-btn" id="lock-btn">
      <i class="fas fa-lock"></i>
    </button>
    
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
              <div style="height:1px;background:rgba(255,255,255,0.1);margin:8px 0;"></div>
              <div class="settings-item" data-speed="0.25">0.25x</div>
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
      const lockBtn = document.getElementById('lock-btn');
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
      
      // State
      let hls;
      let hideControlsTimeout;
      let hideLockButtonTimeout;
      let isSettingsOpen = false;
      let controlsLocked = false;
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
            maxBufferLength: 60,
            maxMaxBufferLength: 120,
            maxBufferSize: 60 * 1000 * 1000,
            maxBufferHole: 0.5,
            lowLatencyMode: true,
            backBufferLength: 60
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
              let errorMsg = 'Stream Error';
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                errorMsg = 'Network Error - Retrying...';
                hls.startLoad();
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                errorMsg = 'Media Error - Recovering...';
                hls.recoverMediaError();
              }
              showError(errorMsg);
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
          showError('Your browser doesn\\'t support HLS streaming');
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
            video.play().catch(e => console.log(e));
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
          updateVolumeSliderColor();
        }
  
        if (savedMuted === 'true') {
          video.muted = true;
          volumeBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
          volumeSlider.value = 0;
          volumeSlider.style.setProperty('--volume-fill', '0%');
        } else {
          updateVolumeIcon();
          updateVolumeSliderColor();
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
      
      function updateVolumeSliderColor() {
        const percent = (video.muted ? 0 : video.volume) * 100;
        volumeSlider.style.setProperty('--volume-fill', percent + '%');
      }
      
      function showControls() {
        if (!controlsLocked) {
          controls.classList.remove('hidden');
          resetHideControlsTimer();
        }
        showLockButton();
      }
      
      function hideControls() {
        if (!video.paused && !isSettingsOpen && !controlsLocked) {
          controls.classList.add('hidden');
        }
      }
      
      function showLockButton() {
        clearTimeout(hideLockButtonTimeout);
        lockBtn.classList.add('visible');
        hideLockButtonTimeout = setTimeout(() => {
          if (!controlsLocked) {
            lockBtn.classList.remove('visible');
          }
        }, 3000);
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
      
      // Lock Button
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        controlsLocked = !controlsLocked;
        
        if (controlsLocked) {
          lockBtn.innerHTML = '<i class="fas fa-lock-open"></i>';
          controls.classList.add('hidden');
          lockBtn.style.color = '#4ecdc4';
        } else {
          lockBtn.innerHTML = '<i class="fas fa-lock"></i>';
          lockBtn.style.color = 'gold';
          showControls();
        }
        showLockButton();
      });
      
      // Play Button
      playBtn.addEventListener('click', () => {
        if (video.paused) {
          video.play().catch(e => showError('Click to play', true));
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
        updateVolumeSliderColor();
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
        updateVolumeSliderColor();
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
      
      // Fullscreen
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
        } else {
          if (document.exitFullscreen) {
            document.exitFullscreen();
          } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
          } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
          }
        }
        showControls();
      }
      
      document.addEventListener('fullscreenchange', updateFullscreenButton);
      document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
      document.addEventListener('msfullscreenchange', updateFullscreenButton);
      
      function updateFullscreenButton() {
        isFullscreen = !!document.fullscreenElement || 
                      !!document.webkitFullscreenElement || 
                      !!document.msFullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<i class="fas fa-compress"></i>' : 
          '<i class="fas fa-expand"></i>';
      }
      
      // Double-click fullscreen with orientation
      video.addEventListener('dblclick', async () => {
        if (!isFullscreen) {
          await toggleFullscreen();
          if (screen.orientation && screen.orientation.lock) {
            try {
              await screen.orientation.lock('portrait');
            } catch (e) {
              console.log('Orientation lock failed');
            }
          }
        } else {
          await toggleFullscreen();
        }
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

// Start server
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
