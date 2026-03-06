/**
 * image-processor.js
 * Handles: image loading, lossless upscale, physical resize, grayscale, Jarvis dithering
 */

class ImageProcessor {
  constructor() {
    this.originalImage = null;
  }

  /** Load an image file into an HTMLImageElement */
  loadImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => { this.originalImage = img; resolve(img); };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  /** Nearest-neighbor lossless upscale */
  upscale(factor) {
    if (!this.originalImage) throw new Error('没有加载图片');
    const src = this.originalImage;
    const w = src.width * factor;
    const h = src.height * factor;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, w, h);
    return { imageData: ctx.getImageData(0, 0, w, h), width: w, height: h };
  }

  /**
   * Resize image to exact dot-matrix dimensions for the target physical size.
   * xDots = targetW_mm * dpi / 25.4
   * yDots = targetH_mm * density
   */
  resizeToGrid(imageData, srcW, srcH, xDots, yDots) {
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    srcCanvas.getContext('2d').putImageData(imageData, 0, 0);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = xDots;
    dstCanvas.height = yDots;
    const dstCtx = dstCanvas.getContext('2d');
    dstCtx.drawImage(srcCanvas, 0, 0, xDots, yDots);
    return dstCtx.getImageData(0, 0, xDots, yDots);
  }

  /** Convert RGBA ImageData to Float32 grayscale array */
  toGrayscale(imageData) {
    const data = imageData.data;
    const len = imageData.width * imageData.height;
    const gray = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
  }

  /**
   * Invert grayscale values: 255 - v
   */
  invertGray(gray) {
    for (let i = 0; i < gray.length; i++) {
      gray[i] = 255 - gray[i];
    }
    return gray;
  }

  /**
   * Invert an RGBA ImageData in-place (255 - R/G/B, alpha unchanged).
   * Returns the same ImageData for chaining.
   */
  invertImageData(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
      // alpha unchanged
    }
    return imageData;
  }

  /**
   * Adjust brightness and contrast on grayscale array.
   * @param {Float32Array} gray
   * @param {number} brightness  -100 to +100 (0 = no change)
   * @param {number} contrast    -100 to +100 (0 = no change)
   */
  adjustBrightnessContrast(gray, brightness, contrast) {
    // Contrast factor: maps [-100,100] to [0, ~3]
    const cf = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < gray.length; i++) {
      let v = gray[i] + brightness;       // brightness shift
      v = cf * (v - 128) + 128;           // contrast around midpoint
      gray[i] = v; // allow out-of-range; clamped later in dithering
    }
    return gray;
  }

  /**
   * Jarvis-Judice-Ninke error-diffusion dithering.
   * Pipeline: grayscale → invert(opt) → brightness/contrast → dither
   * Kernel layout (current pixel marked *):
   *      -   -   *  r1  r2
   *     d1a d1b d1c d1d d1e
   *     d2a d2b d2c d2d d2e
   * Returns { matrix: Uint8Array (1=black dot, 0=white), width, height }
   */
  jarvisDither(imageData, threshold, coefficients, options, onProgress) {
    const w = imageData.width;
    const h = imageData.height;
    let gray = this.toGrayscale(imageData);

    // Pre-processing: brightness/contrast (invert is now a separate step)
    if (options && (options.brightness !== 0 || options.contrast !== 0)) {
      gray = this.adjustBrightnessContrast(gray, options.brightness || 0, options.contrast || 0);
    }

    const result = new Uint8Array(w * h);

    const c = coefficients;
    // Auto-calculate divisor from given coefficients
    const divisor = c.r1 + c.r2 +
      c.d1a + c.d1b + c.d1c + c.d1d + c.d1e +
      c.d2a + c.d2b + c.d2c + c.d2d + c.d2e;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const oldVal = Math.max(0, Math.min(255, gray[idx]));
        const newVal = oldVal > threshold ? 255 : 0;
        result[idx] = newVal === 0 ? 1 : 0; // 1 = black dot
        const err = oldVal - newVal;

        // Row 0 (current row): +1, +2
        if (x + 1 < w) gray[idx + 1] += err * c.r1 / divisor;
        if (x + 2 < w) gray[idx + 2] += err * c.r2 / divisor;

        // Row 1 (next row): -2, -1, 0, +1, +2
        if (y + 1 < h) {
          const r = (y + 1) * w;
          if (x - 2 >= 0) gray[r + x - 2] += err * c.d1a / divisor;
          if (x - 1 >= 0) gray[r + x - 1] += err * c.d1b / divisor;
          gray[r + x] += err * c.d1c / divisor;
          if (x + 1 < w) gray[r + x + 1] += err * c.d1d / divisor;
          if (x + 2 < w) gray[r + x + 2] += err * c.d1e / divisor;
        }

        // Row 2 (two rows down): -2, -1, 0, +1, +2
        if (y + 2 < h) {
          const r = (y + 2) * w;
          if (x - 2 >= 0) gray[r + x - 2] += err * c.d2a / divisor;
          if (x - 1 >= 0) gray[r + x - 1] += err * c.d2b / divisor;
          gray[r + x] += err * c.d2c / divisor;
          if (x + 1 < w) gray[r + x + 1] += err * c.d2d / divisor;
          if (x + 2 < w) gray[r + x + 2] += err * c.d2e / divisor;
        }
      }
      // Report progress every 50 rows
      if (onProgress && y % 50 === 0) onProgress(y / h);
    }
    return { matrix: result, width: w, height: h };
  }

  /** Create a canvas from the binary dithered matrix for preview */
  ditheredToCanvas(dithered) {
    const { matrix, width, height } = dithered;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    for (let i = 0; i < matrix.length; i++) {
      const v = matrix[i] === 1 ? 0 : 255;
      imgData.data[i * 4] = v;
      imgData.data[i * 4 + 1] = v;
      imgData.data[i * 4 + 2] = v;
      imgData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }
}
