class Vector3DWrapEngine {
    constructor(app) {
        this.app = app;
    }

    getSelectedCanvasPolylines() {
        const canvas = this.app?.canvas;
        const hpgl = this.app?.hpgl;
        if (!canvas || !hpgl) return [];

        const selected = Array.isArray(canvas.selectedPaths) ? canvas.selectedPaths : [];
        return selected
            .map(index => canvas.paths[index])
            .map(path => this._pathToPolyline(path, hpgl))
            .filter(polyline => polyline.length >= 2);
    }

    parseSvgPolylines(svgText, sampleLength = 6) {
        const dom = new DOMParser().parseFromString(svgText, 'image/svg+xml');
        const svg = dom.querySelector('svg');
        if (!svg) throw new Error('Invalid SVG file.');

        const polylines = [];
        const walk = (node) => {
            if (!node || node.nodeType !== 1) return;
            const tag = String(node.tagName || '').toLowerCase();

            if (tag === 'path') {
                const d = node.getAttribute('d');
                if (d) {
                    const raw = this.app.hpgl.parsePathData(d) || [];
                    raw.forEach(poly => {
                        if (Array.isArray(poly) && poly.length >= 2) polylines.push(poly.map(this._clonePoint));
                    });
                }
            } else if (tag === 'polyline' || tag === 'polygon') {
                const points = this._parseSvgPointList(node.getAttribute('points'));
                if (tag === 'polygon' && points.length >= 2) points.push({ ...points[0] });
                if (points.length >= 2) polylines.push(points);
            } else if (tag === 'line') {
                const x1 = Number(node.getAttribute('x1')) || 0;
                const y1 = Number(node.getAttribute('y1')) || 0;
                const x2 = Number(node.getAttribute('x2')) || 0;
                const y2 = Number(node.getAttribute('y2')) || 0;
                polylines.push([{ x: x1, y: y1 }, { x: x2, y: y2 }]);
            } else if (tag === 'rect') {
                const x = Number(node.getAttribute('x')) || 0;
                const y = Number(node.getAttribute('y')) || 0;
                const w = Number(node.getAttribute('width')) || 0;
                const h = Number(node.getAttribute('height')) || 0;
                if (w > 0 && h > 0) {
                    polylines.push([
                        { x, y },
                        { x: x + w, y },
                        { x: x + w, y: y + h },
                        { x, y: y + h },
                        { x, y }
                    ]);
                }
            } else if (tag === 'circle') {
                const cx = Number(node.getAttribute('cx')) || 0;
                const cy = Number(node.getAttribute('cy')) || 0;
                const r = Number(node.getAttribute('r')) || 0;
                if (r > 0) polylines.push(this._sampleEllipse(cx, cy, r, r, 48));
            } else if (tag === 'ellipse') {
                const cx = Number(node.getAttribute('cx')) || 0;
                const cy = Number(node.getAttribute('cy')) || 0;
                const rx = Number(node.getAttribute('rx')) || 0;
                const ry = Number(node.getAttribute('ry')) || 0;
                if (rx > 0 && ry > 0) polylines.push(this._sampleEllipse(cx, cy, rx, ry, 48));
            }

            Array.from(node.children || []).forEach(walk);
        };

        walk(svg);
        return this._densifyPolylines(polylines, sampleLength);
    }

    normalizePolylines(polylines) {
        const bounds = this.getBounds(polylines);
        if (!bounds) return [];

        const width = Math.max(1e-6, bounds.maxX - bounds.minX);
        const height = Math.max(1e-6, bounds.maxY - bounds.minY);
        const scale = 1 / Math.max(width, height);
        const cx = (bounds.minX + bounds.maxX) * 0.5;
        const cy = (bounds.minY + bounds.maxY) * 0.5;

        return polylines.map(polyline => polyline.map(point => ({
            x: (point.x - cx) * scale,
            y: (point.y - cy) * scale
        })));
    }

    resamplePolylines(polylines, maxSegmentLength = 0.015) {
        return this._densifyPolylines(polylines, maxSegmentLength);
    }

    getBounds(polylines) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        (polylines || []).forEach(polyline => {
            (polyline || []).forEach(point => {
                if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return;
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            });
        });

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return null;
        }

        return { minX, minY, maxX, maxY };
    }

    buildWrappedResult(options) {
        const {
            THREE,
            camera,
            surfaceMesh,
            planeMesh,
            artworkPolylines,
            mapper,
            mapperPolyline,
            visibilityEvaluator,
            projectPoint,
            includeHidden,
            bedWidth,
            bedHeight,
            activePen,
            enableBridging = false,
            splitOnFaceChange = false,
            useViewportFrame = false,
            viewportAspect = 1
        } = options;

        if (!Array.isArray(artworkPolylines) || artworkPolylines.length === 0) {
            return { projectedPaths: [], wrappedPolylines: [], segmentCount: 0 };
        }

        const wrappedPolylines = artworkPolylines
            .map(polyline => {
                if (typeof mapperPolyline === 'function') {
                    return mapperPolyline(polyline).filter(Boolean);
                }
                return polyline.map(point => mapper(point)).filter(Boolean);
            })
            .filter(polyline => polyline.length >= 2);

        const surfaceTargets = [surfaceMesh];
        if (planeMesh) surfaceTargets.push(planeMesh);

        const projectedFragments = [];
        wrappedPolylines.forEach(polyline => {
            const samples = polyline.map(worldPoint => {
                const visible = includeHidden || (typeof visibilityEvaluator === 'function'
                    ? visibilityEvaluator(worldPoint, surfaceTargets)
                    : this._isPointVisible(camera, worldPoint, surfaceTargets, THREE));
                const projected = typeof projectPoint === 'function'
                    ? projectPoint(worldPoint)
                    : worldPoint.clone().project(camera);
                return {
                    worldPoint,
                    visible,
                    projected: projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)
                        ? {
                            x: projected.x,
                            y: projected.y
                        }
                        : null
                };
            });

            let currentFragment = [];
            for (let i = 0; i < samples.length; i++) {
                const sample = samples[i];
                if (!sample.visible || !sample.projected) {
                    const stitch = !includeHidden && enableBridging
                        ? this._findBridgeCandidate(samples, i)
                        : null;
                    if (stitch && currentFragment.length) {
                        currentFragment.push(stitch.projected);
                        i = stitch.index;
                        continue;
                    }
                    if (currentFragment.length >= 2) projectedFragments.push(currentFragment);
                    currentFragment = [];
                    continue;
                }

                if (splitOnFaceChange && currentFragment.length) {
                    const previousSample = samples[i - 1];
                    const previousFace = previousSample?.worldPoint?._v3dFace;
                    const currentFace = sample?.worldPoint?._v3dFace;
                    if (previousFace != null && currentFace != null && previousFace !== currentFace) {
                        if (currentFragment.length >= 2) projectedFragments.push(currentFragment);
                        currentFragment = [];
                    }
                }

                currentFragment.push(sample.projected);
            }

            if (currentFragment.length >= 2) projectedFragments.push(currentFragment);
        });

        const flattened = this._fitProjectedPolylines(
            projectedFragments,
            bedWidth,
            bedHeight,
            activePen,
            useViewportFrame,
            viewportAspect
        );
        return {
            projectedPaths: flattened,
            wrappedPolylines,
            segmentCount: flattened.reduce((count, path) => count + Math.max(0, (path.points?.length || 0) - 1), 0)
        };
    }

    _findBridgeCandidate(samples, startHiddenIndex) {
        const maxHiddenSamples = 6;
        const maxProjectedGap = 0.035;
        const previous = startHiddenIndex > 0 ? samples[startHiddenIndex - 1] : null;
        if (!previous?.visible || !previous.projected) return null;

        let hiddenCount = 0;
        for (let index = startHiddenIndex; index < samples.length; index++) {
            const sample = samples[index];
            if (!sample.visible || !sample.projected) {
                hiddenCount += 1;
                if (hiddenCount > maxHiddenSamples) return null;
                continue;
            }

            const dx = sample.projected.x - previous.projected.x;
            const dy = sample.projected.y - previous.projected.y;
            const distance = Math.hypot(dx, dy);
            if (distance <= maxProjectedGap) {
                return { index, projected: sample.projected };
            }
            return null;
        }

        return null;
    }

    downloadSvg(paths, filename = '3d-vector-export.svg') {
        const content = this.app.hpgl.exportSVG(paths);
        if (!content) return false;
        const blob = new Blob([content], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
        return true;
    }

    _pathToPolyline(path, hpgl) {
        const points = hpgl.getExportTracePointsForPath(path);
        return Array.isArray(points) ? points.map(this._clonePoint) : [];
    }

    _clonePoint(point) {
        return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
    }

    _parseSvgPointList(rawPoints) {
        if (!rawPoints) return [];
        const values = String(rawPoints).trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
        const points = [];
        for (let i = 0; i < values.length - 1; i += 2) {
            points.push({ x: values[i], y: values[i + 1] });
        }
        return points;
    }

    _sampleEllipse(cx, cy, rx, ry, segments) {
        const points = [];
        const count = Math.max(12, segments | 0);
        for (let i = 0; i <= count; i++) {
            const t = (i / count) * Math.PI * 2;
            points.push({
                x: cx + Math.cos(t) * rx,
                y: cy + Math.sin(t) * ry
            });
        }
        return points;
    }

    _densifyPolylines(polylines, maxSegmentLength) {
        const step = Math.max(1e-4, Number(maxSegmentLength) || 6);
        return (polylines || []).map(polyline => {
            if (!Array.isArray(polyline) || polyline.length < 2) return [];
            const sampled = [this._clonePoint(polyline[0])];
            for (let i = 1; i < polyline.length; i++) {
                const a = polyline[i - 1];
                const b = polyline[i];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.hypot(dx, dy);
                const divisions = Math.max(1, Math.ceil(dist / step));
                for (let j = 1; j <= divisions; j++) {
                    const t = j / divisions;
                    sampled.push({
                        x: a.x + dx * t,
                        y: a.y + dy * t
                    });
                }
            }
            return sampled;
        }).filter(polyline => polyline.length >= 2);
    }

    _isPointVisible(camera, worldPoint, surfaceTargets, THREE) {
        if (!camera || !worldPoint || !Array.isArray(surfaceTargets) || !surfaceTargets.length) return true;

        const origin = camera.position.clone();
        const direction = worldPoint.clone().sub(origin);
        const distanceToPoint = direction.length();
        if (distanceToPoint <= 1e-5) return true;

        const raycaster = new THREE.Raycaster(origin, direction.normalize(), 0.0001, distanceToPoint + 0.001);
        const hits = raycaster.intersectObjects(surfaceTargets, true);
        if (!hits.length) return true;
        const firstSurfaceHit = hits.find(hit => hit?.object?.isMesh);
        if (!firstSurfaceHit) return true;
        return Math.abs(firstSurfaceHit.distance - distanceToPoint) < 0.01;
    }

    _fitProjectedPolylines(projectedPolylines, bedWidth, bedHeight, pen, useViewportFrame = false, viewportAspect = 1) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        if (useViewportFrame) {
            const safeAspect = Math.max(0.1, Number(viewportAspect) || 1);
            if (safeAspect >= 1) {
                const halfHeight = 0.5 / safeAspect;
                minX = 0;
                maxX = 1;
                minY = 0.5 - halfHeight;
                maxY = 0.5 + halfHeight;
            } else {
                const halfWidth = 0.5 * safeAspect;
                minX = 0.5 - halfWidth;
                maxX = 0.5 + halfWidth;
                minY = 0;
                maxY = 1;
            }
        } else {
            projectedPolylines.forEach(polyline => {
                polyline.forEach(point => {
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                });
            });
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
            return [];
        }

        const width = Math.max(1e-6, maxX - minX);
        const height = Math.max(1e-6, maxY - minY);
        const margin = 10;
        const availableWidth = Math.max(10, bedWidth - margin * 2);
        const availableHeight = Math.max(10, bedHeight - margin * 2);
        const squareFit = Math.min(availableWidth, availableHeight);
        const scale = squareFit / Math.max(width, height);
        const offsetX = (bedWidth - width * scale) * 0.5 - minX * scale;
        const offsetY = (bedHeight - height * scale) * 0.5 - minY * scale;

        return projectedPolylines
            .filter(polyline => polyline.length >= 2)
            .map(polyline => ({
                type: 'polyline',
                pen,
                points: polyline.map(point => ({
                    x: point.x * scale + offsetX,
                    y: point.y * scale + offsetY
                }))
            }));
    }
}

if (typeof module !== 'undefined') module.exports = Vector3DWrapEngine;
else window.Vector3DWrapEngine = Vector3DWrapEngine;
