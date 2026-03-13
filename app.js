/**
 * app.js
 * Orchestrates the image → G-code pipeline (pixel-by-pixel mode)
 * and the G25 → G1 conversion pipeline.
 * Includes the pixel timing visualization (④).
 */

document.addEventListener('DOMContentLoaded', () => {

    // #region agent log — silent debug logger (console only)
    function _dlog(loc, msg, data) {
        console.log('[DBG]', loc, msg, data);
        fetch('http://127.0.0.1:7544/ingest/127e5eac-797d-4dc5-aced-7ec78a29971f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'166cd4'},body:JSON.stringify({sessionId:'166cd4',location:loc,message:msg,data:data||{},timestamp:Date.now()})}).catch(()=>{});
    }
    // #endregion

    // ======== DOM ========
    const uploadArea    = document.getElementById('upload-area');
    const fileInput     = document.getElementById('file-input');
    const fileName      = document.getElementById('file-name');
    const imageInfo     = document.getElementById('image-info');
    const btnGenerate   = document.getElementById('btn-generate');
    const btnDownload   = document.getElementById('btn-download');
    const btnDownloadImg= document.getElementById('btn-download-img');
    const gcodeStats    = document.getElementById('gcode-stats');
    const origPreview   = document.getElementById('preview-original');
    const dithPreview   = document.getElementById('preview-dithered');
    const origPlaceholder = document.getElementById('ph-original');
    const dithPlaceholder = document.getElementById('ph-dithered');
    const statusBar     = document.getElementById('status-bar');
    const statusText    = document.getElementById('status-text');
    const stepDots      = document.querySelectorAll('.step');

    // ======== State ========
    const processor = new ImageProcessor();
    let gcodeResult = null;
    let processedCanvas = null;
    let parsedG25 = null;

    // #region agent log
    _dlog('init','DOMContentLoaded',{vizBox:!!document.getElementById('pixel-viz-box'),vizBody:!!document.getElementById('pixel-viz-body'),gcodeStats:!!document.getElementById('gcode-stats'),panelMain:!!document.querySelector('.panel-main')});
    // #endregion

    // ======== Helpers ========
    function getVal(id) { return parseFloat(document.getElementById(id).value); }
    function showStatus(msg) { statusText.textContent = msg; statusBar.classList.add('visible'); }
    function hideStatus() { statusBar.classList.remove('visible'); }
    function setStep(n, state) { const el = stepDots[n]; if (!el) return; el.classList.remove('active','done'); if (state) el.classList.add(state); }
    function resetSteps() { stepDots.forEach((_,i) => setStep(i,'')); }
    function activateStep(n) { for (let i=0;i<n;i++) setStep(i,'done'); setStep(n,'active'); }
    function tick(ms=0) { return new Promise(r => setTimeout(r, ms)); }

    // ======== Image Upload ========
    uploadArea.addEventListener('click', () => fileInput.click());
    uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
    uploadArea.addEventListener('drop', e => { e.preventDefault(); uploadArea.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

    async function handleFile(file) {
        if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
        showStatus('正在加载图片...');
        // #region agent log
        _dlog('handleFile','start',{fileName:file.name,type:file.type,size:file.size});
        // #endregion
        try {
            const img = await processor.loadImage(file);
            fileName.textContent = file.name;
            imageInfo.innerHTML = `<span class="tag">${img.width}×${img.height}px</span><span class="tag">${(file.size/1024).toFixed(1)}KB</span>`;
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            c.getContext('2d').drawImage(img, 0, 0);
            origPreview.innerHTML = ''; origPreview.appendChild(c); origPlaceholder.style.display = 'none';
            btnGenerate.disabled = false;
            updatePixelInfo();
            // #region agent log
            const vizBox = document.getElementById('pixel-viz-box');
            const gcodeCard = document.querySelector('.gcode-output');
            _dlog('handleFile','done',{imgW:img.width,imgH:img.height,vizBoxInDOM:!!vizBox,vizBoxDisplay:vizBox?.style?.display,vizBoxOffsetH:vizBox?.offsetHeight,gcodeCardInDOM:!!gcodeCard,gcodeCardOffsetH:gcodeCard?.offsetHeight,panelScrollH:document.querySelector('.panel-main')?.scrollHeight,panelClientH:document.querySelector('.panel-main')?.clientHeight});
            // #endregion
            hideStatus();
        } catch(e) {
            // #region agent log
            _dlog('handleFile','ERROR',{error:e.message,stack:e.stack});
            // #endregion
            alert('图片加载失败: '+e.message); hideStatus();
        }
    }

    function updatePixelInfo() {
        const infoEl = document.getElementById('pixel-info');
        if (!processor.originalImage) { infoEl.style.display='none'; return; }
        const origW = processor.originalImage.width, origH = processor.originalImage.height;
        const scaleEn = document.getElementById('param-scale-enable').checked;
        const scaleFactor = scaleEn ? getVal('param-scale-factor') : 1;
        const procW = Math.round(origW * scaleFactor), procH = Math.round(origH * scaleFactor);

        const dimMode = document.querySelector('input[name="dim-mode"]:checked').value;
        const targetDim = getVal('param-target-dim');
        let physW, physH;
        if (dimMode === 'width') { physW = targetDim; physH = targetDim * procH / procW; }
        else { physH = targetDim; physW = targetDim * procW / procH; }
        const pxW_mm = physW / procW;
        const pxH_mm = physH / procH;

        infoEl.style.display = '';
        infoEl.innerHTML = `
            <div style="display:flex;justify-content:space-between;"><span>原始像素:</span><strong>${origW} × ${origH}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span>处理后像素:</span><strong>${procW} × ${procH}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span>物理尺寸:</span><strong>${physW.toFixed(2)} × ${physH.toFixed(2)} mm</strong></div>
            <div style="display:flex;justify-content:space-between;"><span>像素物理大小:</span><strong>${(pxW_mm*1000).toFixed(1)} × ${(pxH_mm*1000).toFixed(1)} μm</strong></div>
            <div style="display:flex;justify-content:space-between;"><span>像素物理大小:</span><strong>${pxW_mm.toFixed(4)} × ${pxH_mm.toFixed(4)} mm</strong></div>`;
    }

    // live update pixel info
    ['param-target-dim','param-scale-factor'].forEach(id => {
        document.getElementById(id).addEventListener('input', updatePixelInfo);
    });
    document.querySelectorAll('input[name="dim-mode"]').forEach(r => r.addEventListener('change', updatePixelInfo));
    document.getElementById('param-scale-enable').addEventListener('change', updatePixelInfo);

    // ======== G-code Upload ========
    const gcodeUploadArea = document.getElementById('gcode-upload-area');
    const gcodeFileInput  = document.getElementById('gcode-file-input');
    const gcodeFileName   = document.getElementById('gcode-file-name');
    const gcodeInfo       = document.getElementById('gcode-info');

    gcodeUploadArea.addEventListener('click', () => gcodeFileInput.click());
    gcodeUploadArea.addEventListener('dragover', e => { e.preventDefault(); gcodeUploadArea.classList.add('dragover'); });
    gcodeUploadArea.addEventListener('dragleave', () => gcodeUploadArea.classList.remove('dragover'));
    gcodeUploadArea.addEventListener('drop', e => { e.preventDefault(); gcodeUploadArea.classList.remove('dragover'); if (e.dataTransfer.files.length) handleGcodeFile(e.dataTransfer.files[0]); });
    gcodeFileInput.addEventListener('change', () => { if (gcodeFileInput.files.length) handleGcodeFile(gcodeFileInput.files[0]); });

    async function handleGcodeFile(file) {
        const sizeMB = (file.size/1024/1024).toFixed(1);
        showStatus(`正在读取 G25 文件 (${sizeMB}MB)...`);
        try {
            const text = await file.text();
            showStatus(`正在解析 G25...`);
            await tick(50);
            parsedG25 = GCodeParser.parse(text, p => { statusText.textContent = `解析 G25... ${Math.round(p*100)}%`; });
            const imgSize = GCodeParser.getImageSize(parsedG25);
            gcodeFileName.textContent = `${file.name} (${sizeMB}MB)`;
            gcodeInfo.innerHTML = [
                `<span class="tag">${parsedG25.dots.length.toLocaleString()} 点</span>`,
                `<span class="tag">${parsedG25.yValues.length} 行</span>`,
                `<span class="tag">${imgSize.width.toFixed(2)}×${imgSize.height.toFixed(2)}mm</span>`,
            ].join('');

            showStatus('构建预览...');
            await tick(50);
            const matrix = GCodeParser.buildMatrix(parsedG25);
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = matrix.width; previewCanvas.height = matrix.height;
            const ctx = previewCanvas.getContext('2d');
            const imgData = ctx.createImageData(matrix.width, matrix.height);
            for (let i = 0; i < matrix.matrix.length; i++) {
                const v = matrix.matrix[i] ? 0 : 255;
                imgData.data[i*4]=v; imgData.data[i*4+1]=v; imgData.data[i*4+2]=v; imgData.data[i*4+3]=255;
            }
            ctx.putImageData(imgData, 0, 0);
            origPreview.innerHTML = ''; origPreview.appendChild(previewCanvas); origPlaceholder.style.display = 'none';
            btnGenerate.disabled = false;
            showStatus(`✅ G25 解析完成`); setTimeout(hideStatus, 3000);
        } catch(e) { console.error(e); alert('G25解析失败: '+e.message); hideStatus(); }
    }

    // ======== Generate ========
    btnGenerate.addEventListener('click', () => {
        const mode = document.querySelector('input[name="input-mode"]:checked').value;
        if (mode === 'gcode') runG25Pipeline(); else runPipeline();
    });

    // ======== Image Pipeline (pixel-by-pixel) ========
    async function runPipeline() {
        if (!processor.originalImage) { alert('请先上传图片'); return; }
        btnGenerate.disabled = true; btnDownload.disabled = true; btnDownloadImg.disabled = true;
        gcodeResult = null; processedCanvas = null; resetSteps();

        try {
            const dimMode     = document.querySelector('input[name="dim-mode"]:checked').value;
            const targetDim   = getVal('param-target-dim');
            const scaleEn     = document.getElementById('param-scale-enable').checked;
            const scaleFactor = scaleEn ? getVal('param-scale-factor') : 1;
            const invertEn    = document.getElementById('param-invert').checked;
            const binEn       = document.getElementById('param-bin-enable').checked;
            const binType     = document.getElementById('param-bin-type').value;
            const threshold   = getVal('param-threshold');
            const brightness  = getVal('param-brightness');
            const contrast    = getVal('param-contrast');
            const speed       = getVal('param-speed');
            const tp          = getVal('param-tp');
            const onDelay     = getVal('param-on-delay');
            const offDelay    = getVal('param-off-delay');
            const pmin        = getVal('param-pmin');
            const pmax        = getVal('param-pmax');
            const accel       = getVal('param-accel');
            const yJog        = getVal('param-yjog');
            const workW       = getVal('param-work-w');
            const workH       = getVal('param-work-h');
            const scanMode    = document.querySelector('input[name="scan-mode"]:checked').value;
            const spotX       = getVal('param-spot-x');
            const spotY       = getVal('param-spot-y');

            const origW = processor.originalImage.width;
            const origH = processor.originalImage.height;

            // ── Step 1: Upload done ──
            activateStep(0);
            showStatus('步骤 1/4: 图片已加载');
            await tick(200);

            // ── Step 2: Scale + Invert ──
            activateStep(1);
            let imgData, procW, procH;

            if (scaleEn && scaleFactor !== 1) {
                showStatus(`步骤 2/4: 等比缩放 ×${scaleFactor}...`);
                await tick(50);
                const scaled = processor.scaleImage(scaleFactor);
                imgData = scaled.imageData; procW = scaled.width; procH = scaled.height;
            } else {
                showStatus('步骤 2/4: 使用原始尺寸...');
                const orig = processor.getOriginalImageData();
                imgData = orig.imageData; procW = orig.width; procH = orig.height;
            }

            if (invertEn) {
                showStatus('步骤 2/4: 反色处理...');
                await tick(50);
                processor.invertImageData(imgData);
            }
            await tick(50);

            // Calculate physical dimensions
            let physW, physH;
            if (dimMode === 'width') { physW = targetDim; physH = targetDim * procH / procW; }
            else { physH = targetDim; physW = targetDim * procW / procH; }

            // ── Step 3: Binarization ──
            activateStep(2);
            let binaryImage;
            if (binEn) {
                const opts = { brightness, contrast };
                if (binType === 'jarvis') {
                    showStatus('步骤 3/4: Jarvis 抖动二值化...');
                    await tick(50);
                    const coefficients = {
                        r1: getVal('j-r1'), r2: getVal('j-r2'),
                        d1a: getVal('j-d1a'), d1b: getVal('j-d1b'), d1c: getVal('j-d1c'), d1d: getVal('j-d1d'), d1e: getVal('j-d1e'),
                        d2a: getVal('j-d2a'), d2b: getVal('j-d2b'), d2c: getVal('j-d2c'), d2d: getVal('j-d2d'), d2e: getVal('j-d2e'),
                    };
                    binaryImage = processor.jarvisDither(imgData, threshold, coefficients, opts, p => {
                        statusText.textContent = `步骤 3/4: Jarvis 抖动... ${Math.round(p*100)}%`;
                    });
                } else {
                    showStatus('步骤 3/4: 阈值二值化...');
                    await tick(50);
                    binaryImage = processor.thresholdBinarize(imgData, threshold, opts);
                }
            } else {
                showStatus('步骤 3/4: 跳过二值化（直接灰度阈值）...');
                await tick(50);
                binaryImage = processor.thresholdBinarize(imgData, threshold, { brightness: 0, contrast: 0 });
            }
            await tick(50);

            // Show processed preview
            processedCanvas = processor.ditheredToCanvas(binaryImage);
            dithPreview.innerHTML = ''; dithPreview.appendChild(processedCanvas); dithPlaceholder.style.display = 'none';

            // ── Step 4: Generate G-code ──
            activateStep(3);
            showStatus('步骤 4/4: 生成像素级 G-code...');
            await tick(50);

            const pixelW_mm = physW / procW;
            const pixelH_mm = physH / procH;

            const gen = new GCodeGenerator({
                speed, pulseTime: tp, onDelay, offDelay, pmin, pmax, accel, yJog, workW, workH, scanMode,
                density: 1/pixelH_mm, dpi: 25.4/pixelW_mm, spotX, spotY,
            });

            gcodeResult = gen.generate(binaryImage, physW, physH, p => {
                statusText.textContent = `步骤 4/4: G-code... ${Math.round(p*100)}%`;
            });
            await tick(50);

            // G-code stats
            const gcodeLines = gcodeResult.gcode.split('\n');
            gcodeStats.textContent = `${gcodeLines.length.toLocaleString()} 行 | ${(gcodeResult.gcode.length/1024).toFixed(1)} KB`;

            // Count black pixels
            let blackCount = 0;
            for (let i = 0; i < binaryImage.matrix.length; i++) if (binaryImage.matrix[i]) blackCount++;
            const totalDots = binaryImage.width * binaryImage.height;
            const fillRatio = (blackCount / totalDots * 100).toFixed(1);

            const overscanDist = (speed * speed / (2 * accel)).toFixed(2);
            const markLen = (speed * tp / 1000).toFixed(4);

            const infoItems = [
                ['📐 原始像素', `${origW} × ${origH} px`],
                ['🔍 处理后像素', `${procW} × ${procH} px (×${scaleFactor})`],
                ['📏 物理尺寸', `${physW.toFixed(2)} × ${physH.toFixed(2)} mm`],
                ['🔲 像素物理大小', `${pixelW_mm.toFixed(4)} × ${pixelH_mm.toFixed(4)} mm (${(pixelW_mm*1000).toFixed(1)} × ${(pixelH_mm*1000).toFixed(1)} μm)`],
                ['⬛ 出光像素', `${blackCount.toLocaleString()} / ${totalDots.toLocaleString()} (${fillRatio}%)`],
                ['💡 打点长度', `${markLen} mm (v×tp)`],
                ['📐 Overscan', `${overscanDist} mm`],
                ['↔️ 扫描模式', scanMode === 'bidirectional' ? '双向扫描' : '单向扫描'],
                ['⚠️ 强制关光', `${gcodeResult.forceCount} 像素 ${gcodeResult.forceCount > 0 ? '(打点超出像素边界)' : '(无)'}`],
                ['📄 G-code', `${gcodeLines.length.toLocaleString()} 行, ${(gcodeResult.gcode.length/1024).toFixed(1)} KB`],
            ];

            const detailCard = document.getElementById('image-detail-card');
            const detailContent = document.getElementById('image-detail-content');
            detailCard.style.display = 'block';
            detailContent.innerHTML = infoItems.map(([l,v]) =>
                `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(255,255,255,0.02);border-radius:6px;">` +
                `<span style="color:var(--text-secondary)">${l}</span>` +
                `<span style="color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:0.78rem">${v}</span></div>`
            ).join('');

            // ── Pixel Timing Visualization ──
            // #region agent log
            _dlog('pipeline','beforeDrawViz',{pixelW_mm,speed,tp,onDelay,offDelay,spotX});
            // #endregion
            try { drawPixelViz(pixelW_mm, speed, tp, onDelay, offDelay, spotX); } catch(vizErr) {
                // #region agent log
                _dlog('pipeline','vizError',{error:vizErr.message,stack:vizErr.stack});
                // #endregion
                console.error('drawPixelViz error:', vizErr);
            }

            // #region agent log
            _dlog('pipeline','afterDrawViz',{vizBodyChildren:document.getElementById('pixel-viz-body')?.children?.length,vizBoxDisplay:document.getElementById('pixel-viz-box')?.style?.display,vizBoxOffsetH:document.getElementById('pixel-viz-box')?.offsetHeight,detailCardDisplay:document.getElementById('image-detail-card')?.style?.display,gcodeStatsText:document.getElementById('gcode-stats')?.textContent});
            // #endregion

            // Done
            setStep(3, 'done');
            showStatus('✅ 处理完成！');
            btnDownload.disabled = false; btnDownloadImg.disabled = false;
            setTimeout(hideStatus, 3000);

        } catch(e) {
            // #region agent log
            _dlog('pipeline','PIPELINE_ERROR',{error:e.message,stack:e.stack});
            // #endregion
            console.error(e); alert('处理出错: '+e.message); hideStatus(); }
        btnGenerate.disabled = false;
    }

    // ======== ④ Pixel Timing Visualization ========
    function drawPixelViz(pixelW_mm, speed, tp, onDelay, offDelay, spotX_um) {
        // #region agent log
        _dlog('drawPixelViz','entry',{pixelW_mm,speed,tp,onDelay,offDelay,spotX_um});
        // #endregion
        const vizBody = document.getElementById('pixel-viz-body');
        const placeholder = document.getElementById('ph-pixel-viz');
        const infoDiv = document.getElementById('pixel-viz-info');
        // #region agent log
        _dlog('drawPixelViz','domCheck',{vizBody:!!vizBody,placeholder:!!placeholder,infoDiv:!!infoDiv,vizBoxOffsetH:document.getElementById('pixel-viz-box')?.offsetHeight});
        // #endregion

        const markLen     = speed * tp / 1000;            // mm  打点距离
        const onDist      = speed * onDelay / 1000;      // mm  开光延时距离
        const offDist     = speed * offDelay / 1000;      // mm  关光延时距离
        const spotR_mm    = spotX_um / 1000;              // spot diameter in mm
        const isForced    = (onDist + markLen + offDist) > pixelW_mm;
        const W = 800, H = isForced ? 420 : 250;

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(0, 0, W, H);

        const actOn = onDist;                                         // 实际开光点 = 像素起点 + 开光延时距离
        const normalOffCmd  = actOn + markLen;                        // 关光指令位置 = 实际开光点 + 打点距离
        const normalActOff  = actOn + markLen + offDist;              // 实际关光点 = 实际开光点 + 打点距离 + 关光延时距离
        const forceOffCmd   = Math.max(0, pixelW_mm - offDist);       // 强制关光指令 = 像素终点 - 关光延时距离
        const forceActOff   = Math.max(0, forceOffCmd) + offDist;     // 强制实际关光 ≈ 像素终点

        const margin = 60;
        const drawW = W - margin * 2;
        const maxExtent = Math.max(pixelW_mm, normalActOff + spotR_mm / 2, pixelW_mm + spotR_mm / 2) * 1.15;
        const scale = drawW / maxExtent;
        const toX = mm => margin + mm * scale;

        const scenarios = isForced ? ['normal', 'force'] : ['normal'];
        const rowH = isForced ? 120 : 200;

        scenarios.forEach((mode, si) => {
            const baseY = si * 160 + 58;
            const offCmd   = mode === 'force' ? forceOffCmd : normalOffCmd;
            const actOff   = mode === 'force' ? forceActOff : normalActOff;
            const label    = mode === 'force' ? '⚠️ 强制关光模式' : (isForced ? '❌ 正常模式 (超出像素)' : '✅ 正常模式');

            // Title + direction arrow
            ctx.fillStyle = mode === 'force' ? '#fbbf24' : (isForced ? '#ef4444' : '#22c55e');
            ctx.font = 'bold 13px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(label, margin, baseY - 18);

            // Movement direction arrow (L→R)
            const arrowY = baseY - 4;
            const arrowLeft = toX(pixelW_mm * 0.25);
            const arrowRight = toX(pixelW_mm * 0.75);
            ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(arrowLeft, arrowY); ctx.lineTo(arrowRight, arrowY); ctx.stroke();
            // arrowhead
            ctx.beginPath();
            ctx.moveTo(arrowRight, arrowY);
            ctx.lineTo(arrowRight - 6, arrowY - 4);
            ctx.lineTo(arrowRight - 6, arrowY + 4);
            ctx.closePath();
            ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px Inter, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('扫描方向 (L→R)', (arrowLeft + arrowRight) / 2, arrowY - 7);

            const lineY = baseY + 30;

            // Pixel boundary line (with arrowhead showing direction)
            ctx.strokeStyle = '#555'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(toX(0), lineY); ctx.lineTo(toX(pixelW_mm), lineY); ctx.stroke();
            // small arrowhead at pixel end
            ctx.beginPath();
            ctx.moveTo(toX(pixelW_mm), lineY);
            ctx.lineTo(toX(pixelW_mm) - 8, lineY - 5);
            ctx.lineTo(toX(pixelW_mm) - 8, lineY + 5);
            ctx.closePath();
            ctx.fillStyle = '#555'; ctx.fill();

            // Pixel boundary markers
            ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
            [0, pixelW_mm].forEach(mm => {
                ctx.beginPath(); ctx.moveTo(toX(mm), lineY - 20); ctx.lineTo(toX(mm), lineY + 20); ctx.stroke();
            });
            ctx.fillStyle = '#aaa'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'center';
            ctx.fillText('像素起点 (左)', toX(0), lineY + 35);
            ctx.fillText('像素终点 (右)', toX(pixelW_mm), lineY + 35);
            ctx.fillText(`${pixelW_mm.toFixed(4)}mm`, toX(pixelW_mm / 2), lineY + 48);

            // Actual laser mark (green bar)
            const markStart = actOn;
            const markEnd   = actOff;
            ctx.fillStyle = 'rgba(34, 197, 94, 0.3)';
            ctx.fillRect(toX(markStart), lineY - 12, (markEnd - markStart) * scale, 24);
            ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
            ctx.strokeRect(toX(markStart), lineY - 12, (markEnd - markStart) * scale, 24);

            // Spot at actual ON
            ctx.fillStyle = 'rgba(239, 68, 68, 0.35)';
            const spotPx = spotR_mm * scale;
            ctx.fillRect(toX(actOn) - spotPx/2, lineY - 8, spotPx, 16);
            ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1;
            ctx.strokeRect(toX(actOn) - spotPx/2, lineY - 8, spotPx, 16);

            // Spot at actual OFF
            ctx.fillStyle = 'rgba(59, 130, 246, 0.35)';
            ctx.fillRect(toX(actOff) - spotPx/2, lineY - 8, spotPx, 16);
            ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1;
            ctx.strokeRect(toX(actOff) - spotPx/2, lineY - 8, spotPx, 16);

            // Command markers (triangles) — L→R: 开光 near start, 关光 near end
            // 开光指令 at pixel start
            drawTriangle(ctx, toX(0), lineY - 22, '#ef4444', '▼');
            ctx.fillStyle = '#ef4444'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center';
            ctx.fillText('开光指令', toX(0), lineY - 30);

            // 实际开光点 (after on-delay)
            drawTriangle(ctx, toX(actOn), lineY - 22, '#f97316', '▼');
            ctx.fillStyle = '#f97316'; ctx.font = '9px JetBrains Mono, monospace';
            ctx.fillText('实际开光', toX(actOn), lineY - 30);

            // 关光指令
            const offCmdColor = (mode === 'normal' && isForced) ? '#ef4444' : '#3b82f6';
            drawTriangle(ctx, toX(offCmd), lineY - 22, offCmdColor, '▼');
            ctx.fillStyle = offCmdColor; ctx.font = '9px JetBrains Mono, monospace';
            ctx.fillText('关光指令', toX(offCmd), lineY - 42);

            // 实际关光点 (after off-delay)
            drawTriangle(ctx, toX(actOff), lineY + 22, '#8b5cf6', '▲');
            ctx.fillStyle = '#8b5cf6'; ctx.font = '9px JetBrains Mono, monospace';
            ctx.fillText('实际关光', toX(actOff), lineY + 58);

            // Distance from actual OFF to pixel end
            const gapToEnd = pixelW_mm - actOff;
            const gapMidX = (toX(actOff) + toX(pixelW_mm)) / 2;
            if (Math.abs(gapToEnd) > 1e-6) {
                // draw dimension line between actual OFF and pixel end
                const dimY = lineY + 72;
                ctx.strokeStyle = gapToEnd > 0 ? '#22c55e' : '#ef4444'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
                ctx.beginPath(); ctx.moveTo(toX(actOff), dimY); ctx.lineTo(toX(pixelW_mm), dimY); ctx.stroke();
                ctx.setLineDash([]);
                // end ticks
                ctx.beginPath(); ctx.moveTo(toX(actOff), dimY - 4); ctx.lineTo(toX(actOff), dimY + 4); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(toX(pixelW_mm), dimY - 4); ctx.lineTo(toX(pixelW_mm), dimY + 4); ctx.stroke();
                // label
                ctx.fillStyle = gapToEnd > 0 ? '#22c55e' : '#ef4444';
                ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center';
                const gapLabel = gapToEnd > 0
                    ? `余量 ${gapToEnd.toFixed(4)}mm`
                    : `超出 ${Math.abs(gapToEnd).toFixed(4)}mm`;
                ctx.fillText(gapLabel, gapMidX, dimY - 6);
            } else {
                ctx.fillStyle = '#fbbf24'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center';
                ctx.fillText('关光点=像素终点', gapMidX, lineY + 72);
            }

            // If normal mode exceeds pixel, draw red line beyond pixel boundary
            if (mode === 'normal' && isForced) {
                ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.setLineDash([4,4]);
                ctx.beginPath(); ctx.moveTo(toX(pixelW_mm), lineY); ctx.lineTo(toX(Math.min(actOff, maxExtent)), lineY); ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = '#ef4444'; ctx.font = '9px JetBrains Mono, monospace';
                ctx.fillText('超出像素!', toX(Math.min(actOff, maxExtent)), lineY - 5);
            }
        });

        // Info text
        const totalMark = markLen + offDist;
        const lines = [
            `像素宽度: ${pixelW_mm.toFixed(4)}mm | 打点距离: ${markLen.toFixed(4)}mm | 开光延时: ${onDist.toFixed(4)}mm | 关光延时: ${offDist.toFixed(4)}mm | 光斑X: ${spotR_mm.toFixed(4)}mm`,
            `实际开光 = 像素起点+${onDist.toFixed(4)}mm | 实际关光 = 实际开光+${(markLen+offDist).toFixed(4)}mm(打点+关光延时) | 距像素终点: ${(pixelW_mm - normalActOff).toFixed(4)}mm`,
        ];
        if (isForced) lines.push(`⚠️ 实际关光(${normalActOff.toFixed(4)}mm) > 像素宽度(${pixelW_mm.toFixed(4)}mm) → 强制关光模式激活`);
        infoDiv.innerHTML = lines.join('<br>');

        // Insert canvas as an image into the preview body
        vizBody.innerHTML = '';
        const img = new Image();
        img.src = canvas.toDataURL('image/png');
        img.style.cssText = 'max-width:100%;display:block;border-radius:8px;';
        vizBody.appendChild(img);
        if (placeholder) placeholder.style.display = 'none';

        const vizBox = document.getElementById('pixel-viz-box');
        vizBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // #region agent log
        _dlog('drawPixelViz','done',{vizBodyChildCount:vizBody.children.length,imgSrc:img.src.substring(0,40),vizBoxOffsetH:vizBox.offsetHeight,vizBoxBCR:JSON.stringify(vizBox.getBoundingClientRect())});
        // #endregion
    }

    function drawTriangle(ctx, x, y, color, dir) {
        ctx.fillStyle = color;
        ctx.beginPath();
        if (dir === '▼') { ctx.moveTo(x-4, y-6); ctx.lineTo(x+4, y-6); ctx.lineTo(x, y); }
        else { ctx.moveTo(x-4, y+6); ctx.lineTo(x+4, y+6); ctx.lineTo(x, y); }
        ctx.fill();
    }

    // ======== G25 Pipeline (kept) ========
    async function runG25Pipeline() {
        if (!parsedG25) { alert('请先上传 G25 文件'); return; }
        btnGenerate.disabled = true; btnDownload.disabled = true; btnDownloadImg.disabled = true;
        gcodeResult = null; processedCanvas = null; resetSteps();

        try {
            const speed = getVal('param-speed');
            const tp = getVal('param-tp');
            const onDelay = getVal('param-on-delay');
            const offDelay = getVal('param-off-delay');
            const pmin = getVal('param-pmin');
            const pmax = getVal('param-pmax');
            const accel = getVal('param-accel');
            const yJog = getVal('param-yjog');
            const workW = getVal('param-work-w');
            const workH = getVal('param-work-h');
            const scanMode = document.querySelector('input[name="scan-mode"]:checked').value;
            const spotX = getVal('param-spot-x');
            const spotY = getVal('param-spot-y');

            activateStep(0);
            showStatus(`步骤 1/3: G25 已解析`);
            await tick(200);

            activateStep(1);
            showStatus('步骤 2/3: 预览...');
            await tick(50);
            const previewMatrix = GCodeParser.buildMatrix(parsedG25);
            const previewCanvas = document.createElement('canvas');
            previewCanvas.width = previewMatrix.width; previewCanvas.height = previewMatrix.height;
            const pctx = previewCanvas.getContext('2d');
            const pImgData = pctx.createImageData(previewMatrix.width, previewMatrix.height);
            for (let i = 0; i < previewMatrix.matrix.length; i++) {
                const v = previewMatrix.matrix[i] ? 0 : 255;
                pImgData.data[i*4]=v; pImgData.data[i*4+1]=v; pImgData.data[i*4+2]=v; pImgData.data[i*4+3]=255;
            }
            pctx.putImageData(pImgData, 0, 0);
            processedCanvas = previewCanvas;
            dithPreview.innerHTML = ''; dithPreview.appendChild(processedCanvas); dithPlaceholder.style.display = 'none';
            await tick(50);

            activateStep(2);
            showStatus('步骤 3/3: 生成 G1...');
            await tick(50);

            const xPitchMM = parsedG25.xPitch;
            const yPitchMM = parsedG25.yPitch;
            const rho = 1.0 / yPitchMM;
            const dpi = 25.4 / xPitchMM;

            const gen = new GCodeGenerator({
                speed, pulseTime: tp, onDelay, offDelay, pmin, pmax, accel, yJog, workW, workH, scanMode,
                density: rho, dpi, spotX, spotY,
            });

            gcodeResult = gen.generateFromDots(parsedG25.dots, parsedG25.bounds, p => {
                statusText.textContent = `生成 G1... ${Math.round(p*100)}%`;
            });
            await tick(50);

            const gcodeLines = gcodeResult.gcode.split('\n');
            gcodeStats.textContent = `${gcodeLines.length.toLocaleString()} 行 | ${(gcodeResult.gcode.length/1024).toFixed(1)} KB`;

            const imgW = gcodeResult.imgW_mm, imgH = gcodeResult.imgH_mm;
            const infoItems = [
                ['📥 转换模式', 'G25 → G1'],
                ['📄 G25 点数', `${parsedG25.dots.length.toLocaleString()}`],
                ['⬛ 出光点', `${gcodeResult.dotCount.toLocaleString()}`],
                ['📏 扫描行数', `${gcodeResult.rowCount}`],
                ['📐 尺寸', `${imgW.toFixed(2)} × ${imgH.toFixed(2)} mm`],
                ['↔️ 扫描模式', scanMode === 'bidirectional' ? '双向扫描' : '单向扫描'],
                ['📄 G-code', `${gcodeLines.length.toLocaleString()} 行`],
            ];

            const detailCard = document.getElementById('image-detail-card');
            const detailContent = document.getElementById('image-detail-content');
            detailCard.style.display = 'block';
            detailContent.innerHTML = infoItems.map(([l,v]) =>
                `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(255,255,255,0.02);border-radius:6px;">` +
                `<span style="color:var(--text-secondary)">${l}</span>` +
                `<span style="color:var(--accent);font-family:'JetBrains Mono',monospace;font-size:0.78rem">${v}</span></div>`
            ).join('');

            setStep(2, 'done');
            showStatus('✅ G25 → G1 转换完成！');
            btnDownload.disabled = false; btnDownloadImg.disabled = false;
            setTimeout(hideStatus, 3000);
        } catch(e) { console.error(e); alert('G25转换出错: '+e.message); hideStatus(); }
        btnGenerate.disabled = false;
    }

    // ======== Downloads ========
    btnDownload.addEventListener('click', () => {
        if (!gcodeResult) return;
        const blob = new Blob([gcodeResult.gcode], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const pad = n => String(n).padStart(2,'0');
        a.download = `gcode_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.gcode`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    btnDownloadImg.addEventListener('click', () => {
        if (!processedCanvas) return;
        processedCanvas.toBlob(blob => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const now = new Date();
            const pad = n => String(n).padStart(2,'0');
            a.download = `processed_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.png`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 'image/png');
    });
});
