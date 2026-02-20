const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
const PORT = process.env.PORT || 3000;

// Proxy for .m3u8 playlists with full segment resolution
app.get('/proxy', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url, full = 'false' } = req.query;
  if (!url) return res.status(400).send('Missing url parameter');

  try {
    const response = await axios.get(url, {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      timeout: 60000
    });

    // If this is the master playlist and we need full resolution
    if (full === 'true' && response.data.includes('#EXT-X-STREAM-INF')) {
      // Find the highest quality stream
      const lines = response.data.split('\n');
      let bestUrl = null;
      let bestBandwidth = 0;
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
          const bandwidth = parseInt(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || '0');
          const nextLine = lines[i + 1]?.trim();
          if (nextLine && !nextLine.startsWith('#')) {
            if (bandwidth > bestBandwidth) {
              bestBandwidth = bandwidth;
              // Resolve relative URL
              bestUrl = nextLine.startsWith('http') ? nextLine : 
                       new URL(nextLine, url).href;
            }
          }
        }
      }
      
      if (bestUrl) {
        // Fetch the best quality playlist
        const bestResponse = await axios.get(bestUrl, {
          headers: {
            "accept": "*/*",
            "Referer": "https://appx-play.akamai.net.in/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
        
        const base = bestUrl.substring(0, bestUrl.lastIndexOf('/') + 1);
        let playlist = bestResponse.data;
        
        // Replace segment URLs with proxy URLs
        playlist = playlist.replace(
          /^(?!#)([^\r\n]+)$/gm,
          (line) => {
            if (line.startsWith('http') || line.startsWith('#')) return line;
            // Encode the full segment URL
            const segmentUrl = base + line;
            return `/segment-proxy?url=${encodeURIComponent(segmentUrl)}`;
          }
        );
        
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        return res.send(playlist);
      }
    }
    
    // Regular playlist processing
    const base = url.substring(0, url.lastIndexOf('/') + 1);
    const playlist = response.data.replace(
      /^(?!#)([^\r\n]+)$/gm,
      (line) => {
        if (line.startsWith('http') || line.startsWith('#')) return line;
        const segmentUrl = base + line;
        return `/segment-proxy?url=${encodeURIComponent(segmentUrl)}`;
      }
    );

    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.send(playlist);
  } catch (err) {
    console.error('Error fetching playlist:', err.message);
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// Direct segment proxy
app.get('/segment-proxy', async (req, res) => {
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

    res.status(response.status);
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }
    response.data.pipe(res);
  } catch (err) {
    console.error('Error fetching segment:', err.message);
    res.status(500).send('Segment error: ' + err.message);
  }
});

// Advanced downloader that properly handles HLS streams
app.get('/downloader', (req, res) => {
  const { url } = req.query;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Snow Player - Advanced HLS Downloader</title>
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
      padding: 20px;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
    }

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
      font-size: 36px;
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

    .quality-selector {
      display: flex;
      gap: 15px;
      margin: 20px 0;
      flex-wrap: wrap;
    }

    .quality-btn {
      background: white;
      border: 2px solid #e0e0e0;
      padding: 15px 30px;
      border-radius: 12px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      color: #333;
      transition: all 0.3s;
      flex: 1;
      min-width: 150px;
    }

    .quality-btn:hover {
      border-color: #667eea;
      color: #667eea;
    }

    .quality-btn.active {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      border-color: transparent;
      color: white;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin: 30px 0;
    }

    .stat-card {
      background: white;
      border-radius: 15px;
      padding: 25px;
      text-align: center;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
      transition: transform 0.3s;
    }

    .stat-card:hover {
      transform: translateY(-5px);
    }

    .stat-value {
      font-size: 32px;
      font-weight: 700;
      color: #667eea;
      margin-bottom: 10px;
    }

    .stat-label {
      color: #666;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .progress-section {
      background: white;
      border-radius: 15px;
      padding: 30px;
      margin: 20px 0;
    }

    .progress-bar {
      width: 100%;
      height: 30px;
      background: #f0f0f0;
      border-radius: 15px;
      overflow: hidden;
      margin: 20px 0;
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

    .segment-list {
      background: #1a1a1a;
      border-radius: 15px;
      padding: 20px;
      margin: 20px 0;
      max-height: 400px;
      overflow-y: auto;
    }

    .segment-item {
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      padding: 12px;
      margin: 8px 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #00ff00;
      font-family: monospace;
      transition: all 0.3s;
    }

    .segment-item.downloaded {
      background: rgba(0, 255, 0, 0.1);
      border-left: 4px solid #00ff00;
    }

    .segment-item .index {
      color: #888;
      margin-right: 15px;
    }

    .segment-item .size {
      color: #667eea;
      font-weight: 600;
    }

    .segment-item .status {
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
    }

    .status.pending {
      background: #f39c12;
      color: white;
    }

    .status.downloading {
      background: #3498db;
      color: white;
      animation: pulse 1s infinite;
    }

    .status.completed {
      background: #2ecc71;
      color: white;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    .download-btn {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
      transform: none;
    }

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
      border-left: 4px solid #2ecc71;
    }

    .toast.error {
      border-left: 4px solid #e74c3c;
    }

    .toast i {
      font-size: 24px;
    }

    .toast.success i {
      color: #2ecc71;
    }

    .toast.error i {
      color: #e74c3c;
    }

    .info-panel {
      background: #f8f9fa;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
      border: 1px solid #e0e0e0;
    }

    .info-panel h3 {
      color: #333;
      margin-bottom: 15px;
    }

    .info-panel p {
      color: #666;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>❄️ Snow Player Advanced Downloader</h1>
      <p style="color: #666;">Professional HLS video downloader with quality selection</p>
      
      <div class="url-box">
        <strong style="display: block; margin-bottom: 10px; color: #333;">Video URL:</strong>
        <div style="color: #667eea; font-size: 14px; word-break: break-all;" id="videoUrl">${url || 'No URL provided'}</div>
      </div>

      <div class="quality-selector" id="qualitySelector">
        <button class="quality-btn active" onclick="selectQuality('auto')">🤖 Auto (Best)</button>
        <button class="quality-btn" onclick="selectQuality('1080p')">📺 1080p</button>
        <button class="quality-btn" onclick="selectQuality('720p')">📺 720p</button>
        <button class="quality-btn" onclick="selectQuality('480p')">📺 480p</button>
        <button class="quality-btn" onclick="selectQuality('360p')">📺 360p</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" id="totalSegments">0</div>
        <div class="stat-label">Total Segments</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="downloadedSegments">0</div>
        <div class="stat-label">Downloaded</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="totalSize">0 MB</div>
        <div class="stat-label">Total Size</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="downloadSpeed">0 MB/s</div>
        <div class="stat-label">Speed</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="timeRemaining">--:--</div>
        <div class="stat-label">Time Left</div>
      </div>
    </div>

    <div class="progress-section">
      <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
        <span style="font-weight: 600;" id="progressPercent">0%</span>
        <span style="color: #666;" id="progressDetails">0 of 0 segments</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
    </div>

    <div class="segment-list" id="segmentList">
      <div class="segment-item">
        <span>Loading playlist...</span>
      </div>
    </div>

    <button class="download-btn" id="downloadBtn" onclick="startDownload()">
      <i class="fas fa-download"></i> Start Download
    </button>

    <div class="info-panel">
      <h3>📋 Download Information</h3>
      <p>• This downloader processes the complete HLS stream by downloading all segments</p>
      <p>• The video will be fully downloaded and combined into a single MP4 file</p>
      <p>• Download speed depends on your internet connection and server response</p>
      <p>• Large videos may take several minutes - please be patient</p>
    </div>
  </div>

  <div class="toast" id="toast">
    <i class="fas" id="toastIcon"></i>
    <span id="toastMessage"></span>
  </div>

  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  
  <script>
    // State management
    let segments = [];
    let downloadedData = [];
    let segmentSizes = [];
    let totalSize = 0;
    let startTime = null;
    let speedInterval = null;
    let isDownloading = false;
    let selectedQuality = 'auto';
    let masterPlaylist = null;
    let qualityLevels = [];

    // Show toast notification
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

    // Format bytes to human readable
    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
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
        return hrs + ':' + (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
      } else {
        return mins + ':' + (secs < 10 ? '0' : '') + secs;
      }
    }

    // Update statistics
    function updateStats() {
      const downloadedCount = downloadedData.length;
      const percent = segments.length > 0 ? (downloadedCount / segments.length * 100).toFixed(1) : 0;
      
      document.getElementById('totalSegments').textContent = segments.length;
      document.getElementById('downloadedSegments').textContent = downloadedCount;
      document.getElementById('totalSize').textContent = formatBytes(totalSize);
      document.getElementById('progressPercent').textContent = percent + '%';
      document.getElementById('progressDetails').textContent = \`\${downloadedCount} of \${segments.length} segments\`;
      document.getElementById('progressFill').style.width = percent + '%';
      
      if (startTime && downloadedCount > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = totalSize / elapsed;
        document.getElementById('downloadSpeed').textContent = (speed / 1024 / 1024).toFixed(2) + ' MB/s';
        
        if (segments.length > downloadedCount) {
          const remainingSegments = segments.length - downloadedCount;
          const avgSegmentSize = totalSize / downloadedCount;
          const remainingBytes = remainingSegments * avgSegmentSize;
          const remainingTime = remainingBytes / speed;
          document.getElementById('timeRemaining').textContent = formatTime(remainingTime);
        }
      }
    }

    // Parse master playlist to get quality levels
    async function parseMasterPlaylist(url) {
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
            const name = lines[i].match(/NAME="([^"]+)"/)?.[1];
            const nextLine = lines[i + 1]?.trim();
            
            if (nextLine && !nextLine.startsWith('#')) {
              qualities.push({
                resolution: resolution || 'unknown',
                bandwidth: parseInt(bandwidth || '0'),
                name: name || (resolution ? resolution.split('x')[1] + 'p' : 'auto'),
                url: nextLine.startsWith('http') ? nextLine : new URL(nextLine, url).href
              });
            }
          }
        }
        
        qualityLevels = qualities.sort((a, b) => b.bandwidth - a.bandwidth);
        
        // Update quality selector with available qualities
        const selector = document.getElementById('qualitySelector');
        selector.innerHTML = '<button class="quality-btn active" onclick="selectQuality(\'auto\')">🤖 Auto (Best)</button>';
        
        qualityLevels.forEach(q => {
          const btn = document.createElement('button');
          btn.className = 'quality-btn';
          btn.setAttribute('onclick', \`selectQuality('\${q.url}')\`);
          btn.textContent = \`📺 \${q.name} (\${(q.bandwidth/1000000).toFixed(1)} Mbps)\`;
          selector.appendChild(btn);
        });
        
        return qualityLevels;
      } catch (error) {
        console.error('Error parsing master playlist:', error);
        return [];
      }
    }

    // Select quality
    function selectQuality(quality) {
      document.querySelectorAll('.quality-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      selectedQuality = quality;
      showToast('Quality selected: ' + quality, 'success');
    }

    // Fetch segments for selected quality
    async function fetchSegments() {
      const urlParams = new URLSearchParams(window.location.search);
      const baseUrl = urlParams.get('url');
      
      let playlistUrl = baseUrl;
      
      // If auto mode and we have quality levels, use the highest
      if (selectedQuality === 'auto' && qualityLevels.length > 0) {
        playlistUrl = qualityLevels[0].url;
      } else if (selectedQuality !== 'auto') {
        playlistUrl = selectedQuality;
      }
      
      try {
        const response = await fetch('/proxy?url=' + encodeURIComponent(playlistUrl) + '&full=true');
        const playlist = await response.text();
        
        // Parse segments
        const lines = playlist.split('\n');
        segments = lines.filter(line => 
          line && !line.startsWith('#') && line.trim().length > 0
        ).map(line => {
          // Extract the actual segment URL from the proxy URL
          const match = line.match(/url=([^&]+)/);
          return match ? decodeURIComponent(match[1]) : line;
        });
        
        // Update UI
        const listContainer = document.getElementById('segmentList');
        listContainer.innerHTML = '';
        
        segments.forEach((segment, index) => {
          const item = document.createElement('div');
          item.className = 'segment-item';
          item.id = \`segment-\${index}\`;
          item.innerHTML = \`
            <div>
              <span class="index">#\${index + 1}</span>
              <span>Segment \${index + 1} of \${segments.length}</span>
            </div>
            <div>
              <span class="size">-</span>
              <span class="status pending">Pending</span>
            </div>
          \`;
          listContainer.appendChild(item);
        });
        
        document.getElementById('totalSegments').textContent = segments.length;
        showToast(\`Found \${segments.length} segments\`, 'success');
        
        return segments;
      } catch (error) {
        console.error('Error fetching segments:', error);
        showToast('Error fetching segments: ' + error.message, 'error');
        throw error;
      }
    }

    // Download a single segment
    async function downloadSegment(segmentUrl, index) {
      try {
        // Update status to downloading
        const item = document.getElementById(\`segment-\${index}\`);
        if (item) {
          const statusSpan = item.querySelector('.status');
          statusSpan.className = 'status downloading';
          statusSpan.textContent = 'Downloading';
        }
        
        // Download segment through proxy
        const response = await fetch('/segment-proxy?url=' + encodeURIComponent(segmentUrl));
        const blob = await response.blob();
        
        // Update UI
        if (item) {
          const statusSpan = item.querySelector('.status');
          const sizeSpan = item.querySelector('.size');
          statusSpan.className = 'status completed';
          statusSpan.textContent = 'Completed';
          sizeSpan.textContent = formatBytes(blob.size);
        }
        
        segmentSizes[index] = blob.size;
        return blob;
      } catch (error) {
        console.error(\`Error downloading segment \${index + 1}:\`, error);
        
        const item = document.getElementById(\`segment-\${index}\`);
        if (item) {
          const statusSpan = item.querySelector('.status');
          statusSpan.className = 'status pending';
          statusSpan.textContent = 'Failed - Retry';
        }
        
        throw error;
      }
    }

    // Main download function
    async function startDownload() {
      if (isDownloading) return;
      
      const urlParams = new URLSearchParams(window.location.search);
      const videoUrl = urlParams.get('url');
      
      if (!videoUrl) {
        showToast('No video URL provided', 'error');
        return;
      }

      const downloadBtn = document.getElementById('downloadBtn');
      downloadBtn.disabled = true;
      downloadBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Downloading...';
      
      isDownloading = true;
      downloadedData = [];
      segmentSizes = [];
      totalSize = 0;
      startTime = Date.now();

      try {
        // Parse master playlist first
        showToast('Analyzing video streams...', 'success');
        await parseMasterPlaylist(videoUrl);
        
        // Fetch segments for selected quality
        await fetchSegments();
        
        if (segments.length === 0) {
          throw new Error('No segments found');
        }

        // Download segments with retry logic
        for (let i = 0; i < segments.length; i++) {
          let retries = 3;
          let success = false;
          
          while (retries > 0 && !success) {
            try {
              const blob = await downloadSegment(segments[i], i);
              downloadedData.push(blob);
              totalSize += blob.size;
              updateStats();
              success = true;
            } catch (error) {
              retries--;
              if (retries === 0) {
                throw new Error(\`Failed to download segment \${i + 1} after 3 retries\`);
              }
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }

        // Combine all segments
        showToast('Combining segments into video...', 'success');
        const combinedBlob = new Blob(downloadedData, { type: 'video/mp4' });
        
        // Create download
        const downloadUrl = URL.createObjectURL(combinedBlob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'snow_player_video_' + Date.now() + '.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);

        const elapsed = (Date.now() - startTime) / 1000;
        showToast(\`Download complete! \${formatBytes(totalSize)} in \${formatTime(elapsed)}\`, 'success');
        
        downloadBtn.innerHTML = '<i class="fas fa-check"></i> Download Complete';
        
      } catch (error) {
        console.error('Download error:', error);
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
      // Parse master playlist on load
      parseMasterPlaylist('${url}');
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
          
          hls.loadSource('/proxy?url=' + encodeURIComponent(url) + '&full=true');
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
          video.src = '/proxy?url=' + encodeURIComponent(url) + '&full=true';
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

// Export for Vercel
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
  });
}
