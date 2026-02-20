const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Create temp directory with unique name for each instance
const TEMP_DIR = path.join(os.tmpdir(), 'snow_player_' + Date.now());
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean up temp files on exit
process.on('exit', () => {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  } catch (e) {}
});

// Helper function to generate unique filenames
function generateFileName(extension = 'mp4') {
  return `${crypto.randomBytes(8).toString('hex')}_${Date.now()}.${extension}`;
}

// Proxy for .m3u8 playlists
app.get('/proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    const response = await axios.get(url, {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 30000
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
        "Referer": "https://appx-play.akamai.net.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      responseType: 'stream',
      timeout: 30000
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

// ADVANCED DOWNLOAD ENDPOINT - Multiple methods with fallbacks
app.get('/download', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, method = 'auto' } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const fileName = generateFileName();
  const outputPath = path.join(TEMP_DIR, fileName);
  
  console.log(`Starting download for: ${url}`);
  console.log(`Output path: ${outputPath}`);
  console.log(`Method: ${method}`);

  // Method 1: Try FFmpeg first (best quality)
  if (method === 'auto' || method === 'ffmpeg') {
    try {
      console.log('Attempting FFmpeg download...');
      
      // Check if ffmpeg is available
      try {
        await execPromise('ffmpeg -version');
      } catch (e) {
        console.log('FFmpeg not available, trying next method');
        if (method === 'ffmpeg') throw new Error('FFmpeg not available');
      }

      const proxyUrl = `http://localhost:${PORT}/proxy?url=${encodeURIComponent(url)}`;
      
      // Use ffmpeg to download and convert
      const ffmpeg = spawn('ffmpeg', [
        '-i', proxyUrl,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-f', 'mp4',
        '-y',
        outputPath
      ]);

      let ffmpegError = '';

      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        ffmpegError += output;
        // Log progress
        if (output.includes('time=')) {
          const match = output.match(/time=(\d+:\d+:\d+\.\d+)/);
          if (match) {
            console.log(`FFmpeg progress: ${match[1]}`);
          }
        }
      });

      await new Promise((resolve, reject) => {
        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg exited with code ${code}: ${ffmpegError}`));
          }
        });
      });

      // Stream the file to client
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      
      const fileStream = fs.createReadStream(outputPath);
      await pipeline(fileStream, res);
      
      // Clean up
      fs.unlink(outputPath, () => {});
      
      console.log(`FFmpeg download complete: ${fileName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      return;
      
    } catch (ffmpegError) {
      console.error('FFmpeg download failed:', ffmpegError.message);
      if (method === 'ffmpeg') {
        return res.status(500).json({ error: ffmpegError.message });
      }
    }
  }

  // Method 2: Manual HLS download and concatenation
  if (method === 'auto' || method === 'manual') {
    try {
      console.log('Attempting manual HLS download...');
      
      // Fetch master playlist
      const playlistResponse = await axios.get(url, {
        headers: {
          "accept": "*/*",
          "Referer": "https://appx-play.akamai.net.in/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        timeout: 30000
      });

      const playlist = playlistResponse.data;
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      
      // Parse segments
      const segmentLines = playlist.split('\n')
        .filter(line => line && !line.startsWith('#') && line.trim().length > 0)
        .map(line => line.trim());
      
      console.log(`Found ${segmentLines.length} segments to download`);

      if (segmentLines.length === 0) {
        throw new Error('No segments found in playlist');
      }

      // Download segments in parallel with concurrency control
      const CONCURRENT_DOWNLOADS = 5;
      const segments = [];
      let downloadedSize = 0;

      for (let i = 0; i < segmentLines.length; i += CONCURRENT_DOWNLOADS) {
        const batch = segmentLines.slice(i, i + CONCURRENT_DOWNLOADS);
        const batchPromises = batch.map(async (segmentFile, index) => {
          const segmentUrl = segmentFile.startsWith('http') ? segmentFile : baseUrl + segmentFile;
          
          try {
            const response = await axios.get(segmentUrl, {
              headers: {
                "accept": "*/*",
                "Referer": "https://appx-play.akamai.net.in/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
              },
              responseType: 'arraybuffer',
              timeout: 30000
            });
            
            const segmentData = Buffer.from(response.data);
            downloadedSize += segmentData.length;
            
            console.log(`Downloaded segment ${i + index + 1}/${segmentLines.length} (${(downloadedSize / 1024 / 1024).toFixed(2)} MB)`);
            
            return segmentData;
          } catch (err) {
            console.error(`Failed to download segment ${i + index + 1}:`, err.message);
            throw err;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        segments.push(...batchResults);
      }

      // Combine all segments
      console.log('Combining segments...');
      const combinedBuffer = Buffer.concat(segments);
      
      // Write to file
      fs.writeFileSync(outputPath, combinedBuffer);
      
      // Stream to client
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      
      const fileStream = fs.createReadStream(outputPath);
      await pipeline(fileStream, res);
      
      // Clean up
      fs.unlink(outputPath, () => {});
      
      console.log(`Manual download complete: ${fileName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      return;
      
    } catch (manualError) {
      console.error('Manual download failed:', manualError.message);
      if (method === 'manual') {
        return res.status(500).json({ error: manualError.message });
      }
    }
  }

  // Method 3: Stream passthrough (if video is directly accessible)
  if (method === 'auto' || method === 'direct') {
    try {
      console.log('Attempting direct stream download...');
      
      // Try to access the video directly
      const response = await axios.get(url, {
        headers: {
          "accept": "*/*",
          "Referer": "https://appx-play.akamai.net.in/",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 5
      });

      const contentType = response.headers['content-type'] || 'video/mp4';
      const contentLength = response.headers['content-length'];

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      // Pipe directly to response
      await pipeline(response.data, res);
      
      console.log('Direct stream download complete');
      return;
      
    } catch (directError) {
      console.error('Direct download failed:', directError.message);
      if (method === 'direct') {
        return res.status(500).json({ error: directError.message });
      }
    }
  }

  // If all methods fail
  res.status(500).json({ 
    error: 'All download methods failed',
    message: 'Unable to download video. Please try again later.'
  });
});

// Web-based downloader with real-time progress
app.get('/downloader', (req, res) => {
  const { url } = req.query;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Snow Player - Advanced Downloader</title>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .container {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 30px;
      padding: 40px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      max-width: 800px;
      width: 100%;
      animation: slideUp 0.5s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    h1 {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      font-size: 32px;
      margin-bottom: 10px;
      font-weight: 700;
    }

    .subtitle {
      color: #666;
      margin-bottom: 30px;
      font-size: 16px;
    }

    .url-box {
      background: #f7f7f7;
      border-radius: 15px;
      padding: 20px;
      margin-bottom: 30px;
      border: 1px solid #e0e0e0;
      word-break: break-all;
    }

    .url-box label {
      display: block;
      color: #333;
      font-weight: 600;
      margin-bottom: 10px;
      font-size: 14px;
    }

    .url-box .url {
      color: #667eea;
      font-size: 14px;
      line-height: 1.5;
    }

    .method-selector {
      margin-bottom: 30px;
    }

    .method-selector h3 {
      color: #333;
      margin-bottom: 15px;
      font-size: 16px;
    }

    .method-buttons {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
    }

    .method-btn {
      background: white;
      border: 2px solid #e0e0e0;
      padding: 12px 24px;
      border-radius: 30px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      color: #666;
      transition: all 0.3s;
      flex: 1;
      min-width: 120px;
    }

    .method-btn:hover {
      border-color: #667eea;
      color: #667eea;
    }

    .method-btn.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-color: transparent;
      color: white;
    }

    .progress-container {
      margin: 30px 0;
    }

    .progress-stats {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      color: #666;
      font-size: 14px;
    }

    .progress-bar {
      width: 100%;
      height: 20px;
      background: #f0f0f0;
      border-radius: 10px;
      overflow: hidden;
      position: relative;
    }

    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
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

    .status {
      background: #f7f7f7;
      border-radius: 15px;
      padding: 20px;
      margin: 20px 0;
      border-left: 4px solid #667eea;
    }

    .status-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
      color: #333;
      font-size: 14px;
    }

    .status-item:last-child {
      margin-bottom: 0;
    }

    .status-item .label {
      color: #666;
    }

    .status-item .value {
      font-weight: 600;
      color: #667eea;
    }

    .download-btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 18px 36px;
      border-radius: 50px;
      font-size: 18px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.3s;
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
      transform: none;
    }

    .download-btn.loading::after {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(
        90deg,
        transparent,
        rgba(255, 255, 255, 0.3),
        transparent
      );
      animation: btnShimmer 1.5s infinite;
    }

    @keyframes btnShimmer {
      100% { left: 100%; }
    }

    .toast {
      position: fixed;
      top: 20px;
      right: 20px;
      background: white;
      border-radius: 10px;
      padding: 15px 25px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
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
      border-left: 4px solid #10b981;
    }

    .toast.error {
      border-left: 4px solid #ef4444;
    }

    .toast i {
      font-size: 20px;
    }

    .toast.success i {
      color: #10b981;
    }

    .toast.error i {
      color: #ef4444;
    }

    .logs {
      background: #1a1a1a;
      color: #00ff00;
      border-radius: 10px;
      padding: 20px;
      margin-top: 30px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    .log-entry {
      margin-bottom: 5px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .log-entry .time {
      color: #888;
      margin-right: 10px;
    }

    @media (max-width: 768px) {
      .container {
        padding: 20px;
      }
      
      .method-buttons {
        flex-direction: column;
      }
      
      .method-btn {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>❄️ Snow Player Downloader</h1>
    <p class="subtitle">Advanced HLS video downloader with multiple methods</p>
    
    <div class="url-box">
      <label>Video URL</label>
      <div class="url" id="videoUrl">${url || 'No URL provided'}</div>
    </div>

    <div class="method-selector">
      <h3>Download Method</h3>
      <div class="method-buttons">
        <button class="method-btn active" data-method="auto">🤖 Auto (Best)</button>
        <button class="method-btn" data-method="ffmpeg">🎬 FFmpeg</button>
        <button class="method-btn" data-method="manual">📦 Manual</button>
        <button class="method-btn" data-method="direct">⚡ Direct</button>
      </div>
    </div>

    <div class="progress-container">
      <div class="progress-stats">
        <span id="progressPercent">0%</span>
        <span id="progressSize">0 MB / 0 MB</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
    </div>

    <div class="status">
      <div class="status-item">
        <span class="label">Status:</span>
        <span class="value" id="statusText">Ready to download</span>
      </div>
      <div class="status-item">
        <span class="label">Method:</span>
        <span class="value" id="methodText">Auto</span>
      </div>
      <div class="status-item">
        <span class="label">Segments:</span>
        <span class="value" id="segmentsText">-</span>
      </div>
      <div class="status-item">
        <span class="label">Speed:</span>
        <span class="value" id="speedText">-</span>
      </div>
      <div class="status-item">
        <span class="label">Time elapsed:</span>
        <span class="value" id="timeText">-</span>
      </div>
    </div>

    <button class="download-btn" id="downloadBtn" onclick="startDownload()">
      <i class="fas fa-download"></i> Start Download
    </button>

    <div class="logs" id="logs">
      <div class="log-entry">
        <span class="time">${new Date().toLocaleTimeString()}</span>
        <span>Ready to download. Select method and click Start.</span>
      </div>
    </div>
  </div>

  <div class="toast" id="toast">
    <i class="fas" id="toastIcon"></i>
    <span id="toastMessage"></span>
  </div>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <script>
    let selectedMethod = 'auto';
    let startTime;
    let lastLoaded = 0;
    let speedInterval;

    // Method selection
    document.querySelectorAll('.method-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.method-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedMethod = btn.dataset.method;
        document.getElementById('methodText').textContent = 
          btn.textContent.trim();
        addLog(`Switched to ${btn.textContent.trim()} download method`);
      });
    });

    function addLog(message, type = 'info') {
      const logs = document.getElementById('logs');
      const time = new Date().toLocaleTimeString();
      const logEntry = document.createElement('div');
      logEntry.className = 'log-entry';
      logEntry.innerHTML = \`<span class="time">\${time}</span> \${message}\`;
      logs.appendChild(logEntry);
      logs.scrollTop = logs.scrollHeight;
    }

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

    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatTime(seconds) {
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

    async function startDownload() {
      const url = new URLSearchParams(window.location.search).get('url');
      if (!url) {
        showToast('No URL provided', 'error');
        return;
      }

      const downloadBtn = document.getElementById('downloadBtn');
      const progressFill = document.getElementById('progressFill');
      const progressPercent = document.getElementById('progressPercent');
      const progressSize = document.getElementById('progressSize');
      const statusText = document.getElementById('statusText');
      const speedText = document.getElementById('speedText');
      const timeText = document.getElementById('timeText');
      
      downloadBtn.disabled = true;
      downloadBtn.classList.add('loading');
      statusText.textContent = 'Downloading...';
      startTime = Date.now();
      lastLoaded = 0;
      
      addLog(\`Starting download with method: \${selectedMethod}\`);

      try {
        const response = await fetch('/download?url=' + encodeURIComponent(url) + '&method=' + selectedMethod);
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.message || 'Download failed');
        }

        const contentLength = response.headers.get('content-length');
        const totalSize = contentLength ? parseInt(contentLength) : 0;
        
        if (totalSize > 0) {
          progressSize.textContent = \`0 MB / \${(totalSize / 1024 / 1024).toFixed(2)} MB\`;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;

        // Update speed every second
        speedInterval = setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = lastLoaded / elapsed;
          speedText.textContent = formatBytes(speed) + '/s';
          timeText.textContent = formatTime(elapsed);
        }, 1000);

        while (true) {
          const { done, value } = await reader.read();
          
          if (done) {
            break;
          }
          
          chunks.push(value);
          receivedLength += value.length;
          lastLoaded = receivedLength;
          
          if (totalSize > 0) {
            const percent = (receivedLength / totalSize * 100).toFixed(1);
            progressFill.style.width = percent + '%';
            progressPercent.textContent = percent + '%';
            progressSize.textContent = \`\${(receivedLength / 1024 / 1024).toFixed(2)} MB / \${(totalSize / 1024 / 1024).toFixed(2)} MB\`;
          } else {
            // If no content-length, show downloaded size
            progressSize.textContent = formatBytes(receivedLength);
          }

          // Update segments info if available
          if (receivedLength > 0 && !totalSize) {
            document.getElementById('segmentsText').textContent = 'Downloading...';
          }
        }

        clearInterval(speedInterval);
        
        // Combine chunks and create download
        const blob = new Blob(chunks, { type: 'video/mp4' });
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'snow_player_video_' + Date.now() + '.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);

        const elapsed = (Date.now() - startTime) / 1000;
        statusText.textContent = 'Complete!';
        progressPercent.textContent = '100%';
        progressFill.style.width = '100%';
        
        addLog(\`Download complete! Size: \${formatBytes(receivedLength)} Time: \${formatTime(elapsed)}\`);
        showToast(\`Download complete! (\${formatBytes(receivedLength)})\`, 'success');

      } catch (error) {
        console.error('Download error:', error);
        statusText.textContent = 'Error: ' + error.message;
        addLog(\`Error: \${error.message}\`, 'error');
        showToast(error.message, 'error');
        
        clearInterval(speedInterval);
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('loading');
      }
    }

    // Initialize
    addLog('Downloader initialized');
    if ('${url}') {
      addLog('URL loaded: ' + '${url}'.substring(0, 50) + '...');
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// Update player with download button
app.get('/player', (req, res) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send('Missing URL parameter');
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SNOW PLAYER - Professional Video Player</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #000; overflow: hidden; }
    #player-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; }
    #video { width: 100%; height: 100%; object-fit: contain; }
    #loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; color: rgba(255,255,255,0.9); z-index: 10; }
    .loader { width: 40px; height: 40px; margin: 0 auto 16px; border: 2px solid rgba(255,255,255,0.1); border-top: 2px solid #fff; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    #loading span { font-size: 13px; font-weight: 400; letter-spacing: 1px; text-transform: uppercase; opacity: 0.7; }
    .controls { position: absolute; bottom: 0; left: 0; right: 0; padding: 40px 24px 20px; background: linear-gradient(to top, rgba(0,0,0,0.8), transparent); transition: opacity 0.3s ease; opacity: 1; z-index: 5; }
    .controls.hidden { opacity: 0; pointer-events: none; }
    .progress-container { width: 100%; height: 3px; background: rgba(255,255,255,0.15); cursor: pointer; position: relative; margin-bottom: 18px; border-radius: 0; }
    #progress-bar { height: 100%; background: #fff; width: 0%; position: relative; z-index: 2; transition: width 0.1s linear; }
    #buffer-bar { position: absolute; top: 0; left: 0; height: 100%; background: rgba(255,255,255,0.3); width: 0%; z-index: 1; }
    #progress-handle { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 10px; height: 10px; background: #fff; border-radius: 50%; z-index: 10; pointer-events: none; opacity: 0; transition: opacity 0.2s, transform 0.2s; box-shadow: 0 2px 6px rgba(0,0,0,0.3); }
    .progress-container:hover #progress-handle { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
    .main-controls { display: flex; align-items: center; justify-content: space-between; }
    .left-controls, .right-controls { display: flex; align-items: center; gap: 20px; }
    .control-btn { background: transparent; border: none; color: rgba(255,255,255,0.8); width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px; transition: all 0.2s; }
    .control-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .control-btn:active { transform: scale(0.95); }
    #play-btn { background: rgba(255,255,255,0.1); color: #fff; width: 40px; height: 40px; font-size: 20px; }
    #play-btn:hover { background: rgba(255,255,255,0.2); }
    .skip-btn { font-size: 16px; position: relative; }
    .time-display { font-size: 13px; font-weight: 400; color: rgba(255,255,255,0.7); letter-spacing: 0.3px; background: rgba(0,0,0,0.3); padding: 4px 10px; border-radius: 12px; }
    .volume-container { display: flex; align-items: center; gap: 8px; }
    #volume-slider { width: 70px; height: 3px; -webkit-appearance: none; background: rgba(255,255,255,0.2); border-radius: 0; outline: none; }
    #volume-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; background: #fff; border-radius: 50%; cursor: pointer; transition: transform 0.2s; }
    #volume-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }
    .settings-menu { position: relative; }
    .settings-dropdown { position: absolute; bottom: 45px; right: 0; background: rgba(20,20,20,0.95); backdrop-filter: blur(10px); border-radius: 8px; padding: 4px 0; width: 140px; border: 1px solid rgba(255,255,255,0.1); opacity: 0; transform: translateY(10px); pointer-events: none; transition: all 0.2s; box-shadow: 0 5px 20px rgba(0,0,0,0.5); }
    .settings-menu.active .settings-dropdown { opacity: 1; transform: translateY(0); pointer-events: all; }
    .settings-item { padding: 10px 16px; cursor: pointer; color: rgba(255,255,255,0.7); font-size: 13px; transition: all 0.2s; text-align: left; }
    .settings-item:hover { background: rgba(255,255,255,0.1); color: #fff; }
    .settings-item.selected { color: #fff; background: rgba(255,255,255,0.05); }
    .quality-badge { position: absolute; top: 20px; left: 20px; background: rgba(0,0,0,0.5); color: rgba(255,255,255,0.8); padding: 4px 12px; border-radius: 20px; font-size: 11px; font-weight: 400; letter-spacing: 0.5px; border: 1px solid rgba(255,255,255,0.1); z-index: 10; opacity: 0; transition: opacity 0.2s; }
    .quality-badge.visible { opacity: 1; }
    #download-btn { color: rgba(255,255,255,0.9); }
    #download-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
    #fullscreen-btn { font-size: 18px; }
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
    <video id="video" playsinline crossorigin="anonymous"></video>
    
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

          <!-- Download Button -->
          <button class="control-btn" id="download-btn" title="Download Video" onclick="window.open('/downloader?url=${encodeURIComponent(url)}', '_blank')">
            <i class="fas fa-download"></i>
          </button>
          
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
      
      let hls;
      let hideControlsTimeout;
      let isSettingsOpen = false;
      let isFullscreen = false;
      let isDragging = false;
      let hideQualityBadgeTimeout;
      
      const url = new URLSearchParams(window.location.search).get('url');
      
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
      
      playBtn.addEventListener('click', () => {
        if (video.paused) {
          video.play();
        } else {
          video.pause();
        }
        showControls();
      });
      
      rewindBtn.addEventListener('click', () => {
        video.currentTime = Math.max(0, video.currentTime - 10);
        showControls();
      });
      
      forwardBtn.addEventListener('click', () => {
        video.currentTime = Math.min(video.duration, video.currentTime + 10);
        showControls();
      });
      
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
      
      video.addEventListener('dblclick', toggleFullscreen);
      
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
    console.log('=================================');
    console.log('❄️ SNOW PLAYER - Professional Video Player');
    console.log('=================================');
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Player: http://localhost:${PORT}/player?url=YOUR_HLS_URL`);
    console.log(`Downloader: http://localhost:${PORT}/downloader?url=YOUR_HLS_URL`);
    console.log('=================================');
    console.log('Features:');
    console.log('• Multiple download methods (Auto/FFmpeg/Manual/Direct)');
    console.log('• Real-time progress tracking');
    console.log('• Download speed monitoring');
    console.log('• Segment-by-segment download');
    console.log('• Automatic fallback system');
    console.log('=================================');
  });
}
