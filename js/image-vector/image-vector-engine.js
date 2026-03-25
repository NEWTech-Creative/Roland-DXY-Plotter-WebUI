class ImageVectorEngine {
    constructor() {
        this.imageData = null;
        this.width = 0;
        this.height = 0;
        this.sourceBrightnessMap = null; // Original, never modified
        this.brightnessMap = null;       // Working copy for current session
        this.lineCache = null;           // Cache for string art lines
        this.lastPinCount = -1;
        this.lastSamplingStep = -1;
    }

    setImageData(imageData, channel = 'bw') {
        this.imageData = imageData;
        this.width = imageData.width;
        this.height = imageData.height;
        this._generateBrightnessMap(channel);
    }

    _generateBrightnessMap(channel = 'bw') {
        const data = this.imageData.data;
        this.sourceBrightnessMap = new Float32Array(this.width * this.height);
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            // Fix: Treat transparency as white background
            if (a < 128) {
                this.sourceBrightnessMap[i / 4] = 255;
            } else {
                if (channel === 'r') this.sourceBrightnessMap[i / 4] = r;
                else if (channel === 'g') this.sourceBrightnessMap[i / 4] = g;
                else if (channel === 'b') this.sourceBrightnessMap[i / 4] = b;
                else this.sourceBrightnessMap[i / 4] = (0.299 * r + 0.587 * g + 0.114 * b);
            }
        }
        // Initial copy for edge map and first run
        this.brightnessMap = new Float32Array(this.sourceBrightnessMap);
        this._generateEdgeMap();
    }

    _generateEdgeMap() {
        const w = this.width;
        const h = this.height;
        this.edgeMap = new Float32Array(this.brightnessMap.length);

        // Sobel Kernels
        const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                let sumX = 0;
                let sumY = 0;

                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const val = this.brightnessMap[(y + ky) * w + (x + kx)];
                        const kidx = (ky + 1) * 3 + (kx + 1);
                        sumX += val * gx[kidx];
                        sumY += val * gy[kidx];
                    }
                }
                const mag = Math.sqrt(sumX * sumX + sumY * sumY);
                this.edgeMap[y * w + x] = mag;
            }
        }
    }

    _generateDetailMap() {
        // Laplacian filter for fine detail/texture extraction
        const w = this.width;
        const h = this.height;
        this.detailMap = new Float32Array(this.brightnessMap.length);
        const kernel = [0, -1, 0, -1, 4, -1, 0, -1]; // Sparse Laplacian

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                let sum = 0;
                // Center weighted
                sum += (this.brightnessMap[y * w + x] * 4);
                // Neighbors
                sum -= this.brightnessMap[(y - 1) * w + x];
                sum -= this.brightnessMap[(y + 1) * w + x];
                sum -= this.brightnessMap[y * w + (x - 1)];
                sum -= this.brightnessMap[y * w + (x + 1)];

                this.detailMap[y * w + x] = Math.abs(sum);
            }
        }
    }

    getBrightness(x, y) {
        x = Math.max(0, Math.min(this.width - 1, Math.floor(x)));
        y = Math.max(0, Math.min(this.height - 1, Math.floor(y)));
        return this.brightnessMap[y * this.width + x];
    }

    async process(method, params) {
        // Instead of reusing one brightness map, when process is called with a specific channel, 
        // we might need to regenerate the source brightness map if it's different.
        // Or better yet, we can do it on the fly. 
        if (!this.imageData) return [];
        
        // Always generate a fresh source map for the requested channel to allow panel.js to call process() back to back
        const channel = params.channel || 'bw';
        this._generateBrightnessMap(channel);

        if (!this.sourceBrightnessMap) return [];

        // 1. Reset working copy to fresh source data (Non-destructive)
        this.brightnessMap = new Float32Array(this.sourceBrightnessMap);

        // 2. Apply contrast if requested
        const contrast = params.contrast || 50; // 0-100
        if (contrast !== 50) {
            this._applyContrast(contrast);
        } else {
            // Keep all analysis maps in sync even when contrast is neutral.
            this._generateEdgeMap();
            this._generateDetailMap();
        }

        // Store layerIndex so sub-generators can use it to apply offsets
        this.currentLayerIndex = params.layerIndex || 0;

        switch (method) {
            case 'contour': return this.generateContours(params);
            case 'hatch': return this.generateHatch(params);
            case 'spiral': return this.generateSpiral(params);
            case 'wave': return this.generateWaves(params);
            case 'stipple': return this.generateStippling(params);
            case 'flow': return this.generateFlowField(params);
            case 'shape': return this.generateShapeReplacement(params);
            case 'voronoi': return this.generateVoronoi(params);
            case 'topo': return this.generateTopographic(params);
            case 'string': return await this.generateStringArt(params);
            default: return [];
        }
    }

    _applyContrast(value) {
        // High-sensitivity Contrast: b = (b - 0.5) * factor + 0.5
        // Neutral (50) -> factor 1.0
        // Max (100) -> factor 26.0 (Extremely aggressive)
        // Min (0) -> factor 0.0 (Solid grey)
        const factor = value < 50 ? (value / 50) : (1 + Math.pow((value - 50) / 10, 2));

        for (let i = 0; i < this.brightnessMap.length; i++) {
            let b = this.brightnessMap[i] / 255;
            b = (b - 0.5) * factor + 0.5;
            this.brightnessMap[i] = Math.max(0, Math.min(255, b * 255));
        }
        // Re-generate maps to match adjusted contrast
        this._generateEdgeMap();
        this._generateDetailMap();
    }

    /**
     * Proper Edge Tracing using Sobel + Thresholding + Path Following
     */
    generateContours(params) {
        const threshold = params.threshold || 128;
        const fill = params.fill || 'none';
        const fillSpacing = params.fillSpacing || 8;
        const simplify = (params.simplify || 0) / 20; // Tolerance 0-5.0
        const outPaths = [];

        const binary = new Uint8Array(this.width * this.height);
        for (let i = 0; i < this.brightnessMap.length; i++) {
            binary[i] = (this.brightnessMap[i] < threshold) ? 1 : 0;
        }
        const crispArtwork = this._isHighContrastArtwork();
        const contourOutputStyle = crispArtwork && (params.style || 'curves') === 'curves'
            ? 'mixed'
            : (params.style || 'curves');

        const visited = new Uint8Array(this.width * this.height);
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                const idx = y * this.width + x;
                if (binary[idx] === 1 && !visited[idx]) {
                    if (binary[idx - 1] === 0 || binary[idx + 1] === 0 ||
                        binary[idx - this.width] === 0 || binary[idx + this.width] === 0) {
                        const path = this._traceBoundary(x, y, binary, visited);
                        if (path && path.length > 3) {
                            let processed = crispArtwork ? this._collapsePixelStairSteps(path) : path;
                            const smoothIters = crispArtwork ? 0 : parseInt(params.smooth || 0);
                            for (let i = 0; i < smoothIters; i++) {
                                processed = this._smoothPath(processed);
                            }

                            // Keep crisp logos/text much closer to the source outline.
                            const contourSimplify = crispArtwork
                                ? Math.max(0.9, Math.min(1.4, simplify || 0.9))
                                : Math.max(simplify, (params.spacing || 1) * 0.5);
                            if (contourSimplify > 0) processed = this._simplifyPath(processed, contourSimplify);

                            outPaths.push(processed);
                        }
                    }
                }
            }
        }

        if (fill !== 'none') {
            const fillPaths = this._generateFillPatterns(binary, fill, fillSpacing, params.zigzagSize, params.fillAngle || 45);
            fillPaths.forEach(p => {
                let processed = p;
                if (simplify > 0 && !p.forceLineStyle) processed = this._simplifyPath(processed, simplify);
                outPaths.push(processed);
            });
        }

        return outPaths.map(p => this._pointsToSmoothSegments(p, p.forceLineStyle ? 'lines' : contourOutputStyle));
    }

    _isHighContrastArtwork() {
        if (!this.brightnessMap || this.brightnessMap.length === 0) return false;

        let dark = 0;
        let light = 0;
        let mid = 0;
        const sampleStep = Math.max(1, Math.floor(this.brightnessMap.length / 12000));

        for (let i = 0; i < this.brightnessMap.length; i += sampleStep) {
            const b = this.brightnessMap[i];
            if (b <= 28) dark++;
            else if (b >= 227) light++;
            else mid++;
        }

        const total = dark + light + mid;
        if (!total) return false;

        const extremeRatio = (dark + light) / total;
        const midRatio = mid / total;
        return extremeRatio >= 0.88 && midRatio <= 0.12;
    }

    _collapsePixelStairSteps(path) {
        if (!Array.isArray(path) || path.length < 3) return path;

        const cleaned = [path[0]];
        for (let i = 1; i < path.length; i++) {
            const prev = cleaned[cleaned.length - 1];
            const curr = path[i];
            if (!prev || prev.x !== curr.x || prev.y !== curr.y) {
                cleaned.push(curr);
            }
        }

        if (cleaned.length < 3) return cleaned;

        const collapsed = [cleaned[0]];
        for (let i = 1; i < cleaned.length - 1; i++) {
            const a = collapsed[collapsed.length - 1];
            const b = cleaned[i];
            const c = cleaned[i + 1];
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const bcx = c.x - b.x;
            const bcy = c.y - b.y;

            const collinear = (abx * bcy) === (aby * bcx);
            if (collinear) {
                continue;
            }

            const smallOrthogonalStep =
                Math.abs(abx) <= 1 && Math.abs(aby) <= 1 &&
                Math.abs(bcx) <= 1 && Math.abs(bcy) <= 1 &&
                ((abx === 0 && bcy === 0) || (aby === 0 && bcx === 0));

            const diagonalProgress = Math.abs(c.x - a.x) <= 2 && Math.abs(c.y - a.y) <= 2;

            if (smallOrthogonalStep && diagonalProgress) {
                continue;
            }

            collapsed.push(b);
        }
        collapsed.push(cleaned[cleaned.length - 1]);
        return collapsed;
    }

    _smoothPath(path) {
        if (!path || path.length < 3) return path;

        // One iteration of Chaikin's smoothing
        const smoothed = [];
        smoothed.push(path[0]);

        for (let i = 0; i < path.length - 1; i++) {
            const p0 = path[i];
            const p1 = path[i + 1];

            smoothed.push({
                x: p0.x * 0.75 + p1.x * 0.25,
                y: p0.y * 0.75 + p1.y * 0.25
            });
            smoothed.push({
                x: p0.x * 0.25 + p1.x * 0.75,
                y: p0.y * 0.25 + p1.y * 0.75
            });
        }

        smoothed.push(path[path.length - 1]);
        return smoothed;
    }

    _pointsToSmoothSegments(points, style = 'curves') {
        if (!points || points.length < 3 || style === 'lines') {
            const segments = [];
            if (points && points.length > 0) segments.push({ type: 'M', x: points[0].x, y: points[0].y });
            for (let i = 1; i < (points ? points.length : 0); i++) {
                segments.push({ type: 'L', x: points[i].x, y: points[i].y });
            }
            return Object.assign([...(points || [])], { segments });
        }

        const segments = [{ type: 'M', x: points[0].x, y: points[0].y }];
        const k = 0.25; // Tension/Smoothing factor

        for (let i = 0; i < points.length - 1; i++) {
            const p0 = i === 0 ? points[0] : points[i - 1];
            const p1 = points[i];
            const p2 = points[i + 1];
            const p3 = i + 2 < points.length ? points[i + 2] : p2;

            // Mixed mode: if angle between segments is sharp, use straight line
            if (style === 'mixed') {
                const a1 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
                const a2 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                let diff = Math.abs(a1 - a2);
                if (diff > Math.PI) diff = Math.PI * 2 - diff;

                // If the turn is sharper than ~45 degrees (0.8 rad), use a straight line
                if (diff > 0.8) {
                    segments.push({ type: 'L', x: p2.x, y: p2.y });
                    continue;
                }
            }

            const x1 = p1.x + (p2.x - p0.x) * k;
            const y1 = p1.y + (p2.y - p0.y) * k;

            const x2 = p2.x - (p3.x - p1.x) * k;
            const y2 = p2.y - (p3.y - p1.y) * k;

            segments.push({
                type: 'C',
                x1: x1, y1: y1,
                x2: x2, y2: y2,
                x: p2.x, y: p2.y
            });
        }

        // Return a standard Array with secret hidden `segments` property to satisfy older mapping consumers
        const result = [...points];
        result.segments = segments;
        return result;
    }

    /**
     * Ramer-Douglas-Peucker (RDP) Algorithm
     * Efficiently simplifies a path while preserving its shape.
     */
    _simplifyPath(path, epsilon = 1.0) {
        if (!path || path.length < 3 || epsilon <= 0) return path;

        // Convert tolerance (0-100) to actual epsilon
        // epsilon 0 -> path
        // epsilon 100 -> very simplified
        const dmax = epsilon;

        let index = -1;
        let maxDist = 0;

        for (let i = 1; i < path.length - 1; i++) {
            const d = this.distToSegment(path[i], path[0], path[path.length - 1]);
            if (d > maxDist) {
                index = i;
                maxDist = d;
            }
        }

        if (maxDist > dmax) {
            const res1 = this._simplifyPath(path.slice(0, index + 1), dmax);
            const res2 = this._simplifyPath(path.slice(index), dmax);
            return res1.slice(0, res1.length - 1).concat(res2);
        } else {
            return [path[0], path[path.length - 1]];
        }
    }

    distToSegment(p, v, w) {
        const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
        if (l2 === 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.sqrt((p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2);
    }

    _generateFillPatterns(binary, type, spacing, zigzagSize = 5, fillAngle = 45) {
        const paths = [];
        const step = 2; // Point-to-point step in lines

        // Use a grid-based approach to fill the binary 1 areas
        if (type === 'zigzag') {
            const rowGap = Math.max(1, spacing);
            const stepX = Math.max(1, zigzagSize);
            const amplitude = Math.max(1, zigzagSize * 0.5);
            const layerOffset = (rowGap / 3) * (this.currentLayerIndex || 0);
            const angleRad = fillAngle * Math.PI / 180;
            const dirX = Math.cos(angleRad);
            const dirY = Math.sin(angleRad);
            const normalX = -dirY;
            const normalY = dirX;
            const centerX = this.width / 2;
            const centerY = this.height / 2;
            const maxDistance = Math.ceil(Math.hypot(this.width, this.height));

            for (let offset = -maxDistance + layerOffset; offset <= maxDistance; offset += rowGap) {
                let runStartT = null;
                let runEndT = null;

                for (let t = -maxDistance; t <= maxDistance; t += 1) {
                    const baseX = centerX + (dirX * t) + (normalX * offset);
                    const baseY = centerY + (dirY * t) + (normalY * offset);
                    const x = Math.round(baseX);
                    const y = Math.round(baseY);
                    const inside = x >= 0 && x < this.width && y >= 0 && y < this.height && binary[y * this.width + x];

                    if (inside) {
                        if (runStartT === null) runStartT = t;
                        runEndT = t;
                        continue;
                    }

                    if (runStartT !== null && runEndT !== null && (runEndT - runStartT) >= stepX) {
                        const points = [];
                        const alignedStartT = Math.ceil(runStartT / stepX) * stepX;
                        for (let sampleT = alignedStartT; sampleT <= runEndT; sampleT += stepX) {
                            const zig = (Math.round(sampleT / stepX) % 2) === 0;
                            const baseX = centerX + (dirX * sampleT) + (normalX * offset);
                            const baseY = centerY + (dirY * sampleT) + (normalY * offset);
                            points.push({
                                x: baseX + (normalX * (zig ? -amplitude : amplitude)),
                                y: baseY + (normalY * (zig ? -amplitude : amplitude))
                            });
                        }
                        if (points.length >= 2) {
                            points.forceLineStyle = true;
                            paths.push(points);
                        }
                    }
                    runStartT = null;
                    runEndT = null;
                }

                if (runStartT !== null && runEndT !== null && (runEndT - runStartT) >= stepX) {
                    const points = [];
                    const alignedStartT = Math.ceil(runStartT / stepX) * stepX;
                    for (let sampleT = alignedStartT; sampleT <= runEndT; sampleT += stepX) {
                        const zig = (Math.round(sampleT / stepX) % 2) === 0;
                        const baseX = centerX + (dirX * sampleT) + (normalX * offset);
                        const baseY = centerY + (dirY * sampleT) + (normalY * offset);
                        points.push({
                            x: baseX + (normalX * (zig ? -amplitude : amplitude)),
                            y: baseY + (normalY * (zig ? -amplitude : amplitude))
                        });
                    }
                    if (points.length >= 2) {
                        points.forceLineStyle = true;
                        paths.push(points);
                    }
                }
            }
        } else if (type === 'lines' || type === 'hatch') {
            const angles = [fillAngle];
            if (type === 'hatch') angles.push(fillAngle + 90);

            for (const angle of angles) {
                const cos = Math.cos(angle * Math.PI / 180);
                const sin = Math.sin(angle * Math.PI / 180);

                // Offset for colored layers
                const layerOffset = (spacing / 3) * (this.currentLayerIndex || 0);

                for (let d = -this.width - this.height; d < this.width + this.height; d += spacing) {
                    let currentPath = [];
                    for (let t = -this.width - this.height; t < this.width + this.height; t += step) {
                        const dOffset = d + layerOffset;
                        const baseX = dOffset * cos - t * sin;
                        const baseY = dOffset * sin + t * cos;
                        const x = Math.floor(baseX);
                        const y = Math.floor(baseY);

                        if (x >= 0 && x < this.width && y >= 0 && y < this.height && binary[y * this.width + x]) {
                            currentPath.push({ x, y });
                        } else {
                            if (currentPath.length > 1) {
                                // Efficient perfectly straight lines. Just start and end!
                                if (type !== 'curly') {
                                    currentPath = [currentPath[0], currentPath[currentPath.length - 1]];
                                }
                                paths.push(currentPath);
                                currentPath = [];
                            }
                        }
                    }
                    if (currentPath.length > 1) {
                        if (type !== 'curly') {
                            currentPath = [currentPath[0], currentPath[currentPath.length - 1]];
                        }
                        paths.push(currentPath);
                    }
                }
            }
        } else if (type === 'wave') {
            const layerOffset = (spacing / 3) * (this.currentLayerIndex || 0);
            for (let y = layerOffset; y < this.height; y += spacing) {
                let currentPath = [];
                for (let x = 0; x < this.width; x += step) {
                    const waveY = y + Math.sin(x * 0.1) * (spacing / 2);
                    const intY = Math.floor(waveY);
                    if (x >= 0 && x < this.width && intY >= 0 && intY < this.height && binary[intY * this.width + x]) {
                        currentPath.push({ x, y: waveY });
                    } else {
                        if (currentPath.length > 1) paths.push(currentPath);
                        currentPath = [];
                    }
                }
                if (currentPath.length > 1) paths.push(currentPath);
            }
        } else if (type === 'dots') {
            for (let y = 0; y < this.height; y += spacing) {
                for (let x = 0; x < this.width; x += spacing) {
                    if (binary[y * this.width + x]) {
                        // Tiny circle
                        const dot = [];
                        for (let a = 0; a < Math.PI * 2; a += 1.5) {
                            dot.push({ x: x + Math.cos(a) * 0.5, y: y + Math.sin(a) * 0.5 });
                        }
                        dot.push(dot[0]);
                        paths.push(dot);
                    }
                }
            }
        } else if (type === 'curly') {
            for (let y = 0; y < this.height; y += spacing * 1.5) {
                for (let x = 0; x < this.width; x += spacing * 1.5) {
                    if (binary[Math.floor(y) * this.width + Math.floor(x)]) {
                        const curl = [];
                        for (let a = 0; a < Math.PI * 4; a += 0.5) {
                            const r = (a / (Math.PI * 4)) * (spacing / 2);
                            const px = x + Math.cos(a) * r;
                            const py = y + Math.sin(a) * r;
                            if (px >= 0 && px < this.width && py >= 0 && py < this.height && binary[Math.floor(py) * this.width + Math.floor(px)]) {
                                curl.push({ x: px, y: py });
                            }
                        }
                        if (curl.length > 2) paths.push(curl);
                    }
                }
            }
        }
        return paths;
    }

    _traceBoundary(startX, startY, binary, visited) {
        const path = [];
        let cx = startX, cy = startY;

        // Directions: E, SE, S, SW, W, NW, N, NE
        const dx = [1, 1, 0, -1, -1, -1, 0, 1];
        const dy = [0, 1, 1, 1, 0, -1, -1, -1];

        let dir = 0; // Current direction index

        for (let step = 0; step < 5000; step++) { // Safety limit
            path.push({ x: cx, y: cy });
            visited[cy * this.width + cx] = 1;

            let found = false;
            // Search in Moore neighborhood
            for (let i = 0; i < 8; i++) {
                const nextDir = (dir + 4 + i) % 8; // Start searching opposite to where we came from
                const nx = cx + dx[nextDir];
                const ny = cy + dy[nextDir];

                if (nx >= 0 && nx < this.width && ny >= 0 && ny < this.height) {
                    const idx = ny * this.width + nx;
                    if (binary[idx] === 1 && !visited[idx]) {
                        // Check if it's a boundary pixel
                        if (binary[idx - 1] === 0 || binary[idx + 1] === 0 ||
                            binary[idx - this.width] === 0 || binary[idx + this.width] === 0) {
                            cx = nx;
                            cy = ny;
                            dir = nextDir;
                            found = true;
                            break;
                        }
                    }
                }
            }
            if (!found) break;
            // Loop closed check
            if (cx === startX && cy === startY && path.length > 2) {
                path.push({ x: cx, y: cy }); // Close the shape perfectly
                break;
            }
        }
        return path;
    }

    /**
     * Improved Cross-Hatching
     */
    generateHatch(params) {
        const spacing = params.spacing || 5;
        const layers = params.layers || 2;
        const threshold = params.threshold || 128;
        const simplify = (params.simplify || 0) / 20;
        const paths = [];
        const angles = [45, -45, 0, 90];

        for (let l = 0; l < layers; l++) {
            const angle = angles[l] * (Math.PI / 180);
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            // Use threshold to shift the brightness tiers
            const tierBase = (threshold / (layers + 1));

            for (let d = -this.width - this.height; d < this.width + this.height; d += spacing) {
                let currentPath = [];
                const layerOffset = (spacing / 3) * (this.currentLayerIndex || 0);
                for (let t = -this.width - this.height; t < this.width + this.height; t += 2) {
                    const dOffset = d + layerOffset;
                    const x = Math.floor(dOffset * cos - t * sin);
                    const y = Math.floor(dOffset * sin + t * cos);

                    if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
                        const b = this.getBrightness(x, y);
                        // Density mapping using threshold-influenced tiers
                        if (b < tierBase * (layers - l + 1)) {
                            currentPath.push({ x, y });
                        } else {
                            if (currentPath.length > 1) {
                                // Efficient straight lines: just start and end!
                                paths.push([currentPath[0], currentPath[currentPath.length - 1]]);
                            }
                            currentPath = [];
                        }
                    } else {
                        if (currentPath.length > 1) {
                            paths.push([currentPath[0], currentPath[currentPath.length - 1]]);
                        }
                        currentPath = [];
                    }
                }
                if (currentPath.length > 1) {
                    paths.push([currentPath[0], currentPath[currentPath.length - 1]]);
                }
            }
        }
        return paths;
    }

    generateSpiral(params) {
        const spacing = params.spacing || 5;
        const threshold = params.threshold || 128;
        const centerX = this.width / 2;
        const centerY = this.height / 2;
        const maxRadius = Math.sqrt(centerX * centerX + centerY * centerY);
        const paths = [];
        let currentPath = [];
        
        const layerPhase = (Math.PI * 2 / 3) * (this.currentLayerIndex || 0);

        for (let i = 0; i < (maxRadius / spacing) * 100; i++) {
            const angle = i * 0.1 + layerPhase;
            const rBase = (angle / (Math.PI * 2)) * spacing;
            const xBase = centerX + Math.cos(angle) * rBase;
            const yBase = centerY + Math.sin(angle) * rBase;

            if (xBase >= 0 && xBase < this.width && yBase >= 0 && yBase < this.height) {
                const b = this.getBrightness(xBase, yBase);

                // Only distort/draw if below threshold
                if (b < threshold) {
                    const distortion = (1 - b / 255) * spacing * 0.8;
                    const r = rBase + Math.sin(angle * 8) * distortion;
                    currentPath.push({
                        x: centerX + Math.cos(angle) * r,
                        y: centerY + Math.sin(angle) * r
                    });
                } else {
                    if (currentPath.length > 1) paths.push(currentPath);
                    currentPath = [];
                }
            } else {
                if (currentPath.length > 1) paths.push(currentPath);
                currentPath = [];
            }
        }
        if (currentPath.length > 1) paths.push(currentPath);
        return paths;
    }

    generateWaves(params) {
        const spacing = params.spacing || 5;
        const amplitude = params.amplitude || 10;
        const paths = [];
        const layerOffset = (spacing / 3) * (this.currentLayerIndex || 0);
        const rowGap = Math.max(3, spacing);
        const cellWidth = Math.max(6, spacing * 1.5);
        const maxCycles = 8;
        const minCycles = 1;
        const samplesPerCycle = 10;

        for (let y = layerOffset; y <= this.height; y += rowGap) {
            const currentPath = [];

            for (let cellStartX = 0; cellStartX < this.width; cellStartX += cellWidth) {
                const cellEndX = Math.min(this.width, cellStartX + cellWidth);
                const sampleX = Math.min(this.width - 1, Math.max(0, Math.round((cellStartX + cellEndX) * 0.5)));
                const sampleY = Math.min(this.height - 1, Math.max(0, Math.round(y)));
                const brightness = this.getBrightness(sampleX, sampleY);
                const darkness = 1 - (brightness / 255);
                const cycles = Math.max(minCycles, Math.round(minCycles + (darkness * (maxCycles - minCycles))));
                const localAmplitude = amplitude * darkness;
                const samples = Math.max(4, cycles * samplesPerCycle);

                for (let i = 0; i <= samples; i++) {
                    const t = i / samples;
                    const x = cellStartX + ((cellEndX - cellStartX) * t);
                    const theta = t * Math.PI * 2 * cycles;
                    const yOffset = Math.sin(theta) * localAmplitude;
                    const point = { x, y: y + yOffset };

                    const prev = currentPath[currentPath.length - 1];
                    if (!prev || Math.abs(prev.x - point.x) > 0.01 || Math.abs(prev.y - point.y) > 0.01) {
                        currentPath.push(point);
                    }
                }
            }

            if (currentPath.length > 1) {
                paths.push(currentPath);
            }
        }

        return paths.map(p => this._pointsToSmoothSegments(p, params.style || 'curves'));
    }

    generateStippling(params) {
        const density = params.spacing || 10;
        const threshold = params.threshold || 128;
        const simplify = (params.simplify || 0) / 20;
        const paths = [];
        for (let y = 0; y < this.height; y += density) {
            for (let x = 0; x < this.width; x += density) {
                const b = this.getBrightness(x, y);
                if (b < threshold) {
                    const r = (1 - b / 255) * (density / 2);
                    if (r < 0.5) continue;
                    const circle = [];
                    const detail = 8;
                    for (let a = 0; a < Math.PI * 2; a += (Math.PI * 2 / detail)) {
                        circle.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
                    }
                    circle.push(circle[0]);

                    let p = circle;
                    if (simplify > 0) p = this._simplifyPath(p, simplify);
                    paths.push(p);
                }
            }
        }
        return paths;
    }

    generateFlowField(params) {
        const count = params.count || 500;
        const steps = params.steps || 50;
        const threshold = params.threshold || 128;
        const paths = [];
        
        // Use different starting points randomly for flow to avoid overlaps across layers
        Math.seedrandom && Math.seedrandom(this.currentLayerIndex || Math.random());
        
        for (let i = 0; i < count; i++) {
            let x = Math.random() * this.width, y = Math.random() * this.height;
            const currentPath = [{ x, y }];
            for (let s = 0; s < steps; s++) {
                const b = this.getBrightness(x, y);
                if (b > threshold) break; // Flow only in darker areas
                const angle = (b / 255) * Math.PI * 2;
                x += Math.cos(angle) * 3;
                y += Math.sin(angle) * 3;
                if (x < 0 || x >= this.width || y < 0 || y >= this.height) break;
                currentPath.push({ x, y });
            }
            if (currentPath.length > 2) paths.push(currentPath);
        }
        return paths;
    }

    generateShapeReplacement(params) {
        const size = params.spacing || 20;
        const shape = params.shape || 'rectangle';
        const paths = [];
        
        const layerOffsetX = (size / 3) * (this.currentLayerIndex || 0);
        const layerOffsetY = (size / 3) * (this.currentLayerIndex || 0);
        
        for (let y = size / 2 + layerOffsetY; y < this.height; y += size) {
            for (let x = size / 2 + layerOffsetX; x < this.width; x += size) {
                const b = this.getBrightness(x, y);
                const s = size * (1 - b / 255);
                if (s < 2) continue;

                let p = [];
                if (shape === 'circle') {
                    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
                        p.push({ x: x + Math.cos(a) * (s / 2), y: y + Math.sin(a) * (s / 2) });
                    }
                    p.push(p[0]);
                } else if (shape === 'triangle') {
                    p = [
                        { x: x, y: y - s / 2 },
                        { x: x + s / 2, y: y + s / 2 },
                        { x: x - s / 2, y: y + s / 2 },
                        { x: x, y: y - s / 2 }
                    ];
                } else if (shape === 'rhombus') {
                    p = [
                        { x: x, y: y - s / 2 },
                        { x: x + s / 2, y: y },
                        { x: x, y: y + s / 2 },
                        { x: x - s / 2, y: y },
                        { x: x, y: y - s / 2 }
                    ];
                } else if (shape === 'star') {
                    const outer = s / 2;
                    const inner = s / 4;
                    for (let i = 0; i <= 10; i++) {
                        const r = i % 2 === 0 ? outer : inner;
                        const a = Math.PI * 2 * (i / 10) - Math.PI / 2;
                        p.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
                    }
                } else if (shape === 'letter') {
                    // Letter X
                    paths.push([
                        { x: x - s / 2, y: y - s / 2 },
                        { x: x + s / 2, y: y + s / 2 }
                    ]);
                    paths.push([
                        { x: x + s / 2, y: y - s / 2 },
                        { x: x - s / 2, y: y + s / 2 }
                    ]);
                    continue;
                } else {
                    // Rectangle / Square (default)
                    const w = shape === 'rectangle' ? s : s;
                    const h = shape === 'rectangle' ? s * 0.5 : s;
                    p = [
                        { x: x - w / 2, y: y - h / 2 },
                        { x: x + w / 2, y: y - h / 2 },
                        { x: x + w / 2, y: y + h / 2 },
                        { x: x - w / 2, y: y + h / 2 },
                        { x: x - w / 2, y: y - h / 2 }
                    ];
                }

                if (p.length > 0) paths.push(p);
            }
        }
        return paths;
    }

    generateVoronoi(params) {
        // High quality jittered grid Voronoi approximation
        const count = 20; // Cells per row
        const sizeX = this.width / count;
        const sizeY = this.height / count;
        const sites = [];
        for (let y = 0; y < count; y++) {
            for (let x = 0; x < count; x++) {
                const b = this.getBrightness(x * sizeX, y * sizeY);
                if (b < 200) {
                    sites.push({
                        x: x * sizeX + (Math.random() - 0.5) * sizeX * 0.8,
                        y: y * sizeY + (Math.random() - 0.5) * sizeY * 0.8
                    });
                }
            }
        }
        // Just return dots/circles for now to avoid complex geometry
        return sites.map(s => [{ x: s.x - 2, y: s.y }, { x: s.x + 2, y: s.y }, { x: s.x, y: s.y - 2 }, { x: s.x, y: s.y + 2 }]);
    }

    generateTopographic(params) {
        const levels = params.levels || 5;
        let paths = [];
        for (let i = 1; i <= levels; i++) {
            paths = paths.concat(this.generateContours({ threshold: (255 / levels) * i, style: params.style }));
        }
        return paths;
    }

    async generateStringArt(params) {
        const lineCount = params.lines || 1500;
        const pinsCount = parseInt(params.pins) || 120;
        const shape = params.shape || 'circle';
        const lineWeight = params.lineWeight || 30; // 1-100
        const edgeBoost = params.edgeBoost || 50;   // 0-100

        const pins = this._generatePins(pinsCount, shape);
        if (pins.length === 0) return [];

        // --- PREPARATION (String Art 2.0) ---
        const target = new Float32Array(this.brightnessMap.length);
        const reconstruction = new Float32Array(this.brightnessMap.length).fill(0);

        // Calculate Target Image
        // Invert (0 is white, 255 is black) and apply robust stretching
        let sorted = new Float32Array(this.brightnessMap.length);
        sorted.set(this.brightnessMap);
        sorted.sort();
        let minB = sorted[Math.floor(sorted.length * 0.02)];
        let maxB = sorted[Math.floor(sorted.length * 0.98)];
        if (maxB <= minB) maxB = minB + 1;

        for (let i = 0; i < this.brightnessMap.length; i++) {
            const b = this.brightnessMap[i];
            const e = this.edgeMap ? this.edgeMap[i] : 0;

            // Background rejection (pure white)
            if (b > 250) {
                target[i] = 0;
                continue;
            }

            // Normalised darkness (0 to 1.0)
            let val = (maxB - b) / (maxB - minB);
            val = Math.max(0, Math.min(1.0, val));

            // Edge enhancement (multiplicative)
            if (edgeBoost > 0) {
                const edgeNorm = Math.min(255, e * 3) / 255;
                const boost = (edgeBoost / 100) * 4;
                val = val * (1.0 + edgeNorm * boost);
            }

            target[i] = Math.min(1.0, val) * 255;
        }

        const realPinsCount = pins.length;
        const samplingStep = 1.0; // Fixed for precision in 2.0

        // Cache management
        if (!this.lineCache || this.lastPinCount !== realPinsCount) {
            this.lineCache = this._precalculateLines(pins, samplingStep);
            this.lastPinCount = realPinsCount;
        }

        // Apply layer index offset to starting pin to distribute load across layers
        let cur = Math.floor((this.currentLayerIndex * realPinsCount) / 3) % realPinsCount;
        const path = [pins[cur]];
        const historySize = 24;
        const pinHistory = new Int32Array(historySize).fill(-1);
        let historyIdx = 0;

        // NEW: Enhanced Weight map mixing Edges and Laplacian fine details
        const weightMap = new Float32Array(target.length);
        const hasDetail = !!this.detailMap;
        for (let i = 0; i < target.length; i++) {
            const edgeVal = (this.edgeMap ? this.edgeMap[i] : 0) / 255;
            const laplacianVal = (hasDetail ? this.detailMap[i] : 0) / 255;
            const darkVal = target[i] / 255;

            // Bias strongly toward hard edges and fine local detail.
            weightMap[i] = 1.0 + (edgeVal * 7.0) + (laplacianVal * 18.0) + (darkVal * 0.75);
        }

        // NEW: Angular diversity tracking (72 bins for finer 5-degree control)
        const angleHistory = new Float32Array(72).fill(0);
        let lastAngleBin = -1;

        // NEW: Segment tracking to avoid exact same string overlaps
        const segmentUsage = new Uint16Array(realPinsCount * realPinsCount).fill(0);

        // Line influence
        const lineIntensity = 8 + (lineWeight / 100) * 28;

        for (let l = 0; l < lineCount; l++) {
            const candidates = [];

            // Speed optimization: for high pin counts, sample instead of checking all
            const step = realPinsCount > 300 ? 2 : 1;

            for (let next = 0; next < realPinsCount; next += step) {
                if (next === cur) continue;

                const pinDist = Math.abs(next - cur);
                const invDist = realPinsCount - pinDist;
                const MIN_DETAIL_DISTANCE = Math.max(20, Math.floor(realPinsCount / 7));
                if (pinDist < MIN_DETAIL_DISTANCE || invDist < MIN_DETAIL_DISTANCE) continue;

                const lineIdx = cur * realPinsCount + next;
                const samples = this.lineCache[lineIdx];
                if (!samples) continue;

                let score = 0;
                let peakResidual = 0;
                let detailSum = 0;
                let darkSum = 0;
                for (let i = 0; i < samples.length; i++) {
                    const idx = samples[i];
                    const gain = Math.max(0, target[idx] - reconstruction[idx]);
                    if (gain <= 0) continue;

                    const detailSignal = Math.max(
                        this.edgeMap ? this.edgeMap[idx] / 255 : 0,
                        hasDetail ? this.detailMap[idx] / 255 : 0
                    );
                    const darkSignal = target[idx] / 255;

                    score += gain * weightMap[idx];
                    peakResidual = Math.max(peakResidual, gain * (1 + detailSignal));
                    detailSum += detailSignal;
                    darkSum += darkSignal;
                }

                if (score <= 0) continue;

                const avgDetail = detailSum / samples.length;
                const avgDark = darkSum / samples.length;

                // Keep favoring shorter lines for definition, but not so strongly that
                // longer structural lines disappear completely.
                score = score / Math.pow(samples.length, 1.1);
                score *= 1.0 + (avgDetail * 2.6) + (avgDark * 0.35) + ((peakResidual / 255) * 1.8);

                // Angular Diversity Penalty
                const p1 = pins[cur], p2 = pins[next];
                const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                let normAngle = angle < 0 ? angle + Math.PI : angle;
                if (normAngle >= Math.PI) normAngle -= Math.PI;
                const angleBin = Math.floor((normAngle / Math.PI) * 72) % 72;

                let anglePenalty = 1.0 / (1.0 + angleHistory[angleBin] * 3.5);

                // Consecutivity Penalty: avoid same angle as immediately previous line
                if (lastAngleBin !== -1) {
                    const binDiff = Math.abs(angleBin - lastAngleBin);
                    if (binDiff <= 2 || binDiff >= 70) anglePenalty *= 0.35;
                }

                score *= anglePenalty;

                // History Penalty
                for (let h = 0; h < historySize; h++) {
                    if (pinHistory[h] === next) {
                        score *= 0.2;
                        break;
                    }
                }

                // Segment Usage Penalty
                const usageCount = segmentUsage[lineIdx];
                if (usageCount > 0) {
                    score *= Math.pow(0.3, usageCount);
                }

                if (score > 0) {
                    candidates.push({ pin: next, score, bin: angleBin });
                }
            }

            if (candidates.length === 0) break;

            candidates.sort((a, b) => b.score - a.score);

            const topPoolSize = Math.min(6, candidates.length);
            const maxScore = candidates[0].score;
            let poolCount = 0;
            while (poolCount < topPoolSize && candidates[poolCount].score > maxScore * 0.82) {
                poolCount++;
            }

            const progress = l / Math.max(1, lineCount - 1);
            const exploreChance = 0.22 * (1.0 - progress);
            let selected = candidates[0];

            if (poolCount > 1 && Math.random() < exploreChance) {
                let totalWeight = 0;
                const weighted = [];
                for (let i = 0; i < poolCount; i++) {
                    const w = Math.pow(candidates[i].score / maxScore, 2.5);
                    weighted.push(w);
                    totalWeight += w;
                }

                let pick = Math.random() * totalWeight;
                for (let i = 0; i < poolCount; i++) {
                    pick -= weighted[i];
                    if (pick <= 0) {
                        selected = candidates[i];
                        break;
                    }
                }
            }
            const bestPin = selected.pin;

            const lineIdx = cur * realPinsCount + bestPin;
            const revLineIdx = bestPin * realPinsCount + cur;
            const samples = this.lineCache[lineIdx];

            for (let i = 0; i < samples.length; i++) {
                const idx = samples[i];
                reconstruction[idx] = Math.min(255, reconstruction[idx] + lineIntensity);
            }

            pinHistory[historyIdx] = bestPin;
            historyIdx = (historyIdx + 1) % historySize;
            segmentUsage[lineIdx]++;
            segmentUsage[revLineIdx]++;

            angleHistory[selected.bin] += 1.0;
            lastAngleBin = selected.bin;

            for (let a = 0; a < 72; a++) angleHistory[a] *= 0.998;

            cur = bestPin;
            path.push(pins[cur]);

            if (l % 100 === 0) await new Promise(r => setTimeout(r, 0));
        }

        return [path];
    }

    _precalculateLines(pins, step) {
        const count = pins.length;
        const cache = new Array(count * count);
        for (let i = 0; i < count; i++) {
            for (let j = 0; j < count; j++) {
                if (i === j) continue;
                const p1 = pins[i], p2 = pins[j];
                const dx = p2.x - p1.x, dy = p2.y - p1.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                const numSamples = Math.max(2, Math.floor(len / step));
                let uniqueIndices = new Set();
                for (let s = 0; s < numSamples; s++) {
                    const sx = Math.floor(p1.x + dx * (s / (numSamples - 1)));
                    const sy = Math.floor(p1.y + dy * (s / (numSamples - 1)));
                    uniqueIndices.add(sy * this.width + sx);
                }
                cache[i * count + j] = Int32Array.from(uniqueIndices);
            }
        }
        return cache;
    }

    _generatePins(pinsCount, shape) {
        const pins = [];
        const cx = this.width / 2, cy = this.height / 2;
        const r = Math.min(cx, cy) - 10;
        const safeShape = ['circle', 'rectangle', 'triangle'].includes(shape) ? shape : 'circle';

        if (safeShape === 'circle') {
            for (let i = 0; i < pinsCount; i++) {
                const a = (i / pinsCount) * Math.PI * 2;
                pins.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
            }
        } else if (safeShape === 'rectangle') {
            const margin = 10;
            const left = margin;
            const right = this.width - margin;
            const top = margin;
            const bottom = this.height - margin;
            pins.push(...this._generatePolygonPins(pinsCount, [
                { x: left, y: top },
                { x: right, y: top },
                { x: right, y: bottom },
                { x: left, y: bottom }
            ]));
        } else if (safeShape === 'triangle') {
            const triHalfWidth = Math.min(r, (this.width / 2) - 10);
            const triBottom = this.height - 10;
            const triTop = 10;
            pins.push(...this._generatePolygonPins(pinsCount, [
                { x: cx, y: triTop },
                { x: cx + triHalfWidth, y: triBottom },
                { x: cx - triHalfWidth, y: triBottom }
            ]));
        }
        return pins;
    }

    _generatePolygonPins(pinsCount, vertices) {
        if (!vertices || vertices.length < 2 || pinsCount <= 0) return [];

        const edges = [];
        let perimeter = 0;
        for (let i = 0; i < vertices.length; i++) {
            const p0 = vertices[i];
            const p1 = vertices[(i + 1) % vertices.length];
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            edges.push({ p0, p1, length });
            perimeter += length;
        }

        if (perimeter <= 0) return [];

        const pins = [];
        for (let i = 0; i < pinsCount; i++) {
            const dist = (i / pinsCount) * perimeter;
            let remaining = dist;

            for (let e = 0; e < edges.length; e++) {
                const edge = edges[e];
                if (remaining <= edge.length || e === edges.length - 1) {
                    const t = edge.length > 0 ? (remaining / edge.length) : 0;
                    pins.push({
                        x: edge.p0.x + (edge.p1.x - edge.p0.x) * t,
                        y: edge.p0.y + (edge.p1.y - edge.p0.y) * t
                    });
                    break;
                }
                remaining -= edge.length;
            }
        }

        return pins;
    }
}

if (typeof module !== 'undefined') module.exports = ImageVectorEngine;
else window.ImageVectorEngine = ImageVectorEngine;
