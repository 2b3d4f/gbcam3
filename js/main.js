const vsSource = fetch('./shaders/vs.glsl').then(r => r.text());
const fsSource = fetch('./shaders/fs.glsl').then(r => r.text());

(async () => {
    // ================= DOM Elements =================
    const els = {
        video: document.getElementById('videoFeed'),
        camSel: document.getElementById('cameraSelect'),
        canvas: document.getElementById('glcanvas'),
        brCtrl: document.getElementById('brightness'),
        ctCtrl: document.getElementById('contrast'),
        ditherChk: document.getElementById('dither'),
        paletteSel: document.getElementById('palette'),
        captureBtn: document.getElementById('captureBtn'),
        captureDialog: document.getElementById('captureDialog'),
        captureImg: document.getElementById('captureImg'),
        closeDialog: document.getElementById('closeDialog'),
        downloadLink: document.getElementById('downloadLink'),
        fpsRange: document.getElementById('fpsRange'),
        fpsNumber: document.getElementById('fpsNumber'),
        gifDuration: document.getElementById('gifDuration'),
        recordGifBtn: document.getElementById('recordGifBtn'),
        gifDialog: document.getElementById('gifDialog'),
        gifImg: document.getElementById('gifImg'),
        downloadGifLink: document.getElementById('downloadGifLink'),
        closeGifDialog: document.getElementById('closeGifDialog'),
        settingsBtn: document.getElementById('settingsBtn'),
        settingsDialog: document.getElementById('settingsDialog'),
        closeSettingsDialog: document.getElementById('closeSettingsDialog')
    };
    // Load GIF worker script into a blob URL (to avoid cross-origin worker loading)
    let gifWorkerBlobUrl = null;
    els.recordGifBtn.disabled = true;
    (async () => {
        try {
            const resp = await fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js');
            const text = await resp.text();
            const blob = new Blob([text], { type: 'application/javascript' });
            gifWorkerBlobUrl = URL.createObjectURL(blob);
            els.recordGifBtn.disabled = false;
        } catch (e) {
            console.error('Failed to load GIF worker script', e);
        }
    })();

    // ================= FPS State (fixed at 10 FPS) =================
    let targetFPS = 10;
    let frameInterval = 1000 / targetFPS;
    let lastFrameTime = 0;

    // Stub updateFPS: ignore changes, keep FPS at 10
    const updateFPS = () => {
        targetFPS = 10;
        frameInterval = 1000 / targetFPS;
    };

    // ================= Camera Helpers =================
    let currentStream = null;

    const startStream = async (constraints) => {
        if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
        try {
            currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            console.error('getUserMedia failed:', err);
            alert('カメラにアクセスできませんでした。ブラウザの権限設定をご確認ください。');
            return null;
        }

        els.video.srcObject = currentStream;
        try {
            await els.video.play(); // Safari/iOS needs explicit play()
        } catch (e) {
            console.warn('video.play() rejected:', e);
        }
        return currentStream;
    };

    const populateCameraOptions = async () => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput');
        els.camSel.innerHTML = '';
        cams.forEach((cam, i) => {
            const opt = document.createElement('option');
            opt.value = cam.deviceId;
            opt.textContent = cam.label || `Camera ${i + 1}`;
            els.camSel.appendChild(opt);
        });
    };

    els.camSel.addEventListener('change', async () => {
        await startStream({ video: { deviceId: { exact: els.camSel.value } }, audio: false });
    });

    // Prefer back‑facing camera, fall back to default
    await (async () => {
        try {
            await startStream({
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: false
            });
        } catch {
            await startStream({ video: true, audio: false });
        }
    })();

    await populateCameraOptions();
    if (currentStream) {
        const id = currentStream.getVideoTracks()[0].getSettings().deviceId;
        if (id) els.camSel.value = id;
    }
    // ================= Offscreen Canvas for Captures =================
    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d', { alpha: false });
    offCtx.imageSmoothingEnabled = false;

    // ================= Palettes (from presets JSON) =================
    const data = await fetch('./presets.json').then(r => r.json());
    const rawPresets = data.presets;
    const defaultPresetId = data.default;
    const palettes = {};
    els.paletteSel.innerHTML = '';
    rawPresets.forEach(preset => {
        // Flatten and normalize colors into a single Float32Array
        palettes[preset.id] = new Float32Array(preset.colors.flat().map(v => v / 255));
        const opt = document.createElement('option');
        opt.value = preset.id;
        opt.textContent = preset.name;
        els.paletteSel.appendChild(opt);
    });
    // Apply default preset if specified in JSON
    if (defaultPresetId && palettes[defaultPresetId]) {
        els.paletteSel.value = defaultPresetId;
    }

    // ================= WebGL Setup =================
    const gl = els.canvas.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true });
    if (!gl) {
        alert('お使いのブラウザは WebGL2 に対応していません');
        throw new Error('WebGL2 unsupported');
    }

    const compileShader = (src, type) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(sh);
            console.error(info);
            throw new Error('Shader compile failed');
        }
        return sh;
    };

    const createProgram = (vsText, fsText) => {
        const prog = gl.createProgram();
        gl.attachShader(prog, compileShader(vsText, gl.VERTEX_SHADER));
        gl.attachShader(prog, compileShader(fsText, gl.FRAGMENT_SHADER));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(prog));
            throw new Error('Program link failed');
        }
        return prog;
    };

    const [vsText, fsText] = await Promise.all([vsSource, fsSource]);
    const prog = createProgram(vsText, fsText);
    gl.useProgram(prog);

    // ========== Quad Geometry ==========
    const quad = new Float32Array([
        // pos   // uv
        -1, -1, 0, 0,
        1, -1, 1, 0,
        -1, 1, 0, 1,
        1, 1, 1, 1
    ]);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

    // ========== Texture from Webcam ==========
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Flag to track texture storage allocation
    let textureInitialized = false;

    // ========== Uniform Locations ==========
    const locs = {
        brightness: gl.getUniformLocation(prog, 'uBrightness'),
        contrast: gl.getUniformLocation(prog, 'uContrast'),
        useDither: gl.getUniformLocation(prog, 'uUseDither'),
        palette: gl.getUniformLocation(prog, 'uPalette[0]'), // index 0 for arrays
        scale: gl.getUniformLocation(prog, 'uTexScale'),
        offset: gl.getUniformLocation(prog, 'uTexOffset'),
        texture: gl.getUniformLocation(prog, 'uTexture')
    };
    gl.uniform1i(locs.texture, 0); // texture unit 0

    // ========== Uniform Helpers ==========
    const updatePalette = () => {
        const data = palettes[els.paletteSel.value];
        gl.useProgram(prog);
        gl.uniform3fv(locs.palette, data);
    };
    updatePalette();

    // Bind control events
    els.paletteSel.addEventListener('change', updatePalette);
    els.brCtrl.addEventListener('input', () => gl.uniform1f(locs.brightness, +els.brCtrl.value));
    els.ctCtrl.addEventListener('input', () => gl.uniform1f(locs.contrast, +els.ctCtrl.value));
    els.ditherChk.addEventListener('change', () => gl.uniform1i(locs.useDither, els.ditherChk.checked));

    // Initial uniform values
    gl.uniform1f(locs.brightness, +els.brCtrl.value);
    gl.uniform1f(locs.contrast, +els.ctCtrl.value);
    gl.uniform1i(locs.useDither, els.ditherChk.checked);
    gl.uniform2f(locs.scale, 1, 1);
    gl.uniform2f(locs.offset, 0, 0);

    // ================= Cropping Logic =================
    let lastVidW = 0;
    let lastVidH = 0;

    const updateCrop = () => {
        if (!els.video.videoWidth || !els.video.videoHeight) return;
        if (els.video.videoWidth === lastVidW && els.video.videoHeight === lastVidH) return;

        lastVidW = els.video.videoWidth;
        lastVidH = els.video.videoHeight;
        // Allocate or re-allocate texture storage for new video resolution
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, lastVidW, lastVidH, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
        textureInitialized = true;

        const videoRatio = lastVidW / lastVidH;
        const targetRatio = els.canvas.width / els.canvas.height; // 128 / 112 ≈ 1.1429

        let scaleX = 1,
            scaleY = 1,
            offsetX = 0,
            offsetY = 0;

        if (videoRatio > targetRatio) {
            // Video is wider — crop sides
            scaleX = targetRatio / videoRatio;
            offsetX = (1 - scaleX) * 0.5;
        } else if (videoRatio < targetRatio) {
            // Video is taller — crop top/bottom
            scaleY = videoRatio / targetRatio;
            offsetY = (1 - scaleY) * 0.5;
        }

        gl.useProgram(prog);
        gl.uniform2f(locs.scale, scaleX, scaleY);
        gl.uniform2f(locs.offset, offsetX, offsetY);
    };

    ['loadedmetadata', 'resize', 'playing'].forEach((evt) => els.video.addEventListener(evt, updateCrop));
    // Attempt initial crop/texture allocation in case metadata already available
    updateCrop();

    // ================= Render Loop =================
    const render = (now = 0) => {
        // Throttle to fixed FPS
        if (now - lastFrameTime < frameInterval) return;
        lastFrameTime = now;

        // Draw the latest video frame into the texture
        if (textureInitialized && els.video.readyState >= els.video.HAVE_CURRENT_DATA) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            // Update texture in-place without realloc
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, els.video);
        }

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    // Schedule frames via video frame callback or RAF
    const scheduleFrame = (timestamp) => {
        render(timestamp);
        if (els.video.requestVideoFrameCallback) {
            els.video.requestVideoFrameCallback(scheduleFrame);
        } else {
            requestAnimationFrame(scheduleFrame);
        }
    };
    if (els.video.requestVideoFrameCallback) {
        els.video.requestVideoFrameCallback(scheduleFrame);
    } else {
        requestAnimationFrame(scheduleFrame);
    }

    // ================= Capture Logic =================
    const capturePNG = () => {
        gl.flush();
        const scale = 4;
        const w = els.canvas.width * scale;
        const h = els.canvas.height * scale;
        offCanvas.width = w;
        offCanvas.height = h;
        offCtx.imageSmoothingEnabled = false; // Preserve pixel-art crispness
        offCtx.clearRect(0, 0, w, h);
        offCtx.drawImage(els.canvas, 0, 0, w, h);
        return offCanvas.toDataURL('image/png');
    };

    els.captureBtn.addEventListener('click', () => {
        const png = capturePNG();
        els.captureImg.src = png;
        els.downloadLink.href = png;
        els.captureDialog.showModal();
    });
    els.closeDialog.addEventListener('click', () => els.captureDialog.close());
    // Close button for GIF preview dialog
    els.closeGifDialog.addEventListener('click', () => els.gifDialog.close());
    // Settings dialog open/close
    els.settingsBtn.addEventListener('click', () => els.settingsDialog.showModal());
    els.closeSettingsDialog.addEventListener('click', () => els.settingsDialog.close());
    // ================= GIF Recording Logic =================
    els.recordGifBtn.addEventListener('click', () => {
        const duration = parseFloat(els.gifDuration.value) || 5;
        // Preserve original FPS before applying GIF limit
        const prevFPS = targetFPS;
        // Limit GIF recording FPS to a maximum of 10 using the existing updateFPS helper
        updateFPS(Math.min(prevFPS, 10));
        const fps = targetFPS;
        const frameIntervalMs = frameInterval;
        const totalFrames = Math.ceil(duration * fps);
        const gif = new window.GIF({
            workers: 2,
            quality: 10,
            width: els.canvas.width * 3,
            height: els.canvas.height * 3,
            workerScript: gifWorkerBlobUrl
        });
        // Reuse offscreen canvas for GIF frames
        offCanvas.width = els.canvas.width * 3;
        offCanvas.height = els.canvas.height * 3;
        offCtx.imageSmoothingEnabled = false;
        let frameCount = 0;
        els.recordGifBtn.disabled = true;
        els.recordGifBtn.title = 'Recording...';
        els.captureBtn.disabled = true;
        els.settingsBtn.disabled = true;
        const recordInterval = setInterval(() => {
            offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
            offCtx.drawImage(els.canvas, 0, 0, offCanvas.width, offCanvas.height);
            gif.addFrame(offCanvas, { delay: frameIntervalMs, copy: true });
            frameCount++;
            if (frameCount >= totalFrames) {
                clearInterval(recordInterval);
                // Restore FPS after finishing recording
                updateFPS(prevFPS);
                gif.on('finished', (blob) => {
                    const url = URL.createObjectURL(blob);
                    els.gifImg.src = url;
                    els.downloadGifLink.href = url;
                    els.gifDialog.showModal();
                    els.gifDialog.addEventListener('close', () => {
                        URL.revokeObjectURL(url);
                        els.recordGifBtn.disabled = false;
                        els.recordGifBtn.textContent = '🔴';
                        els.captureBtn.disabled = false;
                        els.settingsBtn.disabled = false;
                    }, { once: true });
                });
                gif.render();
            }
        }, frameIntervalMs);
    });
})();
