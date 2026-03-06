/**
 * gcode-generator.js
 * Converts a binary dithered dot-matrix into laser-engraving G-code
 * with bidirectional scanning, overscan, and delay compensation.
 *
 * Output format matches the reference encoding:
 *   G1F12000S0
 *   G0X152.164Y97.700
 *   G0Z26.980
 *   G1Y97.720S0
 *   G1X172.164
 *   G1X172.276S300
 *   G1X172.831S0
 *   ...
 *
 * Rules:
 *  - No spaces between G/X/Y/S/F tokens in raster section
 *  - S value only emitted when it changes
 *  - Y steps as separate G1Y commands
 *  - Fixed overscan based on full image extents for clean bidirectional scanning
 */

class GCodeGenerator {
    /**
     * @param {Object} p - parameters
     */
    constructor(p) {
        this.v = p.speed;       // mm/s
        this.rho = p.density;     // lines/mm
        this.tp = p.pulseTime;   // ms
        this.pmin = p.pmin;        // S min
        this.pmax = p.pmax;        // S max
        this.a = p.accel || 1000; // mm/s²
        this.t0 = p.delay || 0;  // ms
        this.yJog = p.yJog || 0;   // mm (Y backlash compensation)
        this.workW = p.workW;      // mm
        this.workH = p.workH;      // mm
        this.dpi = p.dpi;
    }

    /**
     * Generate G-code from dithered binary matrix.
     * @returns {{ gcode: string, segments: Array }}
     */
    generate(dithered, imgW_mm, imgH_mm, onProgress) {
        const { matrix, width, height } = dithered;

        const xPitch = 25.4 / this.dpi;          // mm per dot (X)
        const yPitch = 1.0 / this.rho;           // mm per line (Y)
        const feedRate = Math.round(this.v * 60);   // mm/min
        const overscan = (this.v * this.v) / (2 * this.a);
        const delayDist = this.v * this.t0 / 1000;   // mm
        const pulseW = this.v * this.tp / 1000;   // mm

        // Centre offsets
        const xOff = this.workW / 2 - imgW_mm / 2;
        const yOff = this.workH / 2 - imgH_mm / 2;

        // Global overscan limits (based on full image extent)
        const overscanLeft = xOff - overscan;
        const overscanRight = xOff + imgW_mm + overscan;

        const out = [];
        const vizSegments = [];

        // ── Header ──
        out.push(...this._header(feedRate));

        // ── Find first non-empty row ──
        let firstRow = -1;
        for (let r = 0; r < height; r++) {
            for (let c = 0; c < width; c++) {
                if (matrix[r * width + c] === 1) { firstRow = r; break; }
            }
            if (firstRow >= 0) break;
        }
        if (firstRow < 0) {
            out.push('');
            out.push(...this._footer());
            return { gcode: out.join('\n'), segments: vizSegments };
        }

        // ── Feed-rate line ──
        out.push(`G1F${feedRate}S0`);

        let currentS = 0;
        let isFirstLine = true;
        let lineIndex = 0;

        // ── Raster loop ──
        for (let row = 0; row < height; row++) {
            const y = yOff + row * yPitch;
            const isReverse = lineIndex % 2 === 1;

            // Build laser-on runs for this row
            const runs = this._buildRuns(matrix, row, width, xPitch, xOff, pulseW, delayDist, isReverse);
            if (runs.length === 0) continue;

            // ── Position for this scan line ──
            if (isFirstLine) {
                const startX = isReverse ? overscanRight : overscanLeft;
                out.push(`G0X${startX.toFixed(3)}Y${y.toFixed(3)}`);
                out.push(`G0Z26.980`);
                isFirstLine = false;
            } else {
                // Y step — ensure laser off
                if (currentS !== 0) {
                    currentS = 0;
                    if (this.yJog > 0) {
                        // Overshoot: move to y + y_jog first, then back to y
                        out.push(`G1Y${(y + this.yJog).toFixed(3)}S0`);
                        out.push(`G1Y${y.toFixed(3)}`);
                    } else {
                        out.push(`G1Y${y.toFixed(3)}S0`);
                    }
                } else {
                    if (this.yJog > 0) {
                        // Overshoot: move to y + y_jog first, then back to y
                        out.push(`G1Y${(y + this.yJog).toFixed(3)}`);
                        out.push(`G1Y${y.toFixed(3)}`);
                    } else {
                        out.push(`G1Y${y.toFixed(3)}`);
                    }
                }
            }

            // ── Scan segments ──
            if (isReverse) {
                // Right → Left
                const sorted = [...runs].sort((a, b) => b.x2 - a.x2); // rightmost first
                let curX = overscanRight;

                for (const seg of sorted) {
                    // Approach to segment right edge (laser off)
                    if (Math.abs(curX - seg.x2) > 0.0005) {
                        out.push(this._g1x(seg.x2, currentS, 0));
                        vizSegments.push({ x1: curX, x2: seg.x2, y, power: 0 });
                        currentS = 0;
                        curX = seg.x2;
                    }
                    // Laser ON segment (right → left, so x2 → x1)
                    out.push(this._g1x(seg.x1, currentS, this.pmax));
                    vizSegments.push({ x1: seg.x2, x2: seg.x1, y, power: this.pmax });
                    currentS = this.pmax;
                    curX = seg.x1;
                }

                // Exit overscan
                if (Math.abs(curX - overscanLeft) > 0.0005) {
                    out.push(this._g1x(overscanLeft, currentS, 0));
                    vizSegments.push({ x1: curX, x2: overscanLeft, y, power: 0 });
                    currentS = 0;
                }
            } else {
                // Left → Right
                const sorted = [...runs].sort((a, b) => a.x1 - b.x1); // leftmost first
                let curX = overscanLeft;

                for (const seg of sorted) {
                    // Approach to segment left edge (laser off)
                    if (Math.abs(curX - seg.x1) > 0.0005) {
                        out.push(this._g1x(seg.x1, currentS, 0));
                        vizSegments.push({ x1: curX, x2: seg.x1, y, power: 0 });
                        currentS = 0;
                        curX = seg.x1;
                    }
                    // Laser ON segment
                    out.push(this._g1x(seg.x2, currentS, this.pmax));
                    vizSegments.push({ x1: seg.x1, x2: seg.x2, y, power: this.pmax });
                    currentS = this.pmax;
                    curX = seg.x2;
                }

                // Exit overscan
                if (Math.abs(curX - overscanRight) > 0.0005) {
                    out.push(this._g1x(overscanRight, currentS, 0));
                    vizSegments.push({ x1: curX, x2: overscanRight, y, power: 0 });
                    currentS = 0;
                }
            }

            lineIndex++;
            if (onProgress && row % 20 === 0) onProgress(row / height);
        }

        out.push('');
        out.push(...this._footer());

        return { gcode: out.join('\n'), segments: vizSegments };
    }

    /**
     * Generate G-code directly from raw G25 dot positions.
     * Every dot with S > 0 is preserved at its EXACT position — no matrix, no grid, no loss.
     *
     * @param {Array<{x,y,s}>} dots - parsed G25 dot positions
     * @param {Object} bounds - { minX, maxX, minY, maxY }
     * @param {function} onProgress - optional progress callback
     * @returns {{ gcode: string, segments: Array, dotCount: number, rowCount: number }}
     */
    generateFromDots(dots, bounds, onProgress) {
        const feedRate = Math.round(this.v * 60);
        const overscan = (this.v * this.v) / (2 * this.a);
        const delayDist = this.v * this.t0 / 1000;
        const pulseW = this.v * this.tp / 1000;

        // Image size from bounds
        const imgW_mm = bounds.maxX - bounds.minX;
        const imgH_mm = bounds.maxY - bounds.minY;

        // Centre offset: shift so image center → work area center
        const xShift = (this.workW / 2) - (bounds.minX + imgW_mm / 2);
        const yShift = (this.workH / 2) - (bounds.minY + imgH_mm / 2);

        // Overscan limits (in output coordinates)
        const imgLeft = bounds.minX + xShift;
        const imgRight = bounds.maxX + xShift;
        const overscanLeft = imgLeft - overscan;
        const overscanRight = imgRight + overscan;

        // Group dots by Y coordinate (preserve exact Y values)
        const rowMap = new Map();
        let activeDots = 0;
        for (const d of dots) {
            if (d.s <= 0) continue;
            activeDots++;
            const yKey = d.y.toFixed(6);
            if (!rowMap.has(yKey)) rowMap.set(yKey, []);
            rowMap.get(yKey).push(d);
        }

        // Sort rows by Y
        const sortedYKeys = [...rowMap.keys()].sort((a, b) => parseFloat(a) - parseFloat(b));

        const out = [];
        const vizSegments = [];

        // Header
        out.push(...this._header(feedRate));
        out.push(`G1F${feedRate}S0`);

        let currentS = 0;
        let isFirstLine = true;
        let lineIndex = 0;

        for (let ri = 0; ri < sortedYKeys.length; ri++) {
            const yKey = sortedYKeys[ri];
            const rowDots = rowMap.get(yKey);
            const y = parseFloat(yKey) + yShift;  // apply Y centering
            const isReverse = lineIndex % 2 === 1;

            // Sort dots by X within this row
            rowDots.sort((a, b) => a.x - b.x);

            // Build laser-on runs from exact dot positions
            // Each dot creates a run: [dot.x, dot.x + pulseW]
            // Merge overlapping/adjacent runs
            const rawRuns = [];
            for (const d of rowDots) {
                const dotX = d.x + xShift;  // apply X centering
                const comp = isReverse ? -delayDist : delayDist;
                rawRuns.push({ x1: dotX + comp, x2: dotX + pulseW + comp });
            }

            // Merge overlapping runs
            const runs = [];
            if (rawRuns.length > 0) {
                let cur = { ...rawRuns[0] };
                for (let i = 1; i < rawRuns.length; i++) {
                    if (rawRuns[i].x1 <= cur.x2 + 0.0001) {
                        cur.x2 = Math.max(cur.x2, rawRuns[i].x2);
                    } else {
                        runs.push(cur);
                        cur = { ...rawRuns[i] };
                    }
                }
                runs.push(cur);
            }

            if (runs.length === 0) continue;

            // Position for this scan line
            if (isFirstLine) {
                const startX = isReverse ? overscanRight : overscanLeft;
                out.push(`G0X${startX.toFixed(3)}Y${y.toFixed(3)}`);
                out.push(`G0Z26.980`);
                isFirstLine = false;
            } else {
                if (currentS !== 0) {
                    currentS = 0;
                    if (this.yJog > 0) {
                        out.push(`G1Y${(y + this.yJog).toFixed(3)}S0`);
                        out.push(`G1Y${y.toFixed(3)}`);
                    } else {
                        out.push(`G1Y${y.toFixed(3)}S0`);
                    }
                } else {
                    if (this.yJog > 0) {
                        out.push(`G1Y${(y + this.yJog).toFixed(3)}`);
                        out.push(`G1Y${y.toFixed(3)}`);
                    } else {
                        out.push(`G1Y${y.toFixed(3)}`);
                    }
                }
            }

            // Scan segments
            if (isReverse) {
                const sorted = [...runs].sort((a, b) => b.x2 - a.x2);
                let curX = overscanRight;
                for (const seg of sorted) {
                    if (Math.abs(curX - seg.x2) > 0.0005) {
                        out.push(this._g1x(seg.x2, currentS, 0));
                        vizSegments.push({ x1: curX, x2: seg.x2, y, power: 0 });
                        currentS = 0;
                        curX = seg.x2;
                    }
                    out.push(this._g1x(seg.x1, currentS, this.pmax));
                    vizSegments.push({ x1: seg.x2, x2: seg.x1, y, power: this.pmax });
                    currentS = this.pmax;
                    curX = seg.x1;
                }
                if (Math.abs(curX - overscanLeft) > 0.0005) {
                    out.push(this._g1x(overscanLeft, currentS, 0));
                    vizSegments.push({ x1: curX, x2: overscanLeft, y, power: 0 });
                    currentS = 0;
                }
            } else {
                const sorted = [...runs].sort((a, b) => a.x1 - b.x1);
                let curX = overscanLeft;
                for (const seg of sorted) {
                    if (Math.abs(curX - seg.x1) > 0.0005) {
                        out.push(this._g1x(seg.x1, currentS, 0));
                        vizSegments.push({ x1: curX, x2: seg.x1, y, power: 0 });
                        currentS = 0;
                        curX = seg.x1;
                    }
                    out.push(this._g1x(seg.x2, currentS, this.pmax));
                    vizSegments.push({ x1: seg.x1, x2: seg.x2, y, power: this.pmax });
                    currentS = this.pmax;
                    curX = seg.x2;
                }
                if (Math.abs(curX - overscanRight) > 0.0005) {
                    out.push(this._g1x(overscanRight, currentS, 0));
                    vizSegments.push({ x1: curX, x2: overscanRight, y, power: 0 });
                    currentS = 0;
                }
            }

            lineIndex++;
            if (onProgress && ri % 20 === 0) onProgress(ri / sortedYKeys.length);
        }

        out.push('');
        out.push(...this._footer());

        return {
            gcode: out.join('\n'),
            segments: vizSegments,
            dotCount: activeDots,
            rowCount: sortedYKeys.length,
            imgW_mm, imgH_mm,
            xShift, yShift,
        };
    }

    /**
     * Emit G1X command, only including S when the power value changes.
     * @param {number} x       - target X coordinate
     * @param {number} curS    - current S value
     * @param {number} newS    - desired S value
     * @returns {string}
     */
    _g1x(x, curS, newS) {
        if (newS !== curS) {
            return `G1X${x.toFixed(3)}S${newS}`;
        }
        return `G1X${x.toFixed(3)}`;
    }

    /**
     * Build run-length laser-on segments for a single row.
     * Returns array of { x1, x2 } where x1 < x2 (physical left-to-right).
     */
    _buildRuns(matrix, row, width, xPitch, xOff, pulseW, delayDist, isReverse) {
        const runs = [];
        let inRun = false;
        let runStart = 0;

        for (let c = 0; c <= width; c++) {
            const isOn = c < width && matrix[row * width + c] === 1;
            if (isOn && !inRun) {
                runStart = c;
                inRun = true;
            } else if (!isOn && inRun) {
                // Run from runStart to c-1 (inclusive)
                let x1 = xOff + runStart * xPitch;
                let x2 = xOff + (c - 1) * xPitch + pulseW;
                // Delay compensation
                const comp = isReverse ? -delayDist : delayDist;
                runs.push({ x1: x1 + comp, x2: x2 + comp });
                inRun = false;
            }
        }
        return runs;
    }

    /** G-code header — spaces in config lines, no spaces in raster setup */
    _header(feedRate) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ds = `${now.getFullYear()}_${pad(now.getMonth() + 1)}_${pad(now.getDate())}_${pad(now.getHours())}_${pad(now.getMinutes())}_${pad(now.getSeconds())}`;

        return [
            `# date=${ds}`,
            `# version=1.5.7-pr2-b5-cos-0210-3`,
            `# algorithmVersion=1.5.5-alpha`,
            `# gc={"size":{"w":${this.workW},"h":${this.workH}}}`,
            `# gc={"offset":{"x":0,"y":0}}`,
            `# gc={"start":{"x":0,"y":0.0000}}`,
            `# gc={"keys":["x","y"],"rm":1,"is3DMode":false}`,
            `# timeConfig=`,
            `G90`,
            `G0 F3000`,
            ``,
            `# JS002 HEAD`,
            `M1001 S1P0A150B30`,
            `G0 X0 Y0 U0 F18000`,
            `M9064 B3`,
            `G198 P78 "M9064 B3"`,
            `M9039 C3`,
            `G198 P76 "M9039 V35"`,
            `G198 P76 "M9043 H1 I1 J1 K194 L1 M1"`,
            ``,
            `# JS002 BITMAP HEAD`,
            `# motion_start`,
            `M1002 S0P3`,
            `M32 X2300Y2300`,
            `# blockConfig={"powerFactor":${(this.pmax / 1000).toFixed(1)},"density":"${this.rho.toFixed(2)}","power":[${this.pmin},${this.pmax}],"bitmapMode":"Jarvis"}`,
            ``,
        ];
    }

    /** G-code footer */
    _footer() {
        return [
            `# JS002 END`,
            `G1 Z0 F1200 S0`,
            `G1 X0 Y0 U0 F18000`,
        ];
    }
}
