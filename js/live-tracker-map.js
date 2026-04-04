class LiveTrackerMapper {
    constructor(app) {
        this.app = app;
        this.reset();
    }

    reset() {
        this.lastSmoothedNorm = null;
        this.lastOutputVisual = null;
        this.lastOutputTime = 0;
    }

    clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    toVisualPoint(normPoint, settings = {}) {
        const bedWidth = this.app?.settings?.bedWidth || this.app?.canvas?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || this.app?.canvas?.bedHeight || 297;
        const overlay = settings?.trackingBounds || settings?.overlay || null;
        const canvas = this.app?.canvas || null;

        if (overlay && canvas && typeof canvas.canvasPxToMM === 'function') {
            const px = (overlay.left || 0) + (this.clamp(normPoint.x, 0, 1) * (overlay.width || 0));
            const py = (overlay.top || 0) + (this.clamp(normPoint.y, 0, 1) * (overlay.height || 0));
            const point = canvas.canvasPxToMM(px, py);
            return {
                x: this.clamp(point.xMM, 0, bedWidth),
                y: this.clamp(point.yMM, 0, bedHeight)
            };
        }

        return {
            x: this.clamp(normPoint.x, 0, 1) * bedWidth,
            y: this.clamp(normPoint.y, 0, 1) * bedHeight
        };
    }

    getSpeedLight(speed, maxSpeed) {
        if (!Number.isFinite(speed) || speed <= 0.01) return 'green';
        const ratio = maxSpeed > 0 ? (speed / maxSpeed) : 0;
        if (ratio >= 0.9) return 'red';
        if (ratio >= 0.6) return 'orange';
        return 'green';
    }

    mapLatest(rawNormPoint, settings, timestamp = performance.now()) {
        if (!rawNormPoint) return null;

        const smoothing = this.clamp(Number(settings?.smoothing ?? 0.45), 0, 0.95);
        const alpha = 1 - smoothing;
        const lastNorm = this.lastSmoothedNorm || rawNormPoint;
        const smoothedNorm = {
            x: lastNorm.x + ((rawNormPoint.x - lastNorm.x) * alpha),
            y: lastNorm.y + ((rawNormPoint.y - lastNorm.y) * alpha)
        };
        this.lastSmoothedNorm = smoothedNorm;

        const visualPoint = this.toVisualPoint(smoothedNorm, settings);
        const lastVisual = this.lastOutputVisual || visualPoint;
        const dtMs = Math.max(1, timestamp - (this.lastOutputTime || timestamp));
        const dtSeconds = dtMs / 1000;
        const maxSpeed = Math.max(5, Number(settings?.maxSpeed ?? 65));
        const outputIntervalMs = Math.max(10, Number(settings?.outputInterval ?? 33));
        const intervalFactor = Math.max(1, outputIntervalMs / 25);
        const maxDistancePerTick = Math.max(4, Math.min(160, maxSpeed * intervalFactor));

        let dx = visualPoint.x - lastVisual.x;
        let dy = visualPoint.y - lastVisual.y;
        const distance = Math.hypot(dx, dy);
        let limitedVisual = visualPoint;

        if (distance > maxDistancePerTick && maxDistancePerTick > 0) {
            const scale = maxDistancePerTick / distance;
            limitedVisual = {
                x: lastVisual.x + (dx * scale),
                y: lastVisual.y + (dy * scale)
            };
            dx = limitedVisual.x - lastVisual.x;
            dy = limitedVisual.y - lastVisual.y;
        }

        const limitedDistance = Math.hypot(dx, dy);
        const speed = limitedDistance / dtSeconds;
        const machinePoint = this.app?.hpgl?.transformOutputPoint
            ? this.app.hpgl.transformOutputPoint(limitedVisual.x, limitedVisual.y)
            : limitedVisual;

        return {
            visualPoint: limitedVisual,
            machinePoint,
            distance: limitedDistance,
            speed,
            light: this.getSpeedLight(speed, maxSpeed),
            thresholdMet: limitedDistance >= Math.max(0.1, Number(settings?.minMoveThreshold ?? 1.2))
        };
    }

    commitOutput(output, timestamp = performance.now()) {
        if (!output) return;
        this.lastOutputVisual = { ...output.visualPoint };
        this.lastOutputTime = timestamp;
    }
}
