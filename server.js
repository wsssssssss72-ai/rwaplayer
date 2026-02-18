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


// -------------------- PDF VIEWER ROUTE --------------------
// Works like Chrome's PDF viewer with same referer/headers & Range support
app.get('/pdf', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    // Forward required headers
    const forwardHeaders = {
      accept: req.headers.accept || 'application/pdf,application/octet-stream,*/*',
      referer: 'https://appx-play.akamai.net.in/', // same as your other proxy routes
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    };

    // Pass through Range header for partial content support
    if (req.headers.range) {
      forwardHeaders.Range = req.headers.range;
    }

    // Fetch from upstream
    const upstream = await axios.get(url, {
      headers: forwardHeaders,
      responseType: 'stream',
      validateStatus: status => status < 400
    });

    // Set status and propagate important headers
    res.status(upstream.status);

    const incomingHeaders = upstream.headers || {};
    res.setHeader('content-type', incomingHeaders['content-type'] || 'application/pdf');
    if (incomingHeaders['content-length']) res.setHeader('content-length', incomingHeaders['content-length']);
    if (incomingHeaders['accept-ranges']) res.setHeader('accept-ranges', incomingHeaders['accept-ranges']);
    if (incomingHeaders['content-range']) res.setHeader('content-range', incomingHeaders['content-range']);
    if (incomingHeaders['last-modified']) res.setHeader('last-modified', incomingHeaders['last-modified']);
    if (incomingHeaders['etag']) res.setHeader('etag', incomingHeaders['etag']);

    // Force inline display in browser PDF viewer
    res.setHeader('content-disposition', 'inline; filename="document.pdf"');

    // Pipe the data to the response
    upstream.data.pipe(res);
  } catch (err) {
    console.error('Error fetching PDF:', err.message || err);
    if (err.response && err.response.data) {
      res.status(err.response.status || 500).type('text').send(`Upstream error fetching PDF`);
    } else {
      res.status(500).send('Proxy error: ' + (err.message || 'unknown error'));
    }
  }
});
// -----------------------------------------------------------


// -------------------- ADVANCED PDF VIEWER ROUTE (FIXED HEADERS) --------------------
app.get('/pdf-viewer', async (req, res) => {
  const { url, dl = '0' } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    // If direct download is requested
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

    // Encode URL for safe embedding in HTML/JS
    const encodedUrl = encodeURIComponent(url);
    
    // Serve the HTML viewer with high-quality rendering
    const viewerHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mr. Kagra x RWA</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background-color: #525659; height: 100vh; display: flex; flex-direction: column; }
    .toolbar { background: #323639; color: white; padding: 8px; display: flex; align-items: center; gap: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.3); }
    .toolbar button { background: #4a4e52; border: none; color: white; padding: 5px 10px; border-radius: 3px; cursor: pointer; transition: background 0.2s; }
    .toolbar button:hover { background: #5a5e62; }
    .toolbar button:disabled { opacity: 0.5; cursor: not-allowed; }
    .toolbar .spacer { flex-grow: 1; }
    .toolbar .page-info { font-size: 14px; margin: 0 10px; }
    .toolbar .download-btn { background: #2a5885; }
    .toolbar .download-btn:hover { background: #3a6895; }
    .viewer-container { flex: 1; overflow: auto; position: relative; background-color: #525659; }
    #pdf-viewer { display: block; margin: 0 auto; max-width: 100%; width: 100%; height: auto; box-shadow: 0 0 10px rgba(0,0,0,0.5); }
    .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: white; }
    .zoom-controls { display: flex; align-items: center; gap: 5px; }
    .zoom-controls button { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; }
    .search-container { display: flex; align-items: center; gap: 5px; margin-left: 10px; }
    .search-container input { padding: 5px; border-radius: 3px; border: none; }
    .search-matches { font-size: 13px; margin-right: 5px; }
    @media (max-width: 768px) {
      .toolbar { flex-wrap: wrap; padding: 5px; }
      .search-container { order: 1; width: 100%; margin: 5px 0 0 0; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="prev-page" title="Previous Page"><i class="fas fa-arrow-left"></i></button>
    <button id="next-page" title="Next Page"><i class="fas fa-arrow-right"></i></button>
    <span class="page-info">Page <span id="page-num">1</span> of <span id="page-count">0</span></span>
    
    <div class="zoom-controls">
      <button id="zoom-out" title="Zoom Out"><i class="fas fa-search-minus"></i></button>
      <button id="zoom-reset" title="Reset Zoom">100%</button>
      <button id="zoom-in" title="Zoom In"><i class="fas fa-search-plus"></i></button>
    </div>
    
    <div class="spacer"></div>
    
    <div class="search-container">
      <input type="text" id="search-input" placeholder="Search..." />
      <button id="search-prev" title="Previous Match"><i class="fas fa-chevron-up"></i></button>
      <button id="search-next" title="Next Match"><i class="fas fa-chevron-down"></i></button>
      <span class="search-matches" id="search-matches"></span>
    </div>
    
    <button class="download-btn" id="download" title="Download PDF"><i class="fas fa-download"></i></button>
  </div>
  
  <div class="viewer-container">
    <div class="loading">Loading PDF...</div>
    <canvas id="pdf-viewer"></canvas>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js"></script>
  <script>
    // Set PDF.js worker path
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
    
    // PDF viewer state
    let pdfDoc = null,
        pageNum = 1,
        pageRendering = false,
        pageNumPending = null,
        scale = 1.0,
        canvas = document.getElementById('pdf-viewer'),
        ctx = canvas.getContext('2d'),
        searchText = '',
        searchMatches = [],
        currentMatch = 0;
    
    // Custom PDF loader to add referer headers
    class CustomPDFLoader {
      constructor(url) {
        this.url = url;
      }
      
      async getRange(begin, end) {
        const response = await fetch('/pdf?url=' + encodeURIComponent(this.url), {
          headers: {
            'Range': 'bytes=' + begin + '-' + (end - 1),
            'Referer': 'https://appx-play.akamai.net.in/'
          }
        });
        
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' loading PDF');
        }
        
        return new Uint8Array(await response.arrayBuffer());
      }
      
      async getData() {
        const response = await fetch('/pdf?url=' + encodeURIComponent(this.url), {
          headers: {
            'Referer': 'https://appx-play.akamai.net.in/'
          }
        });
        
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' loading PDF');
        }
        
        return new Uint8Array(await response.arrayBuffer());
      }
    }
    
    // Initialize the viewer
    function initPDFViewer() {
      const pdfUrl = decodeURIComponent("${encodedUrl}");
      
      // Use our custom loader for proper headers
      const customLoader = new CustomPDFLoader(pdfUrl);
      
      const loadingTask = pdfjsLib.getDocument({
        url: '/pdf?url=' + encodeURIComponent(pdfUrl),
        withCredentials: false,
        httpHeaders: { 
          'Referer': 'https://appx-play.akamai.net.in/',
          'User-Agent': navigator.userAgent
        },
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/cmaps/',
        cMapPacked: true
      });
      
      loadingTask.promise.then(function(pdf) {
        pdfDoc = pdf;
        document.getElementById('page-count').textContent = pdf.numPages;
        
        // Initial page render
        renderPage(pageNum);
        
        // Handle window resize
        window.addEventListener('resize', function() {
          if (pdfDoc && !pageRendering) {
            renderPage(pageNum);
          }
        });
      }).catch(function(err) {
        console.error('PDF loading error:', err);
        document.querySelector('.loading').textContent = 'Error loading PDF. ' + (err.message || 'Please check the PDF URL');
        
        // Fallback: try direct URL with referer header
        setTimeout(() => {
          document.querySelector('.loading').textContent = 'Trying alternative method...';
          const fallbackTask = pdfjsLib.getDocument({
            url: pdfUrl,
            httpHeaders: { 
              'Referer': 'https://appx-play.akamai.net.in/',
              'User-Agent': navigator.userAgent
            }
          });
          
          fallbackTask.promise.then(function(pdf) {
            pdfDoc = pdf;
            document.getElementById('page-count').textContent = pdf.numPages;
            renderPage(pageNum);
          }).catch(function(fallbackErr) {
            document.querySelector('.loading').textContent = 'Failed to load PDF: ' + (fallbackErr.message || 'Unknown error');
          });
        }, 1000);
      });
    }
    
    // Render a page with high quality
    function renderPage(num) {
      pageRendering = true;
      document.querySelector('.loading').style.display = 'block';
      
      // Get device pixel ratio for crisp rendering
      const dpr = window.devicePixelRatio || 1;
      const container = canvas.parentElement;
      
      pdfDoc.getPage(num).then(function(page) {
        // Get viewport at default scale to calculate proper scaling
        const viewport = page.getViewport({ scale: 1.0 });
        
        // Calculate optimal scale to fit width while maintaining aspect ratio
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        const pageAspectRatio = viewport.width / viewport.height;
        
        // Calculate the display dimensions
        let displayWidth = containerWidth;
        let displayHeight = containerWidth / pageAspectRatio;
        
        // If height exceeds container, scale down
        if (displayHeight > containerHeight) {
          displayHeight = containerHeight;
          displayWidth = containerHeight * pageAspectRatio;
        }
        
        // Calculate the scale needed to fit the page width
        scale = displayWidth / viewport.width;
        
        // Set canvas display dimensions
        canvas.style.width = displayWidth + 'px';
        canvas.style.height = displayHeight + 'px';
        
        // Set canvas rendering dimensions (actual pixels)
        canvas.width = Math.floor(displayWidth * dpr);
        canvas.height = Math.floor(displayHeight * dpr);
        
        // Get viewport with calculated scale and DPR
        const scaledViewport = page.getViewport({ 
          scale: scale * dpr,
          offsetX: 0,
          offsetY: 0,
          dontFlip: false
        });
        
        const renderContext = {
          canvasContext: ctx,
          viewport: scaledViewport
        };
        
        // Clear canvas and render
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
      }).catch(function(err) {
        console.error('Page rendering error:', err);
        document.querySelector('.loading').textContent = 'Error rendering page. ' + (err.message || '');
      });
      
      document.getElementById('page-num').textContent = num;
    }

    // Queue page rendering
    function queueRenderPage(num) {
      if (pageRendering) {
        pageNumPending = num;
      } else {
        renderPage(num);
      }
    }
    
    // Navigation functions
    function prevPage() {
      if (pageNum <= 1) return;
      pageNum--;
      queueRenderPage(pageNum);
    }
    
    function nextPage() {
      if (pageNum >= pdfDoc.numPages) return;
      pageNum++;
      queueRenderPage(pageNum);
    }
    
    // Zoom functions with limits
    function zoomIn() {
      scale = Math.min(scale * 1.1, 3.0); // Max zoom 300%
      queueRenderPage(pageNum);
    }
    
    function zoomOut() {
      scale = Math.max(scale / 1.1, 0.5); // Min zoom 50%
      queueRenderPage(pageNum);
    }
    
    function zoomReset() {
      // Reset to fit page width
      scale = 1.0;
      queueRenderPage(pageNum);
    }
    
    // Event listeners
    document.getElementById('prev-page').addEventListener('click', prevPage);
    document.getElementById('next-page').addEventListener('click', nextPage);
    document.getElementById('zoom-in').addEventListener('click', zoomIn);
    document.getElementById('zoom-out').addEventListener('click', zoomOut);
    document.getElementById('zoom-reset').addEventListener('click', zoomReset);
    document.getElementById('download').addEventListener('click', function() {
      window.location.href = window.location.pathname + '?url=${encodedUrl}&dl=1';
    });
    
    // Initialize on load
    window.addEventListener('load', initPDFViewer);
  </script>
</body>
</html>`;

    res.setHeader('content-type', 'text/html');
    res.send(viewerHTML);
  } catch (err) {
    console.error('Error in PDF viewer:', err);
    const encodedUrl = encodeURIComponent(req.query.url || '');
    res.status(500).send(`
      <html><body style="background:#525659;color:white;padding:20px;font-family:Arial">
        <h1>Error loading PDF viewer</h1>
        <p>${err.message || 'Unknown error'}</p>
        <p>You can try to <a href="/pdf?url=${encodedUrl}" style="color:lightblue">view the PDF directly</a> or 
        <a href="/pdf-viewer?url=${encodedUrl}&dl=1" style="color:lightblue">download it</a>.</p>
      </body></html>
    `);
  }
});


// Player endpoint with all features
app.get('/player', (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send(`
      <html>
        <body style="background:black;color:white;display:flex;justify-content:center;align-items:center;height:100vh;">
          <h1>Missing URL parameter - Usage: /player?url=STREAM_URL</h1>
        </body>
      </html>
    `);
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Mr. Kagra x RWA</title>
  <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
  <style>
    :root {
      --primary: #ff2d55;
      --text: #ffffff;
      --highlight: rgba(255,45,85,0.4);
      --volume-color: #4CAF50;
      --buffer-color: rgba(255, 255, 255, 0.3);
      --gold: #FFD700;
    }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', sans-serif; background: #000; color: var(--text); }
    
    #player-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #000;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    
    #video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    
    #loading {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-size: 1.2rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 15px;
      z-index: 10;
    }
    
    .spinner {
      animation: spin 1s linear infinite;
      font-size: 2rem;
    }
    
    @keyframes spin {
      100% { transform: rotate(360deg); }
    }
    
    .controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 15px;
      background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 5;
      transition: all 0.3s ease;
      opacity: 1;
    }
    
    .controls.hidden {
      opacity: 0;
      pointer-events: none;
    }
    
    .progress-container {
      width: 100%;
      height: 5px;
      background: rgba(255,255,255,0.1);
      cursor: pointer;
      position: relative;
      border-radius: 3px;
      overflow: visible;
    }
    
    #progress-bar {
      height: 100%;
      background: var(--primary);
      width: 0%;
      position: relative;
      z-index: 2;
    }
    
    #buffer-bar {
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: var(--buffer-color);
      width: 0%;
      z-index: 1;
    }

    /* 🆕 Video progress handle — white circle with colorful border */
    #progress-handle {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: white; /* inner circle white */
      border: 2px solid transparent;
      background-image:         
        linear-gradient(135deg, #ffffff, #f0f0f0),     /* premium white gradient */
        linear-gradient(90deg, #ff4757, #ffa502, #2ed573, #3742fa, #8e44ad); /* vibrant border */
      background-origin: border-box;
      background-clip: content-box, border-box;
      box-shadow: 0 0 8px rgba(255, 45, 85, 0.6);
      z-index: 10;
      pointer-events: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }

    /* Hover effect (slightly enlarge + glow more) */
    .progress-container:hover #progress-handle {
      transform: translate(-50%, -50%) scale(1.3);
      box-shadow: 0 0 14px rgba(255, 45, 85, 0.8);
    }
    
    .main-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      gap: 10px;
    }
    
    .left-controls, .right-controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: nowrap;
    }
    
    .control-btn {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: white;
      font-size: 1.1rem;
      cursor: pointer;
      width: 42px;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: background 0.25s, transform 0.25s;
      position: relative;
      overflow: hidden;
    }

    .control-btn:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: scale(1.1);
    }

    /* 🔵 Ripple effect like YouTube */
    .control-btn::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 0;
      height: 0;
      background: rgba(255, 255, 255, 0.4);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      opacity: 0;
      pointer-events: none;
    }

    .control-btn:active::after {
      width: 180%;
      height: 180%;
      opacity: 0.3;
      transition: width 0.35s ease-out, height 0.35s ease-out, opacity 0.5s ease-out;
    }

    .control-btn:focus,
    .control-btn:active {
      outline: none !important;
      box-shadow: none !important;
    }

    .control-btn {
      -webkit-tap-highlight-color: transparent;
    }
    
    .material-icons {
      font-size: 20px;
    }
    
    /* Skip Buttons */
    .skip-btn {
      position: relative;
    }
    
    .skip-btn::before {
      content: '10';
      position: absolute;
      top: -8px;
      right: -5px;
      font-size: 10px;
      color: white;
      background: var(--primary);
      border-radius: 50%;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
    }
    
    /* Lock Button */
    #lock-btn {
      position: absolute;
      right: 20px;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255, 215, 0, 0.2);
      color: var(--gold);
      z-index: 10;
      opacity: 0;
      transition: opacity 0.3s;
    }
    
    #lock-btn.visible {
      opacity: 1;
    }
    
    #lock-btn:hover {
      background: rgba(255, 215, 0, 0.3);
    }
    
    .time-display {
      font-size: 0.9rem;
      min-width: 110px;
      text-align: center;
      color: white;
      padding: 8px 12px;
    }
    
    /* Volume Control */
    .volume-container {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 120px;
    }

    #volume-slider {
      width: 80px;
      height: 4px;
      -webkit-appearance: none;
      /* CHANGED LINE */
      background: rgba(255, 255, 255, 0.2);
      border-radius: 2px;
      /* NEW LINES */
      position: relative;
    }

    /* COMPLETELY NEW SECTION ADD */
    #volume-slider::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      height: 100%;
      background: var(--volume-color);
      width: var(--volume-fill, 100%);
      border-radius: 2px;
      z-index: 1;
    }

    #volume-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: white;
      border: 2px solid #8B5CF6; /* Violet border */
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      cursor: pointer;
      position: relative;
      z-index: 2;
      transition: all 0.2s ease;
    }

    #volume-slider::-webkit-slider-thumb:hover {
      transform: scale(1.1);
      border-color: #7C3AED; /* Darker violet on hover */
    }

    #volume-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: white;
      border: 2px solid #8B5CF6; /* VIOLET BORDER */
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      cursor: pointer;
      transition: all 0.2s ease;
    }

    #volume-slider::-moz-range-thumb:hover {
      transform: scale(1.1);
      border-color: #7C3AED; /* Darker violet on hover */
    }

    /* NEW LINES ADDED */
    #volume-slider::-webkit-slider-track {
      background: transparent;
    }

    #volume-slider::-moz-range-track {
      background: rgba(255, 255, 255, 0.2);
      height: 4px;
      border-radius: 2px;
      border: none;
    }

    #volume-slider::-moz-range-progress {
      background: var(--volume-color);
      height: 4px;
      border-radius: 2px;
    }

    #volume-slider::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: white;
      cursor: pointer;
      border: none;
    }
    
    /* Settings Menu */
    .settings-menu {
      position: relative;
    }
    
    .settings-dropdown {
      position: absolute;
      bottom: 50px;
      right: 0;
      background: rgba(30, 30, 30, 0.95);
      border-radius: 8px;
      padding: 8px 0;
      width: 160px;
      opacity: 0;
      pointer-events: none;
      transition: all 0.3s;
    }
    
    .settings-menu.active .settings-dropdown {
      opacity: 1;
      pointer-events: all;
    }
    
    .settings-item {
      padding: 8px 15px;
      cursor: pointer;
      color: white;
    }
    
    .settings-item:hover {
      color: var(--primary);
    }
    
    .settings-item.selected {
      color: var(--primary);
      font-weight: bold;
    }
    
    /* Fullscreen Styles */
    #player-container:fullscreen {
      width: 100% !important;
      height: 100% !important;
      background: black;
    }
    
    #player-container:-webkit-full-screen {
      width: 100% !important;
      height: 100% !important;
      background: black;
    }
    
    #player-container:-moz-full-screen {
      width: 100% !important;
      height: 100% !important;
      background: black;
    }
    
    #player-container:-ms-fullscreen {
      width: 100% !important;
      height: 100% !important;
      background: black;
    }
  </style>
</head>
<body>
  <div id="player-container">
    <video id="video" playsinline></video>
    <div id="loading">
      <span class="material-icons spinner">autorenew</span>
      <span>Loading Stream...</span>
    </div>
    
    <!-- Lock Button -->
    <button class="control-btn" id="lock-btn" title="Lock Controls">
      <span class="material-icons">lock</span>
    </button>
    
    <div class="controls">
      <div class="progress-container">
        <div id="buffer-bar"></div>
        <div id="progress-bar"></div>
        <div id="progress-handle"></div> <!-- 🆕 Added -->
      </div>
      
      <div class="main-controls">
        <div class="left-controls">
          <button class="control-btn" id="play-btn">
            <span class="material-icons">play_arrow</span>
          </button>
          
          <button class="control-btn skip-btn" id="rewind-btn">
            <span class="material-icons">replay_10</span>
          </button>
          
          <button class="control-btn skip-btn" id="forward-btn">
            <span class="material-icons">forward_10</span>
          </button>
          
          <div class="volume-container">
            <button class="control-btn" id="volume-btn">
              <span class="material-icons">volume_up</span>
            </button>
            <input type="range" id="volume-slider" min="0" max="1" step="0.01" value="1">
          </div>
          
          <div class="time-display" id="time-display">0:00 / 0:00</div>
        </div>
        
        <div class="right-controls">
          <div class="settings-menu" id="settings-menu">
            <button class="control-btn" id="settings-btn">
              <span class="material-icons">settings</span>
            </button>
            <div class="settings-dropdown" id="settings-dropdown">
              <div class="settings-item" data-speed="0.25">0.25x</div>
              <div class="settings-item" data-speed="0.5">0.5x</div>
              <div class="settings-item" data-speed="0.75">0.75x</div>
              <div class="settings-item selected" data-speed="1">1x</div>
              <div class="settings-item" data-speed="1.25">1.25x</div>
              <div class="settings-item" data-speed="1.5">1.5x</div>
              <div class="settings-item" data-speed="2">2x</div>
              <div class="settings-item" data-speed="3">3x</div>
              <div class="settings-item" data-speed="4">4x</div>
            </div>
          </div>
          
          <button class="control-btn" id="fullscreen-btn">
            <span class="material-icons">fullscreen</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

  <!-- Vercel Analytics -->
  <script defer src="https://vercel.com/analytics/script.js"></script>
  
  <script>
    document.addEventListener('DOMContentLoaded', () => {
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
      const timeDisplay = document.getElementById('time-display');
      const playerContainer = document.getElementById('player-container');
      const controls = document.querySelector('.controls');
      
      let hls;
      let hideControlsTimeout;
      let hideLockButtonTimeout;
      let isSettingsOpen = false;
      let controlsLocked = false;
      let isFullscreen = false;
      const url = new URLSearchParams(window.location.search).get('url');
      
      // Initialize player
      function initPlayer() {
        if (!url) {
          showError('Missing stream URL');
          return;
        }
        
        if (Hls.isSupported()) {
          hls = new Hls({
            maxBufferLength: 600,
            maxMaxBufferLength: 1800,
            maxBufferSize: 60 * 1000 * 1000,
            maxBufferHole: 5.0
          });
          
          hls.loadSource('/proxy?url=' + encodeURIComponent(url));
          hls.attachMedia(video);
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            loading.style.display = 'none';
            video.play().catch(e => {
              showError('Click to play', true);
            });
            initVolume();
            showControls();
          });
          
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              let errorMsg = 'Stream Error';
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                errorMsg = 'Network Error - Try reloading';
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                errorMsg = 'Media Error - Try another stream';
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
            video.play().catch(e => {
              showError('Click to play', true);
            });
            initVolume();
            showControls();
          });
        } else {
          showError('Your browser doesn\\'t support HLS streaming');
        }
      }
      
      function showError(message, clickable = false) {
        loading.innerHTML = \`<span class="material-icons">error</span> \${message}\`;
        if (clickable) {
          loading.style.cursor = 'pointer';
          loading.onclick = () => {
            video.play().catch(e => console.log(e));
            loading.style.display = 'none';
          };
        }
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
          volumeBtn.innerHTML = '<span class="material-icons">volume_off</span>';
          volumeSlider.value = 0;  // NEW LINE - slider position 0 pe set karo
          volumeSlider.style.setProperty('--volume-fill', '0%');
        } else {
          updateVolumeIcon();
          updateVolumeSliderColor();
        }
      }
            
      function updateVolumeIcon() {
        if (video.volume === 0) {
          volumeBtn.innerHTML = '<span class="material-icons">volume_off</span>';
        } else if (video.volume < 0.5) {
          volumeBtn.innerHTML = '<span class="material-icons">volume_down</span>';
        } else {
          volumeBtn.innerHTML = '<span class="material-icons">volume_up</span>';
        }
      }
      
      function updateVolumeSliderColor() {
        const percent = video.volume * 100;
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
          lockBtn.classList.remove('visible');
        }, 3000);
      }
      
      function resetHideControlsTimer() {
        clearTimeout(hideControlsTimeout);
        hideControlsTimeout = setTimeout(hideControls, 3000);
      }
      
      playerContainer.addEventListener('mousemove', () => {
        showControls();
      });
      
      playerContainer.addEventListener('click', (e) => {
        if (e.target === playerContainer || e.target === video) {
          if (controls.classList.contains('hidden')) {
            showControls();
          } else {
            hideControls();
          }
        }
      });
      
      // Lock Controls
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        controlsLocked = !controlsLocked;
        
        if (controlsLocked) {
          lockBtn.innerHTML = '<span class="material-icons">lock_open</span>';
          controls.classList.add('hidden');
        } else {
          lockBtn.innerHTML = '<span class="material-icons">lock</span>';
          showControls();
        }
        showLockButton();
      });
      
      // Playback controls
      playBtn.addEventListener('click', () => {
        if (video.paused) {
          video.play().catch(e => showError('Click to play', true));
        } else {
          video.pause();
        }
        showControls();
      });
      
      video.addEventListener('play', () => {
        playBtn.innerHTML = '<span class="material-icons">pause</span>';
      });
      
      video.addEventListener('pause', () => {
        playBtn.innerHTML = '<span class="material-icons">play_arrow</span>';
      });
      
      // Skip buttons
      rewindBtn.addEventListener('click', () => {
        video.currentTime = Math.max(0, video.currentTime - 10);
        showControls();
      });
      
      forwardBtn.addEventListener('click', () => {
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
        showControls();
      });
      
      // ==========================
      // 🎯 Final Working Progress Logic
      // ==========================

      const progressHandle = document.getElementById('progress-handle');
      let isDragging = false;

      // ✅ Updates bar + handle position
      function updateProgressUI(percent) {
        progressBar.style.width = percent + '%';
        if (progressHandle) {
          progressHandle.style.left = percent + '%';
        }
      }

      // ✅ Jump to selected position (mouse/touch)
      function seekToPosition(clientX) {
        const rect = progressContainer.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const percent = pos * 100;
        updateProgressUI(percent);
        if (!isNaN(video.duration)) {
          video.currentTime = pos * video.duration;
        }
      }

      // ✅ When video plays normally — move circle
      video.addEventListener('timeupdate', () => {
         if (!isDragging && !isNaN(video.duration)) {
           const percent = (video.currentTime / video.duration) * 100;
           updateProgressUI(percent);
           timeDisplay.textContent =
             formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
         }
       });

       // ✅ Mouse control
       progressContainer.addEventListener('mousedown', (e) => {
         isDragging = true;
         seekToPosition(e.clientX);
       });

       document.addEventListener('mousemove', (e) => {
         if (isDragging) seekToPosition(e.clientX);
       });

       document.addEventListener('mouseup', () => {
         isDragging = false;
       });

       // ✅ Touch control (mobile)
       progressContainer.addEventListener('touchstart', (e) => {
         isDragging = true;
         seekToPosition(e.touches[0].clientX);
       });

       document.addEventListener('touchmove', (e) => {
         if (isDragging) seekToPosition(e.touches[0].clientX);
       });

       document.addEventListener('touchend', () => {
         isDragging = false;
       });

      // Touch support for mobile
      progressContainer.addEventListener('touchstart', (e) => {
        isDragging = true;
        const rect = progressContainer.getBoundingClientRect();
        const pos = (e.touches[0].clientX - rect.left) / rect.width;
        video.currentTime = pos * video.duration;
        showControls();
      });

      document.addEventListener('touchmove', (e) => {
        if (isDragging) {
          const rect = progressContainer.getBoundingClientRect();
          const pos = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
          video.currentTime = pos * video.duration;
        }
      });

      document.addEventListener('touchend', () => {
        isDragging = false;
      });
      
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
      
      video.addEventListener('timeupdate', () => {
        if (!isNaN(video.duration)) {
          const percent = (video.currentTime / video.duration) * 100;
          progressBar.style.width = percent + '%';
          timeDisplay.textContent = 
            formatTime(video.currentTime) + ' / ' + formatTime(video.duration);
        }
      });
      
      // Volume control
      volumeBtn.addEventListener('click', () => {
        if (video.muted) {
          // Unmute - restore previous volume
          video.muted = false;
          volumeSlider.value = video.volume;
          updateVolumeIcon();
          updateVolumeSliderColor();
        } else {
          // Mute - remember current volume and set to 0
          video.muted = true;
          volumeSlider.value = 0;
          volumeBtn.innerHTML = '<span class="material-icons">volume_off</span>';
          volumeSlider.style.setProperty('--volume-fill', '0%');
        }
  
        localStorage.setItem('playerMuted', video.muted);
        showControls();
      });
      
      volumeSlider.addEventListener('input', (e) => {
        video.volume = e.target.value;
        // NEW CONDITION ADDED
        if (video.volume > 0) {
          video.muted = false;
          localStorage.setItem('playerMuted', false);
        }
        localStorage.setItem('playerVolume', video.volume);
        updateVolumeIcon();
        updateVolumeSliderColor();
        showControls();
      });
      
      // Settings menu
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
      fullscreenBtn.addEventListener('click', () => {
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
      });
      
      document.addEventListener('fullscreenchange', () => {
        isFullscreen = !!document.fullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<span class="material-icons">fullscreen_exit</span>' : 
          '<span class="material-icons">fullscreen</span>';
      });
      
      document.addEventListener('webkitfullscreenchange', () => {
        isFullscreen = !!document.webkitFullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<span class="material-icons">fullscreen_exit</span>' : 
          '<span class="material-icons">fullscreen</span>';
      });
      
      document.addEventListener('msfullscreenchange', () => {
        isFullscreen = !!document.msFullscreenElement;
        fullscreenBtn.innerHTML = isFullscreen ? 
          '<span class="material-icons">fullscreen_exit</span>' : 
          '<span class="material-icons">fullscreen</span>';
      });

      video.addEventListener('dblclick', async () => {
          const isFull = !!document.fullscreenElement;

          try {
              if (!isFull) {
                  // Enter fullscreen in portrait
                  await playerContainer.requestFullscreen();
            
                  if (screen.orientation?.lock) {
                      try {
                          await screen.orientation.lock('portrait');
                      } catch (orientationError) {
                          console.warn('Portrait lock failed, falling back to zoom:', orientationError);
                          // Fallback zoom if portrait lock fails
                          video.style.transform = 'rotate(0deg) scale(1.25)';
                          video.style.transformOrigin = 'center center';
                          video.style.transition = 'transform 0.3s ease';
                      }
                  }
              } else {
                  // Already fullscreen → check orientation
                  if (screen.orientation?.type?.includes('portrait')) {
                      // Switch to landscape
                      try {
                          await screen.orientation.lock('landscape');
                      } catch (landscapeError) {
                          console.warn('Landscape lock failed:', landscapeError);
                      }
                  } else {
                      // Landscape → exit fullscreen & reset zoom
                      await document.exitFullscreen();
                      video.style.transform = '';
                      video.style.transition = '';
                  }
              }
          } catch (fullscreenError) {
              console.error('Fullscreen error:', fullscreenError);
          }
      });
      
      function formatTime(seconds) {
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
