/**
 * gcode-generator.js
 * Pixel-by-pixel laser G-code generator.
 *
 * Strategy: each binary pixel is individually controlled.
 *   - Laser ON at pixel left edge (L→R) or right edge (R→L)
 *   - Laser OFF at ON + v·tp  (normal mode)
 *   - If OFF exceeds pixel boundary → forced OFF at boundary − v·t_off
 *
 * Keeps: overscan, y-jog backlash, JS002 header, work-area centering.
 */

class GCodeGenerator {
    constructor(p) {
        this.v       = p.speed;            // mm/s
        this.tp      = p.pulseTime;        // ms  打点时长
        this.onDelay = p.onDelay  || 0;    // ms  开光延时
        this.offDelay= p.offDelay || 0;    // ms  关光延时
        this.pmin    = p.pmin;             // S min (off)
        this.pmax    = p.pmax;             // S max (on)
        this.a       = p.accel || 1000;    // mm/s²
        this.yJog    = p.yJog  || 0;       // mm
        this.workW   = p.workW;            // mm
        this.workH   = p.workH;            // mm
        this.scanMode= p.scanMode || 'bidirectional';

        // kept for header/generateFromDots compat
        this.rho     = p.density  || 10;
        this.dpi     = p.dpi      || 254;
        this.spotX   = p.spotX    || 0;    // μm
        this.spotY   = p.spotY    || 0;    // μm
    }

    /* ────────────────── pixel-by-pixel generate ────────────────── */

    /**
     * @param {Object} bin   – { matrix: Uint8Array, width, height }  (1 = on)
     * @param {number} imgW_mm  physical output width
     * @param {number} imgH_mm  physical output height
     * @returns {{ gcode, segments, pixelW, pixelH, forceCount }}
     */
    generate(bin, imgW_mm, imgH_mm, onProgress) {
        const { matrix, width, height } = bin;
        const pixelW   = imgW_mm / width;
        const pixelH   = imgH_mm / height;
        const feedRate  = Math.round(this.v * 60);
        const overscan  = (this.v * this.v) / (2 * this.a);

        const xOff = this.workW / 2 - imgW_mm / 2;
        const yOff = this.workH / 2 - imgH_mm / 2;
        const osL  = xOff - overscan;
        const osR  = xOff + imgW_mm + overscan;

        const markLen    = this.v * this.tp    / 1000;   // normal mark distance
        const offComp    = this.v * this.offDelay / 1000; // off-delay compensation

        const out = [];
        const segs = [];
        let   curS = 0, firstLine = true, lineIdx = 0, forceCount = 0;

        out.push(...this._header(feedRate));

        // any content?
        let hasAny = false;
        for (let i = 0; i < matrix.length; i++) { if (matrix[i]) { hasAny = true; break; } }
        if (!hasAny) { out.push('', ...this._footer()); return { gcode: out.join('\n'), segments: segs, pixelW, pixelH, forceCount }; }

        out.push(`G1F${feedRate}S0`);

        for (let row = 0; row < height; row++) {
            const y = yOff + (row + 0.5) * pixelH;
            const rev = this.scanMode === 'bidirectional' ? (lineIdx & 1) === 1 : false;

            // skip empty rows
            let empty = true;
            for (let c = 0; c < width; c++) if (matrix[row * width + c]) { empty = false; break; }
            if (empty) continue;

            // ── position ──
            if (firstLine) {
                out.push(`G0X${(rev ? osR : osL).toFixed(3)}Y${y.toFixed(3)}`);
                out.push(`G0Z26.980`);
                firstLine = false;
            } else {
                if (curS !== 0) {
                    curS = 0;
                    if (this.yJog > 0) { out.push(`G1Y${(y + this.yJog).toFixed(3)}S0`); out.push(`G1Y${y.toFixed(3)}`); }
                    else out.push(`G1Y${y.toFixed(3)}S0`);
                } else {
                    if (this.yJog > 0) { out.push(`G1Y${(y + this.yJog).toFixed(3)}`); out.push(`G1Y${y.toFixed(3)}`); }
                    else out.push(`G1Y${y.toFixed(3)}`);
                }
            }

            // ── scan pixels ──
            if (rev) {
                let curX = osR;
                for (let c = width - 1; c >= 0; c--) {
                    if (!matrix[row * width + c]) continue;
                    const pR = xOff + (c + 1) * pixelW;
                    const pL = xOff + c * pixelW;

                    if (Math.abs(curX - pR) > 0.0005) {
                        out.push(this._g1x(pR, curS, 0));
                        segs.push({ x1: curX, x2: pR, y, power: 0 });
                        curS = 0; curX = pR;
                    }

                    let offCmd = pR - markLen;
                    if (offCmd < pL) { offCmd = pL + offComp; if (offCmd > pR) offCmd = pR; forceCount++; }

                    out.push(this._g1x(offCmd, curS, this.pmax));
                    segs.push({ x1: pR, x2: offCmd, y, power: this.pmax });
                    curS = this.pmax; curX = offCmd;
                }
                if (Math.abs(curX - osL) > 0.0005) {
                    out.push(this._g1x(osL, curS, 0));
                    segs.push({ x1: curX, x2: osL, y, power: 0 });
                    curS = 0;
                }
            } else {
                let curX = osL;
                for (let c = 0; c < width; c++) {
                    if (!matrix[row * width + c]) continue;
                    const pL = xOff + c * pixelW;
                    const pR = xOff + (c + 1) * pixelW;

                    if (Math.abs(curX - pL) > 0.0005) {
                        out.push(this._g1x(pL, curS, 0));
                        segs.push({ x1: curX, x2: pL, y, power: 0 });
                        curS = 0; curX = pL;
                    }

                    let offCmd = pL + markLen;
                    if (offCmd > pR) { offCmd = pR - offComp; if (offCmd < pL) offCmd = pL; forceCount++; }

                    out.push(this._g1x(offCmd, curS, this.pmax));
                    segs.push({ x1: pL, x2: offCmd, y, power: this.pmax });
                    curS = this.pmax; curX = offCmd;
                }
                if (Math.abs(curX - osR) > 0.0005) {
                    out.push(this._g1x(osR, curS, 0));
                    segs.push({ x1: curX, x2: osR, y, power: 0 });
                    curS = 0;
                }
                if (this.scanMode === 'unidirectional') {
                    out.push(this._g1x(osL, curS, 0));
                    segs.push({ x1: osR, x2: osL, y, power: 0 });
                    curS = 0;
                }
            }

            lineIdx++;
            if (onProgress && row % 20 === 0) onProgress(row / height);
        }

        out.push('', ...this._footer());
        return { gcode: out.join('\n'), segments: segs, pixelW, pixelH, forceCount };
    }

    /* ────────── helpers (unchanged) ────────── */

    _g1x(x, curS, newS) {
        return newS !== curS ? `G1X${x.toFixed(3)}S${newS}` : `G1X${x.toFixed(3)}`;
    }

    _header(feedRate) {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const ds = `${now.getFullYear()}_${pad(now.getMonth()+1)}_${pad(now.getDate())}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;
        return [
            `# date=${ds}`,
            `# version=1.5.7-pr2-b5-cos-0210-3`,
            `# algorithmVersion=1.5.5-alpha`,
            `# gc={"size":{"w":${this.workW},"h":${this.workH}}}`,
            `# gc={"offset":{"x":0,"y":0}}`,
            `# gc={"start":{"x":0,"y":0.0000}}`,
            `# gc={"keys":["x","y"],"rm":1,"is3DMode":false}`,
            `# timeConfig=`,
            `G90`, `G0 F3000`, ``,
            `# JS002 HEAD`,
            `M1001 S1P0A150B30`,
            `G0 X0 Y0 U0 F18000`,
            `M9064 B3`, `G198 P78 "M9064 B3"`,
            `M9039 C3`, `G198 P76 "M9039 V35"`,
            `G198 P76 "M9043 H1 I1 J1 K194 L1 M1"`, ``,
            `# JS002 BITMAP HEAD`,
            `# motion_start`,
            `M1002 S0P3`,
            `M32 X2300Y2300`,
            `# blockConfig={"powerFactor":${(this.pmax/1000).toFixed(1)},"density":"${this.rho.toFixed(2)}","power":[${this.pmin},${this.pmax}],"bitmapMode":"pixel-by-pixel"}`,
            ``,
        ];
    }

    _footer() {
        return [ `# JS002 END`, `G1 Z0 F1200 S0`, `G1 X0 Y0 U0 F18000` ];
    }

    /* ────────── G25 dot mode (kept as-is) ────────── */

    generateFromDots(dots, bounds, onProgress) {
        const feedRate = Math.round(this.v * 60);
        const overscan = (this.v * this.v) / (2 * this.a);
        const delayDist = this.v * this.onDelay / 1000;
        const pulseW = this.v * this.tp / 1000;

        const imgW_mm = bounds.maxX - bounds.minX;
        const imgH_mm = bounds.maxY - bounds.minY;
        const xShift = (this.workW / 2) - (bounds.minX + imgW_mm / 2);
        const yShift = (this.workH / 2) - (bounds.minY + imgH_mm / 2);

        const imgLeft = bounds.minX + xShift;
        const imgRight = bounds.maxX + xShift;
        const overscanLeft = imgLeft - overscan;
        const overscanRight = imgRight + overscan;

        const rowMap = new Map();
        let activeDots = 0;
        for (const d of dots) {
            if (d.s <= 0) continue;
            activeDots++;
            const yKey = d.y.toFixed(6);
            if (!rowMap.has(yKey)) rowMap.set(yKey, []);
            rowMap.get(yKey).push(d);
        }
        const sortedYKeys = [...rowMap.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));

        const out = [];
        const vizSegments = [];
        out.push(...this._header(feedRate));
        out.push(`G1F${feedRate}S0`);
        let currentS = 0, isFirstLine = true, lineIndex = 0;

        for (let ri = 0; ri < sortedYKeys.length; ri++) {
            const yKey = sortedYKeys[ri];
            const rowDots = rowMap.get(yKey);
            const y = parseFloat(yKey) + yShift;
            const isReverse = this.scanMode === 'bidirectional' ? (lineIndex % 2 === 1) : false;
            rowDots.sort((a, b) => a.x - b.x);

            const rawRuns = [];
            for (const d of rowDots) {
                const dotX = d.x + xShift;
                const comp = isReverse ? -delayDist : delayDist;
                rawRuns.push({ x1: dotX + comp, x2: dotX + pulseW + comp });
            }
            const runs = [];
            if (rawRuns.length > 0) {
                let cur = { ...rawRuns[0] };
                for (let i = 1; i < rawRuns.length; i++) {
                    if (rawRuns[i].x1 <= cur.x2 + 0.0001) cur.x2 = Math.max(cur.x2, rawRuns[i].x2);
                    else { runs.push(cur); cur = { ...rawRuns[i] }; }
                }
                runs.push(cur);
            }
            if (runs.length === 0) continue;

            if (isFirstLine) {
                out.push(`G0X${(isReverse ? overscanRight : overscanLeft).toFixed(3)}Y${y.toFixed(3)}`);
                out.push(`G0Z26.980`);
                isFirstLine = false;
            } else {
                if (currentS !== 0) { currentS = 0; if (this.yJog > 0) { out.push(`G1Y${(y+this.yJog).toFixed(3)}S0`); out.push(`G1Y${y.toFixed(3)}`); } else out.push(`G1Y${y.toFixed(3)}S0`); }
                else { if (this.yJog > 0) { out.push(`G1Y${(y+this.yJog).toFixed(3)}`); out.push(`G1Y${y.toFixed(3)}`); } else out.push(`G1Y${y.toFixed(3)}`); }
            }

            if (isReverse) {
                const sorted = [...runs].sort((a, b) => b.x2 - a.x2);
                let curX = overscanRight;
                for (const seg of sorted) {
                    if (Math.abs(curX - seg.x2) > 0.0005) { out.push(this._g1x(seg.x2, currentS, 0)); vizSegments.push({x1:curX,x2:seg.x2,y,power:0}); currentS=0; curX=seg.x2; }
                    out.push(this._g1x(seg.x1, currentS, this.pmax)); vizSegments.push({x1:seg.x2,x2:seg.x1,y,power:this.pmax}); currentS=this.pmax; curX=seg.x1;
                }
                if (Math.abs(curX-overscanLeft)>0.0005) { out.push(this._g1x(overscanLeft,currentS,0)); vizSegments.push({x1:curX,x2:overscanLeft,y,power:0}); currentS=0; }
            } else {
                const sorted = [...runs].sort((a, b) => a.x1 - b.x1);
                let curX = overscanLeft;
                for (const seg of sorted) {
                    if (Math.abs(curX-seg.x1)>0.0005) { out.push(this._g1x(seg.x1,currentS,0)); vizSegments.push({x1:curX,x2:seg.x1,y,power:0}); currentS=0; curX=seg.x1; }
                    out.push(this._g1x(seg.x2,currentS,this.pmax)); vizSegments.push({x1:seg.x1,x2:seg.x2,y,power:this.pmax}); currentS=this.pmax; curX=seg.x2;
                }
                if (Math.abs(curX-overscanRight)>0.0005) { out.push(this._g1x(overscanRight,currentS,0)); vizSegments.push({x1:curX,x2:overscanRight,y,power:0}); currentS=0; }
                if (this.scanMode === 'unidirectional') { out.push(this._g1x(overscanLeft,currentS,0)); vizSegments.push({x1:overscanRight,x2:overscanLeft,y,power:0}); currentS=0; }
            }
            lineIndex++;
            if (onProgress && ri % 20 === 0) onProgress(ri / sortedYKeys.length);
        }

        out.push('', ...this._footer());
        return { gcode: out.join('\n'), segments: vizSegments, dotCount: activeDots, rowCount: sortedYKeys.length, imgW_mm, imgH_mm, xShift, yShift };
    }
}
