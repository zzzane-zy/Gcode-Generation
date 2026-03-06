/**
 * gcode-parser.js
 * Parses G25-encoded G-code files and extracts dot positions.
 * Optimized for large files (20MB+).
 * Only extracts G25 lines — all other commands are ignored.
 */

class GCodeParser {

    /**
     * Parse G25 G-code text and return dot positions.
     * @param {string} gcodeText - raw G-code file content
     * @param {function} onProgress - optional progress callback (0-1)
     */
    static parse(gcodeText, onProgress) {
        const lines = gcodeText.split(/\r?\n/);
        const totalLines = lines.length;
        const dots = [];
        let curX = 0, curY = 0, curS = 0;

        // Incremental bounds
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        const ySet = new Set();

        // Detect X pitch from first consecutive same-row delta
        let xPitchDetected = 0;
        let prevX = null, prevY = null;

        const rxX = /X([\d.\-]+)/;
        const rxY = /Y([\d.\-]+)/;
        const rxS = /S(\d+)/;

        for (let i = 0; i < totalLines; i++) {
            const line = lines[i].trim();

            // Only parse G25 lines (skip everything else)
            if (!line.startsWith('G25') || line.startsWith('G25T')) continue;

            const mx = rxX.exec(line);
            const my = rxY.exec(line);
            const ms = rxS.exec(line);

            if (mx) curX = parseFloat(mx[1]);
            if (my) curY = parseFloat(my[1]);
            if (ms) curS = parseInt(ms[1]);

            dots.push({ x: curX, y: curY, s: curS });

            // Update bounds
            if (curX < minX) minX = curX;
            if (curX > maxX) maxX = curX;
            if (curY < minY) minY = curY;
            if (curY > maxY) maxY = curY;
            ySet.add(curY.toFixed(4));

            // Detect X pitch from first same-row delta
            if (xPitchDetected === 0 && prevY !== null && Math.abs(curY - prevY) < 0.0001 && prevX !== null) {
                const dx = Math.abs(curX - prevX);
                if (dx > 0.0001) xPitchDetected = dx;
            }
            prevX = curX;
            prevY = curY;

            if (onProgress && i % 10000 === 0) onProgress(i / totalLines);
        }

        if (dots.length === 0) {
            throw new Error(`未找到 G25 点位 (共扫描 ${totalLines} 行)`);
        }

        const yValues = [...ySet].map(parseFloat).sort((a, b) => a - b);

        // Y pitch from first Y delta
        let yPitch = xPitchDetected || 0.1;
        if (yValues.length > 1) {
            const dy = yValues[1] - yValues[0];
            if (dy > 0.0001) yPitch = dy;
        }

        const xPitch = xPitchDetected || 0.1;
        const bounds = { minX, maxX, minY, maxY };

        console.log(`G25 parsed: ${dots.length} dots, ${yValues.length} rows, ` +
            `X[${minX.toFixed(3)}..${maxX.toFixed(3)}] Y[${minY.toFixed(3)}..${maxY.toFixed(3)}], ` +
            `pitch X=${xPitch.toFixed(4)} Y=${yPitch.toFixed(4)}`);

        return { dots, xPitch, yPitch, bounds, yValues };
    }

    /**
     * Build a binary matrix for preview display only.
     */
    static buildMatrix(parsed, threshold = 0) {
        const { dots, bounds, xPitch, yPitch, yValues } = parsed;
        const cols = Math.round((bounds.maxX - bounds.minX) / xPitch) + 1;
        const numRows = yValues.length;
        const matrix = new Uint8Array(cols * numRows);

        const yToRow = new Map();
        for (let i = 0; i < yValues.length; i++) {
            yToRow.set(yValues[i].toFixed(4), i);
        }

        for (const d of dots) {
            if (d.s <= threshold) continue;
            const row = yToRow.get(d.y.toFixed(4));
            const col = Math.round((d.x - bounds.minX) / xPitch);
            if (row !== undefined && col >= 0 && col < cols) {
                matrix[row * cols + col] = 1;
            }
        }

        return { matrix, width: cols, height: numRows };
    }

    static getImageSize(parsed) {
        return {
            width: parsed.bounds.maxX - parsed.bounds.minX,
            height: parsed.bounds.maxY - parsed.bounds.minY,
        };
    }
}
