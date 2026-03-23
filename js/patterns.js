class PatternGenerator {
    constructor(app) {
        this.app = app;
    }

    /**
     * Generates a pattern of paths based on source paths and parameters.
     * @param {Array} sourcePaths - The original paths to replicate
     * @param {Object} params - Pattern parameters
     * @returns {Array} - Array of new transformed path objects
     */
    generate(sourcePaths, params) {
        if (!sourcePaths || sourcePaths.length === 0) return [];

        const {
            type,
            count = 1,
            spacing = 10,
            direction = 0,
            angle = 0,
            size = 1.0,
            growth = 1.0
        } = params;

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
