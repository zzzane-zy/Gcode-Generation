/**
 * app.js
 * Main application orchestrator — wires up the UI, runs the processing pipeline,
 * manages progress, and handles downloads (G-code + dithered image).
 */

document.addEventListener('DOMContentLoaded', () => {

    // ======== DOM References ========
    const uploadArea = document.getElementById('upload-area');
    const fileInput = document.getElementById('file-input');
    const fileName = document.getElementById('file-name');
    const imageInfo = document.getElementById('image-info');
    const btnGenerate = document.getElementById('btn-generate');
    const btnDownload = document.getElementById('btn-download');
    const btnDownloadImg = document.getElementById('btn-download-img');

    const gcodeStats = document.getElementById('gcode-stats');
    const origPreview = document.getElementById('preview-original');
    const dithPreview = document.getElementById('preview-dithered');
    const origPlaceholder = document.getElementById('ph-original');
    const dithPlaceholder = document.getElementById('ph-dithered');
    const statusBar = document.getElementById('status-bar');
    const statusText = document.getElementById('status-text');

    const stepDots = document.querySelectorAll('.step');

    // ======== State ========
    const processor = new ImageProcessor();
    let gcodeResult = null;
    let ditheredCanvas = null; // keep reference for download
    let parsedG25 = null;      // parsed G25 data

    // ======== Helpers ========
    function getVal(id) { return parseFloat(document.getElementById(id).value); }

    function showStatus(msg) {
        statusText.textContent = msg;
        statusBar.classList.add('visible');
    }
    function hideStatus() { statusBar.classList.remove('visible'); }

    function setStep(n, state) {
        const el = stepDots[n];
        if (!el) return;
        el.classList.remove('active', 'done');
        if (state) el.classList.add(state);
    }
    function resetSteps() { stepDots.forEach((_, i) => setStep(i, '')); }
    function activateStep(n) {
        for (let i = 0; i < n; i++) setStep(i, 'done');
        setStep(n, 'active');
    }

    /** Yield to the browser so the UI can update */
    function tick(ms = 0) { return new Promise(r => setTimeout(r, ms)); }

    // ======== Image Upload ========
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files.length) handleFile(fileInput.files[0]);
    });

    async function handleFile(file) {
        if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
        showStatus('正在加载图片...');
        try {
            const img = await processor.loadImage(file);
            fileName.textContent = file.name;
            imageInfo.innerHTML = `<span class="tag">${img.width}×${img.height}px</span><span class="tag">${(file.size / 1024).toFixed(1)}KB</span>`;

            // Show original preview
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            origPreview.innerHTML = '';
            origPreview.appendChild(c);
            origPlaceholder.style.display = 'none';

            btnGenerate.disabled = false;
            hideStatus();
        } catch (e) {
            alert('图片加载失败: ' + e.message);
            hideStatus();
        }
    }

    // ======== G-code Upload ========
    const gcodeUploadArea = document.getElementById('gcode-upload-area');
    const gcodeFileInput = document.getElementById('gcode-file-input');
    const gcodeFileName = document.getElementById('gcode-file-name');
    const gcodeInfo = document.getElementById('gcode-info');

    gcodeUploadArea.addEventListener('click', () => gcodeFileInput.click());
    gcodeUploadArea.addEventListener('dragover', (e) => { e.preventDefault(); gcodeUploadArea.classList.add('dragover'); });
    gcodeUploadArea.addEventListener('dragleave', () => gcodeUploadArea.classList.remove('dragover'));
    gcodeUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        gcodeUploadArea.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleGcodeFile(e.dataTransfer.files[0]);
    });
    gcodeFileInput.addEventListener('change', () => {
        if (gcodeFileInput.files.length) handleGcodeFile(gcodeFileInput.files[0]);
    });

    async function handleGcodeFile(file) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        showStatus(`正在读取 G25 文件 (${sizeMB}MB)...`);
        try {
            const text = await file.text();
            showStatus(`正在解析 G25 (${sizeMB}MB, ${text.split('\n').length.toLocaleString()} 行)...`);
            // Yield to browser before heavy parse
            await tick(50);

            parsedG25 = GCodeParser.parse(text, (p) => {
                statusText.textContent = `解析 G25... ${Math.round(p * 100)}%`;
            });
            const imgSize = GCodeParser.getImageSize(parsedG25);
            gcodeFileName.textContent = `${file.name} (${sizeMB}MB)`;
            gcodeInfo.innerHTML = [
                `<span class="tag">${parsedG25.dots.length.toLocaleString()} 点</span>`,
                `<span class="tag">${parsedG25.yValues.length} 行</span>`,
                `<span class="tag">${imgSize.width.toFixed(2)}×${imgSize.height.toFixed(2)}mm</span>`,
                `<span class="tag">X${parsedG25.xPitch.toFixed(4)}mm</span>`,
                `<span class="tag">Y${parsedG25.yPitch.toFixed(4)}mm</span>`,
            ].join('');

            showStatus('构建预览...');
            await tick(50);

            // Build matrix for preview display
            const matrix = GCodeParser.buildMatrix(parsedG25);
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = matrix.width;
            previewCanvas.height = matrix.height;
            const ctx = previewCanvas.getContext('2d');
            const imgData = ctx.createImageData(matrix.width, matrix.height);
            for (let i = 0; i < matrix.matrix.length; i++) {
                const v = matrix.matrix[i] ? 0 : 255;
                imgData.data[i * 4] = v; imgData.data[i * 4 + 1] = v; imgData.data[i * 4 + 2] = v; imgData.data[i * 4 + 3] = 255;
            }
            ctx.putImageData(imgData, 0, 0);
            origPreview.innerHTML = '';
            origPreview.appendChild(previewCanvas);
            origPlaceholder.style.display = 'none';

            btnGenerate.disabled = false;
            showStatus(`✅ G25 解析完成: ${parsedG25.dots.length.toLocaleString()} 点`);
            setTimeout(hideStatus, 3000);
        } catch (e) {
            console.error('G25 parse error:', e);
            alert('G25文件解析失败: ' + e.message);
            hideStatus();
        }
    }

    // ======== Generate (route by mode) ========
    btnGenerate.addEventListener('click', () => {
        const inputMode = document.querySelector('input[name="input-mode"]:checked').value;
        if (inputMode === 'gcode') {
            runG25Pipeline();
        } else {
            runPipeline();
        }
    });

    async function runPipeline() {
        if (!processor.originalImage) { alert('请先上传图片'); return; }
        btnGenerate.disabled = true;
        btnDownload.disabled = true;
        btnDownloadImg.disabled = true;
        gcodeResult = null;
        ditheredCanvas = null;
        resetSteps();

        try {
            // === Read all parameters ===
            const dimMode = document.querySelector('input[name="dim-mode"]:checked').value;
            const resMode = document.querySelector('input[name="res-mode"]:checked').value;
            const targetDim = getVal('param-target-dim');
            const spotX = getVal('param-spot-x');   // μm (physical laser spot)
            const spotY = getVal('param-spot-y');   // μm
            const threshold = getVal('param-threshold');
            const invertEnabled = document.getElementById('param-invert').checked;
            const brightness = getVal('param-brightness');
            const contrast = getVal('param-contrast');
            const speed = getVal('param-speed');
            const tp = getVal('param-tp');
            const pmin = getVal('param-pmin');
            const pmax = getVal('param-pmax');
            const accel = getVal('param-accel');
            const delay = getVal('param-delay');
            const yJog = getVal('param-yjog');
            const workW = getVal('param-work-w');
            const workH = getVal('param-work-h');

            // Jarvis coefficients
            const coefficients = {
                r1: getVal('j-r1'), r2: getVal('j-r2'),
                d1a: getVal('j-d1a'), d1b: getVal('j-d1b'), d1c: getVal('j-d1c'), d1d: getVal('j-d1d'), d1e: getVal('j-d1e'),
                d2a: getVal('j-d2a'), d2b: getVal('j-d2b'), d2c: getVal('j-d2c'), d2d: getVal('j-d2d'), d2e: getVal('j-d2e'),
            };

            const origW = processor.originalImage.width;
            const origH = processor.originalImage.height;

            // Calculate target dimensions in mm (proportional from original)
            let targetW_mm, targetH_mm;
            if (dimMode === 'width') {
                targetW_mm = targetDim;
                targetH_mm = targetDim * origH / origW;
            } else {
                targetH_mm = targetDim;
                targetW_mm = targetDim * origW / origH;
            }

            // === Effective spot size (motion-elongated in X) ===
            // During pulse time tp, head moves v*tp/1000 mm = v*tp μm
            // Effective X mark = static spotX + movement distance
            const effectiveSpotX_um = spotX + speed * tp; // μm
            const effectiveSpotX_mm = effectiveSpotX_um / 1000;
            const spotY_mm = spotY / 1000;

            // === Resolution mode branching ===
            let xPitchMM, yPitchMM, dpi, rho, xDots, yDots, upscaleFactor;
            let xDensityCm, yDensityCm;

            if (resMode === 'density') {
                // ── Mode 1: User sets line density → auto upscale ──
                xDensityCm = getVal('param-xdensity');
                yDensityCm = getVal('param-ydensity');
                xPitchMM = 10.0 / xDensityCm;
                yPitchMM = 10.0 / yDensityCm;
                xDots = Math.round(targetW_mm / xPitchMM);
                yDots = Math.round(targetH_mm / yPitchMM);
                // Auto upscale: ensure enough pixels for dot matrix
                const dotsPerPixelX = xDots / origW;
                const dotsPerPixelY = yDots / origH;
                upscaleFactor = Math.max(1, Math.ceil(Math.max(dotsPerPixelX, dotsPerPixelY)));
                upscaleFactor = Math.min(upscaleFactor, 16);
            } else {
                // ── Mode 2: User sets upscale factor → auto line density ──
                upscaleFactor = Math.max(1, Math.round(getVal('param-upscale')));
                // Upscaled image IS the dot matrix
                xDots = origW * upscaleFactor;
                yDots = origH * upscaleFactor;
                // Compute pitch from physical size and dot count
                xPitchMM = targetW_mm / xDots;
                yPitchMM = targetH_mm / yDots;
                // Back-calculate line density for display & G-code
                xDensityCm = 10.0 / xPitchMM;
                yDensityCm = 10.0 / yPitchMM;
            }

            // Common derived values for G-code generator
            dpi = 25.4 / xPitchMM;
            rho = 1.0 / yPitchMM;

            // ---- Step 1: Upload (already done) ----
            activateStep(0);
            showStatus('步骤 1/7: 图片已加载');
            await tick(200);

            // ---- Step 2: Upscale ----
            activateStep(1);
            showStatus(`步骤 2/7: 无损放大 ×${upscaleFactor} → ${origW * upscaleFactor}×${origH * upscaleFactor}px, 目标点阵 ${xDots}×${yDots}`);
            await tick(50);
            const upscaled = processor.upscale(upscaleFactor);
            await tick(50);

            // ---- Step 3: Resize to grid ----
            activateStep(2);
            showStatus(`步骤 3/7: 等比缩放至 ${xDots}×${yDots} 点阵...`);
            await tick(50);
            const resized = processor.resizeToGrid(upscaled.imageData, upscaled.width, upscaled.height, xDots, yDots);
            await tick(50);

            // ---- Step 4: Invert (independent pre-processing) ----
            activateStep(3);
            if (invertEnabled) {
                showStatus('步骤 4/7: 反色处理...');
                await tick(50);
                processor.invertImageData(resized);
                // Update original preview to show inverted result
                const invertCanvas = document.createElement('canvas');
                invertCanvas.width = resized.width;
                invertCanvas.height = resized.height;
                const invertCtx = invertCanvas.getContext('2d');
                invertCtx.putImageData(resized, 0, 0);
                origPreview.innerHTML = '';
                origPreview.appendChild(invertCanvas);
            } else {
                showStatus('步骤 4/7: 反色(已跳过)...');
            }
            await tick(50);

            // ---- Step 5: Jarvis Dithering ----
            activateStep(4);
            showStatus('步骤 5/7: Jarvis 抖动处理...');
            await tick(50);
            const ditherOptions = { brightness, contrast };
            const dithered = processor.jarvisDither(resized, threshold, coefficients, ditherOptions, (p) => {
                statusText.textContent = `步骤 5/7: Jarvis 抖动处理... ${Math.round(p * 100)}%`;
            });
            await tick(50);

            // Show dithered preview & keep reference for download
            ditheredCanvas = processor.ditheredToCanvas(dithered);
            dithPreview.innerHTML = '';
            dithPreview.appendChild(ditheredCanvas);
            dithPlaceholder.style.display = 'none';

            // ---- Step 6: Centering ----
            activateStep(5);
            showStatus('步骤 6/7: 居中定位...');
            await tick(100);

            // ---- Step 7: Generate G-code ----
            activateStep(6);
            showStatus('步骤 7/7: 生成G代码...');
            await tick(50);

            const gen = new GCodeGenerator({
                speed, density: rho, pulseTime: tp, pmin, pmax, accel, delay, yJog, workW, workH, dpi
            });

            gcodeResult = gen.generate(dithered, targetW_mm, targetH_mm, (p) => {
                statusText.textContent = `步骤 7/7: 生成G代码... ${Math.round(p * 100)}%`;
            });
            await tick(50);

            // Show G-code stats (no textarea to avoid lag)
            const gcodeLines = gcodeResult.gcode.split('\n');
            gcodeStats.textContent = `${gcodeLines.length} 行 | ${(gcodeResult.gcode.length / 1024).toFixed(1)} KB`;

            // Show image detail info
            const overscanDist = (speed * speed / (2 * accel)).toFixed(2);
            const xCenter = (workW / 2).toFixed(1);
            const yCenter = (workH / 2).toFixed(1);
            const xOffInfo = (workW / 2 - targetW_mm / 2).toFixed(2);
            const yOffInfo = (workH / 2 - targetH_mm / 2).toFixed(2);
            const pulseWidthInfo = (speed * tp / 1000).toFixed(4);

            // Count black/white pixels in dithered output
            let blackCount = 0;
            for (let i = 0; i < dithered.matrix.length; i++) {
                if (dithered.matrix[i] === 1) blackCount++;
            }
            const totalDots = dithered.width * dithered.height;
            const whiteCount = totalDots - blackCount;
            const fillRatio = (blackCount / totalDots * 100).toFixed(1);
            // Estimated time
            const scanLines = dithered.height;
            const scanWidth = targetW_mm + 2 * parseFloat(overscanDist);
            const estTimeSec = scanLines * scanWidth / speed + scanLines * yPitchMM / speed;
            const estMin = Math.floor(estTimeSec / 60);
            const estSec = Math.round(estTimeSec % 60);

            // Coverage: use effective spot X for X direction
            const xCoverage = (effectiveSpotX_mm / xPitchMM * 100).toFixed(0);
            const yCoverage = (spotY_mm / yPitchMM * 100).toFixed(0);

            const infoItems = [
                // ─── 图像信息 ───
                ['📐 原始像素', `${origW} × ${origH} px`],
                ['🔍 放大后像素', `${origW * upscaleFactor} × ${origH * upscaleFactor} px (×${upscaleFactor} ${resMode === 'density' ? '自动' : '手动'})`],
                ['🎯 Jarvis 点阵', `${dithered.width} × ${dithered.height} dots (${totalDots.toLocaleString()} 总点)`],
                ['⬛ 黑点(出光)', `${blackCount.toLocaleString()} 点 (${fillRatio}%)`],
                ['⬜ 白点(不出光)', `${whiteCount.toLocaleString()} 点 (${(100 - fillRatio).toFixed(1)}%)`],
                // ─── 物理尺寸 ───
                ['📏 输出物理尺寸', `${targetW_mm.toFixed(2)} × ${targetH_mm.toFixed(2)} mm`],
                ['📍 居中偏移', `(${xOffInfo}, ${yOffInfo}) → 中心(${xCenter}, ${yCenter})`],
                // ─── 光斑与分辨率 ───
                ['🔴 静态光斑', `X: ${spotX}μm, Y: ${spotY}μm`],
                ['🔥 动态光斑(X)', `${effectiveSpotX_um.toFixed(1)}μm (静态${spotX} + 运动${(speed * tp).toFixed(1)}μm)`],
                ['⚙️ 模式', resMode === 'density' ? '模式1: 线密度→自动放大×' + upscaleFactor : '模式2: 放大×' + upscaleFactor + '→自动线密度'],
                ['↔️ X 线密度', `${xDensityCm.toFixed(1)} 线/cm (间距${xPitchMM.toFixed(4)}mm, ≈${dpi.toFixed(0)}DPI)`],
                ['↕️ Y 线密度', `${yDensityCm.toFixed(1)} 线/cm (间距${yPitchMM.toFixed(4)}mm)`],
                ['📎 覆盖率', `X: ${xCoverage}% (动态光斑/间距), Y: ${yCoverage}%`],
                // ─── 机器参数 ───
                ['💡 脉冲宽度', `${pulseWidthInfo} mm (v×tp)`],
                ['📐 Overscan', `${overscanDist} mm (v²/2a)`],
                ['🔄 Y过冲', `${yJog} mm`],
                ['⏱️ 延时补偿', `±${(speed * delay / 1000).toFixed(4)} mm`],
                ['⏰ 预计耗时', `≈${estMin}分${estSec}秒 (${scanLines}行)`],
                ['📄 G-code', `${gcodeLines.length.toLocaleString()} 行, ${(gcodeResult.gcode.length / 1024).toFixed(1)} KB`],
            ];

            const detailCard = document.getElementById('image-detail-card');
            const detailContent = document.getElementById('image-detail-content');
            detailCard.style.display = 'block';
            detailContent.innerHTML = infoItems.map(([label, val]) =>
                `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(255,255,255,0.02);border-radius:6px;">` +
                `<span style="color:var(--text-secondary)">${label}</span>` +
                `<span style="color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:0.78rem">${val}</span></div>`
            ).join('');

            // Done!
            setStep(6, 'done');
            showStatus('✅ 处理完成！');
            btnDownload.disabled = false;
            btnDownloadImg.disabled = false;
            setTimeout(hideStatus, 3000);

        } catch (e) {
            console.error(e);
            alert('处理出错: ' + e.message);
            hideStatus();
        }
        btnGenerate.disabled = false;
    }

    // ======== G25 → G1 Conversion Pipeline ========
    async function runG25Pipeline() {
        if (!parsedG25) { alert('请先上传 G25 文件'); return; }
        btnGenerate.disabled = true;
        btnDownload.disabled = true;
        btnDownloadImg.disabled = true;
        gcodeResult = null;
        ditheredCanvas = null;
        resetSteps();

        try {
            // Read machine parameters
            const speed = getVal('param-speed');
            const tp = getVal('param-tp');
            const pmin = getVal('param-pmin');
            const pmax = getVal('param-pmax');
            const accel = getVal('param-accel');
            const delay = getVal('param-delay');
            const yJog = getVal('param-yjog');
            const workW = getVal('param-work-w');
            const workH = getVal('param-work-h');
            const spotX = getVal('param-spot-x');
            const spotY = getVal('param-spot-y');

            // Step 1: Parse info
            activateStep(0);
            showStatus(`步骤 1/3: G25 已解析 (${parsedG25.dots.length.toLocaleString()} 点)`);
            await tick(200);

            // Step 2: Build preview (direct pixel paint, no grid quantization)
            activateStep(1);
            showStatus('步骤 2/3: 生成预览...');
            await tick(50);
            const previewMatrix = GCodeParser.buildMatrix(parsedG25);
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = previewMatrix.width;
            previewCanvas.height = previewMatrix.height;
            const pctx = previewCanvas.getContext('2d');
            const pImgData = pctx.createImageData(previewMatrix.width, previewMatrix.height);
            for (let i = 0; i < previewMatrix.matrix.length; i++) {
                const v = previewMatrix.matrix[i] ? 0 : 255;
                pImgData.data[i * 4] = v; pImgData.data[i * 4 + 1] = v; pImgData.data[i * 4 + 2] = v; pImgData.data[i * 4 + 3] = 255;
            }
            pctx.putImageData(pImgData, 0, 0);
            ditheredCanvas = previewCanvas;
            dithPreview.innerHTML = '';
            dithPreview.appendChild(ditheredCanvas);
            dithPlaceholder.style.display = 'none';
            await tick(50);

            // Step 3: Generate G1 directly from raw dot positions (NO matrix — every dot preserved)
            activateStep(2);
            showStatus('步骤 3/3: 直接从 G25 点位生成 G1 代码...');
            await tick(50);

            const xPitchMM = parsedG25.xPitch;
            const yPitchMM = parsedG25.yPitch;
            const rho = 1.0 / yPitchMM;
            const dpi = 25.4 / xPitchMM;

            const gen = new GCodeGenerator({
                speed, density: rho, pulseTime: tp, pmin, pmax, accel, delay, yJog, workW, workH, dpi
            });

            // Direct conversion: every G25 dot position → G1 laser position
            gcodeResult = gen.generateFromDots(parsedG25.dots, parsedG25.bounds, (p) => {
                statusText.textContent = `生成 G1... ${Math.round(p * 100)}%`;
            });
            await tick(50);

            // G-code stats
            const gcodeLines = gcodeResult.gcode.split('\n');
            gcodeStats.textContent = `${gcodeLines.length.toLocaleString()} 行 | ${(gcodeResult.gcode.length / 1024).toFixed(1)} KB`;

            // Info display
            const effectiveSpotX_um = spotX + speed * tp;
            const overscanDist = (speed * speed / (2 * accel)).toFixed(2);
            const pulseWidthMM = (speed * tp / 1000).toFixed(4);
            const imgW = gcodeResult.imgW_mm;
            const imgH = gcodeResult.imgH_mm;
            const xCenter = (workW / 2).toFixed(1);
            const yCenter = (workH / 2).toFixed(1);
            const xDensityCm = 10.0 / xPitchMM;
            const yDensityCm = 10.0 / yPitchMM;
            const scanLineCount = gcodeResult.rowCount;
            const scanWidth = imgW + 2 * parseFloat(overscanDist);
            const estTimeSec = scanLineCount * scanWidth / speed + scanLineCount * yPitchMM / speed;
            const estMin = Math.floor(estTimeSec / 60);
            const estSec = Math.round(estTimeSec % 60);

            const infoItems = [
                ['📥 转换模式', 'G25 → G1 (直接点位映射, 无损)'],
                ['📄 G25 总点数', `${parsedG25.dots.length.toLocaleString()} 点`],
                ['⬛ 出光点(S>0)', `${gcodeResult.dotCount.toLocaleString()} 点`],
                ['📏 扫描行数', `${gcodeResult.rowCount} 行`],
                ['📐 G25 图像尺寸', `${imgW.toFixed(2)} × ${imgH.toFixed(2)} mm`],
                ['↔️ X间距', `${xPitchMM.toFixed(4)} mm (${xDensityCm.toFixed(1)} 线/cm)`],
                ['↕️ Y间距', `${yPitchMM.toFixed(4)} mm (${yDensityCm.toFixed(1)} 线/cm)`],
                ['📍 平移偏移', `X+${gcodeResult.xShift.toFixed(3)}mm, Y+${gcodeResult.yShift.toFixed(3)}mm → 中心(${xCenter}, ${yCenter})`],
                ['🔴 静态光斑', `X: ${spotX}μm, Y: ${spotY}μm`],
                ['🔥 动态光斑(X)', `${effectiveSpotX_um.toFixed(1)}μm (静态${spotX} + 运动${(speed * tp).toFixed(1)}μm)`],
                ['💡 脉冲宽度', `${pulseWidthMM} mm (v×tp)`],
                ['📐 Overscan', `${overscanDist} mm`],
                ['🔄 Y过冲', `${yJog} mm`],
                ['⏱️ 延时补偿', `±${(speed * delay / 1000).toFixed(4)} mm`],
                ['⏰ 预计耗时', `≈${estMin}分${estSec}秒 (${scanLineCount}行)`],
                ['📄 G1 输出', `${gcodeLines.length.toLocaleString()} 行, ${(gcodeResult.gcode.length / 1024).toFixed(1)} KB`],
            ];

            const detailCard = document.getElementById('image-detail-card');
            const detailContent = document.getElementById('image-detail-content');
            detailCard.style.display = 'block';
            detailContent.innerHTML = infoItems.map(([label, val]) =>
                `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(255,255,255,0.02);border-radius:6px;">` +
                `<span style="color:var(--text-secondary)">${label}</span>` +
                `<span style="color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:0.78rem">${val}</span></div>`
            ).join('');

            // Done!
            setStep(2, 'done');
            showStatus('✅ G25 → G1 转换完成！');
            btnDownload.disabled = false;
            btnDownloadImg.disabled = false;
            setTimeout(hideStatus, 3000);

        } catch (e) {
            console.error(e);
            alert('G25转换出错: ' + e.message);
            hideStatus();
        }
        btnGenerate.disabled = false;
    }

    // ======== Download G-code ========
    btnDownload.addEventListener('click', () => {
        if (!gcodeResult) return;
        const blob = new Blob([gcodeResult.gcode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        a.download = `gcode_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.gcode`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // ======== Download Dithered Image ========
    btnDownloadImg.addEventListener('click', () => {
        if (!ditheredCanvas) return;
        ditheredCanvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            a.download = `jarvis_dithered_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/png');
    });
});
