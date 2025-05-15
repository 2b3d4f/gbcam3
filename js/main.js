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
        recordGifBtn: document.getElementById('recordGifBtn')
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

    // ================= FPS State =================
    let targetFPS = +els.fpsRange.value || 5;
    let frameInterval = 1000 / targetFPS;
    let lastFrameTime = 0;

    const updateFPS = (val) => {
        targetFPS = Math.max(1, +val || 1);
        frameInterval = 1000 / targetFPS;
    };

    // Keep controls synced
    ['input', 'change'].forEach((evt) => {
        els.fpsRange.addEventListener(evt, () => {
            els.fpsNumber.value = els.fpsRange.value;
            updateFPS(els.fpsRange.value);
        });
        els.fpsNumber.addEventListener(evt, () => {
            els.fpsRange.value = els.fpsNumber.value;
            updateFPS(els.fpsNumber.value);
        });
    });

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

    // ================= Palettes (0‑1) =================
    const palettes = {
        grayscale: [
            [0, 0, 0],
            [0.33, 0.33, 0.33],
            [0.66, 0.66, 0.66],
            [1, 1, 1]
        ],
        gameboy: [
            [15 / 255, 56 / 255, 15 / 255],
            [48 / 255, 98 / 255, 48 / 255],
            [139 / 255, 172 / 255, 15 / 255],
            [155 / 255, 188 / 255, 15 / 255]
        ],
        sepia: [
            [38 / 255, 19 / 255, 0],
            [87 / 255, 51 / 255, 8 / 255],
            [166 / 255, 124 / 255, 54 / 255],
            [245 / 255, 230 / 255, 196 / 255]
        ],
        cga: [
            [0, 0, 0],
            [85 / 255, 1, 1],
            [1, 85 / 255, 1],
            [1, 1, 1]
        ]
    };

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
        const flat = palettes[els.paletteSel.value].flat();
        gl.useProgram(prog);
        gl.uniform3fv(locs.palette, new Float32Array(flat));
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

    // ================= Render Loop =================
    const render = (now = 0) => {
        requestAnimationFrame(render);
        if (now - lastFrameTime < frameInterval) return; // Throttle FPS
        lastFrameTime = now;

        updateCrop();

        if (els.video.readyState >= els.video.HAVE_CURRENT_DATA) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, els.video);
        }

        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    requestAnimationFrame(render);

    // ================= Capture Logic =================
    const capturePNG = () => {
        gl.flush();
        const scale = 4;
        const w = els.canvas.width * scale;
        const h = els.canvas.height * scale;
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx2d = off.getContext('2d', { alpha: false });
        ctx2d.imageSmoothingEnabled = false; // Preserve pixel‑art crispness
        ctx2d.drawImage(els.canvas, 0, 0, w, h);
        return off.toDataURL('image/png');
    };

    els.captureBtn.addEventListener('click', () => {
        const png = capturePNG();
        els.captureImg.src = png;
        els.downloadLink.href = png;
        els.captureDialog.showModal();
    });
    els.closeDialog.addEventListener('click', () => els.captureDialog.close());
    // ================= GIF Recording Logic =================
    els.recordGifBtn.addEventListener('click', () => {
        const duration = parseFloat(els.gifDuration.value) || 5;
        const fps = targetFPS;
        const frameIntervalMs = 1000 / fps;
        const totalFrames = Math.ceil(duration * fps);
        const gif = new window.GIF({
            workers: 2,
            quality: 10,
            width: els.canvas.width * 2,
            height: els.canvas.height * 2,
            workerScript: gifWorkerBlobUrl
        });
        const off = document.createElement('canvas');
        off.width = els.canvas.width * 2;
        off.height = els.canvas.height * 2;
        const offCtx = off.getContext('2d', { alpha: false });
        offCtx.imageSmoothingEnabled = false;
        let frameCount = 0;
        els.recordGifBtn.disabled = true;
        els.recordGifBtn.textContent = 'Recording...';
        const recordInterval = setInterval(() => {
            offCtx.clearRect(0, 0, off.width, off.height);
            offCtx.drawImage(els.canvas, 0, 0, off.width, off.height);
            gif.addFrame(off, { delay: frameIntervalMs, copy: true });
            frameCount++;
            if (frameCount >= totalFrames) {
                clearInterval(recordInterval);
                gif.on('finished', (blob) => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'gbcam.gif';
                    a.click();
                    URL.revokeObjectURL(url);
                    els.recordGifBtn.disabled = false;
                    els.recordGifBtn.textContent = '🔴 Record GIF';
                });
                gif.render();
            }
        }, frameIntervalMs);
    });
})();
