class CreativeTextEngine {
    static STORAGE_KEY = 'creativeUploadedFonts';
    static builtinFonts = [
        { id: 'bungee', label: 'Bungee', family: '"Bungee", "Arial Black", sans-serif', source: 'builtin', style: 'Blocky' },
        { id: 'fredoka', label: 'Fredoka', family: '"Fredoka", "Trebuchet MS", sans-serif', source: 'builtin', style: 'Rounded' },
        { id: 'baloo2', label: 'Baloo 2', family: '"Baloo 2", "Trebuchet MS", sans-serif', source: 'builtin', style: 'Playful' },
        { id: 'lilitaone', label: 'Lilita One', family: '"Lilita One", Impact, sans-serif', source: 'builtin', style: 'Bold' },
        { id: 'bebasneue', label: 'Bebas Neue', family: '"Bebas Neue", Impact, sans-serif', source: 'builtin', style: 'Poster' },
        { id: 'anton', label: 'Anton', family: '"Anton", Impact, sans-serif', source: 'builtin', style: 'Heavy' },
        { id: 'comfortaa', label: 'Comfortaa', family: '"Comfortaa", "Segoe UI", sans-serif', source: 'builtin', style: 'Curvy' },
        { id: 'pacifico', label: 'Pacifico', family: '"Pacifico", "Brush Script MT", cursive', source: 'builtin', style: 'Script' },
        { id: 'archivoblack', label: 'Archivo Black', family: '"Archivo Black", "Arial Black", sans-serif', source: 'builtin', style: 'Modern' },
        { id: 'luckiestguy', label: 'Luckiest Guy', family: '"Luckiest Guy", Impact, sans-serif', source: 'builtin', style: 'Fun' }
    ];

    static uploadedFonts = [];
    static fontCounter = 0;

    static getAllFonts() {
        return [...this.builtinFonts, ...this.uploadedFonts];
    }

    static getFontById(fontId) {
        return this.getAllFonts().find(font => font.id === fontId) || this.builtinFonts[0];
    }

    static fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read the font file.'));
            reader.readAsDataURL(file);
        });
    }

    static registerUploadedFont(entry) {
        if (!entry?.id || !entry?.dataUrl) throw new Error('Uploaded font entry is missing required data.');

        const existing = this.uploadedFonts.find(font => font.id === entry.id);
        if (existing) return existing;

        const familyName = entry.familyName || `CreativeUpload${++this.fontCounter}`;
        const fontFace = new FontFace(familyName, `url(${entry.dataUrl})`);
        document.fonts.add(fontFace);
        void fontFace.load().catch(() => {});

        const normalized = {
            id: entry.id,
            label: entry.label || 'Uploaded Font',
            family: `"${familyName}", "${entry.label || 'Uploaded Font'}", sans-serif`,
            familyName,
            source: 'upload',
            style: entry.style || 'Uploaded',
            dataUrl: entry.dataUrl
        };
        this.uploadedFonts.push(normalized);
        return normalized;
    }

    static persistUploadedFonts() {
        try {
            const payload = this.uploadedFonts.map(font => ({
                id: font.id,
                label: font.label,
                familyName: font.familyName,
                style: font.style || 'Uploaded',
                dataUrl: font.dataUrl
            }));
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(payload));
        } catch (error) {
            console.error('CreativeTextEngine persist fail:', error);
        }
    }

    static async hydratePersistedFonts() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (!saved) return [];
            const entries = JSON.parse(saved);
            if (!Array.isArray(entries) || entries.length === 0) return [];

            const restored = [];
            for (const entry of entries) {
                if (!entry?.dataUrl || !entry?.id) continue;
                try {
                    const registered = this.registerUploadedFont(entry);
                    restored.push(registered);
                } catch (error) {
                    console.error('CreativeTextEngine restore font fail:', error);
                }
            }
            this.persistUploadedFonts();
            return restored;
        } catch (error) {
            console.error('CreativeTextEngine hydrate fail:', error);
            return [];
        }
    }

    static getFontFamily(path) {
        const fontId = typeof path === 'string' ? path : path?.creativeFontId;
        const font = this.getFontById(fontId);
        return font?.family || '"Bungee", "Arial Black", sans-serif';
    }

    static async loadUploadedFont(file) {
        if (!file) throw new Error('No font file selected.');
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        if (!['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
            throw new Error('Use a TTF, OTF, WOFF, or WOFF2 font file.');
        }

        const safeBase = (file.name.replace(/\.[^.]+$/, '') || 'Uploaded Font').replace(/[^a-z0-9]+/gi, ' ').trim();
        const dataUrl = await this.fileToDataURL(file);
        const entry = this.registerUploadedFont({
            id: `upload_${Date.now()}_${this.fontCounter + 1}`,
            label: safeBase,
            familyName: `CreativeUpload${++this.fontCounter}`,
            style: 'Uploaded',
            dataUrl
        });
        this.persistUploadedFonts();
        return entry;
    }

    static getCacheKey(path) {
        return [
            path.text || '',
            path.fontSize || 10,
            path.rotation || 0,
            path.creativeFontId || 'bungee',
            path.letterSpacing || 0,
            path.curve || 0,
            path.x || 0,
            path.y || 0
        ].join('|');
    }

    static removeCollinearPoints(points) {
        if (!Array.isArray(points) || points.length < 4) return points ? points.slice() : [];
        const cleaned = [];
        for (let i = 0; i < points.length; i++) {
            const prev = points[(i - 1 + points.length) % points.length];
            const current = points[i];
            const next = points[(i + 1) % points.length];
            const sameX = Math.abs(prev.x - current.x) < 1e-6 && Math.abs(current.x - next.x) < 1e-6;
            const sameY = Math.abs(prev.y - current.y) < 1e-6 && Math.abs(current.y - next.y) < 1e-6;
            if (sameX || sameY) continue;
            cleaned.push(current);
        }
        return cleaned.length >= 3 ? cleaned : points.slice();
    }

    static simplifyLoop(points, epsilon = 0.06) {
        if (!Array.isArray(points) || points.length < 4) return points ? points.slice() : [];
        const source = points.slice();

        const perpendicularDistance = (point, lineStart, lineEnd) => {
            const dx = lineEnd.x - lineStart.x;
            const dy = lineEnd.y - lineStart.y;
            if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
                return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
            }
            const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / ((dx * dx) + (dy * dy));
            const projX = lineStart.x + (t * dx);
            const projY = lineStart.y + (t * dy);
            return Math.hypot(point.x - projX, point.y - projY);
        };

        const rdp = (pts) => {
            if (pts.length <= 2) return pts.slice();
            let maxDistance = -1;
            let splitIndex = -1;
            for (let i = 1; i < pts.length - 1; i++) {
                const distance = perpendicularDistance(pts[i], pts[0], pts[pts.length - 1]);
                if (distance > maxDistance) {
                    maxDistance = distance;
                    splitIndex = i;
                }
            }
            if (maxDistance <= epsilon || splitIndex === -1) {
                return [pts[0], pts[pts.length - 1]];
            }
            const left = rdp(pts.slice(0, splitIndex + 1));
            const right = rdp(pts.slice(splitIndex));
            return left.slice(0, -1).concat(right);
        };

        const open = source.concat([source[0]]);
        const simplifiedOpen = rdp(open);
        const simplified = simplifiedOpen.slice(0, -1);
        return this.removeCollinearPoints(simplified);
    }

    static traceLoops(binary, width, height) {
        const edges = [];
        const isFilled = (x, y) => {
            if (x < 0 || y < 0 || x >= width || y >= height) return false;
            return binary[(y * width) + x] === 1;
        };

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!isFilled(x, y)) continue;
                if (!isFilled(x, y - 1)) edges.push({ start: { x, y }, end: { x: x + 1, y } });
                if (!isFilled(x + 1, y)) edges.push({ start: { x: x + 1, y }, end: { x: x + 1, y: y + 1 } });
                if (!isFilled(x, y + 1)) edges.push({ start: { x: x + 1, y: y + 1 }, end: { x, y: y + 1 } });
                if (!isFilled(x - 1, y)) edges.push({ start: { x, y: y + 1 }, end: { x, y } });
            }
        }

        const startMap = new Map();
        edges.forEach((edge, index) => {
            const key = `${edge.start.x},${edge.start.y}`;
            if (!startMap.has(key)) startMap.set(key, []);
            startMap.get(key).push(index);
        });

        const used = new Set();
        const loops = [];
        for (let i = 0; i < edges.length; i++) {
            if (used.has(i)) continue;
            const loop = [];
            let edgeIndex = i;
            while (!used.has(edgeIndex)) {
                used.add(edgeIndex);
                const edge = edges[edgeIndex];
                if (loop.length === 0) loop.push({ x: edge.start.x, y: edge.start.y });
                loop.push({ x: edge.end.x, y: edge.end.y });
                const nextKey = `${edge.end.x},${edge.end.y}`;
                const candidates = startMap.get(nextKey) || [];
                const nextIndex = candidates.find(candidate => !used.has(candidate));
                if (nextIndex == null) break;
                edgeIndex = nextIndex;
            }
            if (loop.length >= 4) loops.push(loop);
        }
        return loops;
    }

    static buildRasterLayout(path) {
        const text = String(path?.text || '');
        const family = this.getFontFamily(path);
        const letterSpacingMm = path?.letterSpacing || 0;
        let pixelsPerMm = 8;
        let fontPx = Math.max(24, (path.fontSize || 10) * pixelsPerMm);
        const probe = document.createElement('canvas');
        const probeCtx = probe.getContext('2d');
        if (!probeCtx) return null;

        const fitCanvas = () => {
            probeCtx.font = `${fontPx}px ${family}`;
            const chars = Array.from(text || ' ');
            const letterSpacingPx = letterSpacingMm * pixelsPerMm;
            let penX = 0;
            let minX = Infinity;
            let maxX = -Infinity;
            let maxAscent = 0;
            let maxDescent = 0;
            const glyphs = chars.map((char, index) => {
                const metrics = probeCtx.measureText(char);
                const left = metrics.actualBoundingBoxLeft || 0;
                const right = metrics.actualBoundingBoxRight || metrics.width || fontPx * 0.6;
                const ascent = metrics.actualBoundingBoxAscent || fontPx * 0.8;
                const descent = metrics.actualBoundingBoxDescent || fontPx * 0.2;
                const startX = penX;
                minX = Math.min(minX, startX - left);
                maxX = Math.max(maxX, startX + right);
                maxAscent = Math.max(maxAscent, ascent);
                maxDescent = Math.max(maxDescent, descent);
                penX += metrics.width + (index < chars.length - 1 ? letterSpacingPx : 0);
                return { char, metrics, startX };
            });

            if (!glyphs.length) {
                const metrics = probeCtx.measureText(' ');
                glyphs.push({ char: ' ', metrics, startX: 0 });
                minX = 0;
                maxX = metrics.width || fontPx * 0.6;
                maxAscent = metrics.actualBoundingBoxAscent || fontPx * 0.8;
                maxDescent = metrics.actualBoundingBoxDescent || fontPx * 0.2;
            }

            const pad = Math.ceil(fontPx * 0.25) + 6;
            const width = Math.max(24, Math.ceil((maxX - minX) + (pad * 2)));
            const height = Math.max(24, Math.ceil(maxAscent + maxDescent + (pad * 2)));
            return {
                glyphs,
                pad,
                width,
                height,
                minX,
                maxX,
                maxAscent,
                maxDescent,
                advancePx: maxX - minX
            };
        };

        let layout = fitCanvas();
        while ((layout.width > 4096 || layout.height > 2048) && pixelsPerMm > 3) {
            pixelsPerMm -= 1;
            fontPx = Math.max(18, (path.fontSize || 10) * pixelsPerMm);
            layout = fitCanvas();
        }

        const canvas = document.createElement('canvas');
        canvas.width = layout.width;
        canvas.height = layout.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `${fontPx}px ${family}`;

        const originX = layout.pad - layout.minX;
        const baselineY = layout.pad + layout.maxAscent;
        layout.glyphs.forEach(glyph => {
            ctx.fillText(glyph.char, originX + glyph.startX, baselineY);
        });

        return {
            canvas,
            ctx,
            pixelsPerMm,
            fontPx,
            originX,
            baselineY,
            ascentMM: layout.maxAscent / pixelsPerMm,
            descentMM: layout.maxDescent / pixelsPerMm,
            advanceMM: layout.advancePx / pixelsPerMm,
            curve: path?.curve || 0
        };
    }

    static getOutlineLoops(path) {
        if (!path || path.type !== 'text' || path.textMode !== 'creative' || !path.text) return [];
        const cacheKey = this.getCacheKey(path);
        if (path._creativeOutlineCache && path._creativeOutlineCache.key === cacheKey) {
            return path._creativeOutlineCache.loops;
        }

        const layout = this.buildRasterLayout(path);
        if (!layout) return [];

        const { canvas, ctx, pixelsPerMm, originX, baselineY } = layout;
        const { width, height, data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const binary = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const alpha = data[((y * width) + x) * 4 + 3];
                binary[(y * width) + x] = alpha > 24 ? 1 : 0;
            }
        }

        const rawLoops = this.traceLoops(binary, width, height);
        const angle = (path.rotation || 0) * (Math.PI / 180);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const rotatePoint = (localX, localY) => ({
            x: path.x + (localX * cosA - localY * sinA),
            y: path.y + (localX * sinA + localY * cosA)
        });
        const advanceMM = layout.advanceMM || 0;
        const curveAmount = path?.curve || 0;
        const warpPoint = (localX, localY) => {
            if (Math.abs(curveAmount) < 0.001 || advanceMM <= 0.001) return { x: localX, y: localY };
            const centerX = advanceMM / 2;
            const normalized = (localX - centerX) / Math.max(0.001, advanceMM / 2);
            const offsetY = -curveAmount * Math.max(0, 1 - (normalized * normalized));
            return { x: localX, y: localY + offsetY };
        };

        const loops = rawLoops
            .map(loop => loop.map(point => {
                const localX = (point.x - originX) / pixelsPerMm;
                const localY = (point.y - baselineY) / pixelsPerMm;
                const warped = warpPoint(localX, localY);
                return rotatePoint(warped.x, warped.y);
            }))
            .map(loop => this.simplifyLoop(loop))
            .filter(loop => Array.isArray(loop) && loop.length >= 3);

        path._creativeOutlineCache = {
            key: cacheKey,
            loops,
            layout
        };
        return loops;
    }

    static getLayoutMetrics(path) {
        const cacheKey = this.getCacheKey(path);
        if (path?._creativeOutlineCache?.key === cacheKey && path._creativeOutlineCache.layout) {
            return path._creativeOutlineCache.layout;
        }
        const layout = this.buildRasterLayout(path);
        if (!layout) {
            return {
                advanceMM: (String(path?.text || '').length || 1) * ((path?.fontSize || 10) * 0.7),
                ascentMM: (path?.fontSize || 10) * 0.8,
                descentMM: (path?.fontSize || 10) * 0.2
            };
        }
        if (!path._creativeOutlineCache || path._creativeOutlineCache.key !== cacheKey) {
            path._creativeOutlineCache = { key: cacheKey, loops: null, layout };
        } else {
            path._creativeOutlineCache.layout = layout;
        }
        return layout;
    }

    static getSegments(path) {
        const loops = this.getOutlineLoops(path);
        const segments = [];
        loops.forEach(loop => {
            for (let i = 0; i < loop.length; i++) {
                const start = loop[i];
                const end = loop[(i + 1) % loop.length];
                segments.push({
                    x1: start.x,
                    y1: start.y,
                    x2: end.x,
                    y2: end.y
                });
            }
        });
        return segments;
    }

    static getBoundingBox(path) {
        const loops = this.getOutlineLoops(path);
        if (!loops.length) return null;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        loops.forEach(loop => {
            loop.forEach(point => {
                if (point.x < minX) minX = point.x;
                if (point.x > maxX) maxX = point.x;
                if (point.y < minY) minY = point.y;
                if (point.y > maxY) maxY = point.y;
            });
        });
        if (!Number.isFinite(minX)) return null;
        return { minX, minY, maxX, maxY };
    }

    static draw(ctx, path, mmToPx, viewZoom = 1, isEditing = false, cursorBlink = false) {
        const loops = this.getOutlineLoops(path);
        ctx.save();
        if (loops.length) {
            ctx.beginPath();
            loops.forEach(loop => {
                if (!loop.length) return;
                ctx.moveTo(loop[0].x * mmToPx, loop[0].y * mmToPx);
                for (let i = 1; i < loop.length; i++) {
                    ctx.lineTo(loop[i].x * mmToPx, loop[i].y * mmToPx);
                }
                ctx.closePath();
            });
            ctx.stroke();
        }

        if (isEditing && cursorBlink) {
            const metrics = this.getLayoutMetrics(path);
            const angle = (path.rotation || 0) * (Math.PI / 180);
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            const cursorHeight = metrics.ascentMM + metrics.descentMM;
            const curveAmount = path?.curve || 0;
            const normalized = metrics.advanceMM > 0.001 ? 1 : 0;
            const offsetY = -curveAmount * Math.max(0, 1 - (normalized * normalized));
            const startX = path.x + (metrics.advanceMM * cosA) + (-offsetY * sinA);
            const startY = path.y + (metrics.advanceMM * sinA) + (offsetY * cosA);
            const endX = startX + (-sinA * cursorHeight);
            const endY = startY + (cosA * cursorHeight);
            ctx.beginPath();
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = Math.max(0.2 / Math.max(1, viewZoom), 0.35 * mmToPx);
            ctx.moveTo(startX * mmToPx, startY * mmToPx);
            ctx.lineTo(endX * mmToPx, endY * mmToPx);
            ctx.stroke();
        }

        ctx.restore();
    }

    static buildPlotLoops(path) {
        return this.getOutlineLoops(path).map(loop => loop.concat([{ ...loop[0] }]));
    }

    static explodeToPaths(path) {
        const loops = this.buildPlotLoops(path);
        const groupId = `creative_text_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        return loops.map(loop => ({
            type: 'polyline',
            points: loop.map(point => ({ x: point.x, y: point.y })),
            pen: path.pen || 1,
            closed: true,
            groupId
        }));
    }
}

window.CreativeTextEngine = CreativeTextEngine;
