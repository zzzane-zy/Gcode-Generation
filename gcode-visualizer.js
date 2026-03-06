/**
 * gcode-visualizer.js
 * Renders G-code scan paths on canvas with a draggable 10mm×10mm inspector box.
 */

class GCodeVisualizer {
    /**
     * @param {HTMLCanvasElement} mainCanvas   - full work-area canvas
     * @param {HTMLCanvasElement} zoomCanvas   - zoomed inspector canvas
     * @param {number} workW  - work area width  (mm)
     * @param {number} workH  - work area height (mm)
     */
    constructor(mainCanvas, zoomCanvas, workW, workH) {
        this.mainCanvas = mainCanvas;
        this.zoomCanvas = zoomCanvas;
        this.workW = workW;
        this.workH = workH;
        this.segments = [];
        this.ditheredCanvas = null;
        this.imgOffX = 0;
        this.imgOffY = 0;
        this.imgW_mm = 0;
        this.imgH_mm = 0;

        // Inspector box position (mm) – center
        this.inspX = workW / 2;
        this.inspY = workH / 2;
        this.inspSize = 10; // mm

        // Canvas sizing
        this.scale = 1;
        this.dragging = false;

        this._setupInteraction();
    }

    /** Set data for rendering */
    setData(segments, ditheredCanvas, imgW_mm, imgH_mm, imgOffX, imgOffY) {
        this.segments = segments;
        this.ditheredCanvas = ditheredCanvas;
        this.imgW_mm = imgW_mm;
        this.imgH_mm = imgH_mm;
        this.imgOffX = imgOffX;
        this.imgOffY = imgOffY;
    }

    /** Fit canvas to container and draw everything */
    render() {
        const container = this.mainCanvas.parentElement;
        const maxW = container.clientWidth - 24;
        const maxH = 500;
        const scaleX = maxW / this.workW;
        const scaleY = maxH / this.workH;
        this.scale = Math.min(scaleX, scaleY, 2.5);

        const cw = Math.round(this.workW * this.scale);
        const ch = Math.round(this.workH * this.scale);
        this.mainCanvas.width = cw;
        this.mainCanvas.height = ch;

        const ctx = this.mainCanvas.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);

        // Background – work area
        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(0, 0, cw, ch);

        // Grid lines every 10mm
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let x = 0; x <= this.workW; x += 10) {
            const px = x * this.scale;
            ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ch); ctx.stroke();
        }
        for (let y = 0; y <= this.workH; y += 10) {
            const py = y * this.scale;
            ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(cw, py); ctx.stroke();
        }

        // Draw dithered image
        if (this.ditheredCanvas) {
            const dx = this.imgOffX * this.scale;
            const dy = this.imgOffY * this.scale;
            const dw = this.imgW_mm * this.scale;
            const dh = this.imgH_mm * this.scale;
            ctx.globalAlpha = 0.25;
            ctx.drawImage(this.ditheredCanvas, dx, dy, dw, dh);
            ctx.globalAlpha = 1;

            // Image border
            ctx.strokeStyle = 'rgba(0, 212, 255, 0.3)';
            ctx.lineWidth = 1;
            ctx.strokeRect(dx, dy, dw, dh);
        }

        // Draw G-code segments
        this._drawSegments(ctx, this.scale, 0, 0, this.workW, this.workH);

        // Draw center crosshair
        const cx = this.workW / 2 * this.scale;
        const cy = this.workH / 2 * this.scale;
        ctx.strokeStyle = 'rgba(255, 100, 100, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, ch); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(cw, cy); ctx.stroke();
        ctx.setLineDash([]);

        // Draw inspector box
        this._drawInspector(ctx);

        // Render zoom view
        this._renderZoom();
    }

    /** Draw G-code segments (clipped to viewBox if provided) */
    _drawSegments(ctx, scale, vx, vy, vw, vh) {
        for (const seg of this.segments) {
            if (seg.y < vy || seg.y > vy + vh) continue;
            const minX = Math.min(seg.x1, seg.x2);
            const maxX = Math.max(seg.x1, seg.x2);
            if (maxX < vx || minX > vx + vw) continue;

            const x1 = (seg.x1 - vx) * scale;
            const x2 = (seg.x2 - vx) * scale;
            const y = (seg.y - vy) * scale;

            ctx.beginPath();
            ctx.moveTo(x1, y);
            ctx.lineTo(x2, y);
            if (seg.power > 0) {
                ctx.strokeStyle = '#00ff87';
                ctx.lineWidth = Math.max(1, scale / this.workW * 2);
                ctx.globalAlpha = 0.85;
            } else {
                ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                ctx.lineWidth = 0.5;
                ctx.globalAlpha = 0.3;
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }

    /** Draw the 10mm inspector box */
    _drawInspector(ctx) {
        const s = this.scale;
        const half = this.inspSize / 2;
        const x = (this.inspX - half) * s;
        const y = (this.inspY - half) * s;
        const w = this.inspSize * s;
        const h = this.inspSize * s;

        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);

        // Corner markers
        const m = 6;
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        // Top-left
        ctx.beginPath(); ctx.moveTo(x, y + m); ctx.lineTo(x, y); ctx.lineTo(x + m, y); ctx.stroke();
        // Top-right
        ctx.beginPath(); ctx.moveTo(x + w - m, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + m); ctx.stroke();
        // Bottom-left
        ctx.beginPath(); ctx.moveTo(x, y + h - m); ctx.lineTo(x, y + h); ctx.lineTo(x + m, y + h); ctx.stroke();
        // Bottom-right
        ctx.beginPath(); ctx.moveTo(x + w - m, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - m); ctx.stroke();

        // Label
        ctx.fillStyle = '#ff6b6b';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(`${this.inspSize}×${this.inspSize}mm`, x + 2, y - 4);
    }

    /** Render zoomed inspector view */
    _renderZoom() {
        const zoomPx = 256;
        this.zoomCanvas.width = zoomPx;
        this.zoomCanvas.height = zoomPx;
        const ctx = this.zoomCanvas.getContext('2d');

        const half = this.inspSize / 2;
        const vx = this.inspX - half;
        const vy = this.inspY - half;
        const zoomScale = zoomPx / this.inspSize;

        // Background
        ctx.fillStyle = '#060612';
        ctx.fillRect(0, 0, zoomPx, zoomPx);

        // Grid lines every 1mm
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= this.inspSize; i++) {
            const p = i * zoomScale;
            ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, zoomPx); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(zoomPx, p); ctx.stroke();
        }

        // Draw dithered image in zoom
        if (this.ditheredCanvas) {
            const dx = (this.imgOffX - vx) * zoomScale;
            const dy = (this.imgOffY - vy) * zoomScale;
            const dw = this.imgW_mm * zoomScale;
            const dh = this.imgH_mm * zoomScale;
            ctx.globalAlpha = 0.2;
            ctx.drawImage(this.ditheredCanvas, dx, dy, dw, dh);
            ctx.globalAlpha = 1;
        }

        // Draw segments in zoom view
        this._drawSegments(ctx, zoomScale, vx, vy, this.inspSize, this.inspSize);

        // Border
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, zoomPx, zoomPx);

        // Coordinate labels
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px JetBrains Mono, monospace';
        ctx.fillText(`(${vx.toFixed(1)}, ${vy.toFixed(1)})`, 4, 12);
        ctx.fillText(`(${(vx + this.inspSize).toFixed(1)}, ${(vy + this.inspSize).toFixed(1)})`, zoomPx - 80, zoomPx - 4);
    }

    /** Setup mouse drag interaction on main canvas */
    _setupInteraction() {
        const cvs = this.mainCanvas;

        cvs.addEventListener('mousedown', (e) => {
            const rect = cvs.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / this.scale;
            const my = (e.clientY - rect.top) / this.scale;
            const half = this.inspSize / 2;
            if (mx >= this.inspX - half && mx <= this.inspX + half &&
                my >= this.inspY - half && my <= this.inspY + half) {
                this.dragging = true;
                this.dragOffX = mx - this.inspX;
                this.dragOffY = my - this.inspY;
            }
        });

        cvs.addEventListener('mousemove', (e) => {
            if (!this.dragging) return;
            const rect = cvs.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / this.scale;
            const my = (e.clientY - rect.top) / this.scale;
            const half = this.inspSize / 2;
            this.inspX = Math.max(half, Math.min(this.workW - half, mx - this.dragOffX));
            this.inspY = Math.max(half, Math.min(this.workH - half, my - this.dragOffY));
            this.render();
        });

        const stopDrag = () => { this.dragging = false; };
        cvs.addEventListener('mouseup', stopDrag);
        cvs.addEventListener('mouseleave', stopDrag);

        // Click to move inspector center
        cvs.addEventListener('dblclick', (e) => {
            const rect = cvs.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / this.scale;
            const my = (e.clientY - rect.top) / this.scale;
            const half = this.inspSize / 2;
            this.inspX = Math.max(half, Math.min(this.workW - half, mx));
            this.inspY = Math.max(half, Math.min(this.workH - half, my));
            this.render();
        });
    }

    /** Update work area dimensions and re-render */
    updateWorkArea(w, h) {
        this.workW = w;
        this.workH = h;
        this.inspX = Math.min(this.inspX, w - this.inspSize / 2);
        this.inspY = Math.min(this.inspY, h - this.inspSize / 2);
    }
}
