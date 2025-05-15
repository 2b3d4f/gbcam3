import { loadShaders, loadPresets } from './utils.js';
import { initGL, compileShader, createProgram, createFBO } from './webgl.js';

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
        echoMode: document.getElementById('echoMode'),
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
        closeSettingsDialog: document.getElementById('closeSettingsDialog'),
        echoDecay: document.getElementById('echoDecay')
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
    // Echo strength control (0.0 - 1.0)
    let echoDecayValue = +els.echoDecay.value;
    els.echoDecay.addEventListener('input', () => {
        echoDecayValue = +els.echoDecay.value;
    });

    // ================= Palettes (from presets JSON) =================
    const data = await loadPresets();
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
    const gl = initGL(els.canvas);

    // Shader compile and program helpers imported from webgl.js

    const { vsText, fsText, echoFsText, passFsText } = await loadShaders();
    // Create main shader program
    const prog = createProgram(gl, vsText, fsText);
    gl.useProgram(prog);
    // ========== Echo and Passthrough Programs ==========
    // Create echo and passthrough programs
    const echoProg = createProgram(gl, vsText, echoFsText);
    const passProg = createProgram(gl, vsText, passFsText);
    // Echo uniforms
    const echoLocs = {
        current: gl.getUniformLocation(echoProg, 'uCurrent'),
        previous: gl.getUniformLocation(echoProg, 'uPrevious'),
        decay: gl.getUniformLocation(echoProg, 'uDecay')
    };
    // Passthrough uniform
    const passLoc = gl.getUniformLocation(passProg, 'uTexture');
    // Initialize echo program texture units
    gl.useProgram(echoProg);
    gl.uniform1i(echoLocs.current, 0);
    gl.uniform1i(echoLocs.previous, 1);
    // Initialize passthrough program
    gl.useProgram(passProg);
    gl.uniform1i(passLoc, 0);
    // Restore main program
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

    // ========== Framebuffer Setup (ping-pong for echo) ==========
    const fboWidth = els.canvas.width;
    const fboHeight = els.canvas.height;
    // Create two buffers for ping-pong echo
    const echoBuffers = [
        createFBO(gl, fboWidth, fboHeight),
        createFBO(gl, fboWidth, fboHeight)
    ];
    let echoRead = 0, echoWrite = 1;
    // Single buffer for processed (after-shader) video
    const processedBuffer = createFBO(gl, fboWidth, fboHeight);
    // Initialize all FBO textures to zero (prevent lazy allocation)
    gl.clearColor(0, 0, 0, 0);
    [echoBuffers[0].fbo, echoBuffers[1].fbo, processedBuffer.fbo].forEach(fbo => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.clear(gl.COLOR_BUFFER_BIT);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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
    els.brCtrl.addEventListener('input', () => {
        gl.useProgram(prog);
        gl.uniform1f(locs.brightness, +els.brCtrl.value)
    });
    els.ctCtrl.addEventListener('input', () => {
        gl.useProgram(prog);
        gl.uniform1f(locs.contrast, +els.ctCtrl.value)
    });
    els.ditherChk.addEventListener('change', () => {
        gl.useProgram(prog);
        gl.uniform1i(locs.useDither, els.ditherChk.checked)
    });

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
        // Ensure primary texture is allocated to avoid lazy init
        if (!textureInitialized) {
            const vw = els.video.videoWidth;
            const vh = els.video.videoHeight;
            if (vw > 0 && vh > 0) {
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, vw, vh, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
                textureInitialized = true;
            }
        }
        // Throttle to fixed FPS
        if (now - lastFrameTime < frameInterval) return;
        lastFrameTime = now;

        // Update video texture
        if (textureInitialized && els.video.readyState >= els.video.HAVE_CURRENT_DATA) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGB, gl.UNSIGNED_BYTE, els.video);
        }

        const mode = els.echoMode.value;
        // Render based on echo mode
        if (mode === 'before') {
            // Combine video + previous echo into echoBuffers[echoWrite]
            gl.bindFramebuffer(gl.FRAMEBUFFER, echoBuffers[echoWrite].fbo);
            gl.viewport(0, 0, fboWidth, fboHeight);
            gl.useProgram(echoProg);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, echoBuffers[echoRead].tex);
            gl.uniform1f(echoLocs.decay, echoDecayValue);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            // Swap echo buffers
            [echoRead, echoWrite] = [echoWrite, echoRead];
            // Main pass from echoBuffers[echoRead] to screen
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, echoBuffers[echoRead].tex);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } else if (mode === 'after') {
            // Main processing into processedBuffer
            gl.bindFramebuffer(gl.FRAMEBUFFER, processedBuffer.fbo);
            gl.viewport(0, 0, fboWidth, fboHeight);
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            // Combine processed + previous echo into echoBuffers[echoWrite]
            gl.bindFramebuffer(gl.FRAMEBUFFER, echoBuffers[echoWrite].fbo);
            gl.viewport(0, 0, fboWidth, fboHeight);
            gl.useProgram(echoProg);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, processedBuffer.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, echoBuffers[echoRead].tex);
            gl.uniform1f(echoLocs.decay, echoDecayValue);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            // Swap echo buffers
            [echoRead, echoWrite] = [echoWrite, echoRead];
            // Draw echoBuffers[echoRead] to screen
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.useProgram(passProg);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, echoBuffers[echoRead].tex);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } else {
            // No echo: direct render
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
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

    // ========== Cleanup on page hide or visibility change ==========
    let _cleaned = false;
    function cleanup() {
        if (_cleaned) return;
        _cleaned = true;
        // Stop camera
        if (currentStream) currentStream.getTracks().forEach(t => t.stop());
        // Delete GL programs and textures
        [prog, echoProg, passProg].forEach(p => p && gl.deleteProgram(p));
        tex && gl.deleteTexture(tex);
        echoBuffers.forEach(buf => {
            gl.deleteFramebuffer(buf.fbo);
            gl.deleteTexture(buf.tex);
        });
        if (processedBuffer) {
            gl.deleteFramebuffer(processedBuffer.fbo);
            gl.deleteTexture(processedBuffer.tex);
        }
        // Revoke worker URL
        gifWorkerBlobUrl && URL.revokeObjectURL(gifWorkerBlobUrl);
        // Clear offscreen canvas
        offCanvas.width = offCanvas.height = 0;
        // Lose WebGL context to free GPU memory on unload
        const lose = gl.getExtension('WEBGL_lose_context');
        lose && lose.loseContext();
    }
    // Fire cleanup on pagehide (bfcache-compatible)
    window.addEventListener('pagehide', cleanup);
})();
