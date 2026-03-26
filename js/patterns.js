class PatternGenerator {
    constructor(app) {
        this.app = app;
        this.sandifyLoopReference = 'References/sandify-master/src/features/effects/Loop.js';
    }

    /**
     * Generates a pattern of paths based on source paths and parameters.
     * @param {Array} sourcePaths - The original paths to replicate
     * @param {Object} params - Pattern parameters
     * @returns {Array} - Array of new transformed path objects
     */
    generate(sourcePaths, params) {
        const {
            type,
            count = 1,
            spacing = 10,
            direction = 0,
            angle = 0,
            size = 1.0,
            growth = 1.0
        } = params;

        if (type === 'continuousContour') {
            return this._generateContinuousContour(sourcePaths || [], params);
        }

        if (!sourcePaths || sourcePaths.length === 0) return [];
        if (type === 'none' || count <= 1 && type !== 'grid') return [];

        // Find bounding box center of source paths for transformation anchor
        const box = this.app.canvas.getGroupBoundingBoxFromPaths(sourcePaths);
        if (!box) return [];
        const centerX = (box.minX + box.maxX) / 2;
        const centerY = (box.minY + box.maxY) / 2;

        let results = [];

        switch (type) {
            case 'radial':
                results = this._generateRadial(sourcePaths, count, spacing, direction, angle, size, growth, centerX, centerY, params.spacingAngle || 0);
                break;
            case 'grid':
                results = this._generateGrid(sourcePaths, count, spacing, direction, angle, size, centerX, centerY, false);
                break;
            case 'staggered':
                results = this._generateGrid(sourcePaths, count, spacing, direction, angle, size, centerX, centerY, true);
                break;
            case 'spiral':
                results = this._generateSpiral(sourcePaths, count, spacing, direction, angle, size, growth, centerX, centerY, params.spacingAngle || 0);
                break;
            case 'geometric':
                results = this._generateSymmetrical(sourcePaths, count, spacing, angle, centerX, centerY);
                break;
        }

        return results;
    }

    _generateContinuousContour(sourcePaths, params) {
        const sourceMode = params.contourSource || 'preset';
        const selectedPoints = sourceMode === 'selected' ? this._extractSelectedLoopPoints(sourcePaths) : [];
        const basePoints = selectedPoints.length >= 3
            ? selectedPoints
            : this._buildContourPresetPoints(params);

        if (!basePoints || basePoints.length < 3) return [];

        const bedWidth = this.app.canvas?.bedWidth || 432;
        const bedHeight = this.app.canvas?.bedHeight || 297;
        const center = this._getPointsCenter(basePoints) || { x: bedWidth / 2, y: bedHeight / 2 };
        const shapeName = params.contourShape || 'circle';
        const sourceLabel = sourceMode === 'selected' ? 'selected' : `${shapeName} preset`;

        // Sandify reference: loop effect smears a closed vertex list over repeated
        // scaled / rotated iterations, so we do the same here for a single continuous path.
        const points = this._generateSandifyStyleLoopPoints(basePoints, {
            numLoops: params.contourLoops || 18,
            scalePerLoop: params.contourScale || 0,
            spinPerLoop: params.contourSpin || 0
        }, center);

        if (!points || points.length < 2) return [];

        return [{
            type: 'polyline',
            points,
            pen: this.app.ui?.activeVisualizerPen || 1,
            generatedBy: 'continuous-contour',
            sourceMode,
            sourceLabel,
            reference: this.sandifyLoopReference
        }];
    }

    _generateSandifyStyleLoopPoints(points, loopParams, center) {
        const closedPoints = this._ensureClosed(points);
        if (closedPoints.length < 3) return [];

        const smearPoints = closedPoints.slice(0, -1);
        const output = [];
        const loops = Math.max(1, Math.floor(loopParams.numLoops || 1));
        const spin = parseFloat(loopParams.spinPerLoop || 0);
        const scaleStep = parseFloat(loopParams.scalePerLoop || 0);

        for (let loopIndex = 0; loopIndex < loops; loopIndex++) {
            for (let pointIndex = 0; pointIndex < smearPoints.length; pointIndex++) {
                const basePoint = smearPoints[pointIndex];
                const amount = loopIndex + (pointIndex / smearPoints.length);
                const scale = Math.max(0.05, (100 + (scaleStep * amount)) / 100);
                const angle = (spin * amount * Math.PI) / 180;
                const dx = basePoint.x - center.x;
                const dy = basePoint.y - center.y;
                const scaledX = dx * scale;
                const scaledY = dy * scale;
                output.push({
                    x: center.x + (scaledX * Math.cos(angle) - scaledY * Math.sin(angle)),
                    y: center.y + (scaledX * Math.sin(angle) + scaledY * Math.cos(angle))
                });
            }
        }

        return output;
    }

    _extractSelectedLoopPoints(sourcePaths) {
        if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return [];
        const primary = sourcePaths[0];
        return this._pathToLoopPoints(primary);
    }

    _pathToLoopPoints(path) {
        if (!path) return [];
        if (path.type === 'circle') {
            return this._ensureClosed(this._sampleCircle(path.x, path.y, path.r, 128));
        }
        if (path.type === 'rectangle') {
            return this._ensureClosed([
                { x: path.x, y: path.y },
                { x: path.x + (path.w || 0), y: path.y },
                { x: path.x + (path.w || 0), y: path.y + (path.h || 0) },
                { x: path.x, y: path.y + (path.h || 0) }
            ]);
        }
        if (path.type === 'text') {
            const width = Math.max(path.fontSize || 10, (path.text?.length || 1) * (path.fontSize || 10) * 0.6);
            const height = path.fontSize || 10;
            return this._ensureClosed([
                { x: path.x, y: path.y },
                { x: path.x + width, y: path.y },
                { x: path.x + width, y: path.y + height },
                { x: path.x, y: path.y + height }
            ]);
        }

        const traced = this.app?.hpgl?.getTracePointsForPath
            ? this.app.hpgl.getTracePointsForPath(path)
            : (Array.isArray(path.points) ? path.points : []);
        return this._ensureClosed(traced.map(point => ({ x: point.x, y: point.y })));
    }

    _buildContourPresetPoints(params) {
        const bedWidth = this.app.canvas?.bedWidth || 432;
        const bedHeight = this.app.canvas?.bedHeight || 297;
        const center = { x: bedWidth / 2, y: bedHeight / 2 };
        const size = Math.max(10, parseFloat(params.contourSize || 120));
        const detail = Math.max(3, parseInt(params.contourDetail || 6, 10));
        const variation = Math.max(1, parseInt(params.contourVariation || 2, 10));
        const shape = params.contourShape || 'circle';

        switch (shape) {
            case 'polygon':
                return this._ensureClosed(this._samplePolygon(center, size * 0.5, detail));
            case 'star':
                return this._ensureClosed(this._sampleStar(center, size * 0.5, detail, Math.max(0.15, Math.min(0.85, variation / 10))));
            case 'rose':
                return this._ensureClosed(this._sampleRose(center, size * 0.5, detail, variation));
            case 'heart':
                return this._ensureClosed(this._sampleHeart(center, size * 0.045));
            case 'circle':
            default:
                return this._ensureClosed(this._sampleCircle(center.x, center.y, size * 0.5, 128));
        }
    }

    _sampleCircle(cx, cy, radius, steps = 128) {
        const points = [];
        for (let i = 0; i <= steps; i++) {
            const angle = (i / steps) * Math.PI * 2;
            points.push({
                x: cx + Math.cos(angle) * radius,
                y: cy + Math.sin(angle) * radius
            });
        }
        return points;
    }

    _samplePolygon(center, radius, sides = 6) {
        const points = [];
        for (let i = 0; i < sides; i++) {
            const angle = ((Math.PI * 2) / sides) * (0.5 + i);
            points.push({
                x: center.x + Math.cos(angle) * radius,
                y: center.y + Math.sin(angle) * radius
            });
        }
        return points;
    }

    _sampleStar(center, radius, pointsCount = 5, innerRatio = 0.5) {
        const points = [];
        const total = pointsCount * 2;
        for (let i = 0; i < total; i++) {
            const angle = ((Math.PI * 2) / total) * i;
            const pointRadius = i % 2 === 0 ? radius * innerRatio : radius;
            points.push({
                x: center.x + Math.cos(angle) * pointRadius,
                y: center.y + Math.sin(angle) * pointRadius
            });
        }
        return points;
    }

    _sampleRose(center, radius, numerator = 3, denominator = 2) {
        const points = [];
        const n = Math.max(1, numerator);
        const d = Math.max(1, denominator);
        const p = (n * d) % 2 === 0 ? 2 : 1;
        const thetaClose = d * p * 32 * n;
        const resolution = 64 * n;

        for (let i = 0; i <= thetaClose; i++) {
            const theta = ((Math.PI * 2) / resolution) * i;
            const r = radius * Math.sin((n / d) * theta);
            points.push({
                x: center.x + r * Math.cos(theta),
                y: center.y + r * Math.sin(theta)
            });
        }
        return points;
    }

    _sampleHeart(center, scale) {
        const points = [];
        for (let i = 0; i < 128; i++) {
            const angle = ((Math.PI * 2) / 128) * i;
            points.push({
                x: center.x + scale * 16 * Math.pow(Math.sin(angle), 3),
                y: center.y + scale * (13 * Math.cos(angle) - 5 * Math.cos(2 * angle) - 2 * Math.cos(3 * angle) - Math.cos(4 * angle))
            });
        }
        return points;
    }

    _getPointsCenter(points) {
        if (!Array.isArray(points) || points.length === 0) return null;
        const box = points.reduce((acc, point) => ({
            minX: Math.min(acc.minX, point.x),
            maxX: Math.max(acc.maxX, point.x),
            minY: Math.min(acc.minY, point.y),
            maxY: Math.max(acc.maxY, point.y)
        }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        return {
            x: (box.minX + box.maxX) / 2,
            y: (box.minY + box.maxY) / 2
        };
    }

    _ensureClosed(points) {
        if (!Array.isArray(points) || points.length === 0) return [];
        const normalized = points.map(point => ({ x: point.x, y: point.y }));
        const first = normalized[0];
        const last = normalized[normalized.length - 1];
        if (!last || Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
            normalized.push({ ...first });
        }
        return normalized;
    }

    _cloneAndTransform(paths, tx, ty, rotDeg, scale, anchorX, anchorY) {
        const rad = (rotDeg * Math.PI) / 180;
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);

        return paths.map(p => {
            const clone = JSON.parse(JSON.stringify(p));

            const transformPoint = (pt) => {
                if (!pt || pt.x === undefined || pt.y === undefined) return pt;
                // 1. Scale relative to anchor
                let x = anchorX + (pt.x - anchorX) * scale;
                let y = anchorY + (pt.y - anchorY) * scale;

                // 2. Rotate relative to anchor
                const dx = x - anchorX;
                const dy = y - anchorY;
                x = anchorX + (dx * cosA - dy * sinA);
                y = anchorY + (dx * sinA + dy * cosA);

                // 3. Translate
                x += tx;
                y += ty;

                return { x, y };
            };

            if (clone.type === 'circle') {
                const pt = transformPoint({ x: clone.x, y: clone.y });
                clone.x = pt.x;
                clone.y = pt.y;
                clone.r *= scale;
            } else if (clone.type === 'rectangle') {
                const pt = transformPoint({ x: clone.x, y: clone.y });
                clone.x = pt.x;
                clone.y = pt.y;
                clone.w = Math.max(0.1, (clone.w || 0) * scale);
                clone.h = Math.max(0.1, (clone.h || 0) * scale);
            } else if (clone.type === 'text') {
                const pt = transformPoint({ x: clone.x, y: clone.y });
                clone.x = pt.x;
                clone.y = pt.y;
                if (clone.fontSize) clone.fontSize *= scale;
                clone.rotation = ((clone.rotation || 0) + rotDeg) % 360;
            } else if (clone.points) {
                clone.points = clone.points.map(pt => transformPoint(pt));
                if (clone.segments) {
                    clone.segments = clone.segments.map(segment => {
                        const nextSegment = { ...segment };
                        if (segment.x !== undefined && segment.y !== undefined) {
                            const pt = transformPoint({ x: segment.x, y: segment.y });
                            nextSegment.x = pt.x;
                            nextSegment.y = pt.y;
                        }
                        if (segment.x1 !== undefined && segment.y1 !== undefined) {
                            const pt = transformPoint({ x: segment.x1, y: segment.y1 });
                            nextSegment.x1 = pt.x;
                            nextSegment.y1 = pt.y;
                        }
                        if (segment.x2 !== undefined && segment.y2 !== undefined) {
                            const pt = transformPoint({ x: segment.x2, y: segment.y2 });
                            nextSegment.x2 = pt.x;
                            nextSegment.y2 = pt.y;
                        }
                        return nextSegment;
                    });
                }
            }

            return clone;
        });
    }

    _generateRadial(source, count, radius, startAngle, itemRotation, scaleStep, growth, cx, cy, spacingAngle = 0) {
        const results = [];
        const baseAngleStep = (360 / count);

        for (let i = 1; i < count; i++) {
            // Incorporate Spacing Angle to compress or expand the radial distribution
            const currentAngleStep = baseAngleStep + spacingAngle;
            const angleDeg = (i * currentAngleStep + startAngle);
            const angleRad = angleDeg * Math.PI / 180;

            const tx = Math.cos(angleRad) * radius - (Math.cos(startAngle * Math.PI / 180) * radius);
            const ty = Math.sin(angleRad) * radius - (Math.sin(startAngle * Math.PI / 180) * radius);

            const rot = i * currentAngleStep + itemRotation;
            const s = Math.pow(growth, i);

            results.push(...this._cloneAndTransform(source, tx, ty, rot, s, cx, cy));
        }
        return results;
    }

    _generateGrid(source, count, spacing, direction, itemRotation, scale, cx, cy, isStaggered) {
        const results = [];
        const cols = Math.ceil(Math.sqrt(count));
        const rows = Math.ceil(count / cols);

        const radDir = (direction * Math.PI) / 180;
        const dirX = Math.cos(radDir);
        const dirY = Math.sin(radDir);

        for (let i = 0; i < count; i++) {
            if (i === 0) continue; // Skip original

            const r = Math.floor(i / cols);
            const c = i % cols;

            let offsetX = c * spacing;
            let offsetY = r * spacing;

            if (isStaggered && r % 2 === 1) {
                offsetX += spacing / 2;
            }

            // Rotate the grid itself by direction
            const tx = offsetX * Math.cos(radDir) - offsetY * Math.sin(radDir);
            const ty = offsetX * Math.sin(radDir) + offsetY * Math.cos(radDir);

            results.push(...this._cloneAndTransform(source, tx, ty, itemRotation, scale, cx, cy));
        }
        return results;
    }

    _generateSpiral(source, count, spacing, startAngle, itemRotation, scale, growth, cx, cy, spacingAngle = 0) {
        const results = [];
        let currentAngle = startAngle;
        let currentRadius = 0;

        const baseStep = (360 / 12); // approx 12 per rev

        for (let i = 1; i < count; i++) {
            // Incorporate spacing angle into spiral step
            const step = baseStep + spacingAngle;
            currentAngle += step;
            currentRadius += spacing / (360 / step);

            const rad = (currentAngle * Math.PI) / 180;
            const tx = Math.cos(rad) * currentRadius;
            const ty = Math.sin(rad) * currentRadius;

            const s = Math.pow(growth, i);
            results.push(...this._cloneAndTransform(source, tx, ty, i * itemRotation, s, cx, cy));
        }
        return results;
    }

    _generateSymmetrical(source, count, spacing, itemRotation, cx, cy) {
        const results = [];
        // Simple rotational symmetry
        for (let i = 1; i < count; i++) {
            const rot = i * (360 / count);
            results.push(...this._cloneAndTransform(source, 0, 0, rot, 1.0, cx, cy));
        }
        return results;
    }
}
