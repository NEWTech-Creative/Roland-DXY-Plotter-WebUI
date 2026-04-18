class HpglParser {
    constructor(app) {
        this.app = app;
        this.currentPen = 1;

        // Roland units: 1 plotter unit = 0.025 mm
        this.UNITS_PER_MM = 40;
    }

    setCurrentPen(penNumber) {
        this.currentPen = penNumber;
        this.app.ui?.setActiveVisualizerPen?.(penNumber);
        this.app.ui.logToConsole(`System: Active Pen set to P${penNumber}`);
    }

    getRolandTextRotationIndex(rotation) {
        const quarterTurns = Math.round((rotation || 0) / 90);
        return ((quarterTurns % 4) + 4) % 4;
    }

    getOutputFlipSettings() {
        const settings = this.app?.settings || {};
        return {
            horizontal: settings.outputFlipHorizontal === true,
            vertical: settings.outputFlipVertical !== false
        };
    }

    transformOutputPoint(xMM, yMM) {
        const { horizontal, vertical } = this.getOutputFlipSettings();
        const bedWidth = this.app?.settings?.bedWidth || this.app?.canvas?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || this.app?.canvas?.bedHeight || 297;

        return {
            x: horizontal ? (bedWidth - xMM) : xMM,
            y: vertical ? (bedHeight - yMM) : yMM
        };
    }

    inverseTransformOutputPoint(xMM, yMM) {
        // Flips are their own inverse, so map machine-space coordinates back to visualiser-space.
        return this.transformOutputPoint(xMM, yMM);
    }

    transformOutputPoints(points = []) {
        return points.map(point => this.transformOutputPoint(point.x, point.y));
    }

    transformSvgExportPoint(xMM, yMM) {
        return { x: xMM, y: yMM };
    }

    transformSvgExportPoints(points = []) {
        return points.map(point => this.transformSvgExportPoint(point.x, point.y));
    }

    escapeSvgText(value = '') {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    buildSvgPathDataFromPolygon(points = []) {
        if (!Array.isArray(points) || points.length < 3) return '';
        const validPoints = points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (validPoints.length < 3) return '';
        const commands = [`M ${validPoints[0].x.toFixed(3)} ${validPoints[0].y.toFixed(3)}`];
        for (let i = 1; i < validPoints.length; i++) {
            commands.push(`L ${validPoints[i].x.toFixed(3)} ${validPoints[i].y.toFixed(3)}`);
        }
        commands.push('Z');
        return commands.join(' ');
    }

    buildSvgPathDataFromRegion(region) {
        if (!Array.isArray(region?.polygon) || region.polygon.length < 3) return '';
        const outerPath = this.buildSvgPathDataFromPolygon(this.transformSvgExportPoints(region.polygon));
        if (!outerPath) return '';
        const holePaths = Array.isArray(region.holePolygons)
            ? region.holePolygons
                .map(polygon => this.buildSvgPathDataFromPolygon(this.transformSvgExportPoints(polygon)))
                .filter(Boolean)
            : [];
        return [outerPath, ...holePaths].join(' ');
    }

    getFillDebugColor(index = 0, alpha = 0.22) {
        const hue = (index * 57) % 360;
        return `hsla(${hue}, 80%, 55%, ${alpha})`;
    }

    exportFillDebugSVG(paths, canvasManager = null) {
        const canvas = canvasManager || this.app?.canvas;
        if (!canvas || !paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to export.');
            return '';
        }

        const bedWidth = this.app?.settings?.bedWidth || canvas?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || canvas?.bedHeight || 297;
        const regions = Array.isArray(canvas?.getClosedFillRegions?.()) ? canvas.getClosedFillRegions() : [];
        const hoverRegion = canvas?.bucketHoverRegion || null;
        const hoverRegionId = hoverRegion?.regionId || '';
        const elements = [
            `<rect x="0" y="0" width="${bedWidth}" height="${bedHeight}" fill="#ffffff" />`
        ];

        const sourceElements = [];
        paths.forEach(path => {
            const pen = path.pen || 1;
            const penCfg = this.app?.ui?.visPenConfig?.[pen - 1];
            if (penCfg && penCfg.visible === false) return;

            const stroke = penCfg?.color || '#7c3aed';
            const strokeWidth = Math.max(0.08, (penCfg?.thickness || 0.3) * 0.65);

            if (path.type === 'circle') {
                const center = this.transformSvgExportPoint(path.x, path.y);
                sourceElements.push(`<circle cx="${center.x.toFixed(3)}" cy="${center.y.toFixed(3)}" r="${(path.r || 0).toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" opacity="0.85" />`);
                return;
            }

            if (path.type === 'rectangle') {
                const points = this.transformSvgExportPoints(this.getRectanglePoints(path.x, path.y, path.x + (path.w || 0), path.y + (path.h || 0)));
                sourceElements.push(`<polyline points="${points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" opacity="0.85" />`);
                return;
            }

            const points = this.getExportTracePointsForPath(path);
            if (!points || points.length < 2) return;
            const transformedPoints = this.transformSvgExportPoints(points);
            sourceElements.push(`<polyline points="${transformedPoints.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" opacity="0.85" />`);
        });
        if (sourceElements.length) {
            elements.push(`<g id="source-geometry">${sourceElements.join('\n')}</g>`);
        }

        const regionElements = [];
        const labelElements = [];
        regions.forEach((region, index) => {
            const pathData = this.buildSvgPathDataFromRegion(region);
            if (!pathData) return;
            const isHoverRegion = hoverRegionId && hoverRegionId === (region.regionId || '');
            const fill = this.getFillDebugColor(index, isHoverRegion ? 0.3 : 0.18);
            const stroke = isHoverRegion ? '#0ea5e9' : (region.isEmbeddedLoop ? '#f97316' : '#2563eb');
            const strokeWidth = isHoverRegion ? 0.8 : 0.35;
            regionElements.push(`<path d="${pathData}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" vector-effect="non-scaling-stroke" />`);

            const labelSource = canvas?.getPolygonInteriorPoint?.(region.polygon);
            if (labelSource && Number.isFinite(labelSource.x) && Number.isFinite(labelSource.y)) {
                const labelPoint = this.transformSvgExportPoint(labelSource.x, labelSource.y);
                const label = this.escapeSvgText(`${index + 1}: ${region.regionId || `p${region.pathIdx}`}`);
                labelElements.push(`<text x="${labelPoint.x.toFixed(3)}" y="${labelPoint.y.toFixed(3)}" font-size="3.2" fill="${isHoverRegion ? '#075985' : '#111827'}" stroke="#ffffff" stroke-width="0.35" paint-order="stroke fill">${label}</text>`);
            }
        });
        if (regionElements.length) {
            elements.push(`<g id="fill-regions">${regionElements.join('\n')}</g>`);
        }
        if (labelElements.length) {
            elements.push(`<g id="fill-region-labels">${labelElements.join('\n')}</g>`);
        }

        const summaryLines = [
            `Detected fill regions: ${regions.length}`,
            hoverRegionId ? `Hovered target: ${hoverRegionId}` : 'Hovered target: none'
        ];
        elements.push(`<g id="debug-summary"><rect x="4" y="4" width="90" height="${(summaryLines.length * 5) + 6}" fill="rgba(255,255,255,0.88)" stroke="#cbd5e1" stroke-width="0.3" />${summaryLines.map((line, index) => `<text x="7" y="${10 + (index * 5)}" font-size="3.2" fill="#111827">${this.escapeSvgText(line)}</text>`).join('')}</g>`);

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${bedWidth} ${bedHeight}" width="${bedWidth}mm" height="${bedHeight}mm">`,
            ...elements,
            '</svg>'
        ].join('\n');
    }

    transformOutputRotation(rotation = 0) {
        const { horizontal, vertical } = this.getOutputFlipSettings();
        const radians = (rotation || 0) * (Math.PI / 180);
        const scaleX = horizontal ? -1 : 1;
        const scaleY = vertical ? -1 : 1;
        const transformedAngle = Math.atan2(Math.sin(radians) * scaleY, Math.cos(radians) * scaleX);
        return Math.round((transformedAngle * 180) / Math.PI / 90) * 90;
    }

    generateCircle(xMM, yMM, rMM) {
        const point = this.transformOutputPoint(xMM, yMM);
        const x = Math.round(point.x * this.UNITS_PER_MM);
        const y = Math.round(point.y * this.UNITS_PER_MM);
        const r = Math.round(rMM * this.UNITS_PER_MM);

        return [
            `PU${x},${y};`,
            `CI${r};`,
            'PU;'
        ];
    }

    getRectanglePoints(x1MM, y1MM, x2MM, y2MM) {
        return [
            { x: x1MM, y: y1MM },
            { x: x2MM, y: y1MM },
            { x: x2MM, y: y2MM },
            { x: x1MM, y: y2MM },
            { x: x1MM, y: y1MM }
        ];
    }

    generateRectangle(x1MM, y1MM, x2MM, y2MM) {
        return this.generatePolylineCommands(this.getRectanglePoints(x1MM, y1MM, x2MM, y2MM));
    }

    generateText(text, xMM, yMM, fontSize = 10, rotation = 0) {
        const point = this.transformOutputPoint(xMM, yMM);
        const x = Math.round(point.x * this.UNITS_PER_MM);
        const y = Math.round(point.y * this.UNITS_PER_MM);
        const transformedRotation = this.transformOutputRotation(rotation);

        // Roland S command: n=0 -> 0.8mm, n=127 -> 102.4mm
        const nAtSize = Math.max(0, Math.min(127, Math.round(fontSize / 0.8) - 1));

        // Roland Q command: 0=0, 1=90, 2=180, 3=270
        const nAtRotate = this.getRolandTextRotationIndex(transformedRotation);

        return [
            `PA${x},${y};`,
            `S${nAtSize};`,
            `Q${nAtRotate};`,
            `LB${text}\x03`, // Terminator CHR$(3)
            'Q0;'
        ];
    }

    generateCurve(points, closed = false) {
        if (!points || points.length < (closed ? 3 : 3)) return []; // Y requires at least 3 pairs for m=0,1

        const m = closed ? 1 : 0; // Absolute curves
        const coords = this.transformOutputPoints(points).map(p => {
            const ux = Math.round(p.x * this.UNITS_PER_MM);
            const uy = Math.round(p.y * this.UNITS_PER_MM);
            return `${ux},${uy}`;
        }).join(",");

        return [`Y${m},${coords};`];
    }

    isRolandTextPath(path) {
        return !!(path && path.type === 'text' && (path.textMode || 'roland') !== 'creative');
    }

    isCreativeTextPath(path) {
        return !!(path && path.type === 'text' && path.textMode === 'creative' && path.exploded !== true);
    }

    pathShouldUseCurve(path) {
        if (!path || path.type !== 'path' || !Array.isArray(path.segments) || !Array.isArray(path.points)) return false;
        if (this.app?.settings?.useInternalCurveEngine === false) return false;
        return path.segments.some(segment => ['C', 'Q'].includes(segment.type));
    }

    isClosedPath(path) {
        if (!path) return false;
        if (Array.isArray(path.segments) && path.segments.some(segment => segment.type === 'Z')) return true;
        const pts = path.points || [];
        if (pts.length < 2) return false;
        const first = pts[0];
        const last = pts[pts.length - 1];
        return !!first && !!last && first.x === last.x && first.y === last.y;
    }

    generatePolylineCommands(points) {
        if (!points || points.length < 2) return [];

        const transformedPts = this.transformOutputPoints(points);
        const first = transformedPts[0];
        const firstX = Math.round(first.x * this.UNITS_PER_MM);
        const firstY = Math.round(first.y * this.UNITS_PER_MM);
        const coords = transformedPts
            .slice(1)
            .map(point => `${Math.round(point.x * this.UNITS_PER_MM)},${Math.round(point.y * this.UNITS_PER_MM)}`)
            .join(',');

        return [
            `PU${firstX},${firstY};`,
            `PD${coords};`,
            'PU;'
        ];
    }

    generatePolylineTraceCommands(points) {
        if (!points || points.length < 2) return [];

        const transformedPts = this.transformOutputPoints(points);
        const first = transformedPts[0];
        const commands = [
            `PU${Math.round(first.x * this.UNITS_PER_MM)},${Math.round(first.y * this.UNITS_PER_MM)};`
        ];

        for (let i = 1; i < transformedPts.length; i++) {
            const point = transformedPts[i];
            commands.push(`PD${Math.round(point.x * this.UNITS_PER_MM)},${Math.round(point.y * this.UNITS_PER_MM)};`);
        }

        commands.push('PU;');
        return commands;
    }

    generatePolylineStreamCommands(points, maxPairsPerCommand = 1) {
        if (!points || points.length < 2) return [];

        const transformedPts = this.transformOutputPoints(points);
        const first = transformedPts[0];
        const commands = [
            `PU${Math.round(first.x * this.UNITS_PER_MM)},${Math.round(first.y * this.UNITS_PER_MM)};`
        ];

        const remaining = transformedPts.slice(1).map(point => ({
            x: Math.round(point.x * this.UNITS_PER_MM),
            y: Math.round(point.y * this.UNITS_PER_MM)
        }));

        for (let i = 0; i < remaining.length; i += maxPairsPerCommand) {
            const chunk = remaining.slice(i, i + maxPairsPerCommand);
            if (chunk.length === 0) continue;
            commands.push(`PD${chunk.map(point => `${point.x},${point.y}`).join(',')};`);
        }

        commands.push('PU;');
        return commands;
    }

    generateCirclePoints(xMM, yMM, rMM, steps = 72) {
        const points = [];
        for (let i = 0; i <= steps; i++) {
            const angle = (i / steps) * Math.PI * 2;
            points.push({
                x: xMM + (Math.cos(angle) * rMM),
                y: yMM + (Math.sin(angle) * rMM)
            });
        }
        return points;
    }

    getTracePointsForPath(path) {
        if (!path) return [];
        if (path.type !== 'path' || !Array.isArray(path.segments) || path.segments.length === 0) {
            return Array.isArray(path.points) ? path.points : [];
        }

        const tracePoints = [];
        let currentPoint = null;
        let subpathStart = null;
        const importResolution = this._getImportResolutionEffectiveValue();
        const normalizedResolution = (importResolution - 1) / 199;
        const getCurveSteps = (curveType, startPoint, segment) => {
            const endPoint = segment && Number.isFinite(segment.x) && Number.isFinite(segment.y)
                ? { x: segment.x, y: segment.y }
                : startPoint;
            const directDistance = startPoint && endPoint
                ? Math.hypot((endPoint.x || 0) - (startPoint.x || 0), (endPoint.y || 0) - (startPoint.y || 0))
                : 0;
            const handleDistance = curveType === 'C'
                ? Math.hypot((segment.x1 || 0) - (startPoint?.x || 0), (segment.y1 || 0) - (startPoint?.y || 0))
                    + Math.hypot((segment.x2 || 0) - (segment.x1 || 0), (segment.y2 || 0) - (segment.y1 || 0))
                    + Math.hypot((endPoint.x || 0) - (segment.x2 || 0), (endPoint.y || 0) - (segment.y2 || 0))
                : Math.hypot((segment.x1 || 0) - (startPoint?.x || 0), (segment.y1 || 0) - (startPoint?.y || 0))
                    + Math.hypot((endPoint.x || 0) - (segment.x1 || 0), (endPoint.y || 0) - (segment.y1 || 0));
            const estimatedLength = Math.max(directDistance, handleDistance, 1);
            const targetStep = Math.max(0.1, 1.6 - (normalizedResolution * 1.45));
            const baseSteps = curveType === 'C' ? 4 : 3;
            const lengthSteps = Math.ceil(estimatedLength / targetStep);
            return Math.max(
                curveType === 'C' ? 6 : 4,
                Math.min(480, baseSteps + lengthSteps)
            );
        };

        const pushPoint = (point) => {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            const last = tracePoints[tracePoints.length - 1];
            if (last && Math.abs(last.x - point.x) < 0.001 && Math.abs(last.y - point.y) < 0.001) return;
            tracePoints.push({ x: point.x, y: point.y });
        };

        const sampleCurve = (pointAt, steps = 24) => {
            if (!currentPoint) return;
            pushPoint(currentPoint);
            for (let step = 1; step <= steps; step++) {
                pushPoint(pointAt(step / steps));
            }
        };
        const sampleArcSegment = (start, segment) => {
            if (!start || !segment || !Number.isFinite(segment.rx) || !Number.isFinite(segment.ry)) {
                if (segment && Number.isFinite(segment.x) && Number.isFinite(segment.y)) {
                    pushPoint({ x: segment.x, y: segment.y });
                }
                return;
            }

            let rx = Math.abs(segment.rx);
            let ry = Math.abs(segment.ry);
            const phi = Number.isFinite(segment.rot) ? segment.rot : 0;
            const end = { x: segment.x, y: segment.y };
            if (rx < 1e-6 || ry < 1e-6) {
                pushPoint(end);
                return;
            }

            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);
            const x1p = cosPhi * (start.x - end.x) / 2 + sinPhi * (start.y - end.y) / 2;
            const y1p = -sinPhi * (start.x - end.x) / 2 + cosPhi * (start.y - end.y) / 2;
            let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
            if (lambda > 1) {
                const scale = Math.sqrt(lambda);
                rx *= scale;
                ry *= scale;
            }

            const denominator = (rx * rx * y1p * y1p) + (ry * ry * x1p * x1p);
            if (denominator <= 1e-9) {
                pushPoint(end);
                return;
            }

            let factor = ((rx * ry) * (rx * ry) - (rx * rx * y1p * y1p) - (ry * ry * x1p * x1p)) / denominator;
            factor = Math.sqrt(Math.max(0, factor));
            if ((segment.large ? 1 : 0) === (segment.sweep ? 1 : 0)) factor = -factor;

            const cxp = factor * ((rx * y1p) / ry);
            const cyp = factor * (-(ry * x1p) / rx);
            const cx = cosPhi * cxp - sinPhi * cyp + ((start.x + end.x) / 2);
            const cy = sinPhi * cxp + cosPhi * cyp + ((start.y + end.y) / 2);
            const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
            let dTheta = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - theta1;
            if ((segment.sweep ? 1 : 0) === 0 && dTheta > 0) dTheta -= Math.PI * 2;
            else if ((segment.sweep ? 1 : 0) === 1 && dTheta < 0) dTheta += Math.PI * 2;

            const avgRadius = Math.max(0.1, (rx + ry) * 0.5);
            const arcLength = Math.abs(dTheta) * avgRadius;
            const targetStep = Math.max(0.1, 1.8 - (normalizedResolution * 1.65));
            const steps = Math.max(
                6,
                Math.min(480, Math.ceil(arcLength / targetStep) + Math.ceil(Math.abs(dTheta) / (Math.PI / 3)))
            );

            pushPoint(start);
            for (let step = 1; step <= steps; step++) {
                const t = step / steps;
                const angle = theta1 + (dTheta * t);
                pushPoint({
                    x: cosPhi * rx * Math.cos(angle) - sinPhi * ry * Math.sin(angle) + cx,
                    y: sinPhi * rx * Math.cos(angle) + cosPhi * ry * Math.sin(angle) + cy
                });
            }
        };

        path.segments.forEach(segment => {
            if (!segment || !segment.type) return;

            if (segment.type === 'M') {
                currentPoint = { x: segment.x, y: segment.y };
                subpathStart = { ...currentPoint };
                pushPoint(currentPoint);
                return;
            }

            if (segment.type === 'L') {
                if (!currentPoint) {
                    currentPoint = { x: segment.x, y: segment.y };
                    subpathStart = subpathStart || { ...currentPoint };
                    pushPoint(currentPoint);
                    return;
                }
                currentPoint = { x: segment.x, y: segment.y };
                pushPoint(currentPoint);
                return;
            }

            if (segment.type === 'C' && currentPoint) {
                const start = { ...currentPoint };
                sampleCurve((t) => {
                    const mt = 1 - t;
                    return {
                        x: (mt * mt * mt * start.x) + (3 * mt * mt * t * segment.x1) + (3 * mt * t * t * segment.x2) + (t * t * t * segment.x),
                        y: (mt * mt * mt * start.y) + (3 * mt * mt * t * segment.y1) + (3 * mt * t * t * segment.y2) + (t * t * t * segment.y)
                    };
                }, getCurveSteps('C', start, segment));
                currentPoint = { x: segment.x, y: segment.y };
                return;
            }

            if (segment.type === 'Q' && currentPoint) {
                const start = { ...currentPoint };
                sampleCurve((t) => {
                    const mt = 1 - t;
                    return {
                        x: (mt * mt * start.x) + (2 * mt * t * segment.x1) + (t * t * segment.x),
                        y: (mt * mt * start.y) + (2 * mt * t * segment.y1) + (t * t * segment.y)
                    };
                }, getCurveSteps('Q', start, segment));
                currentPoint = { x: segment.x, y: segment.y };
                return;
            }

            if (segment.type === 'A') {
                sampleArcSegment(currentPoint, segment);
                currentPoint = { x: segment.x, y: segment.y };
                return;
            }

            if (segment.type === 'Z' && currentPoint && subpathStart) {
                currentPoint = { ...subpathStart };
                pushPoint(currentPoint);
            }
        });

        if (tracePoints.length < 2) {
            return Array.isArray(path.points) ? path.points : [];
        }

        const preserveClosed = this.isClosedPath(path);
        return this._simplifyImportedPoints(tracePoints, preserveClosed);
    }

    pathContainsText(paths = []) {
        return paths.some(entry => {
            const path = entry?.path || entry;
            return this.isRolandTextPath(path);
        });
    }

    buildHpglHeader(paths = []) {
        const header = ['IN;'];
        if (this.pathContainsText(paths)) {
            header.push('DT\x03;');
        }
        return header;
    }

    generateVectorText(text, xMM, yMM, fontSize = 10) {
        if (typeof HandwritingLibrary === 'undefined') return this.generateText(text, xMM, yMM);

        const style = 'plotter';
        const glyphLibrary = HandwritingLibrary[style];
        // Snap size for hardware consistency
        const h = Math.round(fontSize * 2) / 2;
        const spacing = 1.1;

        let hpgl = [];
        let curX = xMM;
        let curY = yMM;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const glyph = glyphLibrary[char] || glyphLibrary['?'];
            if (!glyph) continue;

            let strokes = glyph;
            if (Array.isArray(glyph) && Array.isArray(glyph[0]) && Array.isArray(glyph[0][0]) && typeof glyph[0][0][0] === 'object') {
                strokes = glyph[0];
            }

            strokes.forEach(stroke => {
                if (stroke.length < 2) return;
                for (let j = 0; j < stroke.length; j++) {
                    const point = this.transformOutputPoint(
                        curX + stroke[j].x * h * 0.6,
                        curY + (stroke[j].y - 1) * h
                    );
                    const ux = Math.round(point.x * this.UNITS_PER_MM);
                    const uy = Math.round(point.y * this.UNITS_PER_MM);
                    if (j === 0) {
                        hpgl.push(`PU${ux},${uy};`);
                        hpgl.push('PD;');
                    } else {
                        hpgl.push(`PA${ux},${uy};`);
                    }
                }
                hpgl.push('PU;');
            });

            curX += (h * 0.6 * spacing);
        }
        return hpgl;
    }

    // Convert an abstract feature (e.g. from Canvas tools) to HPGL queue
    queueShape(type, params) {
        let hpgl = [`SP${this.currentPen};`]; // Select active physical pen
        const visPen = this.app.ui.activeVisualizerPen || 1;

        // Ensure the active visualiser pen layer is visible so imports don't appear 'blank'
        if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[visPen - 1]) {
            this.app.ui.visPenConfig[visPen - 1].visible = true;
            this.app.ui.saveWorkspaceState();
            this.app.ui.updateVisualizerPalette();
        }

        if (type === 'circle') {
            this.app.canvas.addPath({ type: 'circle', x: params.x, y: params.y, r: params.r, pen: visPen });
        } else if (type === 'rectangle') {
            this.app.canvas.addPath({ type: 'rectangle', x: params.x, y: params.y, w: params.w, h: params.h, pen: visPen });
        } else if (type === 'text') {
            this.app.canvas.addPath({
                type: 'text',
                text: params.text,
                x: params.x,
                y: params.y,
                pen: visPen,
                textMode: params.textMode || 'roland',
                creativeFontId: params.creativeFontId || 'bungee',
                fontSize: params.fontSize || 10,
                rotation: this.getRolandTextRotationIndex(params.rotation || 0) * 90
            });
        }

        this.app.ui.logToConsole(`System: Added shape to canvas Document.`);
    }

    // Generate HPGL from abstract paths and return as a downloadable string
    exportHPGL(paths) {
        if (!paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to export.');
            return "";
        }

        const groupedPaths = this.optimizePlotPaths(paths);

        let hpglCommands = this.buildHpglHeader(groupedPaths);
        let lastPen = -1;

        groupedPaths.forEach(item => {
            const p = item.path;
            const reqPen = p.pen || 1;

            // Check if this pen layer is currently hidden
            if (this.app && this.app.ui && this.app.ui.visPenConfig) {
                const penCfg = this.app.ui.visPenConfig[reqPen - 1];
                if (penCfg && penCfg.visible === false) return;
            }

            if (reqPen !== lastPen) {
                hpglCommands.push(`SP${reqPen};`);
                lastPen = reqPen;
            }

            if (p.type === 'circle') {
                hpglCommands = hpglCommands.concat(this.generateCircle(p.x, p.y, p.r));
            } else if (p.type === 'text') {
                if (this.isCreativeTextPath(p) && typeof CreativeTextEngine !== 'undefined') {
                    CreativeTextEngine.buildPlotLoops(p).forEach(loop => {
                        hpglCommands = hpglCommands.concat(this.generatePolylineCommands(loop));
                    });
                } else {
                    hpglCommands = hpglCommands.concat(this.generateText(p.text, p.x, p.y, p.fontSize || 10, p.rotation || 0));
                }
            } else if (p.type === 'rectangle') {
                hpglCommands = hpglCommands.concat(
                    this.generateRectangle(p.x, p.y, p.x + (p.w || 0), p.y + (p.h || 0))
                );
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                const pts = Array.isArray(item.plotPoints) && item.plotPoints.length >= 2
                    ? item.plotPoints
                    : this.getTracePointsForPath(p);
                if (pts && pts.length >= 2) {
                    if (!item.plotPoints && this.pathShouldUseCurve(p)) {
                        hpglCommands = hpglCommands.concat(this.generateCurve(pts, this.isClosedPath(p)));
                        hpglCommands.push('PU;');
                    } else {
                        hpglCommands = hpglCommands.concat(this.generatePolylineCommands(pts));
                    }
                }
            }
        });

        hpglCommands.push("SP0;"); // Pen home
        return hpglCommands.join("\n");
    }

    getPathRepresentativePoint(path, tracePoints = null) {
        if (Array.isArray(tracePoints) && tracePoints.length > 0) {
            return tracePoints[0];
        }
        if (path?.type === 'circle') {
            return { x: path.x + (path.r || 0), y: path.y };
        }
        if (path?.type === 'rectangle') {
            return { x: path.x, y: path.y };
        }
        if (path?.type === 'text') {
            return { x: path.x || 0, y: path.y || 0 };
        }
        if (Array.isArray(path?.points) && path.points.length > 0) {
            return path.points[0];
        }
        return { x: 0, y: 0 };
    }

    isPathReversibleForPlot(path, tracePoints = null) {
        if (!path || !['line', 'polyline', 'path'].includes(path.type)) return false;
        if (this.isHandwritingPlotPath(path)) return false;
        if (this.isClosedPath(path)) return false;
        return Array.isArray(tracePoints) && tracePoints.length >= 2;
    }

    isHandwritingPlotPath(path) {
        if (!path) return false;
        if (path.source === 'handwriting') return true;
        if (path.plotOrdering === 'handwriting-sequential') return true;
        return false;
    }

    orientPlotItemFromPoint(item, currentPoint = null) {
        const tracePoints = Array.isArray(item.tracePoints) ? item.tracePoints : [];
        const reversible = item.reversible === true;
        if (!tracePoints.length) {
            const point = this.getPathRepresentativePoint(item.path, tracePoints);
            return {
                path: item.path,
                plotPoints: null,
                startPoint: point,
                endPoint: point
            };
        }

        const forwardStart = tracePoints[0];
        const forwardEnd = tracePoints[tracePoints.length - 1];
        if (!reversible || !currentPoint) {
            return {
                path: item.path,
                plotPoints: tracePoints,
                startPoint: forwardStart,
                endPoint: forwardEnd
            };
        }

        const distanceToStart = Math.hypot((forwardStart.x || 0) - currentPoint.x, (forwardStart.y || 0) - currentPoint.y);
        const distanceToEnd = Math.hypot((forwardEnd.x || 0) - currentPoint.x, (forwardEnd.y || 0) - currentPoint.y);
        if (distanceToEnd + 0.001 < distanceToStart) {
            const reversed = tracePoints.slice().reverse();
            return {
                path: item.path,
                plotPoints: reversed,
                startPoint: reversed[0],
                endPoint: reversed[reversed.length - 1]
            };
        }

        return {
            path: item.path,
            plotPoints: tracePoints,
            startPoint: forwardStart,
            endPoint: forwardEnd
        };
    }

    optimizePlotUnitItems(items = [], currentPoint = null) {
        const allHandwriting = items.length > 0 && items.every(item => this.isHandwritingPlotPath(item?.path));
        if (allHandwriting) {
            const inOrder = items
                .slice()
                .sort((left, right) => {
                    const a = Number.isFinite(left?.path?.plotOrder) ? left.path.plotOrder : left?.sequence ?? 0;
                    const b = Number.isFinite(right?.path?.plotOrder) ? right.path.plotOrder : right?.sequence ?? 0;
                    return a - b;
                })
                .map(item => {
                    const tracePoints = Array.isArray(item.tracePoints) ? item.tracePoints : [];
                    const startPoint = tracePoints[0] || this.getPathRepresentativePoint(item.path, tracePoints);
                    const endPoint = tracePoints.length > 0
                        ? tracePoints[tracePoints.length - 1]
                        : this.getPathRepresentativePoint(item.path, tracePoints);
                    return {
                        path: item.path,
                        plotPoints: tracePoints.length ? tracePoints : null,
                        startPoint,
                        endPoint
                    };
                });

            return {
                items: inOrder,
                entryPoint: inOrder[0]?.startPoint || currentPoint || { x: 0, y: 0 },
                exitPoint: inOrder[inOrder.length - 1]?.endPoint || currentPoint || { x: 0, y: 0 }
            };
        }

        const remaining = items.slice();
        const ordered = [];
        let cursor = currentPoint;
        while (remaining.length > 0) {
            let bestIndex = 0;
            let bestCandidate = null;
            let bestScore = Infinity;

            remaining.forEach((item, index) => {
                const candidate = this.orientPlotItemFromPoint(item, cursor);
                const anchor = cursor || { x: 0, y: 0 };
                const distance = Math.hypot((candidate.startPoint.x || 0) - anchor.x, (candidate.startPoint.y || 0) - anchor.y);
                const tieBreaker = ((candidate.startPoint.y || 0) * 10000) + (candidate.startPoint.x || 0);
                const score = (distance * 1000000) + tieBreaker;
                if (score < bestScore) {
                    bestScore = score;
                    bestIndex = index;
                    bestCandidate = candidate;
                }
            });

            const [selected] = remaining.splice(bestIndex, 1);
            ordered.push(bestCandidate || this.orientPlotItemFromPoint(selected, cursor));
            cursor = ordered[ordered.length - 1].endPoint;
        }

        return {
            items: ordered,
            entryPoint: ordered[0]?.startPoint || currentPoint || { x: 0, y: 0 },
            exitPoint: ordered[ordered.length - 1]?.endPoint || currentPoint || { x: 0, y: 0 }
        };
    }

    optimizePlotPaths(paths = []) {
        if (!Array.isArray(paths) || paths.length === 0) return [];

        const visiblePaths = paths.filter(path => {
            const penCfg = this.app?.ui?.visPenConfig?.[(path?.pen || 1) - 1];
            return !(penCfg && penCfg.visible === false);
        });

        const optimized = [];
        const pens = [...new Set(visiblePaths.map(path => path.pen || 1))].sort((a, b) => a - b);
        pens.forEach(penID => {
            const penPaths = visiblePaths.filter(path => (path.pen || 1) === penID);
            const unitMap = new Map();
            penPaths.forEach((path, index) => {
                const tracePoints = this.getExportTracePointsForPath(path);
                const reversible = this.isPathReversibleForPlot(path, tracePoints);
                const groupKey = path?.groupId ? `group:${path.groupId}` : `path:${index}`;
                if (!unitMap.has(groupKey)) {
                    unitMap.set(groupKey, []);
                }
                unitMap.get(groupKey).push({
                    path,
                    tracePoints,
                    reversible,
                    sequence: index
                });
            });

            const remainingUnits = Array.from(unitMap.values());
            let cursor = { x: 0, y: 0 };
            while (remainingUnits.length > 0) {
                let bestIndex = 0;
                let bestOptimizedUnit = null;
                let bestDistance = Infinity;
                remainingUnits.forEach((unitItems, index) => {
                    const optimizedUnit = this.optimizePlotUnitItems(unitItems, cursor);
                    const entry = optimizedUnit.entryPoint || cursor;
                    const distance = Math.hypot((entry.x || 0) - cursor.x, (entry.y || 0) - cursor.y);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        bestIndex = index;
                        bestOptimizedUnit = optimizedUnit;
                    }
                });

                const [selectedUnit] = remainingUnits.splice(bestIndex, 1);
                const optimizedUnit = bestOptimizedUnit || this.optimizePlotUnitItems(selectedUnit, cursor);
                optimized.push(...optimizedUnit.items);
                cursor = optimizedUnit.exitPoint || cursor;
            }
        });

        return optimized;
    }

    getExportTracePointsForPath(path) {
        if (!path) return [];
        if (path.type === 'circle') {
            return this.generateCirclePoints(path.x, path.y, path.r);
        }
        if (path.type === 'rectangle') {
            return this.getRectanglePoints(path.x, path.y, path.x + (path.w || 0), path.y + (path.h || 0));
        }
        if (path.type === 'text') {
            return [];
        }
        const basePoints = this.getTracePointsForPath(path);
        if (this.app?.canvas?.pathSupportsCurve?.(path)) {
            return this.app.canvas.applyCurveToPoints(basePoints, path.curve);
        }
        return basePoints;
    }

    exportGCode(paths) {
        if (!paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to export.');
            return '';
        }

        const zUp = 5;
        const zDown = 0;
        const travelFeed = 3000;
        const drawFeed = 1200;
        const plungeFeed = 600;
        const commands = [
            'G21',
            'G90',
            `G0 Z${zUp}`
        ];

        this.optimizePlotPaths(paths).forEach(item => {
            const path = item.path;
            const penCfg = this.app?.ui?.visPenConfig?.[(path.pen || 1) - 1];
            if (penCfg && penCfg.visible === false) return;

            const tracePoints = Array.isArray(item.plotPoints) && item.plotPoints.length >= 2
                ? item.plotPoints
                : this.getExportTracePointsForPath(path);
            if (!tracePoints || tracePoints.length < 2) return;

            const transformedPoints = this.transformOutputPoints(tracePoints);
            const first = transformedPoints[0];
            commands.push(`G0 X${first.x.toFixed(3)} Y${first.y.toFixed(3)} F${travelFeed}`);
            commands.push(`G1 Z${zDown} F${plungeFeed}`);

            for (let i = 1; i < transformedPoints.length; i++) {
                const point = transformedPoints[i];
                commands.push(`G1 X${point.x.toFixed(3)} Y${point.y.toFixed(3)} F${drawFeed}`);
            }

            commands.push(`G0 Z${zUp}`);
        });

        commands.push('G0 X0 Y0');
        return commands.join('\n');
    }

    exportSVG(paths) {
        if (!paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to export.');
            return '';
        }

        const bedWidth = this.app?.settings?.bedWidth || this.app?.canvas?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || this.app?.canvas?.bedHeight || 297;
        const elements = [];

        paths.forEach(path => {
            const pen = path.pen || 1;
            const penCfg = this.app?.ui?.visPenConfig?.[pen - 1];
            if (penCfg && penCfg.visible === false) return;

            const stroke = penCfg?.color || '#000000';
            const strokeWidth = Math.max(0.1, penCfg?.thickness || 0.3);

            if (path.type === 'circle') {
                const center = this.transformSvgExportPoint(path.x, path.y);
                elements.push(`<circle cx="${center.x.toFixed(3)}" cy="${center.y.toFixed(3)}" r="${(path.r || 0).toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" />`);
                return;
            }

            if (path.type === 'rectangle') {
                const points = this.transformSvgExportPoints(this.getRectanglePoints(path.x, path.y, path.x + (path.w || 0), path.y + (path.h || 0)));
                elements.push(`<polyline points="${points.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" />`);
                return;
            }

            if (path.type === 'text') {
                if (this.isCreativeTextPath(path) && typeof CreativeTextEngine !== 'undefined') {
                    CreativeTextEngine.buildPlotLoops(path).forEach(loop => {
                        const transformedPoints = this.transformSvgExportPoints(loop);
                        elements.push(`<polyline points="${transformedPoints.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" />`);
                    });
                } else {
                    const point = this.transformSvgExportPoint(path.x, path.y);
                    const safeText = String(path.text || '')
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;')
                        .replace(/"/g, '&quot;');
                    const rotation = path.rotation || 0;
                    elements.push(`<text x="${point.x.toFixed(3)}" y="${point.y.toFixed(3)}" font-size="${(path.fontSize || 10).toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="${Math.max(0.1, strokeWidth * 0.35).toFixed(3)}" transform="rotate(${rotation} ${point.x.toFixed(3)} ${point.y.toFixed(3)})">${safeText}</text>`);
                }
                return;
            }

            const points = this.getExportTracePointsForPath(path);
            if (!points || points.length < 2) return;
            const transformedPoints = this.transformSvgExportPoints(points);
            elements.push(`<polyline points="${transformedPoints.map(point => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(3)}" />`);
        });

        if (elements.length === 0) {
            this.app.ui.logToConsole('System: No visible geometry to export.');
            return '';
        }

        return [
            '<?xml version="1.0" encoding="UTF-8"?>',
            `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${bedWidth} ${bedHeight}" width="${bedWidth}mm" height="${bedHeight}mm">`,
            ...elements,
            '</svg>'
        ].join('\n');
    }

    // Generate HPGL from abstract paths and send to Serial Queue
    generateFromPaths(paths) {
        if (!paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to plot.');
            return false;
        }

        const groupedPaths = this.optimizePlotPaths(paths);

        let hpglQueue = this.buildHpglHeader(groupedPaths);
        let commandsFound = 0;
        let lastPen = -1;

        groupedPaths.forEach(item => {
            const p = item.path;
            const reqPen = p.pen || 1;

            // Check if this pen layer is currently hidden
            if (this.app && this.app.ui && this.app.ui.visPenConfig) {
                const penCfg = this.app.ui.visPenConfig[reqPen - 1];
                if (penCfg && penCfg.visible === false) return; // Skip hidden paths
            }

            if (reqPen !== lastPen) {
                hpglQueue.push(`SP${reqPen};`);
                lastPen = reqPen;
            }

            if (p.type === 'circle') {
                hpglQueue = hpglQueue.concat(this.generateCircle(p.x, p.y, p.r));
                commandsFound++;
            } else if (p.type === 'text') {
                if (this.isCreativeTextPath(p) && typeof CreativeTextEngine !== 'undefined') {
                    CreativeTextEngine.buildPlotLoops(p).forEach(loop => {
                        hpglQueue = hpglQueue.concat(this.generatePolylineStreamCommands(loop));
                        commandsFound++;
                    });
                } else {
                    hpglQueue = hpglQueue.concat(this.generateText(p.text, p.x, p.y, p.fontSize || 10, p.rotation || 0));
                    commandsFound++;
                }
            } else if (p.type === 'rectangle') {
                hpglQueue = hpglQueue.concat(
                    this.generatePolylineStreamCommands(
                        this.getRectanglePoints(p.x, p.y, p.x + (p.w || 0), p.y + (p.h || 0))
                    )
                );
                commandsFound++;
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                const pts = Array.isArray(item.plotPoints) && item.plotPoints.length >= 2
                    ? item.plotPoints
                    : this.getTracePointsForPath(p);
                if (pts && pts.length >= 2) {
                    hpglQueue = hpglQueue.concat(this.generatePolylineStreamCommands(pts));
                    commandsFound += pts.length;
                }
            }
        });

        this.app.serial.queueCommands(hpglQueue);
        this.app.ui.logToConsole(`System: Generated ${hpglQueue.length} HPGL commands from Canvas.`);
        return true;
    }

    normalizeSvgColorValue(colorValue) {
        if (!colorValue) return null;
        const raw = String(colorValue).trim();
        if (!raw || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'transparent') return null;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return raw.toLowerCase();
        ctx.fillStyle = '#000000';
        ctx.fillStyle = raw;
        return String(ctx.fillStyle || raw).toLowerCase();
    }

    parseSvgStyleAttribute(styleValue) {
        const styleMap = {};
        if (!styleValue) return styleMap;
        String(styleValue).split(';').forEach(part => {
            const pieces = part.split(':');
            if (pieces.length < 2) return;
            const key = pieces.shift().trim().toLowerCase();
            const value = pieces.join(':').trim();
            if (key) styleMap[key] = value;
        });
        return styleMap;
    }

    getSvgElementColor(el, inheritedColor = null) {
        if (!el || !el.getAttribute) return inheritedColor;
        const styleMap = this.parseSvgStyleAttribute(el.getAttribute('style'));
        const stroke = el.getAttribute('stroke') || styleMap.stroke;
        const fill = el.getAttribute('fill') || styleMap.fill;
        const color = el.getAttribute('color') || styleMap.color || inheritedColor;
        return this.normalizeSvgColorValue(stroke)
            || this.normalizeSvgColorValue(fill)
            || this.normalizeSvgColorValue(color)
            || inheritedColor;
    }

    getPenForImportedColor(colorKey, colorPenMap, fallbackPen = 1) {
        if (!colorKey) return fallbackPen;
        if (colorPenMap.has(colorKey)) return colorPenMap.get(colorKey);
        const penCount = Array.isArray(this.app?.ui?.visPenConfig) ? this.app.ui.visPenConfig.length : 8;
        const assignedPen = Math.min(penCount, colorPenMap.size + 1);
        colorPenMap.set(colorKey, assignedPen);
        return assignedPen;
    }

    isClosedPointLoop(points = [], tolerance = 0.5) {
        if (!Array.isArray(points) || points.length < 3) return false;
        const first = points[0];
        const last = points[points.length - 1];
        if (!first || !last) return false;
        return Math.hypot((last.x || 0) - (first.x || 0), (last.y || 0) - (first.y || 0)) <= tolerance;
    }

    // Convert an SVG file content into HPGL
    async parseSVG(svgString) {
        const dom = new DOMParser().parseFromString(svgString, 'image/svg+xml');
        const svgElement = dom.querySelector('svg');
        if (!svgElement) {
            this.app.ui.logToConsole(`System: Invalid SVG file.`);
            return;
        }

        this.app.ui.updateLoading(10, 'Parsing SVG structure...');

        // Bounding box for scaling
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const allPaths = []; // Final plotter-ready paths

        // Helper to update global bounds
        const updateBounds = (x, y) => {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        };

        // Flatten SVG elements into line segments
        const processElement = (el, inheritedColor = null) => {
            let pts = [];
            const tag = el.tagName.toLowerCase();
            const sourceColor = this.getSvgElementColor(el, inheritedColor);

            if (tag === 'path') {
                const d = el.getAttribute('d');
                if (d) pts = this.parsePathData(d);
            } else if (tag === 'line') {
                pts = [[
                    { x: Number(el.getAttribute('x1') || 0), y: Number(el.getAttribute('y1') || 0) },
                    { x: Number(el.getAttribute('x2') || 0), y: Number(el.getAttribute('y2') || 0) }
                ]];
            } else if (tag === 'polyline' || tag === 'polygon') {
                const pointsAttr = el.getAttribute('points') || '';
                const nums = pointsAttr.split(/[\s,]+/).filter(Boolean).map(Number);
                let poly = [];
                for (let i = 0; i < nums.length; i += 2) {
                    poly.push({ x: nums[i], y: nums[i + 1] });
                }
                if (tag === 'polygon' && poly.length > 0) poly.push({ ...poly[0] });
                if (poly.length > 0) pts = [poly];
            } else if (tag === 'rect') {
                const x = Number(el.getAttribute('x') || 0);
                const y = Number(el.getAttribute('y') || 0);
                const w = Number(el.getAttribute('width') || 0);
                const h = Number(el.getAttribute('height') || 0);
                pts = [[
                    { x: x, y: y }, { x: x + w, y: y },
                    { x: x + w, y: y + h }, { x: x, y: y + h },
                    { x: x, y: y }
                ]];
            } else if (tag === 'circle' || tag === 'ellipse') {
                const cx = Number(el.getAttribute('cx') || 0);
                const cy = Number(el.getAttribute('cy') || 0);
                const rx = tag === 'circle' ? Number(el.getAttribute('r') || 0) : Number(el.getAttribute('rx') || 0);
                const ry = tag === 'circle' ? Number(el.getAttribute('r') || 0) : Number(el.getAttribute('ry') || 0);
                let circlePts = [];
                const importResolution = this._getImportResolutionValue();
                const steps = Math.max(12, Math.ceil(32 * (importResolution / 15)));
                for (let i = 0; i <= steps; i++) {
                    const ang = (i / steps) * Math.PI * 2;
                    circlePts.push({ x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry });
                }
                pts = [circlePts];
            }

            pts.forEach(segment => {
                const ptsArr = segment.points || segment;
                if (ptsArr.length < 2) return;
                ptsArr.forEach(p => updateBounds(p.x, p.y));
                if (segment && typeof segment === 'object' && !Array.isArray(segment)) {
                    allPaths.push({ ...segment, sourceColor });
                } else {
                    allPaths.push({
                        points: ptsArr,
                        sourceColor,
                        closed: this.isClosedPointLoop(ptsArr)
                    });
                }
            });

            return sourceColor;
        };

        // Recursive traversal (basic, ignoring transforms for now but flattened)
        const walk = (node, inheritedColor = null) => {
            if (node.nodeType !== 1) return;
            const nextInheritedColor = processElement(node, inheritedColor) || inheritedColor;
            node.childNodes.forEach(child => walk(child, nextInheritedColor));
        };
        walk(svgElement);

        if (allPaths.length === 0) {
            this.app.ui.logToConsole(`System: No supported geometry found in SVG.`);
            return;
        }

        // Calculate scaling
        const svgW = maxX - minX;
        const svgH = maxY - minY;
        const margin = 10;
        const bedW = this.app.canvas.bedWidth - (margin * 2);
        const bedH = this.app.canvas.bedHeight - (margin * 2);

        let scale = 1;
        if (svgW > bedW || svgH > bedH) {
            scale = Math.min(bedW / (svgW || 1), bedH / (svgH || 1));
        } else if (svgW < 2 || svgH < 2) {
            scale = Math.min((bedW / 4) / (svgW || 1), (bedH / 4) / (svgH || 1));
        }

        const offsetX = (this.app.canvas.bedWidth / 2) - ((svgW * scale) / 2) - (minX * scale);
        const offsetY = (this.app.canvas.bedHeight / 2) - ((svgH * scale) / 2) - (minY * scale);

        const defaultPen = this.app.ui.activeVisualizerPen || 1;
        const colorPenMap = new Map();
        const colorGroupMap = new Map();
        let pointsCount = 0;

        for (let i = 0; i < allPaths.length; i++) {
            const poly = allPaths[i];
            const ptsArray = poly.points || poly;
            const scaledPoly = ptsArray.map(p => ({
                x: (p.x * scale) + offsetX,
                y: (p.y * scale) + offsetY
            }));

            let scaledSegments = null;
            if (poly.segments) {
                scaledSegments = poly.segments.map(s => {
                    const ns = { type: s.type };
                    if (s.x !== undefined) ns.x = s.x * scale + offsetX;
                    if (s.y !== undefined) ns.y = s.y * scale + offsetY;
                    if (s.x1 !== undefined) ns.x1 = s.x1 * scale + offsetX;
                    if (s.y1 !== undefined) ns.y1 = s.y1 * scale + offsetY;
                    if (s.x2 !== undefined) ns.x2 = s.x2 * scale + offsetX;
                    if (s.y2 !== undefined) ns.y2 = s.y2 * scale + offsetY;
                    return ns;
                });
            }

            const colorKey = poly.sourceColor || 'default';
            const groupId = colorGroupMap.get(colorKey) || `import_color_${colorGroupMap.size + 1}_${Date.now()}`;
            if (!colorGroupMap.has(colorKey)) {
                colorGroupMap.set(colorKey, groupId);
            }
            const assignedPen = this.getPenForImportedColor(poly.sourceColor, colorPenMap, defaultPen);

            this.app.canvas.addPath({
                type: scaledSegments ? 'path' : 'polyline',
                points: scaledPoly,
                segments: scaledSegments,
                closed: poly.closed === true || this.isClosedPointLoop(scaledPoly),
                pen: assignedPen,
                groupId,
                sourceColor: poly.sourceColor || null,
                source: 'svg-import',
                preserveDetail: true
            });
            pointsCount += scaledPoly.length;

            if (i % 100 === 0) {
                const prog = 10 + Math.floor((i / allPaths.length) * 90);
                this.app.ui.updateLoading(prog, `Adding paths: ${i}/${allPaths.length}`);
                // Yield to UI
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig)) {
            colorPenMap.forEach((penNumber) => {
                const penCfg = this.app.ui.visPenConfig[penNumber - 1];
                if (penCfg) penCfg.visible = true;
            });
            const fallbackPenCfg = this.app.ui.visPenConfig[defaultPen - 1];
            if (fallbackPenCfg) fallbackPenCfg.visible = true;
            this.app.ui.saveWorkspaceState();
            this.app.ui.updateVisualizerPalette();
        }

        this.app.ui.logToConsole(`System: Imported SVG (x${scale.toFixed(2)}). Centered. ${pointsCount} points across ${allPaths.length} paths in ${colorGroupMap.size || 1} colour group(s).`);
    }

    // Advanced SVG Path Parser
    parsePathData(d) {
        const tokens = d.match(/[a-df-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/gi) || [];
        const polylines = [];
        let currentPoly = [];
        let currentSegments = [];
        let cx = 0, cy = 0; // Current position
        let px = 0, py = 0; // Previous control point for S/T
        let startX = 0, startY = 0; // Subpath start
        let lastCmd = '';

        let i = 0;
        while (i < tokens.length) {
            let token = tokens[i];
            let isCmd = /[a-df-z]/i.test(token);
            let cmd = isCmd ? token : lastCmd;
            if (isCmd) i++;

            const upper = cmd.toUpperCase();
            const rel = cmd === cmd.toLowerCase();

            const nextNum = () => Number(tokens[i++]);

            if (upper === 'M') {
                if (currentPoly.length > 1) polylines.push({ points: currentPoly, segments: currentSegments });
                cx = nextNum(); cy = nextNum();
                if (rel && lastCmd) { cx += startX; cy += startY; }
                else if (rel) { cx += px; cy += py; }
                startX = cx; startY = cy;
                currentPoly = [{ x: cx, y: cy }];
                currentSegments = [{ type: 'M', x: cx, y: cy }];
                px = cx; py = cy;
                lastCmd = rel ? 'l' : 'L';
            } else if (upper === 'L') {
                cx = nextNum(); cy = nextNum();
                if (rel) { cx += currentPoly[currentPoly.length - 1].x; cy += currentPoly[currentPoly.length - 1].y; }
                currentPoly.push({ x: cx, y: cy });
                currentSegments.push({ type: 'L', x: cx, y: cy });
                px = cx; py = cy;
                lastCmd = cmd;
            } else if (upper === 'H') {
                cx = nextNum();
                if (rel) cx += currentPoly[currentPoly.length - 1].x;
                currentPoly.push({ x: cx, y: cy });
                currentSegments.push({ type: 'L', x: cx, y: cy });
                px = cx; py = cy;
                lastCmd = cmd;
            } else if (upper === 'V') {
                cy = nextNum();
                if (rel) cy += currentPoly[currentPoly.length - 1].y;
                currentPoly.push({ x: cx, y: cy });
                currentSegments.push({ type: 'L', x: cx, y: cy });
                px = cx; py = cy;
                lastCmd = cmd;
            } else if (upper === 'C') {
                let x1 = nextNum(), y1 = nextNum();
                let x2 = nextNum(), y2 = nextNum();
                let x = nextNum(), y = nextNum();
                if (rel) {
                    const lx = currentPoly[currentPoly.length - 1].x;
                    const ly = currentPoly[currentPoly.length - 1].y;
                    x1 += lx; y1 += ly; x2 += lx; y2 += ly; x += lx; y += ly;
                }
                currentSegments.push({ type: 'C', x1, y1, x2, y2, x, y });
                this.interpolateCubic(currentPoly, cx, cy, x1, y1, x2, y2, x, y);
                cx = x; cy = y;
                px = x2; py = y2;
                lastCmd = cmd;
            } else if (upper === 'S') {
                let x2 = nextNum(), y2 = nextNum();
                let x = nextNum(), y = nextNum();
                if (rel) {
                    const lx = currentPoly[currentPoly.length - 1].x;
                    const ly = currentPoly[currentPoly.length - 1].y;
                    x2 += lx; y2 += ly; x += lx; y += ly;
                }
                let x1 = cx, y1 = cy;
                if (lastCmd.toUpperCase() === 'C' || lastCmd.toUpperCase() === 'S') {
                    x1 = 2 * cx - px;
                    y1 = 2 * cy - py;
                }
                currentSegments.push({ type: 'C', x1, y1, x2, y2, x, y });
                this.interpolateCubic(currentPoly, cx, cy, x1, y1, x2, y2, x, y);
                cx = x; cy = y;
                px = x2; py = y2;
                lastCmd = cmd;
            } else if (upper === 'Q') {
                let x1 = nextNum(), y1 = nextNum();
                let x = nextNum(), y = nextNum();
                if (rel) {
                    const lx = currentPoly[currentPoly.length - 1].x;
                    const ly = currentPoly[currentPoly.length - 1].y;
                    x1 += lx; y1 += ly; x += lx; y += ly;
                }
                currentSegments.push({ type: 'Q', x1, y1, x, y });
                this.interpolateQuad(currentPoly, cx, cy, x1, y1, x, y);
                cx = x; cy = y;
                px = x1; py = y1;
                lastCmd = cmd;
            } else if (upper === 'T') {
                let x = nextNum(), y = nextNum();
                if (rel) {
                    const lx = currentPoly[currentPoly.length - 1].x;
                    const ly = currentPoly[currentPoly.length - 1].y;
                    x += lx; y += ly;
                }
                let x1 = cx, y1 = cy;
                if (lastCmd.toUpperCase() === 'Q' || lastCmd.toUpperCase() === 'T') {
                    x1 = 2 * cx - px;
                    y1 = 2 * cy - py;
                }
                currentSegments.push({ type: 'Q', x1, y1, x, y });
                this.interpolateQuad(currentPoly, cx, cy, x1, y1, x, y);
                cx = x; cy = y;
                px = x1; py = y1;
                lastCmd = cmd;
            } else if (upper === 'A') {
                let rx = Math.abs(nextNum()), ry = Math.abs(nextNum());
                let rot = nextNum() * Math.PI / 180;
                let large = nextNum(), sweep = nextNum();
                let x = nextNum(), y = nextNum();
                if (rel) {
                    x += currentPoly[currentPoly.length - 1].x;
                    y += currentPoly[currentPoly.length - 1].y;
                }
                if (rx === 0 || ry === 0) {
                    currentPoly.push({ x: x, y: y });
                    currentSegments.push({ type: 'L', x: x, y: y });
                } else {
                    currentSegments.push({ type: 'A', rx, ry, rot, large, sweep, x, y });
                    this.interpolateArc(currentPoly, cx, cy, rx, ry, rot, large, sweep, x, y);
                }
                cx = x; cy = y;
                px = x; py = y;
                lastCmd = cmd;
            } else if (upper === 'Z') {
                if (currentPoly.length > 0) {
                    currentPoly.push({ ...currentPoly[0] });
                    currentSegments.push({ type: 'Z' });
                    polylines.push({ points: currentPoly, segments: currentSegments });
                    cx = startX; cy = startY;
                    currentPoly = [{ x: cx, y: cy }];
                    currentSegments = [{ type: 'M', x: cx, y: cy }];
                }
                lastCmd = cmd;
            } else {
                i++;
            }
        }
        if (currentPoly.length > 1) polylines.push({ points: currentPoly, segments: currentSegments });
        return polylines;
    }

    interpolateCubic(poly, x0, y0, x1, y1, x2, y2, x3, y3) {
        // By user request: do not add additional nodes to smoothen curves. 
        // We push the control points and endpoint so the native curve math (Y command) can handle it.
        poly.push({ x: x1, y: y1 });
        poly.push({ x: x2, y: y2 });
        poly.push({ x: x3, y: y3 });
    }

    interpolateQuad(poly, x0, y0, x1, y1, x2, y2) {
        poly.push({ x: x1, y: y1 });
        poly.push({ x: x2, y: y2 });
    }

    interpolateArc(poly, x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
        const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
        const x1p = cosPhi * (x1 - x2) / 2 + sinPhi * (y1 - y2) / 2;
        const y1p = -sinPhi * (x1 - x2) / 2 + cosPhi * (y1 - y2) / 2;
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
        const rxry = rx * ry, rxy1p = rx * y1p, ryx1p = ry * x1p;
        let factor = (rxry * rxry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p);
        factor = Math.sqrt(Math.max(0, factor));
        if (largeArc === sweep) factor = -factor;
        const cxp = factor * rxy1p / ry, cyp = -factor * ryx1p / rx;
        const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
        const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
        const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
        let dTheta = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - theta1;
        if (sweep === 0 && dTheta > 0) dTheta -= 2 * Math.PI;
        else if (sweep === 1 && dTheta < 0) dTheta += 2 * Math.PI;

        // Push a mid-point and the end point for native curve interpolation
        const midAng = theta1 + dTheta / 2;
        poly.push({
            x: cosPhi * rx * Math.cos(midAng) - sinPhi * ry * Math.sin(midAng) + cx,
            y: sinPhi * rx * Math.cos(midAng) + cosPhi * ry * Math.sin(midAng) + cy
        });
        poly.push({ x: x2, y: y2 });
    }

    // Truly robust ASCII DXF Parser (Entity-level) - Async with progress

    async parseDXF(content) {
        // DXF is group-code/value pairs. Do NOT trim+filter lines aggressively or you break pairing.
        const raw = content.split(/\r?\n/);

        // Build a stable [code, value, code, value...] array
        const lines = [];
        for (let i = 0; i < raw.length - 1; i += 2) {
            const code = (raw[i] ?? "").trim();
            const val = (raw[i + 1] ?? "");
            if (code === "") continue;
            lines.push(code, val.trim());
        }

        const allPaths = [];
        const blocks = {}; // name -> entityObj[]
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        const updateBounds = (x, y) => {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };

        const readEntityRaw = (startIdx) => {
            // startIdx points to a '0' group code
            const entityRaw = [];
            entityRaw.push(lines[startIdx], lines[startIdx + 1]); // 0, TYPE
            let i = startIdx + 2;
            while (i < lines.length && lines[i] !== '0') {
                entityRaw.push(lines[i], lines[i + 1]);
                i += 2;
            }
            return { entityRaw, nextIdx: i };
        };

        const extractProps = (entityRaw) => {
            const props = {};
            for (let i = 2; i < entityRaw.length; i += 2) {
                const c = parseInt(entityRaw[i], 10);
                const v = entityRaw[i + 1];
                if (Number.isNaN(c)) continue;

                // numeric multi-values we care about
                if (c === 10 || c === 20 || c === 30 || c === 11 || c === 21 || c === 31 ||
                    c === 40 || c === 41 || c === 42 || c === 50 || c === 51 || c === 70) {
                    if (!props[c]) props[c] = [];
                    const num = parseFloat(v);
                    props[c].push(Number.isFinite(num) ? num : v);
                } else {
                    props[c] = v;
                }
            }
            return props;
        };

        // Entity list parser that understands POLYLINE/VERTEX/SEQEND sequences
        const readEntityObject = (startIdx) => {
            const type = (lines[startIdx + 1] || '').trim().toUpperCase();

            if (type !== 'POLYLINE') {
                const { entityRaw, nextIdx } = readEntityRaw(startIdx);
                return { obj: { kind: 'ENTITY', type, entityRaw }, nextIdx };
            }

            // POLYLINE sequence: header + VERTEX* + SEQEND
            const header = readEntityRaw(startIdx);
            let i = header.nextIdx;
            const vertexRaws = [];
            let seqendRaw = null;

            while (i < lines.length && lines[i] === '0') {
                const t = (lines[i + 1] || '').trim().toUpperCase();
                if (t === 'VERTEX') {
                    const vtx = readEntityRaw(i);
                    vertexRaws.push(vtx.entityRaw);
                    i = vtx.nextIdx;
                    continue;
                }
                if (t === 'SEQEND') {
                    const end = readEntityRaw(i);
                    seqendRaw = end.entityRaw;
                    i = end.nextIdx;
                    break;
                }
                break;
            }

            return { obj: { kind: 'POLYLINE_SEQ', headerRaw: header.entityRaw, vertexRaws, seqendRaw }, nextIdx: i };
        };

        const collectSection = (sectionName) => {
            // Returns the index where the named SECTION begins (first item after the section header), else -1.
            for (let i = 0; i < lines.length - 3; i += 2) {
                if (lines[i] === '0' && lines[i + 1] === 'SECTION' && lines[i + 2] === '2' && lines[i + 3] === sectionName) {
                    return i + 4;
                }
            }
            return -1;
        };

        this.app.ui.updateLoading(5, 'Parsing DXF structure...');

        // ---- Pass 1: BLOCKS ----
        let idx = collectSection('BLOCKS');
        if (idx !== -1) {
            while (idx < lines.length) {
                if (lines[idx] === '0' && lines[idx + 1] === 'ENDSEC') break;

                if (lines[idx] === '0' && (lines[idx + 1] || '').trim().toUpperCase() === 'BLOCK') {
                    // Read BLOCK header until we see the first entity (0 ...)
                    let blockName = '';
                    idx += 2;

                    while (idx < lines.length && !(lines[idx] === '0' && (lines[idx + 1] || '').trim().toUpperCase() === 'ENDBLK')) {
                        if (lines[idx] === '2') blockName = (lines[idx + 1] || '').trim();
                        // Entities inside a BLOCK also start with group code 0
                        if (lines[idx] === '0') {
                            break;
                        }
                        idx += 2;
                    }

                    const ents = [];
                    while (idx < lines.length && !(lines[idx] === '0' && (lines[idx + 1] || '').trim().toUpperCase() === 'ENDBLK')) {
                        if (lines[idx] === '0') {
                            const { obj, nextIdx } = readEntityObject(idx);
                            ents.push(obj);
                            idx = nextIdx;
                            continue;
                        }
                        idx += 2;
                    }

                    // Skip ENDBLK entity itself
                    if (idx < lines.length && lines[idx] === '0' && (lines[idx + 1] || '').trim().toUpperCase() === 'ENDBLK') {
                        const end = readEntityRaw(idx);
                        idx = end.nextIdx;
                    }

                    if (blockName) blocks[blockName] = ents;
                    continue;
                }

                idx += 2;
            }
        }

        // ---- Pass 2: ENTITIES ----
        idx = collectSection('ENTITIES');
        const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

        const processObj = async (obj, tf) => {
            if (obj.kind === 'POLYLINE_SEQ') {
                const headerProps = extractProps(obj.headerRaw);
                const vertices = [];

                for (const vRaw of obj.vertexRaws) {
                    const vp = extractProps(vRaw);
                    const x = vp[10]?.[0];
                    const y = vp[20]?.[0];
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        vertices.push({
                            x,
                            y,
                            bulge: Number.isFinite(vp[42]?.[0]) ? vp[42][0] : 0
                        });
                    }
                }

                const closedFlag = headerProps[70]?.[0];
                const isClosed = Number.isFinite(closedFlag) && ((closedFlag & 1) === 1);
                const pts = this._buildDXFPolylinePoints(vertices, isClosed).map(p => this._applyDXFTransform(p, tf));
                pts.forEach(p => updateBounds(p.x, p.y));
                if (pts.length > 1) {
                    allPaths.push(pts);
                }
                return;
            }

            // Normal entity
            const type = obj.type;
            const props = extractProps(obj.entityRaw);

            if (type === 'INSERT') {
                const blockName = (props[2] || '').trim();
                const tx = props[10]?.[0] || 0;
                const ty = props[20]?.[0] || 0;
                const sx = props[41]?.[0] || 1;
                const sy = props[42]?.[0] || 1;
                const rotDeg = props[50]?.[0] || 0;

                const insTf = this._makeDXFTransform(tx, ty, sx, sy, rotDeg);
                const combined = this._composeDXFTransform(tf, insTf);

                const ents = blocks[blockName];
                if (ents && ents.length) {
                    for (const e of ents) {
                        await processObj(e, combined);
                    }
                }
                return;
            }

            // Delegate to entity handler
            await this._processDXFEntity(type, props, allPaths, updateBounds, tf);
        };

        if (idx !== -1) {
            let count = 0;
            while (idx < lines.length) {
                if (lines[idx] === '0' && lines[idx + 1] === 'ENDSEC') break;

                if (lines[idx] === '0') {
                    const { obj, nextIdx } = readEntityObject(idx);
                    idx = nextIdx;

                    await processObj(obj, identity);

                    count++;
                    if (count % 500 === 0) {
                        this.app.ui.updateLoading(20 + (idx / lines.length * 70), "Parsing entities...");
                        await new Promise(r => setTimeout(r, 0));
                    }
                    continue;
                }
                idx += 2;
            }
        }

        this.finalizeImport(allPaths, minX, minY, maxX, maxY, 'DXF', { flipY: true });
    }

    _makeDXFTransform(tx, ty, sx, sy, rotDeg) {
        const r = (rotDeg || 0) * Math.PI / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        // 2x3 affine matrix:
        // x' = a*x + c*y + e
        // y' = b*x + d*y + f
        return {
            a: (sx || 1) * cos,
            b: (sx || 1) * sin,
            c: -(sy || 1) * sin,
            d: (sy || 1) * cos,
            e: tx || 0,
            f: ty || 0
        };
    }

    _composeDXFTransform(t1, t2) {
        // Compose: apply t2, then t1  =>  t = t1 ∘ t2
        return {
            a: t1.a * t2.a + t1.c * t2.b,
            b: t1.b * t2.a + t1.d * t2.b,
            c: t1.a * t2.c + t1.c * t2.d,
            d: t1.b * t2.c + t1.d * t2.d,
            e: t1.a * t2.e + t1.c * t2.f + t1.e,
            f: t1.b * t2.e + t1.d * t2.f + t1.f
        };
    }

    _applyDXFTransform(pt, tf) {
        return {
            x: tf.a * pt.x + tf.c * pt.y + tf.e,
            y: tf.b * pt.x + tf.d * pt.y + tf.f
        };
    }

    _getImportResolutionMultiplier() {
        const res = this._getImportResolutionEffectiveValue();
        return Math.max(0.35, 0.45 + (res / 35));
    }

    _getImportResolutionValue() {
        const raw = this.app?.settings?.importResolution;
        const value = Number.isFinite(raw) ? raw : parseInt(raw, 10);
        return Math.max(1, Math.min(200, Number.isFinite(value) ? value : 130));
    }

    _getImportResolutionEffectiveValue() {
        return this._getImportResolutionValue();
    }

    _getImportMinSegmentLength() {
        const res = this._getImportResolutionEffectiveValue();
        // Keep import detail by default; only cull tiny near-duplicates.
        return Math.max(0.006, 0.18 - ((res - 1) * 0.00175));
    }

    _simplifyImportedPoints(points, preserveClosed = false) {
        if (!Array.isArray(points) || points.length < 3) return points || [];

        const minSegmentLength = this._getImportMinSegmentLength();
        const minSegmentSquared = minSegmentLength * minSegmentLength;
        const perpendicularDistanceSquared = (point, start, end) => {
            if (!point || !start || !end) return 0;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
                const px = point.x - start.x;
                const py = point.y - start.y;
                return (px * px) + (py * py);
            }
            const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / ((dx * dx) + (dy * dy));
            const clampedT = Math.max(0, Math.min(1, t));
            const projX = start.x + (clampedT * dx);
            const projY = start.y + (clampedT * dy);
            const px = point.x - projX;
            const py = point.y - projY;
            return (px * px) + (py * py);
        };
        const rdp = (source, epsilonSquared) => {
            if (!Array.isArray(source) || source.length <= 2) return source ? source.slice() : [];
            let maxDistance = -1;
            let splitIndex = -1;
            const start = source[0];
            const end = source[source.length - 1];
            for (let i = 1; i < source.length - 1; i++) {
                const distance = perpendicularDistanceSquared(source[i], start, end);
                if (distance > maxDistance) {
                    maxDistance = distance;
                    splitIndex = i;
                }
            }
            if (maxDistance <= epsilonSquared || splitIndex < 0) {
                return [start, end];
            }
            const left = rdp(source.slice(0, splitIndex + 1), epsilonSquared);
            const right = rdp(source.slice(splitIndex), epsilonSquared);
            return left.slice(0, -1).concat(right);
        };
        const sourcePoints = preserveClosed && points.length > 3
            ? points.slice(0, -1)
            : points.slice();
        const simplified = [];

        const pushPoint = (point, force = false) => {
            if (!point) return;
            const last = simplified[simplified.length - 1];
            if (!last) {
                simplified.push(point);
                return;
            }
            const dx = point.x - last.x;
            const dy = point.y - last.y;
            if (force || ((dx * dx) + (dy * dy)) >= minSegmentSquared) {
                simplified.push(point);
            }
        };

        const resolution = this._getImportResolutionEffectiveValue();
        const normalizedResolution = (resolution - 1) / 199;
        // Previous tolerance was too aggressive for common SVGs and could over-flatten curves.
        const rdpTolerance = Math.max(0.0025, 0.08 - (normalizedResolution * 0.072));
        const rdpToleranceSquared = rdpTolerance * rdpTolerance;
        const reduced = rdp(sourcePoints, rdpToleranceSquared);

        pushPoint(reduced[0], true);
        for (let i = 1; i < reduced.length - 1; i++) {
            pushPoint(reduced[i], false);
        }
        pushPoint(reduced[reduced.length - 1], true);

        if (preserveClosed && simplified.length > 2) {
            const first = simplified[0];
            const last = simplified[simplified.length - 1];
            if (Math.abs(first.x - last.x) > 0.0001 || Math.abs(first.y - last.y) > 0.0001) {
                simplified.push({ ...first });
            }
        }

        return simplified;
    }

    _estimatePolylineLength(points) {
        if (!Array.isArray(points) || points.length < 2) return 0;
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        }
        return total;
    }

    _sampleCatmullRom(points, closed = false) {
        if (!Array.isArray(points) || points.length < 2) return points || [];

        const resolution = this._getImportResolutionEffectiveValue();
        const estimatedLength = this._estimatePolylineLength(points);
        const avgSpanLength = estimatedLength / Math.max(1, (closed ? points.length : points.length - 1));
        const samplesPerSpan = Math.max(
            10,
            Math.min(
                520,
                Math.ceil(avgSpanLength * (0.75 + (resolution / 18))) + Math.ceil(resolution / 3.1)
            )
        );

        const getPoint = (index) => {
            if (closed) {
                return points[(index + points.length) % points.length];
            }
            if (index < 0) return points[0];
            if (index >= points.length) return points[points.length - 1];
            return points[index];
        };

        const sampled = [];
        const spanCount = closed ? points.length : points.length - 1;
        for (let i = 0; i < spanCount; i++) {
            const p0 = getPoint(i - 1);
            const p1 = getPoint(i);
            const p2 = getPoint(i + 1);
            const p3 = getPoint(i + 2);

            for (let step = 0; step <= samplesPerSpan; step++) {
                if (i > 0 && step === 0) continue;
                const t = step / samplesPerSpan;
                const t2 = t * t;
                const t3 = t2 * t;
                sampled.push({
                    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + ((2 * p0.x) - (5 * p1.x) + (4 * p2.x) - p3.x) * t2 + (-p0.x + (3 * p1.x) - (3 * p2.x) + p3.x) * t3),
                    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + ((2 * p0.y) - (5 * p1.y) + (4 * p2.y) - p3.y) * t2 + (-p0.y + (3 * p1.y) - (3 * p2.y) + p3.y) * t3)
                });
            }
        }

        return this._simplifyImportedPoints(sampled, closed);
    }

    _sampleDXFArc(cx, cy, radius, startRad, endRad, minimumSteps = 12) {
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius <= 0) return [];

        let sweep = endRad - startRad;
        if (sweep < 0) sweep += Math.PI * 2;
        const resolution = this._getImportResolutionEffectiveValue();
        const arcLength = Math.abs(sweep) * radius;
        const steps = Math.max(
            minimumSteps,
            Math.min(
                5200,
                Math.ceil((Math.abs(sweep) / (Math.PI / 40)) * this._getImportResolutionMultiplier()) +
                Math.ceil(arcLength * (0.12 + (resolution / 27)))
            )
        );
        const points = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const angle = startRad + (sweep * t);
            points.push({
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius
            });
        }
        return this._simplifyImportedPoints(points, false);
    }

    _sampleDXFBulgeSegment(start, end, bulge = 0) {
        if (!start || !end) return [];
        if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-6) {
            return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
        }

        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const chord = Math.hypot(dx, dy);
        if (!Number.isFinite(chord) || chord <= 0) {
            return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
        }

        const theta = 4 * Math.atan(bulge);
        const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
        if (!Number.isFinite(radius) || radius <= 0) {
            return [{ x: start.x, y: start.y }, { x: end.x, y: end.y }];
        }

        const midX = (start.x + end.x) * 0.5;
        const midY = (start.y + end.y) * 0.5;
        const halfChord = chord * 0.5;
        const offsetToCenter = Math.sqrt(Math.max(0, (radius * radius) - (halfChord * halfChord)));
        const nx = -dy / chord;
        const ny = dx / chord;
        const direction = bulge >= 0 ? 1 : -1;
        const center = {
            x: midX + (nx * offsetToCenter * direction),
            y: midY + (ny * offsetToCenter * direction)
        };

        let startAngle = Math.atan2(start.y - center.y, start.x - center.x);
        let endAngle = Math.atan2(end.y - center.y, end.x - center.x);
        if (bulge >= 0 && endAngle <= startAngle) endAngle += Math.PI * 2;
        if (bulge < 0 && endAngle >= startAngle) endAngle -= Math.PI * 2;

        const sweep = endAngle - startAngle;
        const resolution = this._getImportResolutionEffectiveValue();
        const arcLength = Math.abs(sweep) * radius;
        const steps = Math.max(
            8,
            Math.min(
                4200,
                Math.ceil((Math.abs(sweep) / (Math.PI / 40)) * this._getImportResolutionMultiplier()) +
                Math.ceil(arcLength * (0.11 + (resolution / 30)))
            )
        );
        const points = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const angle = startAngle + (sweep * t);
            points.push({
                x: center.x + Math.cos(angle) * radius,
                y: center.y + Math.sin(angle) * radius
            });
        }
        return this._simplifyImportedPoints(points, false);
    }

    _buildDXFPolylinePoints(vertices, isClosed = false) {
        if (!Array.isArray(vertices) || vertices.length < 2) return [];

        const path = [];
        const pushPoint = (point) => {
            if (!point) return;
            const last = path[path.length - 1];
            if (last && Math.abs(last.x - point.x) < 0.0001 && Math.abs(last.y - point.y) < 0.0001) return;
            path.push(point);
        };

        const segmentCount = isClosed ? vertices.length : vertices.length - 1;
        for (let i = 0; i < segmentCount; i++) {
            const start = vertices[i];
            const end = vertices[(i + 1) % vertices.length];
            if (!start || !end) continue;
            const segmentPoints = this._sampleDXFBulgeSegment(start, end, start.bulge || 0);
            segmentPoints.forEach(pushPoint);
        }

        if (isClosed && path.length > 1) {
            pushPoint({ ...path[0] });
        }

        return path;
    }

    _findDXFSpan(degree, knots, t) {
        const n = knots.length - degree - 2;
        if (n < degree) return -1;
        if (t >= knots[n + 1]) return n;
        if (t <= knots[degree]) return degree;

        let low = degree;
        let high = n + 1;
        let mid = Math.floor((low + high) / 2);
        while (t < knots[mid] || t >= knots[mid + 1]) {
            if (t < knots[mid]) high = mid;
            else low = mid;
            mid = Math.floor((low + high) / 2);
        }
        return mid;
    }

    _evaluateDXFBSplinePoint(controlPoints, degree, knots, t) {
        const span = this._findDXFSpan(degree, knots, t);
        if (span < 0) return null;

        const d = [];
        for (let j = 0; j <= degree; j++) {
            const point = controlPoints[span - degree + j];
            if (!point) return null;
            d.push({ x: point.x, y: point.y });
        }

        for (let r = 1; r <= degree; r++) {
            for (let j = degree; j >= r; j--) {
                const left = knots[span - degree + j];
                const right = knots[span + 1 + j - r];
                const denom = right - left;
                const alpha = Math.abs(denom) < 1e-9 ? 0 : (t - left) / denom;
                d[j] = {
                    x: ((1 - alpha) * d[j - 1].x) + (alpha * d[j].x),
                    y: ((1 - alpha) * d[j - 1].y) + (alpha * d[j].y)
                };
            }
        }

        return d[degree];
    }

    _sampleDXFSpline(props) {
        const fitXs = props[11] || [];
        const fitYs = props[21] || [];
        if (fitXs.length >= 2 && fitXs.length === fitYs.length) {
            const fitPoints = fitXs.map((x, index) => ({ x, y: fitYs[index] }));
            return this._sampleCatmullRom(fitPoints, false);
        }

        const xs = props[10] || [];
        const ys = props[20] || [];
        const controlPoints = [];
        for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
            const x = xs[i];
            const y = ys[i];
            if (Number.isFinite(x) && Number.isFinite(y)) {
                controlPoints.push({ x, y });
            }
        }
        if (controlPoints.length < 2) return [];

        const degree = Math.max(1, Math.min(10, Math.round(props[71]?.[0] || 3)));
        const rawKnots = (props[40] || []).filter(value => Number.isFinite(value));
        let knots = rawKnots;
        const expectedKnots = controlPoints.length + degree + 1;
        if (knots.length !== expectedKnots) {
            knots = [];
            const interiorCount = Math.max(0, controlPoints.length - degree - 1);
            for (let i = 0; i <= degree; i++) knots.push(0);
            for (let i = 1; i <= interiorCount; i++) knots.push(i);
            for (let i = 0; i <= degree; i++) knots.push(interiorCount + 1);
        }

        const start = knots[degree];
        const end = knots[knots.length - degree - 1];
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return controlPoints;
        }

        const isClosed = Number.isFinite(props[70]?.[0]) && ((props[70][0] & 1) === 1);
        const resolution = this._getImportResolutionEffectiveValue();
        const estimatedLength = this._estimatePolylineLength(controlPoints);
        const normalizedResolution = (resolution - 1) / 199;
        const targetStep = Math.max(0.06, 1.1 - (normalizedResolution * 0.98));
        const sampleCount = Math.max(
            64,
            Math.min(
                26000,
                Math.ceil(estimatedLength / targetStep) +
                Math.ceil(controlPoints.length * (0.05 + (resolution / 200))) +
                Math.ceil(resolution * 13)
            )
        );
        const points = [];
        for (let i = 0; i <= sampleCount; i++) {
            const t = start + ((end - start) * (i / sampleCount));
            const point = this._evaluateDXFBSplinePoint(controlPoints, Math.min(degree, controlPoints.length - 1), knots, t);
            if (!point) continue;
            const last = points[points.length - 1];
            if (!last || Math.abs(last.x - point.x) > 0.0001 || Math.abs(last.y - point.y) > 0.0001) {
                points.push(point);
            }
        }

        if (isClosed && points.length > 1) {
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.abs(first.x - last.x) > 0.0001 || Math.abs(first.y - last.y) > 0.0001) {
                points.push({ ...first });
            }
        }

        return this._simplifyImportedPoints(points, isClosed);
    }

    _sampleDXFSplineDefinition(definition = {}) {
        const fitPoints = Array.isArray(definition.fitPoints) ? definition.fitPoints : [];
        if (fitPoints.length >= 2) {
            return this._sampleCatmullRom(
                fitPoints.map(point => ({ x: point.x, y: point.y })),
                !!definition.isClosed
            );
        }

        const controlPoints = Array.isArray(definition.controlPoints)
            ? definition.controlPoints
                .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y))
                .map(point => ({ x: point.x, y: point.y }))
            : [];
        if (controlPoints.length < 2) return [];

        const degree = Math.max(1, Math.min(10, Math.round(definition.degree || 3)));
        let knots = Array.isArray(definition.knots)
            ? definition.knots.filter(value => Number.isFinite(value))
            : [];
        const expectedKnots = controlPoints.length + degree + 1;
        if (knots.length !== expectedKnots) {
            knots = [];
            const interiorCount = Math.max(0, controlPoints.length - degree - 1);
            for (let i = 0; i <= degree; i++) knots.push(0);
            for (let i = 1; i <= interiorCount; i++) knots.push(i);
            for (let i = 0; i <= degree; i++) knots.push(interiorCount + 1);
        }

        const start = knots[degree];
        const end = knots[knots.length - degree - 1];
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return controlPoints;
        }

        const isClosed = !!definition.isClosed;
        const resolution = this._getImportResolutionEffectiveValue();
        const estimatedLength = this._estimatePolylineLength(controlPoints);
        const normalizedResolution = (resolution - 1) / 199;
        const targetStep = Math.max(0.06, 1.1 - (normalizedResolution * 0.98));
        const sampleCount = Math.max(
            64,
            Math.min(
                26000,
                Math.ceil(estimatedLength / targetStep) +
                Math.ceil(controlPoints.length * (0.05 + (resolution / 200))) +
                Math.ceil(resolution * 13)
            )
        );
        const points = [];
        for (let i = 0; i <= sampleCount; i++) {
            const t = start + ((end - start) * (i / sampleCount));
            const point = this._evaluateDXFBSplinePoint(controlPoints, Math.min(degree, controlPoints.length - 1), knots, t);
            if (!point) continue;
            const last = points[points.length - 1];
            if (!last || Math.abs(last.x - point.x) > 0.0001 || Math.abs(last.y - point.y) > 0.0001) {
                points.push(point);
            }
        }

        if (isClosed && points.length > 1) {
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.abs(first.x - last.x) > 0.0001 || Math.abs(first.y - last.y) > 0.0001) {
                points.push({ ...first });
            }
        }

        return this._simplifyImportedPoints(points, isClosed);
    }

    async _processDXFEntity(type, props, allPaths, updateBounds, tf) {
        const apply = (p) => this._applyDXFTransform(p, tf);

        if (type === 'LINE') {
            const x1 = props[10]?.[0], y1 = props[20]?.[0];
            const x2 = props[11]?.[0], y2 = props[21]?.[0];
            if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
                const p1 = apply({ x: x1, y: y1 });
                const p2 = apply({ x: x2, y: y2 });
                allPaths.push([p1, p2]);
                updateBounds(p1.x, p1.y); updateBounds(p2.x, p2.y);
            }
            return;
        }

        if (type === 'LWPOLYLINE') {
            const xs = props[10] || [];
            const ys = props[20] || [];
            const bulges = props[42] || [];
            const vertices = [];
            for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
                const x = xs[i], y = ys[i];
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    vertices.push({ x, y, bulge: Number.isFinite(bulges[i]) ? bulges[i] : 0 });
                }
            }
            const closedFlag = props[70]?.[0];
            const isClosed = Number.isFinite(closedFlag) && ((closedFlag & 1) === 1);
            const transformedVertices = vertices.map(vertex => {
                const transformed = apply({ x: vertex.x, y: vertex.y });
                return { x: transformed.x, y: transformed.y, bulge: vertex.bulge || 0 };
            });
            const pts = this._buildDXFPolylinePoints(transformedVertices, isClosed);
            pts.forEach(p => updateBounds(p.x, p.y));
            if (pts.length > 1) {
                const hasBulges = transformedVertices.some(vertex => Math.abs(vertex.bulge || 0) > 1e-6);
                if (hasBulges) {
                    allPaths.push({
                        points: pts,
                        machinePreviewSource: {
                            kind: 'dxfBulgePolyline',
                            vertices: transformedVertices,
                            isClosed
                        }
                    });
                } else {
                    allPaths.push(pts);
                }
            }
            return;
        }

        if (type === 'CIRCLE' || type === 'ARC') {
            const cx = props[10]?.[0], cy = props[20]?.[0], r = props[40]?.[0];
            if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;

            const s = (type === 'ARC' ? (props[50]?.[0] || 0) : 0) * Math.PI / 180;
            let e = (type === 'ARC' ? (props[51]?.[0] || 360) : 360) * Math.PI / 180;
            if (e < s) e += Math.PI * 2;

            const arc = this._sampleDXFArc(cx, cy, r, s, e, 12).map(apply);
            arc.forEach(p => updateBounds(p.x, p.y));
            allPaths.push(arc);
            return;
        }

        if (type === 'SPLINE') {
            const pts = this._sampleDXFSpline(props).map(apply);
            pts.forEach(p => updateBounds(p.x, p.y));
            if (pts.length > 1) {
                const fitXs = props[11] || [];
                const fitYs = props[21] || [];
                const transformedFitPoints = fitXs.length >= 2 && fitXs.length === fitYs.length
                    ? fitXs.map((x, index) => apply({ x, y: fitYs[index] }))
                    : [];
                const xs = props[10] || [];
                const ys = props[20] || [];
                const transformedControlPoints = [];
                for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
                    const x = xs[i];
                    const y = ys[i];
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        transformedControlPoints.push(apply({ x, y }));
                    }
                }
                allPaths.push({
                    points: pts,
                    machinePreviewSource: {
                        kind: 'dxfSpline',
                        fitPoints: transformedFitPoints,
                        controlPoints: transformedControlPoints,
                        degree: Math.max(1, Math.min(10, Math.round(props[71]?.[0] || 3))),
                        knots: (props[40] || []).filter(value => Number.isFinite(value)),
                        isClosed: Number.isFinite(props[70]?.[0]) && ((props[70][0] & 1) === 1)
                    }
                });
            }
            return;
        }
    }

    // Ignore HATCH / TEXT / DIMENSION / etc for now (they don't plot cleanly anyway)
    // HPGL Parser - Allows re-importing exported files
    async parseHPGL(content) {
        this.app.ui.updateLoading(5, 'Parsing HPGL commands...');

        // Basic HPGL parsing for PU (Pen Up), PD (Pen Down), PA (Plot Absolute)
        const commands = content.split(';').map(c => c.trim()).filter(c => c !== "");
        const allPaths = [];
        let currentPath = [];
        let penDown = false;
        let lastX = 0, lastY = 0;
        let currentPen = 1;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const updateBounds = (x, y) => {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };

        const parseParams = (str) => {
            if (!str) return [];
            return str.split(/[\s,]+/).filter(t => t.trim() !== "").map(p => parseFloat(p));
        };

        for (let i = 0; i < commands.length; i++) {
            const cmd = commands[i];
            const type = cmd.substring(0, 2).toUpperCase();
            const params = parseParams(cmd.substring(2));

            if (type === 'SP') {
                currentPen = params[0] || 0;
            } else if (type === 'PU') {
                if (currentPath.length > 1) allPaths.push(currentPath);
                currentPath = [];
                penDown = false;
                if (params.length >= 2) {
                    lastX = params[0] / this.UNITS_PER_MM;
                    lastY = params[1] / this.UNITS_PER_MM;
                }
            } else if (type === 'PD') {
                penDown = true;
                if (currentPath.length === 0) {
                    currentPath.push({ x: lastX, y: lastY });
                }
                for (let j = 0; j < params.length; j += 2) {
                    lastX = params[j] / this.UNITS_PER_MM;
                    lastY = params[j + 1] / this.UNITS_PER_MM;
                    currentPath.push({ x: lastX, y: lastY });
                }
            } else if (type === 'PA') {
                for (let j = 0; j < params.length; j += 2) {
                    lastX = params[j] / this.UNITS_PER_MM;
                    lastY = params[j + 1] / this.UNITS_PER_MM;
                    if (penDown) {
                        if (currentPath.length === 0) currentPath.push({ x: lastX, y: lastY });
                        currentPath.push({ x: lastX, y: lastY });
                    }
                }
            } else if (type === 'CI') {
                if (params.length >= 1) {
                    const radius = params[0] / this.UNITS_PER_MM;
                    const visPen = this.app.ui.activeVisualizerPen || 1;

                    // Ensure the active visualiser pen layer is visible so imports don't appear 'blank'
                    if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[visPen - 1]) {
                        this.app.ui.visPenConfig[visPen - 1].visible = true;
                        this.app.ui.saveWorkspaceState();
                        this.app.ui.updateVisualizerPalette();
                    }
                    this.app.canvas.addPath({ type: 'circle', x: lastX, y: lastY, r: radius, pen: visPen });
                }
            }

            if (i % 100 === 0) {
                const prog = 5 + Math.floor((i / commands.length) * 80);
                this.app.ui.updateLoading(prog, `Parsing HPGL: ${i}/${commands.length}`);
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (currentPath.length > 1) allPaths.push(currentPath);

        if (allPaths.length === 0) {
            this.app.ui.logToConsole('System: No valid HPGL paths found.');
            return;
        }

        allPaths.forEach(p => p.forEach(pt => updateBounds(pt.x, pt.y)));

        this.app.ui.updateLoading(90, 'Finalizing paths...');
        this.finalizeImport(allPaths, minX, minY, maxX, maxY, 'HPGL');
    }

    finalizeImport(allPaths, minX, minY, maxX, maxY, formatName, options = {}) {
        if (allPaths.length === 0) {
            this.app.ui.logToConsole(`System: No supported vector geometry found in ${formatName}.`);
            return;
        }

        const svgW = maxX - minX;
        const svgH = maxY - minY;
        const margin = 10;
        const bedW = this.app.canvas.bedWidth - (margin * 2);
        const bedH = this.app.canvas.bedHeight - (margin * 2);

        let scale = 1;
        if (svgW > bedW || svgH > bedH) {
            scale = Math.min(bedW / (svgW || 1), bedH / (svgH || 1));
        } else if (svgW < 2 || svgH < 2) {
            scale = Math.min((bedW / 4) / (svgW || 1), (bedH / 4) / (svgH || 1));
        }

        const offsetX = (this.app.canvas.bedWidth / 2) - ((svgW * scale) / 2) - (minX * scale);
        const offsetY = (this.app.canvas.bedHeight / 2) - ((svgH * scale) / 2) - (minY * scale);
        const normalizeY = (y) => options.flipY ? (minY + maxY - y) : y;

        const visPen = this.app.ui.activeVisualizerPen || 1;

        // Ensure the active visualiser pen layer is visible so imports don't appear 'blank'
        if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[visPen - 1]) {
            this.app.ui.visPenConfig[visPen - 1].visible = true;
            this.app.ui.saveWorkspaceState();
            this.app.ui.updateVisualizerPalette();
        }
        let pointsCount = 0;
        let editableCurvePathCount = 0;
        const groupId = 'import_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        allPaths.forEach(poly => {
            if (Array.isArray(poly)) {
                // Simple point array
                const scaledPoly = poly.map(p => ({
                    x: (p.x * scale) + offsetX,
                    y: (normalizeY(p.y) * scale) + offsetY
                }));
                this.app.canvas.addPath({ type: 'polyline', points: scaledPoly, pen: visPen, groupId });
                pointsCount += scaledPoly.length;
            } else if (poly.points) {
                // Object with points and native curve segments
                const scaledPoly = poly.points.map(p => ({
                    x: (p.x * scale) + offsetX,
                    y: (normalizeY(p.y) * scale) + offsetY
                }));

                let scaledSegments = null;
                if (poly.segments) {
                    scaledSegments = poly.segments.map(s => {
                        const scaled = { ...s };
                        // Scale Endpoints
                        if (s.x !== undefined) { scaled.x = (s.x * scale) + offsetX; scaled.y = (normalizeY(s.y) * scale) + offsetY; }
                        // Scale Handle 1
                        if (s.x1 !== undefined) { scaled.x1 = (s.x1 * scale) + offsetX; scaled.y1 = (normalizeY(s.y1) * scale) + offsetY; }
                        // Scale Handle 2
                        if (s.x2 !== undefined) { scaled.x2 = (s.x2 * scale) + offsetX; scaled.y2 = (normalizeY(s.y2) * scale) + offsetY; }
                        // Scale Arc settings
                        if (s.rx !== undefined) { scaled.rx = s.rx * scale; scaled.ry = s.ry * scale; }
                        return scaled;
                    });
                }
                let scaledMachinePreviewSource = null;
                if (poly.machinePreviewSource) {
                    const scalePreviewPoint = (point) => ({
                        x: (point.x * scale) + offsetX,
                        y: (normalizeY(point.y) * scale) + offsetY
                    });
                    scaledMachinePreviewSource = { ...poly.machinePreviewSource };
                    if (Array.isArray(poly.machinePreviewSource.vertices)) {
                        scaledMachinePreviewSource.vertices = poly.machinePreviewSource.vertices.map(vertex => ({
                            x: (vertex.x * scale) + offsetX,
                            y: (normalizeY(vertex.y) * scale) + offsetY,
                            bulge: vertex.bulge || 0
                        }));
                    }
                    if (Array.isArray(poly.machinePreviewSource.fitPoints)) {
                        scaledMachinePreviewSource.fitPoints = poly.machinePreviewSource.fitPoints.map(scalePreviewPoint);
                    }
                    if (Array.isArray(poly.machinePreviewSource.controlPoints)) {
                        scaledMachinePreviewSource.controlPoints = poly.machinePreviewSource.controlPoints.map(scalePreviewPoint);
                    }
                }

                const pathObj = {
                    type: scaledSegments ? 'path' : 'polyline',
                    points: scaledPoly,
                    closed: poly.closed === true || this.isClosedPointLoop(scaledPoly),
                    pen: visPen,
                    groupId
                };
                if (scaledSegments) {
                    pathObj.segments = scaledSegments;
                    editableCurvePathCount++;
                }
                if (scaledMachinePreviewSource) {
                    pathObj.machinePreviewSource = scaledMachinePreviewSource;
                }
                this.app.canvas.addPath(pathObj);
                pointsCount += scaledPoly.length;
            }
        });

        const resolution = this._getImportResolutionValue();
        this.app.ui.logToConsole(`System: Imported ${formatName} (x${scale.toFixed(2)}). Centered. ${pointsCount} points across ${allPaths.length} paths. Curve resolution ${resolution}/100.`);
        if (editableCurvePathCount > 0) {
            this.app.ui.logToConsole(`System: Preserved ${editableCurvePathCount} imported path(s) with editable curve nodes for the node tool.`);
        }
        if (this.app?.settings?.outputFlipHorizontal === true) {
            this.app.ui.logToConsole('System Warning: Horizontal plot output flip is enabled, so generated output will be mirrored relative to the canvas preview.', 'warning');
        }
    }
}
