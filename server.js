const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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

// DOWNLOAD COMPLETE VIDEO - Using FFmpeg
app.get('/download', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    // Create temp directory if it doesn't exist
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir);
    }

    const timestamp = Date.now();
    const outputFileName = `video_${timestamp}.mp4`;
    const outputPath = path.join(tempDir, outputFileName);
    const proxyUrl = `http://localhost:${PORT}/proxy?url=${encodeURIComponent(url)}`;

    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Method 1: Try using FFmpeg if available
    try {
      console.log('Attempting download with FFmpeg...');
      await execPromise(`ffmpeg -i "${proxyUrl}" -c copy -bsf:a aac_adtstoasc "${outputPath}"`);
      
      // Stream the file to client
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);
      
      // Clean up after streaming
      fileStream.on('end', () => {
        fs.unlink(outputPath, (err) => {
          if (err) console.error('Error deleting temp file:', err);
        });
      });
      
      return;
    } catch (ffmpegError) {
      console.log('FFmpeg not available, using alternative method...');
    }

    // Method 2: Manual HLS downloading and combining
    console.log('Fetching master playlist...');
    const playlistResponse = await axios.get(url, {
      headers: {
        "accept": "*/*",
        "Referer": "https://appx-play.akamai.net.in/"
      }
    });

    const playlist = playlistResponse.data;
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
    
    // Parse all segment URLs
    const segmentLines = playlist.split('\n').filter(line => 
      line && !line.startsWith('#') && line.trim().length > 0
    );
    
    console.log(`Found ${segmentLines.length} segments to download`);

    // Download all segments
    const segments = [];
    let totalSize = 0;
    
    for (let i = 0; i < segmentLines.length; i++) {
      const segmentFile = segmentLines[i].trim();
      const segmentUrl = segmentFile.startsWith('http') ? segmentFile : baseUrl + segmentFile;
      
      console.log(`Downloading segment ${i + 1}/${segmentLines.length}...`);
      
      const segmentResponse = await axios.get(segmentUrl, {
        headers: {
          "accept": "*/*",
          "Referer": "https://appx-play.akamai.net.in/"
        },
        responseType: 'arraybuffer'
      });
      
      segments.push(Buffer.from(segmentResponse.data));
      totalSize += segmentResponse.data.length;
    }

    // Combine all segments
    console.log('Combining segments...');
    const combinedBuffer = Buffer.concat(segments);
    
    console.log(`Download complete! Total size: ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);

    // Set content length and send
    res.setHeader('Content-Length', combinedBuffer.length);
    res.send(combinedBuffer);

  } catch (err) {
    console.error('Error downloading video:', err);
    res.status(500).send('Download error: ' + err.message);
  }
});

// Alternative download method using Python script
app.get('/download-python', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const timestamp = Date.now();
    const outputFileName = `video_${timestamp}.mp4`;
    
    // Set headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${outputFileName}"`);
    res.setHeader('Content-Type', 'video/mp4');

    // Call Python script to download HLS stream
    const pythonScript = `
import m3u8
import requests
import sys
from urllib.parse import urljoin

def download_hls(master_url):
    # Download master playlist
    playlist = m3u8.load(master_url)
    
    # Get the highest quality stream
    if playlist.playlists:
        # Use the first variant (usually highest quality)
        variant_url = urljoin(master_url, playlist.playlists[0].uri)
        playlist = m3u8.load(variant_url)
    
    base_url = master_url[:master_url.rfind('/') + 1]
    segments = []
    
    # Download all segments
    for i, segment in enumerate(playlist.segments):
        sys.stderr.write(f"Downloading segment {i + 1}/{len(playlist.segments)}\\n")
        segment_url = urljoin(base_url, segment.uri)
        response = requests.get(segment_url, headers={
            'Referer': 'https://appx-play.akamai.net.in/'
        })
        sys.stdout.buffer.write(response.content)
    
    return len(playlist.segments)

if __name__ == "__main__":
    url = sys.argv[1]
    total_segments = download_hls(url)
    sys.stderr.write(f"Downloaded {total_segments} segments successfully\\n")
    `;

    // Execute Python script and pipe output to response
    const { spawn } = require('child_process');
    const pythonProcess = spawn('python3', ['-c', pythonScript, url]);
    
    pythonProcess.stdout.pipe(res);
    
    pythonProcess.stderr.on('data', (data) => {
      console.log('Python:', data.toString());
    });
    
    pythonProcess.on('close', (code) => {
      console.log(`Python process exited with code ${code}`);
    });

  } catch (err) {
    console.error('Error in Python download:', err);
    res.status(500).send('Download error: ' + err.message);
  }
});

// Web-based downloader that works in browser
app.get('/web-download', async (req, res) => {
  const { url } = req.query;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>HLS Video Downloader</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      margin: 0;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      max-width: 600px;
      width: 100%;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      font-size: 28px;
    }
    .url-display {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 10px;
      word-break: break-all;
      margin: 20px 0;
      font-size: 14px;
      color: #666;
    }
    .progress-container {
      margin: 30px 0;
    }
    .progress-bar {
      width: 100%;
      height: 30px;
      background: #f0f0f0;
      border-radius: 15px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      width: 0%;
      transition: width 0.3s ease;
    }
    .progress-text {
      text-align: center;
      margin-top: 10px;
      font-size: 16px;
      color: #666;
    }
    .status {
      text-align: center;
      padding: 15px;
      border-radius: 10px;
      margin: 20px 0;
      font-weight: 500;
    }
    .status.downloading {
      background: #e3f2fd;
      color: #1976d2;
    }
    .status.completed {
      background: #e8f5e9;
      color: #388e3c;
    }
    .status.error {
      background: #ffebee;
      color: #d32f2f;
    }
    .button {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      padding: 15px 30px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: transform 0.2s;
    }
    .button:hover {
      transform: translateY(-2px);
    }
    .button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .segment-info {
      margin-top: 20px;
      padding: 15px;
      background: #f9f9f9;
      border-radius: 10px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎥 HLS Video Downloader</h1>
    <p>Download complete HLS videos as MP4</p>
    
    <div class="url-display">
      <strong>Video URL:</strong><br>
      ${url}
    </div>
    
    <div class="progress-container">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
      <div class="progress-text" id="progressText">Ready to download</div>
    </div>
    
    <div class="status" id="status"></div>
    
    <div class="segment-info" id="segmentInfo">
      <strong>Segments:</strong> <span id="segmentCount">0</span><br>
      <strong>Total Size:</strong> <span id="totalSize">0 MB</span>
    </div>
    
    <button class="button" id="downloadBtn" onclick="startDownload()">
      <i class="fas fa-download"></i> Download Complete Video
    </button>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/m3u8-parser/4.7.0/m3u8-parser.min.js"></script>
  <script>
    let segments = [];
    let downloadedSegments = [];
    let totalSize = 0;
    let isDownloading = false;

    async function startDownload() {
      if (isDownloading) return;
      
      isDownloading = true;
      const downloadBtn = document.getElementById('downloadBtn');
      const status = document.getElementById('status');
      const progressFill = document.getElementById('progressFill');
      const progressText = document.getElementById('progressText');
      const segmentCountSpan = document.getElementById('segmentCount');
      const totalSizeSpan = document.getElementById('totalSize');
      
      downloadBtn.disabled = true;
      status.className = 'status downloading';
      status.innerHTML = '📥 Analyzing HLS stream...';
      
      try {
        // Step 1: Fetch and parse master playlist
        const masterResponse = await fetch('/proxy?url=' + encodeURIComponent('${url}'));
        const masterPlaylist = await masterResponse.text();
        
        // Parse master playlist
        const parser = new m3u8Parser.Parser();
        parser.push(masterPlaylist);
        parser.end();
        const manifest = parser.manifest;
        
        // Get the highest quality stream
        let playlistUrl = '${url}';
        if (manifest.playlists && manifest.playlists.length > 0) {
          // Use the first variant (usually highest quality)
          const baseUrl = '${url}'.substring(0, '${url}'.lastIndexOf('/') + 1);
          playlistUrl = baseUrl + manifest.playlists[0].uri;
        }
        
        status.innerHTML = '📋 Downloading segment list...';
        
        // Step 2: Download segment list
        const playlistResponse = await fetch('/proxy?url=' + encodeURIComponent(playlistUrl));
        const playlistText = await playlistResponse.text();
        
        // Parse segments
        const lines = playlistText.split('\\n');
        segments = lines.filter(line => 
          line && !line.startsWith('#') && line.trim().length > 0
        );
        
        segmentCountSpan.textContent = segments.length;
        
        // Step 3: Download all segments
        downloadedSegments = [];
        totalSize = 0;
        
        for (let i = 0; i < segments.length; i++) {
          status.innerHTML = 📥 Downloading segment ${i + 1}/${segments.length}...';
          
          // Get segment URL
          const segmentFile = segments[i].trim();
          const baseUrl = playlistUrl.substring(0, playlistUrl.lastIndexOf('/') + 1);
          const segmentUrl = segmentFile.startsWith('http') ? segmentFile : baseUrl + segmentFile;
          
          // Download segment
          const segmentResponse = await fetch('/segment?base=' + encodeURIComponent(baseUrl) + '&file=' + encodeURIComponent(segmentFile));
          const segmentBlob = await segmentResponse.blob();
          
          downloadedSegments.push(segmentBlob);
          totalSize += segmentBlob.size;
          
          // Update progress
          const percent = ((i + 1) / segments.length * 100).toFixed(1);
          progressFill.style.width = percent + '%';
          progressText.textContent = percent + '% - ' + formatBytes(totalSize);
          totalSizeSpan.textContent = formatBytes(totalSize);
        }
        
        status.className = 'status completed';
        status.innerHTML = '✅ All segments downloaded! Combining...';
        
        // Step 4: Combine all segments
        const combinedBlob = new Blob(downloadedSegments, { type: 'video/mp4' });
        
        // Step 5: Trigger download
        const downloadUrl = URL.createObjectURL(combinedBlob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'video_' + Date.now() + '.mp4';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        
        status.innerHTML = '✅ Download complete!';
        progressText.textContent = 'Complete - ' + formatBytes(totalSize);
        
      } catch (error) {
        console.error('Download error:', error);
        status.className = 'status error';
        status.innerHTML = '❌ Error: ' + error.message;
      } finally {
        isDownloading = false;
        downloadBtn.disabled = false;
      }
    }
    
    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
  </script>
  
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</body>
</html>`;

  res.send(html);
});

// Update player with download button pointing to web-download
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

          <!-- Download Button - Opens web downloader -->
          <button class="control-btn" id="download-btn" title="Download Video" onclick="window.open('/web-download?url=${encodeURIComponent(url)}', '_blank')">
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
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Player: http://localhost:${PORT}/player?url=YOUR_HLS_URL`);
    console.log(`Downloader: http://localhost:${PORT}/web-download?url=YOUR_HLS_URL`);
  });
}
