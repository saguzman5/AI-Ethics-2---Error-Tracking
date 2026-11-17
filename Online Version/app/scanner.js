/* QR scanning with the device camera.
   Decoder order: native BarcodeDetector (Android Chrome/Edge/Samsung) ->
   jsQR (all other browsers, incl. iPhone Safari), loaded on demand. */
(function () {
  'use strict';

  let detector = null;      // BarcodeDetector instance
  let jsQRLoaded = null;    // Promise
  let stream = null;
  let running = false;
  const canvas = document.createElement('canvas');
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });

  async function nativeDetector() {
    if (detector !== null) return detector;
    detector = false;
    try {
      if ('BarcodeDetector' in window) {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      }
    } catch { detector = false; }
    return detector;
  }

  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    if (!jsQRLoaded) {
      jsQRLoaded = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s.onload = () => (window.jsQR ? resolve() : reject(new Error('QR decoder failed to load')));
        s.onerror = () => { jsQRLoaded = null; reject(new Error('QR decoder could not be downloaded. Type the Box ID instead.')); };
        document.head.appendChild(s);
      });
    }
    return jsQRLoaded;
  }

  // Decodes a video element, image bitmap or image element. Returns text or null.
  async function decode(source, width, height) {
    const det = await nativeDetector();
    if (det) {
      try {
        const codes = await det.detect(source);
        if (codes.length) return codes[0].rawValue;
      } catch { /* fall through */ }
      if (source instanceof HTMLVideoElement) return null; // next frame will retry
      // For still photos, also try jsQR as a second opinion when available.
      try { await loadJsQR(); } catch { return null; }
    } else {
      await loadJsQR();
    }
    const scale = Math.min(1, 800 / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx2d.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    const result = window.jsQR(img.data, img.width, img.height, { inversionAttempts: source instanceof HTMLVideoElement ? 'dontInvert' : 'attemptBoth' });
    return result ? result.data : null;
  }

  async function start(video, onCode, onStatus) {
    stop(video);
    if (!window.isSecureContext) {
      throw new Error('The camera needs a secure (https) connection. Use "Scan from photo" or type the Box ID.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot open the camera. Use "Scan from photo" or type the Box ID.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (err) {
      if (err && err.name === 'NotAllowedError') throw new Error('Camera permission was denied. Allow camera access in your browser settings, or type the Box ID.');
      if (err && err.name === 'NotFoundError') throw new Error('No camera found on this device. Type the Box ID instead.');
      throw new Error('Could not start the camera. Type the Box ID instead.');
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    running = true;
    // Preload the fallback decoder while the camera warms up.
    if (!(await nativeDetector())) loadJsQR().catch((e) => onStatus && onStatus(e.message));
    onStatus && onStatus('Point the camera at the QR code');

    let last = 0;
    const tick = async (t) => {
      if (!running) return;
      if (t - last > 140 && video.readyState >= 2) {
        last = t;
        try {
          const text = await decode(video, video.videoWidth, video.videoHeight);
          if (text && running) {
            if (navigator.vibrate) navigator.vibrate(80);
            stop(video);
            onCode(text);
            return;
          }
        } catch (e) { onStatus && onStatus(e.message); }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function stop(video) {
    running = false;
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) video.srcObject = null;
  }

  async function decodeFile(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Could not read that image. Try another photo.');
    }
    const text = await decode(bitmap, bitmap.width, bitmap.height);
    if (bitmap.close) bitmap.close();
    if (!text) throw new Error('No QR code found in that photo. Make sure the code is sharp and fills most of the picture.');
    return text;
  }

  window.Scanner = { start, stop, decodeFile, isRunning: () => running };
})();
