class CanvasManager {
    get canvas() { return document.getElementById('plotter-canvas'); }

    get ctx() {
        const c = this.canvas;
        if (!c) return null;
        if (c !== this._cachedCanvas) {
            this._cachedCanvas = c;
            this._cachedCtx = c.getContext('2d');
        }
        return this._cachedCtx;
    }

    constructor(app) {
        this.app = app;
        // DXY 1300 A3 Dimensions approx 432 x 297 mm
        // We will scale this nicely
        this.bedWidth = 432;
        this.bedHeight = 297;

        // Rendering specifics
        this.gridSize = 10; // mm grid

        // Default Paper Settings
        this.paperSize = 'A3';
        this.paperDims = {};

        this.snapThreshold = 5; // mm
        this.snapPoint = null; // {x, y} for visual hint

        this.paths = []; // abstract paths to draw

        // CAD Edit State
        this.selectedPaths = []; // Array of indices of selected paths
        this.selectedNodes = []; // Array of {pathIdx, nodeIdx} for multi-node editing
        this.activeShapeType = 'circle'; // 'circle', 'rectangle', 'line'
        this.isCreatingShape = false;
        this.currentShapeIdx = -1;
        this.isCreatingBezier = false;
        this.currentBezierPathIdx = -1;
        this.isAdjustingBezierHandle = false;
        this.pendingBezierSegmentIdx = -1;
        this.bezierDragAnchor = null;
        this.bezierPreviewPoint = null;
        this.isFreeDrawBezier = false;
        this.isPanning = false;
        this.dragStartX = 0;
        this.dragStartY = 0;
        this.dragOriginalPath = null;

        // Marquee Selection Box
        this.isMarqueeSelecting = false;
        this.marqueeEndX = 0;
        this.marqueeEndY = 0;

        // View Transformation State
        this.viewOffsetX = 0;
        this.viewOffsetY = 0;
        this.viewZoom = 1;
        this.isPanning = false;

        // Clipboard and Undo States
        this.undoStack = [];
        this.redoStack = [];
        this.maxUndo = 50;
        this.copyBuffer = [];
        this.eventsBound = false;

        // Rotation State
        this.isRotating = false;
        this.dragStartAngle = 0;
        this.dragRotationCenter = null;

        // Simulation State
        this.simulationActive = false;
        this.simulationProgress = 0; // distance travelled along simulation route
        this.simulationPaths = [];
        this.simulationRoute = [];
        this.simulationRouteLength = 0;
        this.simulationSpeed = 60; // mm per second base
        this.simulationMaxSpeedMmPerMin = 60000;
        this.simulationLastTimestamp = 0;
        this.simulationSpeedMultiplier = 1;

        this.patternPreviewPaths = [];
        this.liveTrackerOverlay = null;
        this.liveTrackerStrokeIndex = -1;
        this.bucketHoverRegion = null;
        this.bucketHoverPathIdx = -1;
        this.bucketHoverLookupQueued = false;
        this.bucketHoverPendingPos = null;
        this.editingPathIdx = -1;
        this.displayedCrosshairPoint = null;
        this.warpHandlePositions = null;
        this.warpOriginalHandlePositions = null;
        this.warpOriginalBox = null;
        this.warpActiveHandleIndex = -1;
        this.isWarpDragging = false;
        this.closedFillRegionsCache = null;
        this.viewportHorizontalShift = 0;
        this.viewportVerticalShift = 0;
        this.bedRenderWidthPx = 0;
        this.bedRenderHeightPx = 0;
        this.cursorBlink = true;
        this.drawFramePending = false;
        this.lastSavedCanvasJson = '';
        this.persistenceEventsBound = false;
        this.textEditOriginalSnapshot = null;
        this.cursorTimer = setInterval(() => { this.cursorBlink = !this.cursorBlink; if (this.editingPathIdx !== -1) this.draw(); }, 500);
        this.autoSaveTimer = setInterval(() => this.saveCurrentStateIfChanged(), 5000);
    }

    invalidateFillRegionCache() {
        this.closedFillRegionsCache = null;
        this.bucketHoverPendingPos = null;
    }

    clearBucketHoverPreview() {
        const hadHover = !!this.bucketHoverRegion || this.bucketHoverPathIdx !== -1;
        this.bucketHoverRegion = null;
        this.bucketHoverPathIdx = -1;
        this.bucketHoverPendingPos = null;
        return hadHover;
    }

    queueBucketHoverPreview(xMM, yMM) {
        this.bucketHoverPendingPos = {
            xMM: Number.isFinite(xMM) ? xMM : 0,
            yMM: Number.isFinite(yMM) ? yMM : 0
        };
        if (this.bucketHoverLookupQueued) return;
        this.bucketHoverLookupQueued = true;
        requestAnimationFrame(() => {
            this.bucketHoverLookupQueued = false;
            const pos = this.bucketHoverPendingPos;
            if (!pos || this.app?.ui?.activeTool !== 'bucket') return;

            const target = this.getFillTargetAt(pos.xMM, pos.yMM, { previewOnly: true });
            const nextRegion = target ? target.region : null;
            const nextPathIdx = target ? target.pathIdx : -1;
            if (this.bucketHoverRegion === nextRegion && this.bucketHoverPathIdx === nextPathIdx) return;

            this.bucketHoverRegion = nextRegion;
            this.bucketHoverPathIdx = nextPathIdx;
            this.draw();
        });
    }

    clear() {
        this.paths = []; // Array of path objects
        this.invalidateFillRegionCache();
        this.selectedPaths = [];
        this.selectedNodes = [];
        this.draggingNodeIndex = -1;
        this.patternPreviewPaths = [];
        this.liveTrackerOverlay = null;
        this.liveTrackerStrokeIndex = -1;
        this.resetBezierToolState();

        // Panning and Zooming State
        this.viewOffsetX = 0;
        this.viewOffsetY = 0;
        this.viewZoom = 1;

        this.saveUndoState();
        this.draw();
    }

    clearForLiveTracker() {
        this.paths = [];
        this.invalidateFillRegionCache();
        this.patternPreviewPaths = [];
        this.selectedPaths = [];
        this.selectedNodes = [];
        this.liveTrackerStrokeIndex = -1;
        this.liveTrackerOverlay = null;
        this.draw();
        this.saveUndoState();
    }

    isWorkspaceEmptyForLiveTracker() {
        return this.paths.length === 0
            && this.patternPreviewPaths.length === 0
            && this.selectedPaths.length === 0
            && this.selectedNodes.length === 0;
    }

    startLiveTrackerSession() {
        this.liveTrackerStrokeIndex = -1;
        this.liveTrackerOverlay = null;
        this.draw();
    }

    finishLiveTrackerStroke() {
        const path = this.liveTrackerStrokeIndex >= 0 ? this.paths[this.liveTrackerStrokeIndex] : null;
        if (path && Array.isArray(path.points) && path.points.length >= 3) {
            const first = path.points[0];
            const last = path.points[path.points.length - 1];
            const closeDistance = Math.hypot((last.x || 0) - (first.x || 0), (last.y || 0) - (first.y || 0));
            const closeThreshold = 4;
            if (closeDistance <= closeThreshold) {
                path.points[path.points.length - 1] = { x: first.x, y: first.y };
                path.closed = true;
                this.saveCurrentState();
                this.draw();
            }
        }
        this.liveTrackerStrokeIndex = -1;
    }

    appendLiveTrackerPoint(point, pen = 1) {
        if (!point) return;
        const currentPath = this.liveTrackerStrokeIndex >= 0 ? this.paths[this.liveTrackerStrokeIndex] : null;
        if (!currentPath || currentPath.pen !== pen || !Array.isArray(currentPath.points)) {
            this.paths.push({
                type: 'polyline',
                points: [{ x: point.x, y: point.y }],
                pen,
                liveTrackerGenerated: true
            });
            this.liveTrackerStrokeIndex = this.paths.length - 1;
            this.draw();
            return;
        }

        const lastPoint = currentPath.points[currentPath.points.length - 1];
        if (lastPoint && Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) < 0.01) return;
        currentPath.points.push({ x: point.x, y: point.y });
        this.saveCurrentState();
        this.draw();
    }

    setLiveTrackerOverlay(overlay) {
        this.liveTrackerOverlay = overlay;
        this.draw();
    }

    resetBezierToolState() {
        this.isCreatingBezier = false;
        this.currentBezierPathIdx = -1;
        this.isAdjustingBezierHandle = false;
        this.pendingBezierSegmentIdx = -1;
        this.bezierDragAnchor = null;
        this.bezierPreviewPoint = null;
        this.isFreeDrawBezier = false;
    }

    offsetPathGeometry(path, dx, dy) {
        if (!path) return;
        if (path.type === 'circle' || path.type === 'text' || path.type === 'rectangle') {
            if (Number.isFinite(path.x)) path.x += dx;
            if (Number.isFinite(path.y)) path.y += dy;
            return;
        }
        if (Array.isArray(path.points)) {
            path.points.forEach(pt => {
                if (!pt) return;
                if (Number.isFinite(pt.x)) pt.x += dx;
                if (Number.isFinite(pt.y)) pt.y += dy;
            });
        }
        if (Array.isArray(path.segments)) {
            path.segments.forEach(segment => {
                if (!segment) return;
                if (Number.isFinite(segment.x)) segment.x += dx;
                if (Number.isFinite(segment.y)) segment.y += dy;
                if (Number.isFinite(segment.x1)) segment.x1 += dx;
                if (Number.isFinite(segment.y1)) segment.y1 += dy;
                if (Number.isFinite(segment.x2)) segment.x2 += dx;
                if (Number.isFinite(segment.y2)) segment.y2 += dy;
            });
        }
    }

    startBezierPath(anchor) {
        const start = anchor ? { x: anchor.x, y: anchor.y } : { x: 0, y: 0 };
        const visPen = this.app?.ui?.activeVisualizerPen || 1;
        this.paths.push({
            type: 'path',
            points: [{ ...start }],
            segments: [{ type: 'M', x: start.x, y: start.y }],
            pen: visPen
        });
        this.currentBezierPathIdx = this.paths.length - 1;
        this.isCreatingBezier = true;
        this.isAdjustingBezierHandle = false;
        this.pendingBezierSegmentIdx = -1;
        this.bezierDragAnchor = null;
        this.bezierPreviewPoint = { ...start };
        this.selectedPaths = [this.currentBezierPathIdx];
        this.selectedNodes = [];
    }

    shouldCloseBezierPath(anchor) {
        const path = this.paths[this.currentBezierPathIdx];
        if (!path || !Array.isArray(path.points) || path.points.length < 2 || !anchor) return false;
        const start = path.points[0];
        if (!start) return false;
        const closeThreshold = Math.max(1.5, this.snapThreshold);
        return Math.hypot((anchor.x || 0) - start.x, (anchor.y || 0) - start.y) <= closeThreshold;
    }

    closeBezierPath() {
        const path = this.paths[this.currentBezierPathIdx];
        if (!path || !Array.isArray(path.segments)) return false;
        const hasClose = path.segments.some(segment => segment && segment.type === 'Z');
        if (!hasClose) {
            path.segments.push({ type: 'Z' });
        }
        path.closed = true;
        return true;
    }

    addBezierAnchor(anchor) {
        const path = this.paths[this.currentBezierPathIdx];
        if (!path || !Array.isArray(path.points) || !Array.isArray(path.segments)) return false;
        const lastPoint = path.points[path.points.length - 1];
        if (!lastPoint) return false;
        if (Math.hypot((anchor.x || 0) - lastPoint.x, (anchor.y || 0) - lastPoint.y) < 0.01) return false;

        path.points.push({ x: anchor.x, y: anchor.y });
        path.segments.push({ type: 'L', x: anchor.x, y: anchor.y });
        this.pendingBezierSegmentIdx = path.segments.length - 1;
        this.isAdjustingBezierHandle = true;
        this.bezierDragAnchor = { x: anchor.x, y: anchor.y };
        this.bezierPreviewPoint = { x: anchor.x, y: anchor.y };
        this.selectedPaths = [this.currentBezierPathIdx];
        this.selectedNodes = [];
        return true;
    }

    updateBezierSegmentFromDrag(xMM, yMM) {
        const path = this.paths[this.currentBezierPathIdx];
        const segmentIdx = this.pendingBezierSegmentIdx;
        const anchor = this.bezierDragAnchor;
        if (!path || !anchor || !Array.isArray(path.points) || !Array.isArray(path.segments)) return;
        if (segmentIdx <= 0 || segmentIdx >= path.segments.length) return;

        const segment = path.segments[segmentIdx];
        const previousAnchor = path.points[segmentIdx - 1];
        if (!segment || !previousAnchor) return;

        const dx = xMM - anchor.x;
        const dy = yMM - anchor.y;
        const dragDistance = Math.hypot(dx, dy);

        if (dragDistance < 0.35) {
            segment.type = 'L';
            segment.x = anchor.x;
            segment.y = anchor.y;
            delete segment.x1;
            delete segment.y1;
            delete segment.x2;
            delete segment.y2;
            return;
        }

        segment.type = 'Q';
        segment.x = anchor.x;
        segment.y = anchor.y;
        segment.x1 = anchor.x - dx;
        segment.y1 = anchor.y - dy;
        delete segment.x2;
        delete segment.y2;
    }

    finalizeBezierPath(saveUndo = true) {
        const pathIdx = this.currentBezierPathIdx;
        const path = pathIdx >= 0 ? this.paths[pathIdx] : null;
        let finalized = false;

        if (path) {
            const segmentCount = Array.isArray(path.segments) ? path.segments.length : 0;
            const pointCount = Array.isArray(path.points) ? path.points.length : 0;
            if (segmentCount <= 1 || pointCount <= 1) {
                this.paths.splice(pathIdx, 1);
                this.selectedPaths = [];
            } else {
                finalized = true;
                this.selectedPaths = [pathIdx];
                this.selectedNodes = [];
            }
        }

        this.resetBezierToolState();

        if (finalized && saveUndo) {
            this.saveUndoState();
            this.app?.ui?.logToConsole('System: Bezier path finalized.');
        }

        this.draw();
        return finalized;
    }

    startFreeDrawBezier(anchor) {
        const start = anchor ? { x: anchor.x, y: anchor.y } : { x: 0, y: 0 };
        const visPen = this.app?.ui?.activeVisualizerPen || 1;
        this.paths.push({
            type: 'polyline',
            points: [{ ...start }],
            pen: visPen,
            generatedBy: 'free-draw'
        });
        this.currentBezierPathIdx = this.paths.length - 1;
        this.isCreatingBezier = true;
        this.isFreeDrawBezier = true;
        this.isAdjustingBezierHandle = false;
        this.pendingBezierSegmentIdx = -1;
        this.bezierDragAnchor = null;
        this.bezierPreviewPoint = null;
        this.selectedPaths = [this.currentBezierPathIdx];
        this.selectedNodes = [];
    }

    appendFreeDrawBezierPoint(point) {
        const path = this.paths[this.currentBezierPathIdx];
        if (!path || !Array.isArray(path.points) || !point) return;
        const lastPoint = path.points[path.points.length - 1];
        if (lastPoint && Math.hypot((point.x || 0) - lastPoint.x, (point.y || 0) - lastPoint.y) < 0.35) return;
        path.points.push({ x: point.x, y: point.y });
    }

    simplifyFreeDrawBezierPath(path) {
        if (!path || !Array.isArray(path.points) || path.points.length < 2) return path;
        const rawPoints = path.points
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y }));
        if (rawPoints.length < 2) return path;

        const scope = this.getPaperBooleanScope();
        if (!scope) {
            path.points = rawPoints;
            return path;
        }

        try {
            this.clearPaperBooleanScope(scope);
            const paperPath = new scope.Path({ insert: true });
            rawPoints.forEach((point, index) => {
                if (index === 0) paperPath.moveTo(new scope.Point(point.x, point.y));
                else paperPath.lineTo(new scope.Point(point.x, point.y));
            });
            paperPath.closed = false;
            paperPath.simplify(1.2);
            const simplified = this.buildAppPathFromPaperPath(scope, paperPath, { pen: path.pen });
            paperPath.remove();
            this.clearPaperBooleanScope(scope);
            if (simplified) {
                delete simplified.groupId;
                delete simplified.parentGroupId;
                delete simplified.closed;
                simplified.generatedBy = 'free-draw';
                return simplified;
            }
        } catch (error) {
            console.warn('Free draw simplify failed, using raw stroke.', error);
            this.clearPaperBooleanScope(scope);
        }

        path.points = rawPoints;
        return path;
    }

    finalizeFreeDrawBezierPath(saveUndo = true) {
        const pathIdx = this.currentBezierPathIdx;
        const path = pathIdx >= 0 ? this.paths[pathIdx] : null;
        let finalized = false;

        if (path) {
            if (!Array.isArray(path.points) || path.points.length < 2) {
                this.paths.splice(pathIdx, 1);
                this.selectedPaths = [];
            } else {
                this.paths[pathIdx] = this.simplifyFreeDrawBezierPath(path);
                finalized = true;
                this.selectedPaths = [pathIdx];
                this.selectedNodes = [];
            }
        }

        this.resetBezierToolState();

        if (finalized && saveUndo) {
            this.saveUndoState();
            this.app?.ui?.logToConsole('System: Free draw path finalized.');
        }

        this.draw();
        return finalized;
    }

    saveUndoState() {
        this.invalidateFillRegionCache();
        const snapshot = this.serializePathsSnapshot();
        if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== snapshot) {
            this.undoStack.push(snapshot);
            if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
        }
        this.redoStack = []; // Clear redo stack on new action
        this.saveCurrentState(); // Also persist to localStorage on edit
    }

    ensureUndoCheckpoint() {
        const current = this.serializePathsSnapshot();
        if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== current) {
            this.undoStack.push(current);
            this.redoStack = [];
            if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
            this.saveCurrentState();
        }
    }

    initializeHistoryFromCurrentState() {
        const current = this.serializePathsSnapshot();
        this.undoStack = [current];
        this.redoStack = [];
        this.lastSavedCanvasJson = current;
    }

    restoreSnapshot(snapshot, { logMessage = null } = {}) {
        this.paths = snapshot ? JSON.parse(snapshot) : [];
        this.normalizeLoadedPaths();
        this.invalidateFillRegionCache();
        this.selectedPaths = [];
        this.selectedNodes = [];
        this.editingPathIdx = -1;
        this.textEditOriginalSnapshot = null;
        this.patternPreviewPaths = [];
        this.draw();
        this.saveCurrentState();
        if (logMessage && this.app?.ui) {
            this.app.ui.logToConsole(logMessage);
        }
    }

    serializePathsSnapshot() {
        return JSON.stringify(this.paths, (key, value) => {
            if (typeof key === 'string' && key.startsWith('_')) return undefined;
            return value;
        });
    }

    saveCurrentState() {
        try {
            const serialized = this.serializePathsSnapshot();
            localStorage.setItem('canvasBackup', serialized);
            this.lastSavedCanvasJson = serialized;
        } catch (e) {
            // Persist fail
        }
    }

    saveCurrentStateIfChanged() {
        try {
            const serialized = this.serializePathsSnapshot();
            if (serialized === this.lastSavedCanvasJson) return;
            localStorage.setItem('canvasBackup', serialized);
            this.lastSavedCanvasJson = serialized;
        } catch (e) {
            // Persist fail
        }
    }

    loadSavedState() {
        try {
            const saved = localStorage.getItem('canvasBackup');
            if (saved) {
                this.paths = JSON.parse(saved);
                this.normalizeLoadedPaths();
                this.lastSavedCanvasJson = saved;
                this.invalidateFillRegionCache();
                this.draw();
                this.initializeHistoryFromCurrentState();
                if (this.app && this.app.ui) {
                    this.app.ui.logToConsole('System: Previous canvas drawing restored.');
                }
            } else {
                this.initializeHistoryFromCurrentState();
            }
        } catch (e) {
            // Load fail
            this.initializeHistoryFromCurrentState();
        }
    }

    undo() {
        this.resetBezierToolState();
        if (this.undoStack.length > 1) {
            const current = this.undoStack.pop();
            this.redoStack.push(current);
            const prev = this.undoStack[this.undoStack.length - 1];
            this.restoreSnapshot(prev, { logMessage: 'System: Undo action performed.' });
        }
    }

    redo() {
        this.resetBezierToolState();
        if (this.redoStack.length > 0) {
            const next = this.redoStack.pop();
            this.undoStack.push(next);
            this.restoreSnapshot(next, { logMessage: 'System: Redo action performed.' });
        }
    }

    addPath(pathObj) {
        this.normalizePathData(pathObj);
        this.paths.push(pathObj);
        this.invalidateFillRegionCache();
        this.saveUndoState();
        this.draw();
    }

    cancelCurrentOperation() {
        if (this.isCreatingShape && this.currentShapeIdx !== -1) {
            this.paths.splice(this.currentShapeIdx, 1);
            this.selectedPaths = []; // Clear selection if we were drawing
            this.app.ui.logToConsole('System: Shape drawing cancelled.');
        }
        if (this.isCreatingBezier) {
            if (this.currentBezierPathIdx >= 0 && this.currentBezierPathIdx < this.paths.length) {
                this.paths.splice(this.currentBezierPathIdx, 1);
                this.selectedPaths = [];
                this.selectedNodes = [];
            }
            this.resetBezierToolState();
            this.app.ui.logToConsole('System: Bezier path cancelled.');
        }

        this.isCreatingShape = false;
        this.currentShapeIdx = -1;
        this.isDragging = false;
        this.isRotating = false;
        this.isWarpDragging = false;
        this.warpActiveHandleIndex = -1;
        this.warpHandlePositions = null;
        this.warpOriginalHandlePositions = null;
        this.warpOriginalBox = null;
        this.isMarqueeSelecting = false;
        this.snapPoint = null;
        this.bucketHoverRegion = null;
        this.bucketHoverPathIdx = -1;

        if (this.canvas) {
            this.canvas.classList.remove('rotating');
        }
        if (this.canvas.parentElement) {
            this.canvas.parentElement.classList.remove('panning');
        }

        this.draw();
    }

    finishTextEditing({ removeIfEmpty = true, save = true } = {}) {
        if (this.editingPathIdx === -1) return false;
        const path = this.paths[this.editingPathIdx];
        const isEmpty = !path || path.type !== 'text' || !String(path.text || '').trim();
        const originalSnapshot = this.textEditOriginalSnapshot;

        if (removeIfEmpty && isEmpty && this.editingPathIdx >= 0 && this.editingPathIdx < this.paths.length) {
            this.paths.splice(this.editingPathIdx, 1);
            this.selectedPaths = this.selectedPaths.filter(idx => idx !== this.editingPathIdx).map(idx => idx > this.editingPathIdx ? idx - 1 : idx);
        }

        this.editingPathIdx = -1;
        this.textEditOriginalSnapshot = null;
        if (save) {
            const currentSnapshot = this.serializePathsSnapshot();
            if (currentSnapshot !== originalSnapshot) this.saveUndoState();
            else this.saveCurrentState();
        }
        this.draw();
        return true;
    }

    bindEvents() {
        if (this.eventsBound) return;
        this.eventsBound = true;

        document.getElementById('sel-paper-size').addEventListener('change', (e) => {
            const nextValue = e.target.value;
            if (nextValue === '__custom__') {
                e.target.value = this.paperSize;
                this.app?.ui?.openCustomPaperModal?.();
                return;
            }
            this.paperSize = nextValue;
            if (this.app?.settings) {
                this.app.settings.paperSize = this.paperSize;
                this.app.saveSettings?.();
            }
            this.handleResize(); // re-draw
        });
        document.getElementById('sel-paper-size').addEventListener('focus', () => {
            this.setPaperDropdownDetailMode(true);
        });
        document.getElementById('sel-paper-size').addEventListener('mousedown', () => {
            this.setPaperDropdownDetailMode(true);
        });
        document.getElementById('sel-paper-size').addEventListener('blur', () => {
            this.setPaperDropdownDetailMode(false);
        });

        document.addEventListener('keydown', (e) => {
            // Ignore if in input field
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            // Delete
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedPaths.length > 0) {
                let indices = [...this.selectedPaths].sort((a, b) => b - a);
                indices.forEach(idx => {
                    this.paths.splice(idx, 1);
                });
                this.selectedPaths = [];
                this.selectedNodes = [];
                this.saveUndoState();
                this.draw();
                this.app.ui.logToConsole(`System: ${indices.length} path(s) deleted.`);
            }

            // A / Select All (Ctrl+A)
            if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                this.selectedPaths = this.paths.map((_, i) => i);
                this.draw();
            }

            // Copy (Ctrl+C)
            if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
                if (this.selectedPaths.length > 0) {
                    this.copyBuffer = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                    this.app.ui.logToConsole(`System: Copied ${this.copyBuffer.length} toolpaths to clipboard.`);
                }
            }

            // X / Cut (Ctrl+X)
            if (e.ctrlKey && (e.key === 'x' || e.key === 'X')) {
                if (this.selectedPaths.length > 0) {
                    this.copyBuffer = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                    let indices = [...this.selectedPaths].sort((a, b) => b - a);
                    indices.forEach(idx => this.paths.splice(idx, 1));
                    this.selectedPaths = [];
                    this.saveUndoState();
                    this.draw();
                    this.app.ui.logToConsole(`System: Cut ${this.copyBuffer.length} toolpaths to clipboard.`);
                }
            }

            // V / Paste (Ctrl+V)
            if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
                if (this.copyBuffer.length > 0) {
                    this.selectedPaths = []; // Clear current selection, select the new pastes
                    this.copyBuffer.forEach(p => {
                        const clone = JSON.parse(JSON.stringify(p));
                        this.offsetPathGeometry(clone, 10, 10);
                        this.paths.push(clone);
                        this.selectedPaths.push(this.paths.length - 1);
                    });

                    // Also offset the buffer again in case of multi-pastes
                    this.copyBuffer.forEach(p => {
                        this.offsetPathGeometry(p, 10, 10);
                    });

                    this.saveUndoState();
                    this.draw();
                    this.app.ui.logToConsole(`System: Pasted ${this.copyBuffer.length} toolpaths.`);
                }
            }

            // G / Group (Ctrl+G)
            if (e.ctrlKey && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
                e.preventDefault();
                this.groupSelectedPaths();
            }

            // G / Ungroup (Ctrl+Shift+G)
            if (e.ctrlKey && e.shiftKey && (e.key === 'g' || e.key === 'G')) {
                e.preventDefault();
                this.ungroupSelectedPaths();
            }

            // Z / Undo (Ctrl+Z)
            if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
                this.undo();
            }

            if (!e.ctrlKey && !e.metaKey && this.isCreatingBezier && (e.key === 'Enter' || e.key === 'Escape')) {
                e.preventDefault();
                if (e.key === 'Enter') {
                    if (this.isFreeDrawBezier) this.finalizeFreeDrawBezierPath(true);
                    else this.finalizeBezierPath(true);
                } else {
                    this.cancelCurrentOperation();
                }
                return;
            }

            // Inline Text Editing
            if (this.editingPathIdx !== -1) {
                e.preventDefault();
                const p = this.paths[this.editingPathIdx];
                if (e.key === 'Enter' || e.key === 'Escape') {
                    this.finishTextEditing({ removeIfEmpty: true, save: true });
                } else if (e.key === 'Backspace') {
                    p.text = p.text.slice(0, -1);
                    this.invalidateTextPathCache(p);
                    this.saveCurrentState();
                } else if (e.key.length === 1) {
                    p.text += e.key;
                    this.invalidateTextPathCache(p);
                    this.saveCurrentState();
                }
                this.draw();
                return;
            }

            // Escape / Cancel
            if (e.key === 'Escape') {
                if (this.simulationActive) {
                    e.preventDefault();
                    this.stopSimulation('escape');
                    return;
                }
                if (this.isCreatingShape || this.isDragging || this.isRotating || this.isMarqueeSelecting) {
                    this.cancelCurrentOperation();
                } else if (this.app.ui.activeTool !== 'select') {
                    this.app.ui.setTool('select');
                }
            }
        });

        const checkTarget = (e) => {
            return e.target.id === 'plotter-canvas' || (this.canvas && this.canvas.contains(e.target));
        };

        // Disable the browser context menu on the canvas so right-drag can pan
        this.canvas.addEventListener('contextmenu', (e) => {
            if (!checkTarget(e)) return;
            e.preventDefault();
        });

        document.addEventListener('dblclick', (e) => {
            if (!checkTarget(e)) return;
            if (this.app.ui.activeTool === 'bezier' && this.isCreatingBezier && !this.isFreeDrawBezier) {
                e.preventDefault();
                this.finalizeBezierPath(true);
                return;
            }

            const pos = this.getMousePosMM(e);
            const hitIdx = this.hitTest(pos.xMM, pos.yMM);
            if (hitIdx !== -1) {
                const hitPath = this.paths[hitIdx];
                if (hitPath?.type === 'text') {
                    e.preventDefault();
                    this.selectedPaths = [hitIdx];
                    this.textEditOriginalSnapshot = this.serializePathsSnapshot();
                    this.editingPathIdx = hitIdx;
                    this.app.ui?.setTool?.('select');
                    this.draw();
                }
            }
        });


        document.addEventListener('wheel', (e) => {
            if (!checkTarget(e)) return;
            e.preventDefault();
            // Zoom in/out based on wheel direction
            const zoomFactor = 1.1;
            const dir = Math.sign(e.deltaY);

            const prevZoom = this.viewZoom;
            if (dir < 0) this.viewZoom *= zoomFactor;
            else this.viewZoom /= zoomFactor;

            // Limit zoom
            this.viewZoom = Math.max(1.0, Math.min(this.viewZoom, 20));

            // Anchor to edges if at minimum zoom (view all)
            if (this.viewZoom <= 1.0) {
                this.viewZoom = 1.0;
                this.viewOffsetX = 0;
                this.viewOffsetY = 0;
            }

            // To zoom at cursor, we calculate cursor position in original space,
            // then offset our view so that same coordinate sits under the cursor.
            const rect = this.canvas.getBoundingClientRect();
            // Pixel position relative to canvas box
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;

            // Reverse current transform to find raw coordinate under mouse
            const hx = (px - this.viewOffsetX) / prevZoom;
            const hy = (py - this.viewOffsetY) / prevZoom;

            // Recalculate viewOffset so (hx, hy) stays under (px, py)
            this.viewOffsetX = px - (hx * this.viewZoom);
            this.viewOffsetY = py - (hy * this.viewZoom);

            this.draw();
        }, { passive: false });

        document.addEventListener('mousedown', (e) => {
            if (!checkTarget(e) && !this.isCreatingShape && !this.isCreatingBezier) return;

            const pos = this.getMousePosMM(e);

            if (e.button === 1 || e.button === 2) { // Middle OR Right click for panning
                e.preventDefault();
                this.isPanning = true;
                if (this.canvas.parentElement) this.canvas.parentElement.classList.add('panning');
                return;
            }

            if (this.app.ui) this.app.ui.updatePatternPanelState();

            // Handle tool clicks (like text tool)
            if (this.app.ui.activeTool === 'text' || (this.app.ui.activeTool === 'shape' && !this.isCreatingShape)) {
                this.handleCanvasClick(pos.xMM, pos.yMM);
                if (this.app.ui.activeTool === 'text') return; // Handled
            }

            if (this.app.ui.activeTool === 'bucket' && e.button === 0) {
                void this.applyBucketFillAt(pos.xMM, pos.yMM);
                return;
            }

            if (this.app.ui.activeTool === 'bezier' && e.button === 0) {
                if (this.app.ui?.bezierToolMode === 'free-draw') {
                    this.startFreeDrawBezier({ x: pos.xMM, y: pos.yMM });
                    this.app.ui.logToConsole('System: Free draw started. Drag to sketch and release to finish.');
                    this.draw();
                    return;
                }
                let anchorX = pos.xMM;
                let anchorY = pos.yMM;
                const excludeNodeIdx = this.isCreatingBezier && this.currentBezierPathIdx >= 0
                    ? Math.max(0, (this.paths[this.currentBezierPathIdx]?.points?.length || 1) - 1)
                    : -1;
                const snap = this.getSnapPoint(anchorX, anchorY, this.currentBezierPathIdx, excludeNodeIdx);
                if (snap) {
                    anchorX = snap.x;
                    anchorY = snap.y;
                    this.snapPoint = snap;
                } else {
                    this.snapPoint = null;
                }

                if (!this.isCreatingBezier || this.currentBezierPathIdx < 0) {
                    this.startBezierPath({ x: anchorX, y: anchorY });
                    this.app.ui.logToConsole('System: Bezier path started. Click for corners, click-drag for curves, Enter or double-click to finish.');
                } else {
                    if (this.shouldCloseBezierPath({ x: anchorX, y: anchorY })) {
                        this.closeBezierPath();
                        this.finalizeBezierPath(true);
                        this.app.ui.setTool('select');
                        return;
                    }
                    this.addBezierAnchor({ x: anchorX, y: anchorY });
                }

                this.draw();
                return;
            }

            // Toggle Panning on Middle Mouse
            if (e.button === 1 || (this.isSelectionInteractionTool() || this.app.ui.activeTool === 'node' || this.app.ui.activeTool === 'shape')) {
                if (this.app.ui.activeTool === 'node' && this.selectedPaths.length >= 1) {
                    // Find the nearest node across all selected paths
                    let clickedPathIdx = -1;
                    let clickedNodeIdx = -1;
                    let clickedDistance = Infinity;

                    for (let i = 0; i < this.selectedPaths.length; i++) {
                        const selIdx = this.selectedPaths[i];
                        const hit = this.hitTestNodesDetailed(this.paths[selIdx], pos.xMM, pos.yMM);
                        if (hit && hit.distance < clickedDistance) {
                            clickedPathIdx = selIdx;
                            clickedNodeIdx = hit.nodeIdx;
                            clickedDistance = hit.distance;
                        }
                    }

                    if (clickedNodeIdx > -1) {
                        // If holding shift, toggle this node in selectedNodes
                        if (e.shiftKey) {
                            const existingIdx = this.selectedNodes.findIndex(n => n.pathIdx === clickedPathIdx && n.nodeIdx === clickedNodeIdx);
                            if (existingIdx > -1) this.selectedNodes.splice(existingIdx, 1);
                            else this.selectedNodes.push({ pathIdx: clickedPathIdx, nodeIdx: clickedNodeIdx });
                        } else {
                            // If clicked node is NOT already in selectedNodes, clear and select only it
                            const isAlreadySelected = this.selectedNodes.some(n => n.pathIdx === clickedPathIdx && n.nodeIdx === clickedNodeIdx);
                            if (!isAlreadySelected) {
                                this.selectedNodes = [{ pathIdx: clickedPathIdx, nodeIdx: clickedNodeIdx }];
                            }
                        }

                        this.isDragging = true;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        // Deep copy selected paths for translation reference
                        this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                        this.draw();
                        return;
                    }
                }

                if (this.app.ui.activeTool === 'warp' && this.selectedPaths.length >= 1) {
                    const warpHandleIdx = this.hitTestWarpHandle(this.selectedPaths, pos.xMM, pos.yMM);
                    if (warpHandleIdx > -1 && this.beginWarpDrag(warpHandleIdx)) {
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        this.draw();
                        return;
                    }
                }

                if (this.isSelectionInteractionTool()) {
                    // 1. Check Resize Handles FIRST
                    if (this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1) {
                        const box = this.getGroupBoundingBox(this.selectedPaths);
                        if (box) {
                            const cornerIdx = this.hitTestResizeGroup(this.selectedPaths, pos.xMM, pos.yMM);

                            // Hit test for ROTATION zone (circular handles at corner or top)
                            const rotateThreshold = 12 / (this.scale * this.viewZoom);
                            const stalkLen = 20 / (this.scale * this.viewZoom);

                            // Rotation handle at Top-Center
                            const tc = { x: box.minX + (box.maxX - box.minX) / 2, y: box.minY - stalkLen };
                            const distTC = Math.sqrt((pos.xMM - tc.x) ** 2 + (pos.yMM - tc.y) ** 2);

                            if (distTC < rotateThreshold) {
                                this.isRotating = true;
                                if (this.canvas) this.canvas.classList.add('rotating');
                                this.dragRotationCenter = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
                                this.dragStartAngle = Math.atan2(pos.yMM - this.dragRotationCenter.y, pos.xMM - this.dragRotationCenter.x);
                                this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                                return;
                            }

                            if (cornerIdx > -1) {
                                this.isDragging = true;
                                this.draggingNodeIndex = cornerIdx;
                                this.dragStartX = pos.xMM;
                                this.dragStartY = pos.yMM;
                                this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                                return;
                            }
                        }
                    }

                    // 2. Check Paths (for moving)
                    const hitIdx = this.hitTest(pos.xMM, pos.yMM);
                    if (hitIdx !== -1) {
                        if (e.shiftKey) {
                            if (this.selectedPaths.includes(hitIdx)) {
                                this.selectedPaths = this.selectedPaths.filter(idx => idx !== hitIdx);
                            } else {
                                this.selectedPaths.push(hitIdx);
                            }
                        } else if (!this.selectedPaths.includes(hitIdx)) {
                            this.selectedPaths = [hitIdx];
                        }

                        this.expandSelectionToGroups();

                        this.isDragging = true;
                        this.draggingNodeIndex = -1;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                    } else {
                        // 3. Clicked empty space - DESELECT and start Marquee
                        if (!e.shiftKey) {
                            this.finishTextEditing({ removeIfEmpty: true, save: true });
                            this.selectedPaths = [];
                        }
                        this.isMarqueeSelecting = true;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        this.marqueeEndX = pos.xMM;
                        this.marqueeEndY = pos.yMM;
                    }
                } else if (this.app.ui.activeTool === 'text') {
                    // Handled above via handleCanvasClick
                } else if (this.app.ui.activeTool === 'node') {
                    // Node Tool logic
                    const hitIdx = this.hitTest(pos.xMM, pos.yMM);
                    if (hitIdx !== -1) {
                        if (e.shiftKey) {
                            if (this.selectedPaths.includes(hitIdx)) {
                                this.selectedPaths = this.selectedPaths.filter(idx => idx !== hitIdx);
                            } else {
                                this.selectedPaths.push(hitIdx);
                            }
                        } else if (!this.selectedPaths.includes(hitIdx)) {
                            this.selectedPaths = [hitIdx];
                        }

                        this.isDragging = true;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
                        this.draggingNodeIndex = -1;
                    } else {
                        this.isMarqueeSelecting = true;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        this.marqueeEndX = pos.xMM;
                        this.marqueeEndY = pos.yMM;
                        if (!e.shiftKey) {
                            this.selectedNodes = [];
                        }
                    }
                } else if (this.app.ui.activeTool === 'shape') {
                    if (this.isCreatingShape) {
                        // Second click - FINALIZE
                        const finalizedShapeIdx = this.currentShapeIdx;
                        this.isCreatingShape = false;
                        this.currentShapeIdx = -1;
                        if (finalizedShapeIdx > -1) {
                            this.selectedPaths = [finalizedShapeIdx];
                        }
                        this.saveUndoState();
                        this.app.ui.logToConsole('System: Shape finalized.');
                        if (this.app?.ui?.setTool) {
                            this.app.ui.setTool('select');
                        }
                    } else {
                        // First click - START
                        this.isCreatingShape = true;
                        this.dragStartX = pos.xMM;
                        this.dragStartY = pos.yMM;
                        const visPen = this.app.ui.activeVisualizerPen || 1;

                        if (this.activeShapeType === 'circle') {
                            this.paths.push({ type: 'circle', x: pos.xMM, y: pos.yMM, r: 0.1, pen: visPen });
                        } else if (this.activeShapeType === 'rectangle') {
                            this.paths.push({ type: 'rectangle', x: pos.xMM, y: pos.yMM, w: 0.1, h: 0.1, pen: visPen });
                        } else if (this.activeShapeType === 'line') {
                            let startX = pos.xMM;
                            let startY = pos.yMM;

                            // Hit test for existing endpoints to SNAP and MERGE
                            let targetPathIdx = -1;
                            let bestDist = this.snapThreshold;

                            this.paths.forEach((p, pIdx) => {
                                if (p.type === 'line' || p.type === 'polyline') {
                                    const lastPt = p.points[p.points.length - 1];
                                    const dLast = Math.sqrt((pos.xMM - lastPt.x) ** 2 + (pos.yMM - lastPt.y) ** 2);
                                    if (dLast < bestDist) {
                                        bestDist = dLast;
                                        targetPathIdx = pIdx;
                                        startX = lastPt.x;
                                        startY = lastPt.y;
                                    }
                                }
                            });

                            if (targetPathIdx !== -1) {
                                const p = this.paths[targetPathIdx];
                                p.type = 'polyline';
                                p.points.push({ x: startX, y: startY });
                                this.currentShapeIdx = targetPathIdx;
                            } else {
                                this.paths.push({ type: 'line', points: [{ x: startX, y: startY }, { x: startX, y: startY }], pen: visPen });
                                this.currentShapeIdx = this.paths.length - 1;
                            }
                        }
                        this.currentShapeIdx = this.paths.length - 1;
                        this.selectedPaths = [this.currentShapeIdx];
                    }
                }
            }
            this.draw();
        }, true);

        document.addEventListener('mousemove', (e) => {
            if (!this.isPanning && !this.isMarqueeSelecting && !this.isDragging && !this.isCreatingShape && !this.isCreatingBezier) {
                if (!checkTarget(e)) return;
            }

            if (this.isPanning) {
                if (this.viewZoom <= 1.0) {
                    this.isPanning = false;
                    return;
                }
                // e.movementX/Y are unscaled physical screen pixels. 
                this.viewOffsetX += e.movementX;
                this.viewOffsetY += e.movementY;
                this.draw();
                return;
            }

            const pos = this.getMousePosMM(e);

            if (this.app.ui.activeTool === 'bucket' && !this.isDragging && !this.isMarqueeSelecting && !this.isCreatingShape && !this.isRotating && !this.isCreatingBezier) {
                this.queueBucketHoverPreview(pos.xMM, pos.yMM);
            } else if (this.clearBucketHoverPreview()) {
                this.draw();
            }

            // Set Cursor
            let cursor = 'default';
            if (this.isPanning) cursor = 'grabbing';
            else if (this.isRotating) cursor = 'alias';
            else if (this.isDragging) cursor = this.isWarpDragging ? 'grabbing' : 'move';
            else if (this.isMarqueeSelecting) cursor = 'crosshair';
            else if (this.editingPathIdx !== -1) cursor = 'text'; // Text editing cursor
            else if (this.app.ui.activeTool === 'bezier') cursor = 'crosshair';
            else if (this.app.ui.activeTool === 'warp' && this.selectedPaths.length >= 1) {
                const warpHandleIdx = this.hitTestWarpHandle(this.selectedPaths, pos.xMM, pos.yMM);
                cursor = warpHandleIdx > -1 ? 'grab' : (this.hitTest(pos.xMM, pos.yMM) !== -1 ? 'pointer' : 'default');
            } else if (this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1) {
                const box = this.getGroupBoundingBox(this.selectedPaths);
                if (box) {
                    const cornerIdx = this.hitTestResizeGroup(this.selectedPaths, pos.xMM, pos.yMM);

                    // Use same distance logic as mousedown for hover feedback
                    const rotateThreshold = 12 / (this.scale * this.viewZoom);
                    const stalkLen = 20 / (this.scale * this.viewZoom);
                    const tc = { x: box.minX + (box.maxX - box.minX) / 2, y: box.minY - stalkLen };
                    const distTC = Math.sqrt((pos.xMM - tc.x) ** 2 + (pos.yMM - tc.y) ** 2);

                    if (distTC < rotateThreshold) cursor = 'move'; // Or a custom rotation cursor if available
                    else if (cornerIdx === 0 || cornerIdx === 4) cursor = 'nwse-resize';
                    else if (cornerIdx === 2 || cornerIdx === 6) cursor = 'nesw-resize';
                    else if (cornerIdx === 1 || cornerIdx === 5) cursor = 'ns-resize';
                    else if (cornerIdx === 3 || cornerIdx === 7) cursor = 'ew-resize';
                    else if (this.hitTest(pos.xMM, pos.yMM) !== -1) cursor = 'pointer';
                } else if (this.hitTest(pos.xMM, pos.yMM) !== -1) {
                    cursor = 'pointer';
                }
            } else if (this.app.ui.activeTool === 'boolean' && this.hitTest(pos.xMM, pos.yMM) !== -1) {
                cursor = 'pointer';
            } else if (this.hitTest(pos.xMM, pos.yMM) !== -1) {
                cursor = 'pointer';
            }
            this.canvas.style.cursor = cursor;

            if (this.app.ui.activeTool === 'bezier' && this.isCreatingBezier && this.isFreeDrawBezier) {
                this.appendFreeDrawBezierPoint({ x: pos.xMM, y: pos.yMM });
                this.draw();
                return;
            }

            if (this.app.ui.activeTool === 'bezier' && this.isCreatingBezier) {
                let previewX = pos.xMM;
                let previewY = pos.yMM;
                const previewSnap = this.getSnapPoint(previewX, previewY, this.currentBezierPathIdx, -1);
                if (previewSnap && !this.isAdjustingBezierHandle) {
                    previewX = previewSnap.x;
                    previewY = previewSnap.y;
                    this.snapPoint = previewSnap;
                } else if (!this.isAdjustingBezierHandle) {
                    this.snapPoint = null;
                }
                this.bezierPreviewPoint = { x: previewX, y: previewY };

                if (this.isAdjustingBezierHandle) {
                    this.updateBezierSegmentFromDrag(pos.xMM, pos.yMM);
                }

                this.draw();
                return;
            }

            if (this.isRotating && this.selectedPaths.length > 0) {
                const currentAngle = Math.atan2(pos.yMM - this.dragRotationCenter.y, pos.xMM - this.dragRotationCenter.x);
                const deltaAngle = currentAngle - this.dragStartAngle;

                this.selectedPaths.forEach((pathIdx, i) => {
                    const p = this.paths[pathIdx];
                    const orig = this.dragOriginalPaths[i];

                    const rotatePoint = (pt) => {
                        const dx = pt.x - this.dragRotationCenter.x;
                        const dy = pt.y - this.dragRotationCenter.y;
                        const cosA = Math.cos(deltaAngle);
                        const sinA = Math.sin(deltaAngle);
                        return {
                            x: this.dragRotationCenter.x + (dx * cosA - dy * sinA),
                            y: this.dragRotationCenter.y + (dx * sinA + dy * cosA)
                        };
                    };

                    if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                        if (p.segments && orig.segments) {
                            p.segments.forEach((s, j) => {
                                const os = orig.segments[j];
                                if (os.x !== undefined) { const r = rotatePoint({ x: os.x, y: os.y }); s.x = r.x; s.y = r.y; }
                                if (os.x1 !== undefined) { const r = rotatePoint({ x: os.x1, y: os.y1 }); s.x1 = r.x; s.y1 = r.y; }
                                if (os.x2 !== undefined) { const r = rotatePoint({ x: os.x2, y: os.y2 }); s.x2 = r.x; s.y2 = r.y; }
                            });
                        }
                        if (p.points && orig.points) {
                            p.points = orig.points.map(pt => rotatePoint(pt));
                        }
                    } else if (p.type === 'circle') {
                        const newCenter = rotatePoint({ x: orig.x, y: orig.y });
                        p.x = newCenter.x;
                        p.y = newCenter.y;
                    } else if (p.type === 'rectangle' || (p.type === 'text' && p.rotation !== undefined)) {
                        // For rectangles, convert to polyline to support arbitrary rotation
                        if (p.type === 'rectangle') {
                            p.type = 'polyline';
                            const pts = [
                                { x: orig.x, y: orig.y },
                                { x: orig.x + orig.w, y: orig.y },
                                { x: orig.x + orig.w, y: orig.y + orig.h },
                                { x: orig.x, y: orig.y + orig.h },
                                { x: orig.x, y: orig.y }
                            ];
                            p.points = pts.map(pt => rotatePoint(pt));
                            delete p.x; delete p.y; delete p.w; delete p.h;
                        } else if (p.type === 'text') {
                            const newPos = rotatePoint({ x: orig.x, y: orig.y });
                            p.x = newPos.x;
                            p.y = newPos.y;
                            p.rotation = this.getAppliedTextRotation(
                                p,
                                (orig.rotation || 0) + (deltaAngle * 180 / Math.PI)
                            );
                            this.invalidateTextPathCache(p);
                        }
                    }
                });
                this.draw();
                return;
            }

            if (this.isMarqueeSelecting) {
                // BUGFIX: Clamp marquee coordinates to bed dimensions to prevent freezing and out-of-bounds issues
                const clampedX = Math.max(0, Math.min(pos.xMM, this.bedWidth));
                const clampedY = Math.max(0, Math.min(pos.yMM, this.bedHeight));

                this.marqueeEndX = clampedX;
                this.marqueeEndY = clampedY;

                // Select items in marquee
                const box = {
                    x1: Math.min(this.dragStartX, this.marqueeEndX),
                    y1: Math.min(this.dragStartY, this.marqueeEndY),
                    x2: Math.max(this.dragStartX, this.marqueeEndX),
                    y2: Math.max(this.dragStartY, this.marqueeEndY)
                };

                const newSel = [];
                this.paths.forEach((p, i) => {
                    const pBox = this.getBoundingBox(p);
                    if (pBox && pBox.minX >= box.x1 && pBox.maxX <= box.x2 && pBox.minY >= box.y1 && pBox.maxY <= box.y2) {
                        newSel.push(i);
                    }
                });

                if (e.shiftKey) {
                    // Selection addition is tricky with indices, but expandSelectionToGroups will clean it up
                    this.selectedPaths = [...new Set([...this.selectedPaths, ...newSel])];
                } else {
                    this.selectedPaths = newSel;
                }
                this.expandSelectionToGroups();

                this.draw();
                return;
            }

            if (this.isCreatingShape && this.currentShapeIdx !== -1) {
                const p = this.paths[this.currentShapeIdx];
                // BUGFIX: Clamp coordinates to bed dimensions for shape creation
                const clampedX = Math.max(0, Math.min(pos.xMM, this.bedWidth));
                const clampedY = Math.max(0, Math.min(pos.yMM, this.bedHeight));

                const dx = clampedX - this.dragStartX;
                const dy = clampedY - this.dragStartY;

                if (p.type === 'circle') {
                    p.r = Math.sqrt(dx * dx + dy * dy);
                } else if (p.type === 'rectangle') {
                    p.x = Math.min(clampedX, this.dragStartX);
                    p.y = Math.min(clampedY, this.dragStartY);
                    p.w = Math.abs(dx);
                    p.h = Math.abs(dy);
                } else if (p.type === 'line' || p.type === 'polyline') {
                    let tx = pos.xMM;
                    let ty = pos.yMM;

                    // Endpoint Snapping
                    const snap = this.getSnapPoint(tx, ty, this.currentShapeIdx, p.points.length - 1);
                    if (snap) {
                        tx = snap.x;
                        ty = snap.y;
                        this.snapPoint = snap;
                    } else {
                        this.snapPoint = null;
                    }

                    p.points[p.points.length - 1].x = tx;
                    p.points[p.points.length - 1].y = ty;
                }
                this.draw();
                return;
            }

            if (this.isDragging && this.selectedPaths.length > 0) {
                const dx = pos.xMM - this.dragStartX;
                const dy = pos.yMM - this.dragStartY;

                if (this.isWarpDragging && this.app.ui.activeTool === 'warp' && this.warpActiveHandleIndex > -1) {
                    if (this.warpHandlePositions && this.warpHandlePositions[this.warpActiveHandleIndex]) {
                        this.warpHandlePositions[this.warpActiveHandleIndex] = { x: pos.xMM, y: pos.yMM };
                        this.applyWarpToSelectedPaths();
                    }
                } else if (this.app.ui.activeTool === 'node' && this.selectedNodes.length > 0) {
                    this.snapPoint = null;
                    // Update all selected nodes based on original positions
                    this.selectedNodes.forEach(nodeRef => {
                        const pIdx = nodeRef.pathIdx;
                        const nIdx = nodeRef.nodeIdx;
                        const p = this.paths[pIdx];

                        // Find this path in dragOriginalPaths
                        const selArrayIdx = this.selectedPaths.indexOf(pIdx);
                        if (selArrayIdx === -1) return; // Should not happen
                        const orig = this.dragOriginalPaths[selArrayIdx];

                        if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                            if (p.segments) {
                                // Bezier Curve Editing
                                const isCtrl1 = nIdx >= 10000 && nIdx < 20000;
                                const isCtrl2 = nIdx >= 20000;
                                const baseIdx = isCtrl2 ? nIdx - 20000 : (isCtrl1 ? nIdx - 10000 : nIdx);

                                const s = p.segments[baseIdx];
                                const origS = orig.segments[baseIdx];

                                let tx, ty;
                                if (isCtrl1) {
                                    tx = origS.x1 + dx; ty = origS.y1 + dy;
                                    s.x1 = tx; s.y1 = ty;
                                } else if (isCtrl2) {
                                    tx = origS.x2 + dx; ty = origS.y2 + dy;
                                    s.x2 = tx; s.y2 = ty;
                                } else {
                                    // Moving the anchor node
                                    tx = origS.x + dx; ty = origS.y + dy;

                                    if (this.selectedNodes.length === 1) {
                                        const snap = this.getSnapPoint(tx, ty, pIdx, baseIdx);
                                        if (snap) { tx = snap.x; ty = snap.y; this.snapPoint = snap; }
                                    }

                                    s.x = tx; s.y = ty;
                                    p.points[baseIdx].x = tx; p.points[baseIdx].y = ty; // Keep points in sync for bounding box

                                    // If moving an anchor, also shift its outgoing control points so the shape stays intact
                                    if (origS.type === 'Q' || origS.type === 'C') {
                                        s.x1 = origS.x1 + dx; s.y1 = origS.y1 + dy;
                                        if (origS.type === 'C') {
                                            s.x2 = origS.x2 + dx; s.y2 = origS.y2 + dy;
                                        }
                                    }

                                    // Also shift the *incoming* control point of the NEXT segment if it exists
                                    if (baseIdx + 1 < p.segments.length) {
                                        const nextS = p.segments[baseIdx + 1];
                                        const nextOrigS = orig.segments[baseIdx + 1];
                                        if (nextOrigS.type === 'Q' || nextOrigS.type === 'C') {
                                            // The first control handle relies on this node as the start point, 
                                            // so we shift it to maintain the curve structure.
                                            nextS.x1 = nextOrigS.x1 + dx; nextS.y1 = nextOrigS.y1 + dy;
                                        }
                                    }
                                }
                            } else {
                                // Fallback to raw polyline editing
                                let tx = orig.points[nIdx].x + dx;
                                let ty = orig.points[nIdx].y + dy;

                                if (this.selectedNodes.length === 1) {
                                    const snap = this.getSnapPoint(tx, ty, pIdx, nIdx);
                                    if (snap) {
                                        tx = snap.x;
                                        ty = snap.y;
                                        this.snapPoint = snap;
                                    }
                                }

                                p.points[nIdx].x = tx;
                                p.points[nIdx].y = ty;
                            }
                        } else if (p.type === 'circle') {
                            if (nIdx === 0) { // Center
                                let tx = orig.x + dx;
                                let ty = orig.y + dy;
                                const snap = this.getSnapPoint(tx, ty, pIdx, 0);
                                if (snap) {
                                    tx = snap.x; ty = snap.y;
                                    this.snapPoint = snap;
                                }
                                p.x = tx; p.y = ty;
                            } else if (nIdx === 1) { // Edge (change radius)
                                const newR = Math.sqrt((pos.xMM - p.x) ** 2 + (pos.yMM - p.y) ** 2);
                                p.r = Math.max(0.1, newR);
                            }
                        }
                    });
                } else if (this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1 && this.draggingNodeIndex > -1) {
                    const origBox = this.getGroupBoundingBoxFromPaths(this.dragOriginalPaths);
                    if (!origBox || origBox.maxX === origBox.minX || origBox.maxY === origBox.minY) return;

                    let anchorX, anchorY, newW, newH;
                    const w = origBox.maxX - origBox.minX;
                    const h = origBox.maxY - origBox.minY;

                    // 8-Point anchor logic:
                    if (this.draggingNodeIndex === 0) {
                        anchorX = origBox.maxX; anchorY = origBox.maxY;
                        newW = anchorX - pos.xMM; newH = anchorY - pos.yMM;
                    } else if (this.draggingNodeIndex === 1) {
                        anchorX = origBox.minX; anchorY = origBox.maxY;
                        newW = w; newH = anchorY - pos.yMM;
                    } else if (this.draggingNodeIndex === 2) {
                        anchorX = origBox.minX; anchorY = origBox.maxY;
                        newW = pos.xMM - anchorX; newH = anchorY - pos.yMM;
                    } else if (this.draggingNodeIndex === 3) {
                        anchorX = origBox.minX; anchorY = origBox.minY;
                        newW = pos.xMM - anchorX; newH = h;
                    } else if (this.draggingNodeIndex === 4) {
                        anchorX = origBox.minX; anchorY = origBox.minY;
                        newW = pos.xMM - anchorX; newH = pos.yMM - anchorY;
                    } else if (this.draggingNodeIndex === 5) {
                        anchorX = origBox.minX; anchorY = origBox.minY;
                        newW = w; newH = pos.yMM - anchorY;
                    } else if (this.draggingNodeIndex === 6) {
                        anchorX = origBox.maxX; anchorY = origBox.minY;
                        newW = anchorX - pos.xMM; newH = pos.yMM - anchorY;
                    } else if (this.draggingNodeIndex === 7) {
                        anchorX = origBox.maxX; anchorY = origBox.minY;
                        newW = anchorX - pos.xMM; newH = h;
                    }

                    let sx = newW / w;
                    let sy = newH / h;

                    // Uniform scaling if Shift is held
                    if (e.shiftKey) {
                        const s = Math.max(Math.abs(sx), Math.abs(sy)) * Math.sign(sx); // Rough approximation for uniform
                        sx = s; sy = s;
                    }

                    if (sx < 0.05) sx = 0.05;
                    if (sy < 0.05) sy = 0.05;

                    this.scaleSelectedPaths(anchorX, anchorY, sx, sy);
                } else {
                    // Standard translation (Select Tool, acts on multiple items)
                    for (let i = 0; i < this.selectedPaths.length; i++) {
                        const selIdx = this.selectedPaths[i];
                        const p = this.paths[selIdx];
                        const orig = this.dragOriginalPaths[i];

                        if (p.type === 'circle' || p.type === 'text' || p.type === 'rectangle') {
                            p.x = orig.x + dx;
                            p.y = orig.y + dy;
                        } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                            if (p.segments && orig.segments) {
                                for (let j = 0; j < p.segments.length; j++) {
                                    const s = p.segments[j];
                                    const os = orig.segments[j];
                                    if (os.x !== undefined) s.x = os.x + dx;
                                    if (os.y !== undefined) s.y = os.y + dy;
                                    if (os.x1 !== undefined) s.x1 = os.x1 + dx;
                                    if (os.y1 !== undefined) s.y1 = os.y1 + dy;
                                    if (os.x2 !== undefined) s.x2 = os.x2 + dx;
                                    if (os.y2 !== undefined) s.y2 = os.y2 + dy;
                                }
                            }
                            if (p.points && orig.points) {
                                for (let j = 0; j < p.points.length; j++) {
                                    p.points[j].x = orig.points[j].x + dx;
                                    p.points[j].y = orig.points[j].y + dy;
                                }
                            }
                        }
                    }
                }
                this.draw();
            }
        }, true);

        document.addEventListener('mouseup', (e) => {
            if (!this.isPanning && !this.isMarqueeSelecting && !this.isDragging && !this.isCreatingBezier) {
                if (!checkTarget(e)) return;
            }

            this.snapPoint = null;

            if (this.app.ui.activeTool === 'bezier' && this.isFreeDrawBezier && this.isCreatingBezier) {
                if (e.button === 0) {
                    this.finalizeFreeDrawBezierPath(true);
                }
                return;
            }

            if (this.app.ui.activeTool === 'bezier' && this.isAdjustingBezierHandle) {
                this.isAdjustingBezierHandle = false;
                this.pendingBezierSegmentIdx = -1;
                this.bezierDragAnchor = null;
                this.saveCurrentState();
                this.draw();
                return;
            }

            if (e.button === 1 || this.isPanning) {
                this.isPanning = false;
                if (this.canvas.parentElement) this.canvas.parentElement.classList.remove('panning');
            }
            if (this.isMarqueeSelecting) {
                // Finalize marquee selection
                this.isMarqueeSelecting = false;
                const minX = Math.min(this.dragStartX, this.marqueeEndX);
                const maxX = Math.max(this.dragStartX, this.marqueeEndX);
                const minY = Math.min(this.dragStartY, this.marqueeEndY);
                const maxY = Math.max(this.dragStartY, this.marqueeEndY);

                if (this.app.ui.activeTool === 'node') {
                    // Node Marquee Selection: only select nodes of ALREADY selected paths
                    for (let i = 0; i < this.selectedPaths.length; i++) {
                        const pIdx = this.selectedPaths[i];
                        const p = this.paths[pIdx];

                        if (p.type === 'circle') {
                            if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
                                if (!this.selectedNodes.some(n => n.pathIdx === pIdx && n.nodeIdx === 0)) {
                                    this.selectedNodes.push({ pathIdx: pIdx, nodeIdx: 0 }); // Center
                                }
                            }
                            if ((p.x + p.r) >= minX && (p.x + p.r) <= maxX && p.y >= minY && p.y <= maxY) {
                                if (!this.selectedNodes.some(n => n.pathIdx === pIdx && n.nodeIdx === 1)) {
                                    this.selectedNodes.push({ pathIdx: pIdx, nodeIdx: 1 }); // Edge
                                }
                            }
                        } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                            for (let j = 0; j < p.points.length; j++) {
                                const pt = p.points[j];
                                if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
                                    if (!this.selectedNodes.some(n => n.pathIdx === pIdx && n.nodeIdx === j)) {
                                        this.selectedNodes.push({ pathIdx: pIdx, nodeIdx: j });
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // Object Marquee Selection
                    for (let i = 0; i < this.paths.length; i++) {
                        const box = this.getBoundingBox(this.paths[i]);
                        if (box) {
                            if (!(box.maxX < minX || box.minX > maxX || box.maxY < minY || box.minY > maxY)) {
                                if (!this.selectedPaths.includes(i)) {
                                    this.selectedPaths.push(i);
                                }
                            }
                        }
                    }
                }
                this.draw();
            }
            if (this.isDragging || this.isRotating) {
                this.saveUndoState(); // Done editing node/drag/resize/rotate/warp
            }
            this.isDragging = false;
            this.isRotating = false;
            this.isMarqueeSelecting = false;
            if (this.isWarpDragging) this.endWarpDrag();

            if (this.canvas) this.canvas.classList.remove('rotating');
            if (this.app.ui) this.app.ui.updatePatternPanelState();

            // NOTE: isCreatingShape is NOT reset here to allow click-to-click. 
            // It is reset in mousedown on the second click or via cancelCurrentOperation (Escape).
        }, true);

        document.addEventListener('mouseout', (e) => {
            const c = this.canvas;
            if (c && c.contains(e.target) && (!e.relatedTarget || !c.contains(e.relatedTarget))) {
                // BUGFIX: Do NOT reset isDragging or isMarqueeSelecting here.
                // Releasing mouse outside should still work.
                this.isPanning = false;
                if (c.parentElement) c.parentElement.classList.remove('panning');
            }
        });
    }

    getMousePosMM(e) {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        return this.canvasPxToMM(px, py);
    }

    getViewportTransform() {
        const mmToPx = this.scale;
        const horizontalShift = Number.isFinite(this.viewportHorizontalShift) ? this.viewportHorizontalShift : 0;
        const verticalShift = Number.isFinite(this.viewportVerticalShift) ? this.viewportVerticalShift : 0;
        return { mmToPx, horizontalShift, verticalShift };
    }

    canvasPxToMM(px, py) {
        const safePx = Number.isFinite(px) ? px : 0;
        const safePy = Number.isFinite(py) ? py : 0;

        // Match the live render transform so hover/click math stays aligned after resize.
        const { mmToPx, horizontalShift, verticalShift } = this.getViewportTransform();

        // Reverse translate and zoom
        const transformedPx = (safePx - this.viewOffsetX - horizontalShift) / this.viewZoom;
        const transformedPy = (safePy - this.viewOffsetY - verticalShift) / this.viewZoom;

        const xMM = transformedPx / mmToPx;
        const yMM = transformedPy / mmToPx;

        return { xMM, yMM };
    }

    mmToCanvasPx(xMM, yMM) {
        const safeX = Number.isFinite(xMM) ? xMM : 0;
        const safeY = Number.isFinite(yMM) ? yMM : 0;
        const { mmToPx, horizontalShift, verticalShift } = this.getViewportTransform();
        return {
            x: (safeX * mmToPx * this.viewZoom) + this.viewOffsetX + horizontalShift,
            y: (safeY * mmToPx * this.viewZoom) + this.viewOffsetY + verticalShift
        };
    }

    normalizeTextRotation(rotation) {
        const quarterTurns = Math.round((rotation || 0) / 90);
        return (((quarterTurns % 4) + 4) % 4) * 90;
    }

    getAppliedTextRotation(pathOrMode, rotation) {
        const mode = typeof pathOrMode === 'string'
            ? pathOrMode
            : (pathOrMode?.textMode || 'roland');
        const safeRotation = Number.isFinite(rotation) ? rotation : 0;
        return mode === 'creative' ? safeRotation : this.normalizeTextRotation(safeRotation);
    }

    normalizeTextPath(path) {
        if (!path || path.type !== 'text') return path;
        path.textMode = path.textMode === 'creative' ? 'creative' : 'roland';
        path.creativeFontId = path.creativeFontId || this.app?.ui?.textToolSettings?.creativeFontId || 'bungee';
        path.fontSize = Number.isFinite(path.fontSize) ? path.fontSize : 10;
        path.rotation = this.getAppliedTextRotation(path, Number.isFinite(path.rotation) ? path.rotation : 0);
        path.letterSpacing = Number.isFinite(path.letterSpacing) ? path.letterSpacing : 0;
        path.curve = Number.isFinite(path.curve) ? path.curve : 0;
        path.exploded = path.exploded === true;
        return path;
    }

    pathSupportsCurve(path) {
        return !!(path && ['line', 'polyline', 'path'].includes(path.type));
    }

    normalizePathCurve(path) {
        if (!this.pathSupportsCurve(path)) return path;
        path.curve = Number.isFinite(path.curve) ? path.curve : 0;
        return path;
    }

    normalizePathData(path) {
        if (!path) return path;
        this.normalizePathCurve(path);
        if (path.type === 'text') this.normalizeTextPath(path);
        return path;
    }

    normalizeLoadedPaths() {
        this.paths.forEach(path => this.normalizePathData(path));
    }

    isCreativeTextPath(path) {
        return !!(path && path.type === 'text' && path.textMode === 'creative' && path.exploded !== true);
    }

    invalidateTextPathCache(path) {
        if (!path || path.type !== 'text') return;
        delete path._vectorTextCache;
        delete path._creativeOutlineCache;
    }

    handleCanvasClick(xMM, yMM) {
        const tool = this.app.ui.activeTool;
        if (tool === 'text') {
            const visPen = this.app.ui.activeVisualizerPen || 1;
            const textSettings = this.app.ui?.textToolSettings || {};
            this.textEditOriginalSnapshot = this.serializePathsSnapshot();
            const textPath = this.normalizeTextPath({
                type: 'text',
                text: '',
                x: xMM,
                y: yMM,
                pen: visPen,
                textMode: textSettings.mode || 'roland',
                creativeFontId: textSettings.creativeFontId || 'bungee',
                fontSize: Number.isFinite(textSettings.fontSize) ? textSettings.fontSize : 10,
                rotation: Number.isFinite(textSettings.rotation) ? textSettings.rotation : 0,
                letterSpacing: Number.isFinite(textSettings.letterSpacing) ? textSettings.letterSpacing : 0,
                curve: Number.isFinite(textSettings.curve) ? textSettings.curve : 0
            });
            this.paths.push(textPath);
            this.editingPathIdx = this.paths.length - 1;
            this.selectedPaths = [this.editingPathIdx];
            this.app?.ui?.resetTextToolTransientSettings?.({ persist: true, applyToSelection: false });
            this.draw();
        } else if (tool === 'shape') {
            // Handled by mouse down/drag
        }
    }

    // Mathematical utility for hit testing
    hitTest(xMM, yMM) {
        const tol = 10; // Increased to 10mm for easier selection
        for (let i = this.paths.length - 1; i >= 0; i--) {
            const p = this.paths[i];

            if (p.type === 'circle') {
                const dist = Math.sqrt((xMM - p.x) ** 2 + (yMM - p.y) ** 2);
                if (Math.abs(dist - p.r) <= tol) return i;
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                const hitPoints = this.getPathTracePoints(p);
                for (let j = 0; j < hitPoints.length - 1; j++) {
                    const p1 = hitPoints[j];
                    const p2 = hitPoints[j + 1];
                    const d = this.distToSegment({ x: xMM, y: yMM }, p1, p2);
                    if (d <= tol) return i;
                }
            } else if (p.type === 'text') {
                this.normalizeTextPath(p);
                const textSegments = this.getVectorTextSegments(p);
                if (textSegments.length > 0) {
                    for (let j = 0; j < textSegments.length; j++) {
                        const segment = textSegments[j];
                        const d = this.distToSegment(
                            { x: xMM, y: yMM },
                            { x: segment.x1, y: segment.y1 },
                            { x: segment.x2, y: segment.y2 }
                        );
                        if (d <= tol) return i;
                    }
                }
            } else if (p.type === 'rectangle') {
                const x1 = p.x;
                const y1 = p.y;
                const x2 = p.x + (p.w || 0);
                const y2 = p.y + (p.h || 0);
                const edges = [
                    [{ x: x1, y: y1 }, { x: x2, y: y1 }],
                    [{ x: x2, y: y1 }, { x: x2, y: y2 }],
                    [{ x: x2, y: y2 }, { x: x1, y: y2 }],
                    [{ x: x1, y: y2 }, { x: x1, y: y1 }]
                ];
                for (let j = 0; j < edges.length; j++) {
                    const d = this.distToSegment({ x: xMM, y: yMM }, edges[j][0], edges[j][1]);
                    if (d <= tol) return i;
                }
            }
        }
        return -1;
    }

    distToSegment(p, v, w) {
        const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
        if (l2 == 0) return Math.sqrt((p.x - v.x) ** 2 + (p.y - v.y) ** 2);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return Math.sqrt((p.x - (v.x + t * (w.x - v.x))) ** 2 + (p.y - (v.y + t * (w.y - v.y))) ** 2);
    }

    hitTestNodesDetailed(p, xMM, yMM) {
        const tol = 4; // mm tolerance for grabbing nodes
        let bestNode = -1;
        let bestDistance = Infinity;
        const considerNode = (nodeIdx, nx, ny) => {
            if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
            const distance = Math.hypot(nx - xMM, ny - yMM);
            if (distance <= tol && distance < bestDistance) {
                bestDistance = distance;
                bestNode = nodeIdx;
            }
        };

        if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
            if (p.segments) {
                for (let i = 0; i < p.segments.length; i++) {
                    const s = p.segments[i];
                    if (s.x !== undefined) considerNode(i, s.x, s.y);
                    if (s.type === 'Q' || s.type === 'C') considerNode(i + 10000, s.x1, s.y1);
                    if (s.type === 'C') considerNode(i + 20000, s.x2, s.y2);
                }
            } else {
                for (let i = 0; i < p.points.length; i++) {
                    const pt = p.points[i];
                    considerNode(i, pt.x, pt.y);
                }
            }
        } else if (p.type === 'circle') {
            considerNode(0, p.x, p.y); // Center
            considerNode(1, p.x + p.r, p.y); // Radius handle
        }
        return bestNode > -1 ? { nodeIdx: bestNode, distance: bestDistance } : null;
    }

    hitTestNodes(p, xMM, yMM) {
        const hit = this.hitTestNodesDetailed(p, xMM, yMM);
        return hit ? hit.nodeIdx : -1;
    }

    applyCurveToPoints(points, curve) {
        const sourcePoints = Array.isArray(points)
            ? points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            : [];
        if (sourcePoints.length === 0) return [];

        const curveAmount = Number.isFinite(curve) ? curve : 0;
        if (Math.abs(curveAmount) < 0.001) {
            return sourcePoints.map(point => ({ x: point.x, y: point.y }));
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        sourcePoints.forEach(point => {
            if (point.x < minX) minX = point.x;
            if (point.x > maxX) maxX = point.x;
            if (point.y < minY) minY = point.y;
            if (point.y > maxY) maxY = point.y;
        });

        const width = Math.max(0.001, maxX - minX);
        const height = Math.max(0.001, maxY - minY);
        const bendAlongX = width >= height;
        const axisMin = bendAlongX ? minX : minY;
        const axisSize = bendAlongX ? width : height;
        const axisCenter = axisMin + (axisSize / 2);

        return sourcePoints.map(point => {
            const axisValue = bendAlongX ? point.x : point.y;
            const normalized = (axisValue - axisCenter) / Math.max(0.001, axisSize / 2);
            const offset = -curveAmount * Math.max(0, 1 - (normalized * normalized));
            return bendAlongX
                ? { x: point.x, y: point.y + offset }
                : { x: point.x + offset, y: point.y };
        });
    }

    sampleSvgArcPoints(start, segment) {
        if (!start || !segment || !Number.isFinite(segment.x) || !Number.isFinite(segment.y)) return [];
        if (!Number.isFinite(segment.rx) || !Number.isFinite(segment.ry)) {
            return [{ x: segment.x, y: segment.y }];
        }

        let rx = Math.abs(segment.rx);
        let ry = Math.abs(segment.ry);
        const phi = Number.isFinite(segment.rot) ? segment.rot : 0;
        const end = { x: segment.x, y: segment.y };
        if (rx < 1e-6 || ry < 1e-6) return [end];

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
        if (denominator <= 1e-9) return [end];

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
        const steps = Math.max(
            6,
            Math.min(240, Math.ceil(arcLength / 1.2) + Math.ceil(Math.abs(dTheta) / (Math.PI / 3)))
        );

        const points = [];
        for (let step = 1; step <= steps; step++) {
            const t = step / steps;
            const angle = theta1 + (dTheta * t);
            points.push({
                x: cosPhi * rx * Math.cos(angle) - sinPhi * ry * Math.sin(angle) + cx,
                y: sinPhi * rx * Math.cos(angle) + cosPhi * ry * Math.sin(angle) + cy
            });
        }
        return points;
    }

    pathHasArcSegments(path) {
        return !!(Array.isArray(path?.segments) && path.segments.some(segment => segment?.type === 'A'));
    }

    getPathTracePoints(path, { applyCurve = true } = {}) {
        if (!path) return [];
        let points = [];

        if (path.type === 'rectangle') {
            points = [
                { x: path.x, y: path.y },
                { x: path.x + (path.w || 0), y: path.y },
                { x: path.x + (path.w || 0), y: path.y + (path.h || 0) },
                { x: path.x, y: path.y + (path.h || 0) }
            ];
        } else if (path.type === 'circle') {
            const radius = Math.max(0.1, path.r || 0);
            const circumference = Math.PI * 2 * radius;
            const steps = Math.max(64, Math.min(512, Math.ceil(circumference / 1.2)));
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                points.push({
                    x: path.x + Math.cos(angle) * path.r,
                    y: path.y + Math.sin(angle) * path.r
                });
            }
        } else if (path.type === 'path' && Array.isArray(path.segments) && path.segments.length > 0) {
            let currentPoint = null;
            let subpathStart = null;
            const estimateSegmentSteps = (lengthEstimate, minSteps, maxSteps) => {
                return Math.max(minSteps, Math.min(maxSteps, Math.ceil(Math.max(0.1, lengthEstimate) / 1.2)));
            };
            const addPoint = (pt) => {
                if (!pt) return;
                const prev = points[points.length - 1];
                if (!prev || Math.hypot(prev.x - pt.x, prev.y - pt.y) > 0.01) points.push({ x: pt.x, y: pt.y });
            };
            path.segments.forEach(segment => {
                if (segment.type === 'M') {
                    currentPoint = { x: segment.x, y: segment.y };
                    subpathStart = { ...currentPoint };
                    addPoint(currentPoint);
                } else if (segment.type === 'L') {
                    currentPoint = { x: segment.x, y: segment.y };
                    addPoint(currentPoint);
                } else if (segment.type === 'C' && currentPoint) {
                    const start = { ...currentPoint };
                    const controlSpan = Math.hypot(segment.x1 - start.x, segment.y1 - start.y)
                        + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
                        + Math.hypot(segment.x - segment.x2, segment.y - segment.y2);
                    const steps = estimateSegmentSteps(controlSpan, 24, 240);
                    for (let i = 1; i <= steps; i++) {
                        const t = i / steps;
                        const mt = 1 - t;
                        addPoint({
                            x: (mt ** 3) * start.x + 3 * (mt ** 2) * t * segment.x1 + 3 * mt * (t ** 2) * segment.x2 + (t ** 3) * segment.x,
                            y: (mt ** 3) * start.y + 3 * (mt ** 2) * t * segment.y1 + 3 * mt * (t ** 2) * segment.y2 + (t ** 3) * segment.y
                        });
                    }
                    currentPoint = { x: segment.x, y: segment.y };
                } else if (segment.type === 'Q' && currentPoint) {
                    const start = { ...currentPoint };
                    const controlSpan = Math.hypot(segment.x1 - start.x, segment.y1 - start.y)
                        + Math.hypot(segment.x - segment.x1, segment.y - segment.y1);
                    const steps = estimateSegmentSteps(controlSpan, 20, 180);
                    for (let i = 1; i <= steps; i++) {
                        const t = i / steps;
                        const mt = 1 - t;
                        addPoint({
                            x: (mt ** 2) * start.x + 2 * mt * t * segment.x1 + (t ** 2) * segment.x,
                            y: (mt ** 2) * start.y + 2 * mt * t * segment.y1 + (t ** 2) * segment.y
                        });
                    }
                    currentPoint = { x: segment.x, y: segment.y };
                } else if (segment.type === 'A') {
                    const start = currentPoint ? { ...currentPoint } : null;
                    this.sampleSvgArcPoints(start, segment).forEach(addPoint);
                    currentPoint = { x: segment.x, y: segment.y };
                } else if (segment.type === 'Z' && subpathStart) {
                    addPoint({ ...subpathStart });
                    currentPoint = { ...subpathStart };
                }
            });
        } else if (Array.isArray(path.points)) {
            points = path.points.map(point => ({ x: point.x, y: point.y }));
        }

        if (applyCurve && this.pathSupportsCurve(path)) {
            return this.applyCurveToPoints(points, path.curve);
        }
        return points;
    }

    getBoundingBox(p) {
        if (p.type === 'circle') {
            return { minX: p.x - p.r, minY: p.y - p.r, maxX: p.x + p.r, maxY: p.y + p.r };
        } else if (p.type === 'rectangle') {
            const x1 = p.x;
            const y1 = p.y;
            const x2 = p.x + (p.w || 0);
            const y2 = p.y + (p.h || 0);
            return {
                minX: Math.min(x1, x2),
                minY: Math.min(y1, y2),
                maxX: Math.max(x1, x2),
                maxY: Math.max(y1, y2)
            };
        } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            this.getPathTracePoints(p).forEach(pt => {
                if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
                if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
            });
            if (minX === Infinity) return null;
            return { minX, minY, maxX, maxY };
        } else if (p.type === 'text') {
            this.normalizeTextPath(p);
            if (this.isCreativeTextPath(p) && typeof CreativeTextEngine !== 'undefined') {
                const creativeBox = CreativeTextEngine.getBoundingBox(p);
                if (creativeBox) return creativeBox;
            }
            const n = Math.max(0, Math.min(127, Math.round((p.fontSize || 10) / 0.8) - 1));
            const charH = (n + 1) * 0.8;
            const stepH = (n + 1) * 0.6;
            const textW = (p.text.length || 1) * stepH;

            let box = { minX: p.x, minY: p.y - charH, maxX: p.x + textW, maxY: p.y };

            // Handle rotation (4 cardinal angles)
            if (p.rotation) {
                const nRotate = Math.round(((p.rotation || 0) % 360) / 90) % 4;
                const angle = (nRotate < 0 ? nRotate + 4 : nRotate) * 90;

                if (angle === 90) {
                    box = { minX: p.x - charH, minY: p.y, maxX: p.x, maxY: p.y + textW };
                } else if (angle === 180) {
                    box = { minX: p.x - textW, minY: p.y, maxX: p.x, maxY: p.y + charH };
                } else if (angle === 270) {
                    box = { minX: p.x, minY: p.y - textW, maxX: p.x + charH, maxY: p.y };
                }
            }
            return box;
        }
        return null;
    }

    hitTestResize(p, xMM, yMM) {
        const box = this.getBoundingBox(p);
        if (!box) return -1;
        const tol = 5;
        const corners = [
            { x: box.minX, y: box.minY },                      // 0: Top-Left
            { x: box.minX + (box.maxX - box.minX) / 2, y: box.minY }, // 1: Top-Mid
            { x: box.maxX, y: box.minY },                      // 2: Top-Right
            { x: box.maxX, y: box.minY + (box.maxY - box.minY) / 2 }, // 3: Mid-Right
            { x: box.maxX, y: box.maxY },                      // 4: Bottom-Right
            { x: box.minX + (box.maxX - box.minX) / 2, y: box.maxY }, // 5: Bottom-Mid
            { x: box.minX, y: box.maxY },                      // 6: Bottom-Left
            { x: box.minX, y: box.minY + (box.maxY - box.minY) / 2 }  // 7: Mid-Left
        ];
        for (let i = 0; i < corners.length; i++) {
            if (Math.abs(corners[i].x - xMM) <= tol && Math.abs(corners[i].y - yMM) <= tol) return i;
        }
        return -1;
    }

    getGroupBoundingBox(indices) {
        if (!indices || indices.length === 0) return null;
        let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
        for (let i = 0; i < indices.length; i++) {
            const box = this.getBoundingBox(this.paths[indices[i]]);
            if (box) {
                if (box.minX < gMinX) gMinX = box.minX;
                if (box.maxX > gMaxX) gMaxX = box.maxX;
                if (box.minY < gMinY) gMinY = box.minY;
                if (box.maxY > gMaxY) gMaxY = box.maxY;
            }
        }
        if (gMinX === Infinity) return null;
        return { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY };
    }

    getGroupBoundingBoxFromPaths(pathsArray) {
        if (!pathsArray || pathsArray.length === 0) return null;
        let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
        for (let i = 0; i < pathsArray.length; i++) {
            const box = this.getBoundingBox(pathsArray[i]);
            if (box) {
                if (box.minX < gMinX) gMinX = box.minX;
                if (box.maxX > gMaxX) gMaxX = box.maxX;
                if (box.minY < gMinY) gMinY = box.minY;
                if (box.maxY > gMaxY) gMaxY = box.maxY;
            }
        }
        if (gMinX === Infinity) return null;
        return { minX: gMinX, minY: gMinY, maxX: gMaxX, maxY: gMaxY };
    }

    getSelectedDimensions() {
        const box = this.getGroupBoundingBox(this.selectedPaths);
        if (!box) return null;
        return {
            width: Math.max(0, box.maxX - box.minX),
            height: Math.max(0, box.maxY - box.minY),
            box
        };
    }

    isSelectionInteractionTool(tool = this.app?.ui?.activeTool) {
        return tool === 'select' || tool === 'warp' || tool === 'boolean';
    }

    getEightHandlePositions(box) {
        if (!box) return [];
        return [
            { x: box.minX, y: box.minY },
            { x: box.minX + ((box.maxX - box.minX) / 2), y: box.minY },
            { x: box.maxX, y: box.minY },
            { x: box.maxX, y: box.minY + ((box.maxY - box.minY) / 2) },
            { x: box.maxX, y: box.maxY },
            { x: box.minX + ((box.maxX - box.minX) / 2), y: box.maxY },
            { x: box.minX, y: box.maxY },
            { x: box.minX, y: box.minY + ((box.maxY - box.minY) / 2) }
        ];
    }

    hitTestWarpHandle(indices, xMM, yMM) {
        const handlePositions = this.warpHandlePositions
            || this.getEightHandlePositions(this.getGroupBoundingBox(indices));
        if (!Array.isArray(handlePositions) || handlePositions.length !== 8) return -1;
        const tol = 7;
        for (let i = 0; i < handlePositions.length; i++) {
            const handle = handlePositions[i];
            if (Math.abs(handle.x - xMM) <= tol && Math.abs(handle.y - yMM) <= tol) return i;
        }
        return -1;
    }

    makeClosedPolylinePath(points, sourcePath = {}) {
        const normalized = Array.isArray(points)
            ? points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)).map(point => ({ x: point.x, y: point.y }))
            : [];
        if (normalized.length < 3) return null;
        const first = normalized[0];
        const last = normalized[normalized.length - 1];
        if (Math.hypot((last.x || 0) - first.x, (last.y || 0) - first.y) > 0.01) {
            normalized.push({ ...first });
        }
        return {
            type: 'polyline',
            points: normalized,
            pen: sourcePath.pen || this.app?.ui?.activeVisualizerPen || 1,
            closed: true,
            groupId: sourcePath.groupId,
            parentGroupId: sourcePath.parentGroupId
        };
    }

    convertPathToEditablePolyline(path) {
        if (!path) return null;
        if (path.type === 'polyline') {
            const clone = JSON.parse(JSON.stringify(path));
            clone.closed = this.isPathClosed(clone);
            return clone;
        }
        if (path.type === 'line') {
            const clone = JSON.parse(JSON.stringify(path));
            clone.type = 'polyline';
            clone.closed = this.isPathClosed(clone);
            return clone;
        }
        if (path.type === 'rectangle' || path.type === 'circle') {
            return this.makeClosedPolylinePath(this.flattenPathForFill(path), path);
        }
        if (path.type === 'path') {
            const clone = JSON.parse(JSON.stringify(path));
            clone.points = this.getPathTracePoints(clone, { applyCurve: false });
            clone.closed = this.isPathClosed(clone);
            return clone;
        }
        return null;
    }

    prepareSelectedPathsForWarp() {
        if (!Array.isArray(this.selectedPaths) || this.selectedPaths.length === 0) return false;
        const replacements = [];
        for (const pathIdx of this.selectedPaths) {
            const path = this.paths[pathIdx];
            if (!path) continue;
            if (path.type === 'text') {
                this.app?.ui?.logToConsole('Warp Tool: Text objects need to be converted to outlines first.', 'error');
                return false;
            }
            if (path.type === 'rectangle' || path.type === 'circle' || path.type === 'line') {
                const converted = this.convertPathToEditablePolyline(path);
                if (!converted) {
                    this.app?.ui?.logToConsole('Warp Tool: Unable to convert the selected shape for warping.', 'error');
                    return false;
                }
                replacements.push({ pathIdx, converted });
            }
        }
        replacements.forEach(({ pathIdx, converted }) => {
            this.paths[pathIdx] = converted;
        });
        return true;
    }

    beginWarpDrag(handleIndex) {
        if (handleIndex < 0 || this.selectedPaths.length === 0) return false;
        if (!this.prepareSelectedPathsForWarp()) return false;
        const box = this.getGroupBoundingBox(this.selectedPaths);
        if (!box) return false;
        this.warpOriginalBox = { ...box };
        this.warpOriginalHandlePositions = this.getEightHandlePositions(box);
        this.warpHandlePositions = this.warpOriginalHandlePositions.map(handle => ({ ...handle }));
        this.warpActiveHandleIndex = handleIndex;
        this.isWarpDragging = true;
        this.isDragging = true;
        this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
        return true;
    }

    warpPointFromHandles(point, originalBox, originalHandles, warpedHandles) {
        if (!point || !originalBox || !Array.isArray(originalHandles) || !Array.isArray(warpedHandles)) return point;
        const width = Math.max(0.001, originalBox.maxX - originalBox.minX);
        const height = Math.max(0.001, originalBox.maxY - originalBox.minY);
        let offsetX = 0;
        let offsetY = 0;
        let totalWeight = 0;
        for (let i = 0; i < originalHandles.length; i++) {
            const source = originalHandles[i];
            const target = warpedHandles[i];
            if (!source || !target) continue;
            const distance = Math.hypot(point.x - source.x, point.y - source.y);
            if (distance <= 0.0001) return { x: target.x, y: target.y };
            const weight = 1 / Math.pow(distance + 0.35, 1.35);
            offsetX += (target.x - source.x) * weight;
            offsetY += (target.y - source.y) * weight;
            totalWeight += weight;
        }
        if (totalWeight <= 0) return { x: point.x, y: point.y };

        const u = Math.max(0, Math.min(1, (point.x - originalBox.minX) / width));
        const v = Math.max(0, Math.min(1, (point.y - originalBox.minY) / height));
        const edgeBias = 0.55 + (0.45 * Math.max(Math.abs((u * 2) - 1), Math.abs((v * 2) - 1)));

        return {
            x: point.x + ((offsetX / totalWeight) * edgeBias),
            y: point.y + ((offsetY / totalWeight) * edgeBias)
        };
    }

    applyWarpToSelectedPaths() {
        if (!this.warpOriginalBox || !this.warpOriginalHandlePositions || !this.warpHandlePositions) return;
        this.selectedPaths.forEach((pathIdx, selectionIndex) => {
            const path = this.paths[pathIdx];
            const original = this.dragOriginalPaths?.[selectionIndex];
            if (!path || !original) return;

            const warpPoint = (sourcePoint) => this.warpPointFromHandles(
                sourcePoint,
                this.warpOriginalBox,
                this.warpOriginalHandlePositions,
                this.warpHandlePositions
            );

            if (Array.isArray(path.points) && Array.isArray(original.points)) {
                path.points = original.points.map(point => warpPoint(point));
            }
            if (Array.isArray(path.segments) && Array.isArray(original.segments)) {
                path.segments = original.segments.map(segment => {
                    const next = { ...segment };
                    if (Number.isFinite(segment.x) && Number.isFinite(segment.y)) {
                        const warped = warpPoint({ x: segment.x, y: segment.y });
                        next.x = warped.x;
                        next.y = warped.y;
                    }
                    if (Number.isFinite(segment.x1) && Number.isFinite(segment.y1)) {
                        const warped = warpPoint({ x: segment.x1, y: segment.y1 });
                        next.x1 = warped.x;
                        next.y1 = warped.y;
                    }
                    if (Number.isFinite(segment.x2) && Number.isFinite(segment.y2)) {
                        const warped = warpPoint({ x: segment.x2, y: segment.y2 });
                        next.x2 = warped.x;
                        next.y2 = warped.y;
                    }
                    return next;
                });
            }
        });
    }

    endWarpDrag() {
        this.isWarpDragging = false;
        this.warpActiveHandleIndex = -1;
        this.warpHandlePositions = null;
        this.warpOriginalHandlePositions = null;
        this.warpOriginalBox = null;
    }

    scaleSelectedPaths(anchorX, anchorY, sx, sy) {
        for (let i = 0; i < this.selectedPaths.length; i++) {
            const selIdx = this.selectedPaths[i];
            const p = this.paths[selIdx];
            const orig = this.dragOriginalPaths[i];

            if (p.type === 'circle') {
                const s = Math.max(sx, sy);
                p.r = Math.max(0.1, orig.r * s);
                p.x = anchorX + (orig.x - anchorX) * sx;
                p.y = anchorY + (orig.y - anchorY) * sy;
            } else if (p.type === 'rectangle') {
                p.x = anchorX + (orig.x - anchorX) * sx;
                p.y = anchorY + (orig.y - anchorY) * sy;
                p.w = orig.w * sx;
                p.h = orig.h * sy;
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                if (p.segments && orig.segments) {
                    for (let j = 0; j < p.segments.length; j++) {
                        const s = p.segments[j];
                        const os = orig.segments[j];
                        if (os.x !== undefined) s.x = anchorX + (os.x - anchorX) * sx;
                        if (os.y !== undefined) s.y = anchorY + (os.y - anchorY) * sy;
                        if (os.x1 !== undefined) s.x1 = anchorX + (os.x1 - anchorX) * sx;
                        if (os.y1 !== undefined) s.y1 = anchorY + (os.y1 - anchorY) * sy;
                        if (os.x2 !== undefined) s.x2 = anchorX + (os.x2 - anchorX) * sx;
                        if (os.y2 !== undefined) s.y2 = anchorY + (os.y2 - anchorY) * sy;
                    }
                }
                if (p.points && orig.points) {
                    for (let j = 0; j < p.points.length; j++) {
                        p.points[j].x = anchorX + (orig.points[j].x - anchorX) * sx;
                        p.points[j].y = anchorY + (orig.points[j].y - anchorY) * sy;
                    }
                }
            } else if (p.type === 'text') {
                const s = Math.max(sx, sy);
                p.fontSize = Math.max(1, orig.fontSize * s);
                p.x = anchorX + (orig.x - anchorX) * sx;
                p.y = anchorY + (orig.y - anchorY) * sy;
                this.invalidateTextPathCache(p);
            }
        }
    }

    resizeSelectionToDimensions(targetWidth, targetHeight, uniform = true) {
        const dims = this.getSelectedDimensions();
        if (!dims || this.selectedPaths.length === 0) return false;

        const currentWidth = Math.max(0.1, dims.width);
        const currentHeight = Math.max(0.1, dims.height);
        let nextWidth = targetWidth != null ? Math.max(0.1, targetWidth) : currentWidth;
        let nextHeight = targetHeight != null ? Math.max(0.1, targetHeight) : currentHeight;

        if (uniform) {
            const widthScale = nextWidth / currentWidth;
            const heightScale = nextHeight / currentHeight;
            const scale = targetWidth != null && targetHeight == null ? widthScale
                : targetHeight != null && targetWidth == null ? heightScale
                : widthScale;
            nextWidth = currentWidth * scale;
            nextHeight = currentHeight * scale;
        }

        const sx = Math.max(0.05, nextWidth / currentWidth);
        const sy = Math.max(0.05, nextHeight / currentHeight);
        const anchorX = (dims.box.minX + dims.box.maxX) / 2;
        const anchorY = (dims.box.minY + dims.box.maxY) / 2;

        this.dragOriginalPaths = this.selectedPaths.map(idx => JSON.parse(JSON.stringify(this.paths[idx])));
        this.scaleSelectedPaths(anchorX, anchorY, sx, sy);
        this.saveUndoState();
        this.draw();
        return true;
    }

    getSnapPoint(x, y, excludePathIdx, excludeNodeIdx) {
        const zoomAdjustedThreshold = Math.max(0.25, this.snapThreshold / Math.max(1, this.viewZoom * 4));
        let bestDist = zoomAdjustedThreshold;
        let snap = null;

        this.paths.forEach((p, pIdx) => {
            if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                p.points.forEach((pt, nIdx) => {
                    if (pIdx === excludePathIdx && nIdx === excludeNodeIdx) return;
                    const d = Math.sqrt((x - pt.x) ** 2 + (y - pt.y) ** 2);
                    if (d < bestDist) {
                        bestDist = d;
                        snap = { x: pt.x, y: pt.y };
                    }
                });
            } else if (p.type === 'circle') {
                // Snap to center
                if (pIdx === excludePathIdx && excludeNodeIdx === 0) { } else {
                    const d = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
                    if (d < bestDist) {
                        bestDist = d;
                        snap = { x: p.x, y: p.y };
                    }
                }
            }
        });
        return snap;
    }

    isPathClosed(path) {
        if (!path) return false;
        if (path.closed === true) return true;
        if (path.type === 'rectangle' || path.type === 'circle') return true;
        if (Array.isArray(path.segments) && path.segments.some(segment => segment.type === 'Z')) return true;
        if (Array.isArray(path.points) && path.points.length >= 3) {
            const first = path.points[0];
            const last = path.points[path.points.length - 1];
            // Keep inferred closure very strict so exported helper/fill polylines
            // are not promoted into fake fill boundaries.
            return Math.hypot((last.x || 0) - (first.x || 0), (last.y || 0) - (first.y || 0)) <= 0.08;
        }
        return false;
    }

    shouldTreatPathAsClosedForOffset(path) {
        if (this.isPathClosed(path)) return true;
        if (!Array.isArray(path?.points) || path.points.length < 6) return false;

        const validPoints = path.points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (validPoints.length < 6) return false;

        const first = validPoints[0];
        const last = validPoints[validPoints.length - 1];
        const closureGap = Math.hypot((last.x || 0) - (first.x || 0), (last.y || 0) - (first.y || 0));

        let perimeter = 0;
        for (let i = 1; i < validPoints.length; i++) {
            perimeter += Math.hypot(validPoints[i].x - validPoints[i - 1].x, validPoints[i].y - validPoints[i - 1].y);
        }
        const averageSegment = perimeter / Math.max(1, validPoints.length - 1);
        const tolerance = Math.max(0.08, Math.min(2.5, averageSegment * 2.5));

        return closureGap <= tolerance;
    }

    isImportedVectorPathForOffset(path) {
        if (!path) return false;
        const groupId = String(path.groupId || '');
        return !!(
            path.sourceColor
            || groupId.startsWith('import_')
            || groupId.startsWith('import_color_')
            || path.machinePreviewSource
        );
    }

    flattenPathForFill(path) {
        return this.getPathTracePoints(path);
    }

    pointInPolygon(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            const intersect = ((yi > y) !== (yj > y))
                && (x < ((xj - xi) * (y - yi) / ((yj - yi) || 0.000001)) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    extractClosedPathPolygons(path) {
        if (path?.type !== 'path' || !Array.isArray(path.segments) || path.segments.length === 0) return [];

        const polygons = [];
        let currentPolygon = [];
        let currentPoint = null;
        let subpathStart = null;
        const closeTolerance = 0.18;
        const minClosedRegionArea = 0.2;
        const estimateSegmentSteps = (lengthEstimate, minSteps, maxSteps) => {
            return Math.max(minSteps, Math.min(maxSteps, Math.ceil(Math.max(0.1, lengthEstimate) / 1.2)));
        };
        const addPoint = (pt) => {
            if (!Number.isFinite(pt?.x) || !Number.isFinite(pt?.y)) return;
            const prev = currentPolygon[currentPolygon.length - 1];
            if (!prev || Math.hypot(prev.x - pt.x, prev.y - pt.y) > 0.01) {
                currentPolygon.push({ x: pt.x, y: pt.y });
            }
        };
        const flushPolygon = (forceClose = false) => {
            if (currentPolygon.length < 3 || !subpathStart) {
                currentPolygon = [];
                return;
            }
            const first = currentPolygon[0];
            const last = currentPolygon[currentPolygon.length - 1];
            const isClosed = Math.hypot(last.x - first.x, last.y - first.y) <= closeTolerance;
            if (!forceClose && !isClosed) {
                currentPolygon = [];
                return;
            }
            if (!isClosed) currentPolygon.push({ ...first });
            const polygon = currentPolygon.map(point => ({ ...point }));
            if (this.getPolygonArea(polygon) >= minClosedRegionArea) polygons.push(polygon);
            currentPolygon = [];
        };

        path.segments.forEach(segment => {
            if (segment.type === 'M') {
                flushPolygon(path.closed === true);
                currentPoint = { x: segment.x, y: segment.y };
                subpathStart = { ...currentPoint };
                addPoint(currentPoint);
            } else if (segment.type === 'L') {
                currentPoint = { x: segment.x, y: segment.y };
                addPoint(currentPoint);
            } else if (segment.type === 'C' && currentPoint) {
                const start = { ...currentPoint };
                const controlSpan = Math.hypot(segment.x1 - start.x, segment.y1 - start.y)
                    + Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
                    + Math.hypot(segment.x - segment.x2, segment.y - segment.y2);
                const steps = estimateSegmentSteps(controlSpan, 24, 240);
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    const mt = 1 - t;
                    addPoint({
                        x: (mt ** 3) * start.x + 3 * (mt ** 2) * t * segment.x1 + 3 * mt * (t ** 2) * segment.x2 + (t ** 3) * segment.x,
                        y: (mt ** 3) * start.y + 3 * (mt ** 2) * t * segment.y1 + 3 * mt * (t ** 2) * segment.y2 + (t ** 3) * segment.y
                    });
                }
                currentPoint = { x: segment.x, y: segment.y };
            } else if (segment.type === 'Q' && currentPoint) {
                const start = { ...currentPoint };
                const controlSpan = Math.hypot(segment.x1 - start.x, segment.y1 - start.y)
                    + Math.hypot(segment.x - segment.x1, segment.y - segment.y1);
                const steps = estimateSegmentSteps(controlSpan, 20, 180);
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    const mt = 1 - t;
                    addPoint({
                        x: (mt ** 2) * start.x + 2 * mt * t * segment.x1 + (t ** 2) * segment.x,
                        y: (mt ** 2) * start.y + 2 * mt * t * segment.y1 + (t ** 2) * segment.y
                    });
                }
                currentPoint = { x: segment.x, y: segment.y };
            } else if (segment.type === 'A') {
                const start = currentPoint ? { ...currentPoint } : null;
                this.sampleSvgArcPoints(start, segment).forEach(addPoint);
                currentPoint = { x: segment.x, y: segment.y };
            } else if (segment.type === 'Z' && subpathStart) {
                addPoint({ ...subpathStart });
                currentPoint = { ...subpathStart };
                flushPolygon(true);
                subpathStart = null;
            }
        });

        // Only explicitly closed paths get force-closed here. This avoids
        // silently sealing near-touching export polylines into bogus regions.
        flushPolygon(path.closed === true);
        return polygons;
    }

    getPolygonInteriorPoint(polygon) {
        if (!Array.isArray(polygon) || polygon.length < 3) return null;
        const box = this.getPolygonBox(polygon);
        if (!box) return null;

        const candidateYs = [];
        const centerY = (box.minY + box.maxY) * 0.5;
        candidateYs.push(centerY);
        const height = Math.max(0.001, box.maxY - box.minY);
        for (let i = 1; i <= 6; i++) {
            const offset = (height * i) / 14;
            candidateYs.push(centerY - offset, centerY + offset);
        }

        for (const y of candidateYs) {
            const intersections = [];
            for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                const a = polygon[j];
                const b = polygon[i];
                if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y) || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) continue;
                const crossesScanline = ((a.y > y) !== (b.y > y));
                if (!crossesScanline) continue;
                const t = (y - a.y) / ((b.y - a.y) || 0.000001);
                intersections.push(a.x + ((b.x - a.x) * t));
            }

            intersections.sort((left, right) => left - right);
            for (let i = 0; i + 1 < intersections.length; i += 2) {
                const x1 = intersections[i];
                const x2 = intersections[i + 1];
                if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;
                if (x2 - x1 <= 0.001) continue;
                const candidate = { x: (x1 + x2) * 0.5, y };
                if (this.pointInPolygon(candidate.x, candidate.y, polygon)) {
                    return candidate;
                }
            }
        }

        const validPoints = polygon.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (validPoints.length === 0) return null;
        const centroid = validPoints.reduce((acc, point) => ({
            x: acc.x + point.x,
            y: acc.y + point.y
        }), { x: 0, y: 0 });
        const fallback = {
            x: centroid.x / validPoints.length,
            y: centroid.y / validPoints.length
        };
        return this.pointInPolygon(fallback.x, fallback.y, polygon) ? fallback : validPoints[0];
    }

    buildCompoundFillRegions(polygons, path, pathIdx) {
        if (!Array.isArray(polygons) || polygons.length === 0) return [];

        const polygonMeta = polygons.map((polygon, polygonIdx) => ({
            polygonIdx,
            polygon,
            box: this.getPolygonBox(polygon),
            area: this.getPolygonArea(polygon),
            samplePoint: this.getPolygonInteriorPoint(polygon),
            parentIdx: -1,
            depth: 0,
            children: []
        })).filter(meta => meta.box && meta.area > 0 && meta.samplePoint);

        polygonMeta.forEach((meta, idx) => {
            let bestParentIdx = -1;
            let bestParentArea = Infinity;
            polygonMeta.forEach((candidate, candidateIdx) => {
                if (candidateIdx === idx) return;
                if (candidate.area <= meta.area) return;
                if (!this.pointInPolygon(meta.samplePoint.x, meta.samplePoint.y, candidate.polygon)) return;
                if (candidate.area < bestParentArea) {
                    bestParentArea = candidate.area;
                    bestParentIdx = candidateIdx;
                }
            });
            meta.parentIdx = bestParentIdx;
        });

        polygonMeta.forEach((meta, idx) => {
            let depth = 0;
            let cursor = meta.parentIdx;
            while (cursor !== -1) {
                depth++;
                cursor = polygonMeta[cursor]?.parentIdx ?? -1;
            }
            meta.depth = depth;
            if (meta.parentIdx !== -1) {
                polygonMeta[meta.parentIdx].children.push(idx);
            }
        });

        return polygonMeta
            .filter(meta => meta.depth % 2 === 0)
            .map(meta => {
                const holeIndices = meta.children.filter(childIdx => polygonMeta[childIdx]?.depth === meta.depth + 1);
                return {
                    regionId: `${pathIdx}:compound:${meta.polygonIdx}`,
                    box: meta.box,
                    polygon: meta.polygon,
                    holePolygons: holeIndices.map(childIdx => polygonMeta[childIdx].polygon),
                    pathIdx,
                    path,
                    contains: (x, y) => {
                        if (!this.pointInPolygon(x, y, meta.polygon)) return false;
                        return !holeIndices.some(childIdx => this.pointInPolygon(x, y, polygonMeta[childIdx].polygon));
                    }
                };
            });
    }

    getBaseFillRegions(path, pathIdx) {
        if (!path) return [];
        if (path.type === 'circle') {
            const polygon = this.flattenPathForFill(path);
            const box = this.getBoundingBox(path);
            if (!box || polygon.length < 3) return [];
            return [{
                regionId: `${pathIdx}:circle`,
                box,
                polygon,
                pathIdx,
                path,
                contains: (x, y) => Math.hypot(x - path.x, y - path.y) <= path.r
            }];
        }
        if (path.type === 'rectangle') {
            const polygon = this.flattenPathForFill(path);
            const box = this.getBoundingBox(path);
            if (!box || polygon.length < 3) return [];
            return [{
                regionId: `${pathIdx}:rect`,
                box,
                polygon,
                pathIdx,
                path,
                contains: (x, y) => {
                    const minX = Math.min(path.x, path.x + (path.w || 0));
                    const maxX = Math.max(path.x, path.x + (path.w || 0));
                    const minY = Math.min(path.y, path.y + (path.h || 0));
                    const maxY = Math.max(path.y, path.y + (path.h || 0));
                    return x >= minX && x <= maxX && y >= minY && y <= maxY;
                }
            }];
        }

        const polygons = this.extractClosedPathPolygons(path);
        if (polygons.length > 0) {
            const compoundRegions = this.buildCompoundFillRegions(polygons, path, pathIdx);
            if (compoundRegions.length > 0) return compoundRegions;
        }

        const box = this.getBoundingBox(path);
        if (!box || !this.isPathClosed(path)) return [];
        const polygon = this.flattenPathForFill(path);
        if (!polygon || polygon.length < 3) return [];
        return [{
            regionId: `${pathIdx}:base`,
            box,
            polygon,
            pathIdx,
            path,
            contains: (x, y) => this.pointInPolygon(x, y, polygon)
        }];
    }

    getPolygonBox(points = []) {
        if (!Array.isArray(points) || points.length < 3) return null;
        const validPoints = points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (validPoints.length < 3) return null;
        return validPoints.reduce((box, point) => ({
            minX: Math.min(box.minX, point.x),
            minY: Math.min(box.minY, point.y),
            maxX: Math.max(box.maxX, point.x),
            maxY: Math.max(box.maxY, point.y)
        }), {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        });
    }

    getPolygonArea(points = []) {
        if (!Array.isArray(points) || points.length < 3) return 0;
        const validPoints = points.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (validPoints.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < validPoints.length; i++) {
            const a = validPoints[i];
            const b = validPoints[(i + 1) % validPoints.length];
            area += (a.x * b.y) - (b.x * a.y);
        }
        return Math.abs(area) * 0.5;
    }

    removeCollinearLoopPoints(points = []) {
        if (!Array.isArray(points) || points.length < 4) return Array.isArray(points) ? points.slice() : [];
        const cleaned = [];
        for (let i = 0; i < points.length; i++) {
            const prev = points[(i - 1 + points.length) % points.length];
            const current = points[i];
            const next = points[(i + 1) % points.length];
            if (!prev || !current || !next) continue;
            const cross = ((current.x - prev.x) * (next.y - current.y)) - ((current.y - prev.y) * (next.x - current.x));
            if (Math.abs(cross) <= 1e-6) continue;
            cleaned.push({ x: current.x, y: current.y });
        }
        return cleaned.length >= 3 ? cleaned : points.slice();
    }

    simplifyLoopPoints(points = [], epsilon = 0.06) {
        if (!Array.isArray(points) || points.length < 4) return Array.isArray(points) ? points.slice() : [];

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

        const openLoop = points.concat([points[0]]);
        const simplifiedOpen = rdp(openLoop);
        const simplified = simplifiedOpen.slice(0, -1);
        return this.removeCollinearLoopPoints(simplified);
    }

    getEmbeddedLoopFillRegions(path, pathIdx) {
        if (!path || !Array.isArray(path.points) || path.points.length < 6) return [];
        // Imported/explicitly closed contours already produce exact fill faces.
        // Mining "embedded loops" inside them creates lots of tiny bogus regions
        // that show up as jagged cut-outs in bucket targeting.
        if (this.isPathClosed(path)) return [];
        const source = path.points
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y }));
        if (source.length < 6) return [];

        // Dense tracked strokes can make loop discovery explode during bucket hover.
        const maxLoopPoints = path.liveTrackerGenerated ? 900 : 600;
        if (source.length > maxLoopPoints) return [];

        const loops = [];
        const seen = new Set();
        const closeThreshold = path.liveTrackerGenerated ? 4.5 : 2.5;
        const maxLoopSpan = path.liveTrackerGenerated ? 180 : 240;
        const maxLoopChecks = path.liveTrackerGenerated ? 12000 : 18000;
        let loopChecks = 0;

        for (let start = 0; start < source.length - 4; start++) {
            const endLimit = Math.min(source.length, start + maxLoopSpan);
            for (let end = start + 4; end < endLimit; end++) {
                loopChecks++;
                if (loopChecks > maxLoopChecks) return loops;
                const startPoint = source[start];
                const endPoint = source[end];
                if (Math.hypot((endPoint.x || 0) - (startPoint.x || 0), (endPoint.y || 0) - (startPoint.y || 0)) > closeThreshold) {
                    continue;
                }

                const polygon = source.slice(start, end + 1).map(point => ({ x: point.x, y: point.y }));
                polygon[polygon.length - 1] = { x: startPoint.x, y: startPoint.y };
                const area = this.getPolygonArea(polygon);
                if (area < 0.2) continue;

                const signature = `${start}:${end}:${Math.round(area * 10)}`;
                if (seen.has(signature)) continue;
                seen.add(signature);

                const box = this.getPolygonBox(polygon);
                if (!box) continue;

                loops.push({
                    regionId: `${pathIdx}:embedded:${start}:${end}`,
                    box,
                    polygon,
                    pathIdx,
                    path,
                    isEmbeddedLoop: true,
                    contains: (x, y) => this.pointInPolygon(x, y, polygon)
                });
            }
        }

        return loops;
    }

    getClosedFillRegions() {
        if (this.closedFillRegionsCache) {
            return this.closedFillRegionsCache;
        }
        const regions = [];
        for (let i = 0; i < this.paths.length; i++) {
            const path = this.paths[i];
            if (path?.generatedBy === 'bucket-fill') continue;
            this.getBaseFillRegions(path, i).forEach(region => regions.push(region));
            this.getEmbeddedLoopFillRegions(path, i).forEach(loopRegion => regions.push(loopRegion));
        }
        this.closedFillRegionsCache = regions;
        return regions;
    }

    getFillRegionsForPath(path, pathIdx = 0) {
        const regions = [];
        this.getBaseFillRegions(path, pathIdx).forEach(region => regions.push(region));
        this.getEmbeddedLoopFillRegions(path, pathIdx).forEach(region => regions.push(region));
        return regions;
    }

    isPointInsidePathRegionSet(x, y, path) {
        const regions = this.getFillRegionsForPath(path, -1)
            .filter(region => typeof region.contains === 'function');
        return regions.some(region => region.contains(x, y));
    }

    traceCoverageMaskLoops(mask) {
        if (!mask?.cells || !(mask.cells instanceof Set) || !mask.cells.size) return [];
        const adjacency = new Map();
        const edges = [];
        const addAdjacency = (startKey, endKey) => {
            if (!adjacency.has(startKey)) adjacency.set(startKey, []);
            adjacency.get(startKey).push(endKey);
        };

        mask.cells.forEach(key => {
            const [cxRaw, cyRaw] = key.split(',');
            const cx = parseInt(cxRaw, 10);
            const cy = parseInt(cyRaw, 10);
            const x = mask.originX + (cx * mask.cellSize);
            const y = mask.originY + (cy * mask.cellSize);
            const leftEmpty = !mask.cells.has(`${cx - 1},${cy}`);
            const rightEmpty = !mask.cells.has(`${cx + 1},${cy}`);
            const topEmpty = !mask.cells.has(`${cx},${cy - 1}`);
            const bottomEmpty = !mask.cells.has(`${cx},${cy + 1}`);

            const cellEdges = [];
            if (topEmpty) cellEdges.push([{ x, y }, { x: x + mask.cellSize, y }]);
            if (rightEmpty) cellEdges.push([{ x: x + mask.cellSize, y }, { x: x + mask.cellSize, y: y + mask.cellSize }]);
            if (bottomEmpty) cellEdges.push([{ x: x + mask.cellSize, y: y + mask.cellSize }, { x, y: y + mask.cellSize }]);
            if (leftEmpty) cellEdges.push([{ x, y: y + mask.cellSize }, { x, y }]);

            cellEdges.forEach(([start, end]) => {
                const startKey = `${start.x.toFixed(4)},${start.y.toFixed(4)}`;
                const endKey = `${end.x.toFixed(4)},${end.y.toFixed(4)}`;
                edges.push({ start, end, startKey, endKey });
                addAdjacency(startKey, endKey);
            });
        });

        const edgeMap = new Map(edges.map(edge => [`${edge.startKey}>${edge.endKey}`, edge]));
        const visited = new Set();
        const loops = [];

        edgeMap.forEach((edge, edgeKey) => {
            if (visited.has(edgeKey)) return;
            const loop = [{ ...edge.start }];
            let currentEdge = edge;
            visited.add(edgeKey);
            loop.push({ ...currentEdge.end });

            while (true) {
                const nextCandidates = (adjacency.get(currentEdge.endKey) || [])
                    .map(nextKey => edgeMap.get(`${currentEdge.endKey}>${nextKey}`))
                    .filter(Boolean)
                    .filter(nextEdge => !visited.has(`${nextEdge.startKey}>${nextEdge.endKey}`));
                if (!nextCandidates.length) break;
                const nextEdge = nextCandidates[0];
                visited.add(`${nextEdge.startKey}>${nextEdge.endKey}`);
                currentEdge = nextEdge;
                loop.push({ ...currentEdge.end });
                if (currentEdge.endKey === edge.startKey) break;
            }

            if (loop.length >= 4) {
                const first = loop[0];
                const last = loop[loop.length - 1];
                if (Math.hypot(last.x - first.x, last.y - first.y) > 0.001) {
                    loop.push({ ...first });
                }
                if (this.getPolygonArea(loop) >= Math.max(0.5, mask.cellSize * mask.cellSize)) {
                    loops.push(loop);
                }
            }
        });

        return loops;
    }

    traceBooleanGridLoops(grid) {
        if (!grid || !Array.isArray(grid.samples) || !grid.samples.length) return [];

        const getSample = (x, y) => {
            if (x < 0 || y < 0 || x > grid.cols || y > grid.rows) return false;
            return !!grid.samples[(y * (grid.cols + 1)) + x];
        };
        const edgePoint = (cellX, cellY, edgeIdx) => {
            const x = grid.originX + (cellX * grid.cellSize);
            const y = grid.originY + (cellY * grid.cellSize);
            switch (edgeIdx) {
                case 0: return { x: x + (grid.cellSize * 0.5), y };
                case 1: return { x: x + grid.cellSize, y: y + (grid.cellSize * 0.5) };
                case 2: return { x: x + (grid.cellSize * 0.5), y: y + grid.cellSize };
                case 3: return { x, y: y + (grid.cellSize * 0.5) };
                default: return { x, y };
            }
        };
        const caseSegments = {
            1: [[3, 2]],
            2: [[2, 1]],
            3: [[3, 1]],
            4: [[0, 1]],
            5: [[0, 3], [1, 2]],
            6: [[0, 2]],
            7: [[0, 3]],
            8: [[0, 3]],
            9: [[0, 2]],
            10: [[0, 1], [2, 3]],
            11: [[0, 1]],
            12: [[3, 1]],
            13: [[2, 1]],
            14: [[3, 2]]
        };

        const segments = [];
        for (let y = 0; y < grid.rows; y++) {
            for (let x = 0; x < grid.cols; x++) {
                const tl = getSample(x, y);
                const tr = getSample(x + 1, y);
                const br = getSample(x + 1, y + 1);
                const bl = getSample(x, y + 1);
                const caseIndex = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
                const mappings = caseSegments[caseIndex];
                if (!mappings) continue;
                mappings.forEach(([startEdge, endEdge]) => {
                    segments.push({
                        start: edgePoint(x, y, startEdge),
                        end: edgePoint(x, y, endEdge)
                    });
                });
            }
        }

        if (!segments.length) return [];

        const keyForPoint = (point) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`;
        const adjacency = new Map();
        segments.forEach((segment, index) => {
            const startKey = keyForPoint(segment.start);
            const endKey = keyForPoint(segment.end);
            if (!adjacency.has(startKey)) adjacency.set(startKey, []);
            if (!adjacency.has(endKey)) adjacency.set(endKey, []);
            adjacency.get(startKey).push({ index, point: segment.end, key: endKey });
            adjacency.get(endKey).push({ index, point: segment.start, key: startKey });
        });

        const visited = new Set();
        const loops = [];
        for (let i = 0; i < segments.length; i++) {
            if (visited.has(i)) continue;
            visited.add(i);
            const loop = [{ ...segments[i].start }, { ...segments[i].end }];
            let currentKey = keyForPoint(segments[i].end);
            const startKey = keyForPoint(segments[i].start);

            while (currentKey !== startKey) {
                const candidates = (adjacency.get(currentKey) || []).filter(candidate => !visited.has(candidate.index));
                if (!candidates.length) break;
                const next = candidates[0];
                visited.add(next.index);
                loop.push({ ...next.point });
                currentKey = next.key;
            }

            if (loop.length >= 4) {
                const first = loop[0];
                const last = loop[loop.length - 1];
                if (Math.hypot(last.x - first.x, last.y - first.y) > 0.001) {
                    loop.push({ ...first });
                }
                if (this.getPolygonArea(loop) >= Math.max(0.05, grid.cellSize * grid.cellSize)) {
                    loops.push(loop);
                }
            }
        }

        return loops;
    }

    buildBooleanResultPathsFromMask(mask, pen = 1) {
        let loops = Array.isArray(mask?.samples)
            ? this.traceBooleanGridLoops(mask)
            : [];
        if (!loops.length) {
            loops = this.traceCoverageMaskLoops(mask);
        }
        if (!loops.length) return [];
        return loops.map(points => {
            const openLoop = Array.isArray(points) && points.length > 1 ? points.slice(0, -1) : [];
            const simplified = this.simplifyLoopPoints(openLoop, Math.max(0.02, (mask?.cellSize || 0.1) * 0.35));
            const finalPoints = simplified.length >= 3 ? simplified.concat([{ ...simplified[0] }]) : points;
            return {
                type: 'polyline',
                points: finalPoints,
                pen,
                closed: true,
                generatedBy: 'boolean-op'
            };
        });
    }

    getPaperBooleanScope() {
        if (this._paperBooleanScope && typeof paper !== 'undefined') return this._paperBooleanScope;
        if (typeof paper === 'undefined' || typeof paper.PaperScope !== 'function') return null;
        const scope = new paper.PaperScope();
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 8;
        offscreenCanvas.height = 8;
        scope.setup(offscreenCanvas);
        this._paperBooleanScope = scope;
        return scope;
    }

    clearPaperBooleanScope(scope) {
        if (!scope?.project) return;
        if (typeof scope.project.clear === 'function') {
            scope.project.clear();
            return;
        }
        if (scope.project.activeLayer?.removeChildren) {
            scope.project.activeLayer.removeChildren();
        }
    }

    getClipperScope() {
        if (typeof ClipperLib === 'undefined' || !ClipperLib?.ClipperOffset) return null;
        return ClipperLib;
    }

    getMakerJsScope() {
        if (typeof makerjs === 'undefined' || !makerjs?.model?.outline) return null;
        return makerjs;
    }

    getBooleanSourcePoints(path) {
        if (!path) return [];
        if ((path.type === 'line' || path.type === 'polyline') && Array.isArray(path.points)) {
            let points = path.points
                .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
                .map(point => ({ x: point.x, y: point.y }));
            if (this.pathSupportsCurve(path) && Math.abs(path.curve || 0) >= 0.001) {
                points = this.getPathTracePoints(path);
            }
            if (this.isPathClosed(path) && points.length > 2) {
                const first = points[0];
                const last = points[points.length - 1];
                if (Math.hypot(last.x - first.x, last.y - first.y) <= 0.01) {
                    points = points.slice(0, -1);
                }
            }
            return points;
        }
        if (path.type === 'path' && Array.isArray(path.segments) && Math.abs(path.curve || 0) < 0.001) {
            return null;
        }
        let traced = this.getPathTracePoints(path, { applyCurve: true });
        if (this.isPathClosed(path) && traced.length > 2) {
            const first = traced[0];
            const last = traced[traced.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) <= 0.01) {
                traced = traced.slice(0, -1);
            }
        }
        return traced;
    }

    densifyPolylinePoints(points, maxSegmentLength = 0.18) {
        if (!Array.isArray(points) || points.length < 2) return Array.isArray(points) ? points.slice() : [];
        const densified = [{ x: points[0].x, y: points[0].y }];
        for (let i = 1; i < points.length; i++) {
            const start = points[i - 1];
            const end = points[i];
            if (!start || !end) continue;
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const distance = Math.hypot(dx, dy);
            const steps = Math.max(1, Math.ceil(distance / Math.max(0.05, maxSegmentLength)));
            for (let step = 1; step <= steps; step++) {
                densified.push({
                    x: start.x + ((dx * step) / steps),
                    y: start.y + ((dy * step) / steps)
                });
            }
        }
        return densified;
    }

    convertAppPathToClipperPath(path, scale = 100000) {
        let points = this.getBooleanSourcePoints(path);
        if (!Array.isArray(points) || points.length < 2) return null;

        let normalized = points
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y }));
        if (path?.type === 'circle') {
            const radius = Math.max(0.1, Math.abs(path.r || 0));
            const circumference = Math.PI * 2 * radius;
            const steps = Math.max(360, Math.min(8192, Math.ceil(circumference / 0.1)));
            normalized = [];
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                normalized.push({
                    x: path.x + Math.cos(angle) * radius,
                    y: path.y + Math.sin(angle) * radius
                });
            }
        } else {
            const maxSegmentLength = this.isPathClosed(path) ? 0.12 : 0.1;
            normalized = this.densifyPolylinePoints(normalized, maxSegmentLength);
        }
        if (this.shouldTreatPathAsClosedForOffset(path) && normalized.length > 2) {
            const first = normalized[0];
            const last = normalized[normalized.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) > 0.0001) {
                normalized.push({ ...first });
            }
        }
        if (this.shouldTreatPathAsClosedForOffset(path) && normalized.length > 2) {
            const first = normalized[0];
            const last = normalized[normalized.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) <= 0.01) {
                normalized = normalized.slice(0, -1);
            }
        }
        if (normalized.length < 2) return null;

        return normalized.map(point => ({
            X: Math.round(point.x * scale),
            Y: Math.round(point.y * scale)
        }));
    }

    buildAppPathsFromClipperPaths(paths, pen, scale = 100000) {
        if (!Array.isArray(paths) || !paths.length) return [];
        return paths
            .map(path => {
                const cleanedPath = typeof ClipperLib !== 'undefined' && ClipperLib?.Clipper?.CleanPolygon
                    ? ClipperLib.Clipper.CleanPolygon(path || [], 2)
                    : (path || []);
                const points = cleanedPath
                    .filter(point => Number.isFinite(point?.X) && Number.isFinite(point?.Y))
                    .map(point => ({
                        x: point.X / scale,
                        y: point.Y / scale
                    }));
                if (points.length < 3) return null;
                const cleaned = this.removeCollinearLoopPoints(points);
                if (!Array.isArray(cleaned) || cleaned.length < 3) return null;
                const closedPoints = cleaned.concat([{ ...cleaned[0] }]);
                return {
                    type: 'polyline',
                    points: closedPoints,
                    pen,
                    closed: true,
                    generatedBy: 'boolean-op-clipper'
                };
            })
            .filter(Boolean);
    }

    convertAppPathToMakerModel(path) {
        if (!path) return null;
        const maker = this.getMakerJsScope();
        if (!maker) return null;

        if (path.type === 'circle') {
            return {
                paths: {
                    c0: new maker.paths.Circle([path.x, path.y], Math.abs(path.r || 0))
                }
            };
        }

        if (path.type === 'path' && Array.isArray(path.segments) && path.segments.length > 0) {
            const model = { paths: {}, models: {} };
            let pathCount = 0;
            let modelCount = 0;
            let currentPoint = null;
            let subpathStart = null;

            const toMakerPoint = (x, y) => [x, y];
            const addLine = (start, end) => {
                if (!start || !end) return;
                if (Math.hypot((end.x || 0) - (start.x || 0), (end.y || 0) - (start.y || 0)) <= 0.0001) return;
                model.paths[`p${pathCount++}`] = new maker.paths.Line(
                    toMakerPoint(start.x, start.y),
                    toMakerPoint(end.x, end.y)
                );
            };
            const addBezier = (seedPoints) => {
                if (!Array.isArray(seedPoints) || seedPoints.length < 3) return;
                model.models[`b${modelCount++}`] = new maker.models.BezierCurve(seedPoints.map(point => toMakerPoint(point.x, point.y)));
            };

            path.segments.forEach(segment => {
                if (!segment) return;
                if (segment.type === 'M') {
                    currentPoint = { x: segment.x, y: segment.y };
                    subpathStart = currentPoint ? { ...currentPoint } : null;
                    return;
                }
                if (!currentPoint) return;

                if (segment.type === 'L') {
                    const nextPoint = { x: segment.x, y: segment.y };
                    addLine(currentPoint, nextPoint);
                    currentPoint = nextPoint;
                    return;
                }

                if (segment.type === 'Q') {
                    const nextPoint = { x: segment.x, y: segment.y };
                    addBezier([
                        { ...currentPoint },
                        { x: segment.x1, y: segment.y1 },
                        { ...nextPoint }
                    ]);
                    currentPoint = nextPoint;
                    return;
                }

                if (segment.type === 'C') {
                    const nextPoint = { x: segment.x, y: segment.y };
                    addBezier([
                        { ...currentPoint },
                        { x: segment.x1, y: segment.y1 },
                        { x: segment.x2, y: segment.y2 },
                        { ...nextPoint }
                    ]);
                    currentPoint = nextPoint;
                    return;
                }

                if (segment.type === 'Z') {
                    if (currentPoint && subpathStart) {
                        addLine(currentPoint, subpathStart);
                        currentPoint = { ...subpathStart };
                    }
                    return;
                }

                if (Number.isFinite(segment.x) && Number.isFinite(segment.y)) {
                    const nextPoint = { x: segment.x, y: segment.y };
                    addLine(currentPoint, nextPoint);
                    currentPoint = nextPoint;
                }
            });

            if (pathCount || modelCount) return model;
        }

        const tracePoints = this.getBooleanSourcePoints(path);
        if (!Array.isArray(tracePoints) || tracePoints.length < 2) return null;

        let points = tracePoints
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => [point.x, point.y]);
        const treatClosed = this.shouldTreatPathAsClosedForOffset(path);
        if (treatClosed && points.length > 2) {
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.hypot(last[0] - first[0], last[1] - first[1]) <= 0.01) {
                points = points.slice(0, -1);
            }
        }
        if (points.length < 2) return null;

        const model = { paths: {} };
        for (let i = 1; i < points.length; i++) {
            model.paths[`p${i - 1}`] = new maker.paths.Line(points[i - 1], points[i]);
        }
        if (treatClosed && points.length > 2) {
            model.paths[`p${points.length - 1}`] = new maker.paths.Line(points[points.length - 1], points[0]);
        }
        return model;
    }

    sampleMakerPath(pathContext, offset = [0, 0], reversed = false) {
        const maker = this.getMakerJsScope();
        if (!maker || !pathContext) return [];
        const ox = Number.isFinite(offset?.[0]) ? offset[0] : 0;
        const oy = Number.isFinite(offset?.[1]) ? offset[1] : 0;

        if (pathContext.type === maker.pathType.Line) {
            const start = {
                x: (pathContext.origin?.[0] || 0) + ox,
                y: (pathContext.origin?.[1] || 0) + oy
            };
            const end = {
                x: (pathContext.end?.[0] || 0) + ox,
                y: (pathContext.end?.[1] || 0) + oy
            };
            return reversed ? [end, start] : [start, end];
        }

        if (pathContext.type === maker.pathType.Circle) {
            const radius = Math.abs(pathContext.radius || 0);
            const centerX = (pathContext.origin?.[0] || 0) + ox;
            const centerY = (pathContext.origin?.[1] || 0) + oy;
            const steps = Math.max(360, Math.min(4096, Math.ceil((Math.PI * 2 * radius) / 0.1)));
            const points = [];
            for (let i = 0; i < steps; i++) {
                const t = reversed ? (1 - (i / steps)) : (i / steps);
                const angle = t * Math.PI * 2;
                points.push({
                    x: centerX + Math.cos(angle) * radius,
                    y: centerY + Math.sin(angle) * radius
                });
            }
            return points;
        }

        if (pathContext.type === maker.pathType.Arc) {
            const radius = Math.abs(pathContext.radius || 0);
            const centerX = (pathContext.origin?.[0] || 0) + ox;
            const centerY = (pathContext.origin?.[1] || 0) + oy;
            const startAngle = (pathContext.startAngle || 0) * (Math.PI / 180);
            const endAngle = (pathContext.endAngle || 0) * (Math.PI / 180);
            let sweep = endAngle - startAngle;
            while (sweep <= -Math.PI * 2) sweep += Math.PI * 2;
            while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
            const steps = Math.max(24, Math.min(2048, Math.ceil((Math.abs(sweep) * radius) / 0.12)));
            const points = [];
            for (let i = 0; i <= steps; i++) {
                const ratio = reversed ? (1 - (i / steps)) : (i / steps);
                const angle = startAngle + (sweep * ratio);
                points.push({
                    x: centerX + Math.cos(angle) * radius,
                    y: centerY + Math.sin(angle) * radius
                });
            }
            return points;
        }

        if (pathContext.type === maker.pathType.BezierSeed && maker.models?.BezierCurve) {
            const length = Math.max(0.1, maker.models.BezierCurve.computeLength(pathContext) || 0);
            const steps = Math.max(32, Math.min(2048, Math.ceil(length / 0.1)));
            const points = [];
            for (let i = 0; i <= steps; i++) {
                const t = reversed ? (1 - (i / steps)) : (i / steps);
                const point = maker.models.BezierCurve.computePoint(pathContext, t);
                if (!Array.isArray(point) || point.length < 2) continue;
                points.push({
                    x: point[0] + ox,
                    y: point[1] + oy
                });
            }
            return points;
        }

        return [];
    }

    buildAppPathsFromMakerModel(outlinedModel, pen) {
        const maker = this.getMakerJsScope();
        if (!maker || !outlinedModel) return [];

        const chains = maker.model.findChains(outlinedModel, { byLayers: false, pointMatchingDistance: 0.02 }) || [];
        const chainList = Array.isArray(chains) ? chains : [];
        const result = [];

        chainList.forEach((chain, chainIndex) => {
            if (!chain?.links?.length) return;
            const points = [];
            chain.links.forEach((link, linkIndex) => {
                const sampled = this.sampleMakerPath(link.walkedPath?.pathContext, link.walkedPath?.offset, !!link.reversed);
                if (!sampled.length) return;
                if (points.length && sampled.length) {
                    const first = sampled[0];
                    const prev = points[points.length - 1];
                    if (Math.hypot(prev.x - first.x, prev.y - first.y) <= 0.01) {
                        points.push(...sampled.slice(1));
                        return;
                    }
                }
                points.push(...sampled);
            });

            if (chain.endless && points.length > 2) {
                const first = points[0];
                const last = points[points.length - 1];
                if (Math.hypot(last.x - first.x, last.y - first.y) > 0.01) {
                    points.push({ ...first });
                }
            }

            if (points.length < 3) return;
            result.push({
                type: 'polyline',
                points,
                pen,
                closed: !!chain.endless,
                groupId: chainList.length > 1 ? `maker_outline_${Date.now()}_${chainIndex}` : undefined,
                generatedBy: 'boolean-op-maker'
            });
        });

        return result;
    }

    applyMakerOffsetOperation(selectedEntries, offsetAmount, pen) {
        const maker = this.getMakerJsScope();
        if (!maker || Math.abs(offsetAmount || 0) < 0.0001) return null;
        try {
            const root = { models: {} };
            let added = 0;
            selectedEntries.forEach((entry, index) => {
                const model = this.convertAppPathToMakerModel(entry.path);
                if (!model) return;
                root.models[`m${index}`] = model;
                added++;
            });
            if (!added) return null;

            const outlined = maker.model.outline(root, Math.abs(offsetAmount), 0, offsetAmount < 0);
            if (!outlined) return null;
            const resultPaths = this.buildAppPathsFromMakerModel(outlined, pen);
            return resultPaths.length ? resultPaths : null;
        } catch (error) {
            console.warn('Maker.js offset operation failed, falling back to Clipper/Paper offset.', error);
            return null;
        }
    }

    convertAppPathToPaperItem(scope, path) {
        if (!scope || !path) return null;
        if (path.type === 'rectangle') {
            const left = Math.min(path.x, path.x + (path.w || 0));
            const top = Math.min(path.y, path.y + (path.h || 0));
            const width = Math.abs(path.w || 0);
            const height = Math.abs(path.h || 0);
            if (width < 0.0001 || height < 0.0001) return null;
            return new scope.Path.Rectangle(new scope.Rectangle(left, top, width, height));
        }
        if (path.type === 'circle') {
            const radius = Math.abs(path.r || 0);
            if (radius < 0.0001) return null;
            return new scope.Path.Circle(new scope.Point(path.x, path.y), radius);
        }
        if (path.type === 'path' && Array.isArray(path.segments) && Math.abs(path.curve || 0) < 0.001) {
            const paperPath = new scope.Path({ insert: true });
            let started = false;
            path.segments.forEach(segment => {
                if (!segment || typeof segment.type !== 'string') return;
                if (segment.type === 'M') {
                    paperPath.moveTo(new scope.Point(segment.x, segment.y));
                    started = true;
                } else if (segment.type === 'L' && started) {
                    paperPath.lineTo(new scope.Point(segment.x, segment.y));
                } else if (segment.type === 'C' && started) {
                    paperPath.cubicCurveTo(
                        new scope.Point(segment.x1, segment.y1),
                        new scope.Point(segment.x2, segment.y2),
                        new scope.Point(segment.x, segment.y)
                    );
                } else if (segment.type === 'Q' && started) {
                    paperPath.quadraticCurveTo(
                        new scope.Point(segment.x1, segment.y1),
                        new scope.Point(segment.x, segment.y)
                    );
                } else if (segment.type === 'A' && started) {
                    paperPath.lineTo(new scope.Point(segment.x, segment.y));
                } else if (segment.type === 'Z' && started) {
                    paperPath.closed = true;
                }
            });
            if (!paperPath.segments.length) {
                paperPath.remove();
                return null;
            }
            paperPath.closed = this.isPathClosed(path);
            return paperPath;
        }

        const points = this.getBooleanSourcePoints(path);
        if (!Array.isArray(points) || points.length < 2) return null;
        const normalizedPoints = points
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y }));
        if (normalizedPoints.length < 2) return null;
        const paperPath = new scope.Path({ insert: true });
        normalizedPoints.forEach((point, index) => {
            if (index === 0) {
                paperPath.moveTo(new scope.Point(point.x, point.y));
            } else {
                paperPath.lineTo(new scope.Point(point.x, point.y));
            }
        });
        paperPath.closed = this.isPathClosed(path);
        return paperPath;
    }

    convertAppPathToOffsetPaperItem(scope, path) {
        if (!scope || !path) return null;
        if (path.type === 'rectangle' || path.type === 'circle') {
            return this.convertAppPathToPaperItem(scope, path);
        }

        if (path.type === 'path' && Array.isArray(path.segments) && path.segments.length > 0 && Math.abs(path.curve || 0) < 0.001) {
            const exactPath = this.convertAppPathToPaperItem(scope, path);
            if (exactPath) {
                exactPath.closed = this.shouldTreatPathAsClosedForOffset(path);
                return exactPath;
            }
        }

        const sourcePoints = this.getBooleanSourcePoints(path);
        if (!Array.isArray(sourcePoints) || sourcePoints.length < 2) return null;

        const treatClosed = this.shouldTreatPathAsClosedForOffset(path);
        let points = sourcePoints
            .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
            .map(point => ({ x: point.x, y: point.y }));
        if (treatClosed && points.length > 2) {
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) <= 0.01) {
                points = points.slice(0, -1);
            }
        }
        if (points.length < 2) return null;

        const hpgl = this.app?.hpgl;
        const shouldSmoothSource = treatClosed
            && points.length >= 8
            && (this.isImportedVectorPathForOffset(path) || points.length >= 24)
            && typeof hpgl?._sampleCatmullRom === 'function';
        if (shouldSmoothSource) {
            try {
                const sampled = hpgl._sampleCatmullRom(points.map(point => ({ x: point.x, y: point.y })), true);
                if (Array.isArray(sampled) && sampled.length >= points.length) {
                    points = sampled
                        .filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
                        .map(point => ({ x: point.x, y: point.y }));
                    if (points.length > 2) {
                        const first = points[0];
                        const last = points[points.length - 1];
                        if (Math.hypot(last.x - first.x, last.y - first.y) <= 0.01) {
                            points = points.slice(0, -1);
                        }
                    }
                }
            } catch (error) {
                console.warn('Offset source smoothing failed; using raw contour.', error);
            }
        }

        const paperPath = new scope.Path({ insert: true });
        points.forEach((point, index) => {
            const nextPoint = new scope.Point(point.x, point.y);
            if (index === 0) paperPath.moveTo(nextPoint);
            else paperPath.lineTo(nextPoint);
        });
        paperPath.closed = treatClosed;
        return paperPath;
    }

    buildAppPathFromPaperPath(scope, paperPath, sourceMeta = {}) {
        const paperSegments = paperPath?.segments ? Array.from(paperPath.segments) : null;
        if (!scope || !paperPath || !paperSegments || paperSegments.length < 2) return null;
        const pen = sourceMeta.pen || this.app?.ui?.activeVisualizerPen || 1;
        const closed = !!paperPath.closed;
        const points = paperSegments.map(segment => ({
            x: segment.point.x,
            y: segment.point.y
        }));
        if (closed && points.length > 1) {
            points.push({ ...points[0] });
        }

        const hasCurves = paperSegments.some(segment => {
            const inLen = segment.handleIn ? segment.handleIn.length : 0;
            const outLen = segment.handleOut ? segment.handleOut.length : 0;
            return inLen > 0.0001 || outLen > 0.0001;
        });

        if (!hasCurves) {
            return {
                type: 'polyline',
                points,
                pen,
                closed,
                groupId: sourceMeta.groupId,
                parentGroupId: sourceMeta.parentGroupId,
                generatedBy: 'boolean-op-paper'
            };
        }

        const appSegments = [];
        const segmentCount = paperSegments.length;
        const firstSegment = paperSegments[0];
        appSegments.push({
            type: 'M',
            x: firstSegment.point.x,
            y: firstSegment.point.y
        });

        const appendEdge = (fromSegment, toSegment) => {
            const cp1 = fromSegment.point.add(fromSegment.handleOut || new scope.Point(0, 0));
            const cp2 = toSegment.point.add(toSegment.handleIn || new scope.Point(0, 0));
            const isLinear = (fromSegment.handleOut?.length || 0) <= 0.0001
                && (toSegment.handleIn?.length || 0) <= 0.0001;
            if (isLinear) {
                appSegments.push({
                    type: 'L',
                    x: toSegment.point.x,
                    y: toSegment.point.y
                });
            } else {
                appSegments.push({
                    type: 'C',
                    x1: cp1.x,
                    y1: cp1.y,
                    x2: cp2.x,
                    y2: cp2.y,
                    x: toSegment.point.x,
                    y: toSegment.point.y
                });
            }
        };

        for (let i = 1; i < segmentCount; i++) {
            appendEdge(paperSegments[i - 1], paperSegments[i]);
        }
        if (closed) {
            appendEdge(paperSegments[segmentCount - 1], paperSegments[0]);
            appSegments.push({ type: 'Z' });
        }

        return {
            type: 'path',
            points,
            segments: appSegments,
            pen,
            closed,
            groupId: sourceMeta.groupId,
            parentGroupId: sourceMeta.parentGroupId,
            generatedBy: 'boolean-op-paper'
        };
    }

    convertPaperItemToAppPaths(scope, item, sourceMeta = {}) {
        if (!scope || !item) return [];
        const paths = [];
        const visit = (current) => {
            if (!current || current.isEmpty?.()) return;
            if (current instanceof scope.CompoundPath) {
                current.children.forEach(child => visit(child));
                return;
            }
            if (!(current instanceof scope.Path)) return;
            const built = this.buildAppPathFromPaperPath(scope, current, sourceMeta);
            if (built) paths.push(built);
        };
        visit(item);
        return paths;
    }

    applyPaperBooleanOperation(operation, selectedEntries, pen) {
        const scope = this.getPaperBooleanScope();
        if (!scope) return null;
        try {
            this.clearPaperBooleanScope(scope);
            const paperItems = selectedEntries.map(entry => this.convertAppPathToPaperItem(scope, entry.path));
            if (paperItems.some(item => !item)) {
                this.clearPaperBooleanScope(scope);
                return null;
            }

            const applyTwo = (left, right, opName) => {
                if (!left || !right) return null;
                if (opName === 'union') return left.unite(right);
                if (opName === 'intersect') return left.intersect(right);
                if (opName === 'exclude') return left.exclude(right);
                return left.subtract(right);
            };

            let result = null;
            if (operation === 'subtract') {
                const cutter = paperItems[paperItems.length - 1];
                let base = paperItems[0];
                for (let i = 1; i < paperItems.length - 1; i++) {
                    const nextBase = base.unite(paperItems[i]);
                    base.remove();
                    paperItems[i].remove();
                    base = nextBase;
                }
                result = applyTwo(base, cutter, operation);
                base.remove();
                cutter.remove();
            } else {
                result = paperItems[0];
                for (let i = 1; i < paperItems.length; i++) {
                    const nextResult = applyTwo(result, paperItems[i], operation);
                    result.remove();
                    paperItems[i].remove();
                    result = nextResult;
                }
            }

            if (!result) {
                this.clearPaperBooleanScope(scope);
                return null;
            }

            const resultPaths = this.convertPaperItemToAppPaths(scope, result, { pen });
            result.remove();
            this.clearPaperBooleanScope(scope);
            return resultPaths.length ? resultPaths : null;
        } catch (error) {
            console.warn('Paper boolean operation failed, falling back to sampled boolean.', error);
            this.clearPaperBooleanScope(scope);
            return null;
        }
    }

    buildPaperOffsetPath(scope, paperPath, offsetAmount) {
        if (!scope || !paperPath || Math.abs(offsetAmount || 0) < 0.0001) return null;
        const length = paperPath.length || 0;
        if (!Number.isFinite(length) || length < 0.0001) return null;

        const sampleStep = Math.max(0.2, Math.min(1.2, Math.max(Math.abs(offsetAmount) * 0.2, length / 260)));
        const sampleCount = Math.max(24, Math.min(960, Math.ceil(length / sampleStep)));
        const probeDistance = Math.max(0.04, Math.min(0.4, Math.abs(offsetAmount) * 0.2 + 0.04));
        const sampledPoints = [];

        for (let i = 0; i < sampleCount; i++) {
            const offset = (i / sampleCount) * length;
            const point = paperPath.getPointAt(offset);
            if (!point) continue;

            let normal = paperPath.getNormalAt(offset);
            if (!normal || !Number.isFinite(normal.x) || !Number.isFinite(normal.y) || normal.length < 0.0001) {
                const tangent = paperPath.getTangentAt(offset);
                if (!tangent || !Number.isFinite(tangent.x) || !Number.isFinite(tangent.y) || tangent.length < 0.0001) {
                    continue;
                }
                normal = new scope.Point(-tangent.y, tangent.x);
            }

            normal = normal.normalize();
            const probePoint = point.add(normal.multiply(probeDistance));
            const outwardNormal = paperPath.contains(probePoint) ? normal.multiply(-1) : normal;
            const shifted = point.add(outwardNormal.normalize().multiply(offsetAmount));
            const previous = sampledPoints[sampledPoints.length - 1];
            if (!previous || previous.getDistance(shifted) > 0.02) {
                sampledPoints.push(shifted);
            }
        }

        if (sampledPoints.length < 3) return null;

        const offsetPath = new scope.Path({ insert: true, closed: true });
        sampledPoints.forEach(point => offsetPath.add(point));
        if (offsetPath.segments.length < 3) {
            offsetPath.remove();
            return null;
        }

        try {
            offsetPath.simplify(Math.max(0.03, Math.min(0.3, Math.abs(offsetAmount) * 0.08)));
        } catch (_) {}
        try {
            offsetPath.smooth({ type: 'continuous' });
        } catch (_) {}

        if (Math.abs(offsetPath.area || 0) < 0.0001 || offsetPath.segments.length < 3) {
            offsetPath.remove();
            return null;
        }
        return offsetPath;
    }

    buildPaperOpenOffsetPath(scope, paperPath, offsetAmount) {
        if (!scope || !paperPath || Math.abs(offsetAmount || 0) < 0.0001) return null;
        const halfWidth = Math.abs(offsetAmount);
        const length = paperPath.length || 0;
        if (!Number.isFinite(length) || length < 0.0001) return null;

        const sampleStep = Math.max(0.2, Math.min(1.1, Math.max(halfWidth * 0.2, length / 220)));
        const sampleCount = Math.max(12, Math.min(720, Math.ceil(length / sampleStep) + 1));
        const leftPoints = [];
        const rightPoints = [];

        for (let i = 0; i < sampleCount; i++) {
            const offset = sampleCount === 1 ? 0 : (i / (sampleCount - 1)) * length;
            const point = paperPath.getPointAt(offset);
            if (!point) continue;

            let normal = paperPath.getNormalAt(offset);
            if (!normal || !Number.isFinite(normal.x) || !Number.isFinite(normal.y) || normal.length < 0.0001) {
                const tangent = paperPath.getTangentAt(offset);
                if (!tangent || !Number.isFinite(tangent.x) || !Number.isFinite(tangent.y) || tangent.length < 0.0001) {
                    continue;
                }
                normal = new scope.Point(-tangent.y, tangent.x);
            }
            normal = normal.normalize().multiply(halfWidth);

            const leftPoint = point.add(normal);
            const rightPoint = point.subtract(normal);
            const prevLeft = leftPoints[leftPoints.length - 1];
            if (!prevLeft || prevLeft.getDistance(leftPoint) > 0.02) {
                leftPoints.push(leftPoint);
                rightPoints.push(rightPoint);
            }
        }

        if (leftPoints.length < 2 || rightPoints.length < 2) return null;

        const buildCap = (center, fromPoint, toPoint, directionHint) => {
            const startAngle = Math.atan2(fromPoint.y - center.y, fromPoint.x - center.x);
            let endAngle = Math.atan2(toPoint.y - center.y, toPoint.x - center.x);
            let sweep = endAngle - startAngle;
            while (sweep <= -Math.PI) sweep += Math.PI * 2;
            while (sweep > Math.PI) sweep -= Math.PI * 2;
            if (directionHint > 0 && sweep < 0) sweep += Math.PI * 2;
            if (directionHint < 0 && sweep > 0) sweep -= Math.PI * 2;
            const steps = Math.max(6, Math.ceil(Math.abs(sweep) / (Math.PI / 10)));
            const capPoints = [];
            for (let i = 1; i < steps; i++) {
                const angle = startAngle + ((sweep * i) / steps);
                capPoints.push(new scope.Point(
                    center.x + (Math.cos(angle) * halfWidth),
                    center.y + (Math.sin(angle) * halfWidth)
                ));
            }
            return capPoints;
        };

        const startCenter = paperPath.getPointAt(0) || leftPoints[0].add(rightPoints[0]).divide(2);
        const endCenter = paperPath.getPointAt(length) || leftPoints[leftPoints.length - 1].add(rightPoints[rightPoints.length - 1]).divide(2);
        const endCap = buildCap(endCenter, leftPoints[leftPoints.length - 1], rightPoints[rightPoints.length - 1], 1);
        const startCap = buildCap(startCenter, rightPoints[0], leftPoints[0], 1);

        const outlinePoints = [
            ...leftPoints,
            ...endCap,
            ...rightPoints.slice().reverse(),
            ...startCap
        ];
        if (outlinePoints.length < 3) return null;

        const offsetPath = new scope.Path({ insert: true, closed: true });
        outlinePoints.forEach(point => offsetPath.add(point));
        if (offsetPath.segments.length < 3) {
            offsetPath.remove();
            return null;
        }

        try {
            offsetPath.simplify(Math.max(0.03, Math.min(0.25, halfWidth * 0.08)));
        } catch (_) {}
        try {
            offsetPath.smooth({ type: 'continuous' });
        } catch (_) {}

        if (Math.abs(offsetPath.area || 0) < 0.0001 || offsetPath.segments.length < 3) {
            offsetPath.remove();
            return null;
        }
        return offsetPath;
    }

    buildPaperOffsetItem(scope, item, offsetAmount) {
        if (!scope || !item) return null;
        if (item instanceof scope.CompoundPath) {
            const compound = new scope.CompoundPath({ insert: true });
            item.children.forEach(child => {
                const offsetChild = this.buildPaperOffsetItem(scope, child, offsetAmount);
                if (!offsetChild) return;
                if (offsetChild instanceof scope.CompoundPath) {
                    const adoptedChildren = Array.from(offsetChild.children);
                    adoptedChildren.forEach(grandChild => compound.addChild(grandChild));
                    offsetChild.remove();
                } else {
                    compound.addChild(offsetChild);
                }
            });
            if (!compound.children.length) {
                compound.remove();
                return null;
            }
            return compound;
        }
        if (!(item instanceof scope.Path)) return null;
        if (item.closed) {
            return this.buildPaperOffsetPath(scope, item, offsetAmount);
        }
        return this.buildPaperOpenOffsetPath(scope, item, offsetAmount);
    }

    applyPaperOffsetOperation(selectedEntries, offsetAmount, pen) {
        const scope = this.getPaperBooleanScope();
        if (!scope) return null;
        try {
            this.clearPaperBooleanScope(scope);
            const paperItems = selectedEntries.map(entry => this.convertAppPathToPaperItem(scope, entry.path));
            if (paperItems.some(item => !item)) {
                this.clearPaperBooleanScope(scope);
                return null;
            }

            let merged = paperItems[0];
            for (let i = 1; i < paperItems.length; i++) {
                const nextMerged = merged.unite(paperItems[i]);
                merged.remove();
                paperItems[i].remove();
                merged = nextMerged;
            }

            const offsetItem = this.buildPaperOffsetItem(scope, merged, offsetAmount);
            merged.remove();
            if (!offsetItem) {
                this.clearPaperBooleanScope(scope);
                return null;
            }

            const resultPaths = this.convertPaperItemToAppPaths(scope, offsetItem, { pen });
            offsetItem.remove();
            this.clearPaperBooleanScope(scope);
            return resultPaths.length ? resultPaths : null;
        } catch (error) {
            console.warn('Paper offset operation failed, falling back to sampled boolean offset.', error);
            this.clearPaperBooleanScope(scope);
            return null;
        }
    }

    applyRebuiltOffsetOperation(selectedEntries, offsetAmount, pen) {
        const scope = this.getPaperBooleanScope();
        if (!scope || Math.abs(offsetAmount || 0) < 0.0001) return null;
        try {
            this.clearPaperBooleanScope(scope);
            const paperItems = selectedEntries
                .map(entry => ({
                    entry,
                    item: this.convertAppPathToOffsetPaperItem(scope, entry.path)
                }))
                .filter(record => record.item);
            if (!paperItems.length) {
                this.clearPaperBooleanScope(scope);
                return null;
            }

            const closedItems = paperItems.filter(record => record.item.closed);
            const openItems = paperItems.filter(record => !record.item.closed);
            const resultPaths = [];

            if (closedItems.length) {
                let merged = closedItems[0].item;
                for (let i = 1; i < closedItems.length; i++) {
                    const nextMerged = merged.unite(closedItems[i].item);
                    merged.remove();
                    closedItems[i].item.remove();
                    merged = nextMerged;
                }
                const offsetItem = this.buildPaperOffsetItem(scope, merged, offsetAmount);
                merged.remove();
                if (offsetItem) {
                    resultPaths.push(...this.convertPaperItemToAppPaths(scope, offsetItem, { pen }));
                    offsetItem.remove();
                }
            }

            openItems.forEach(record => {
                const offsetItem = this.buildPaperOffsetItem(scope, record.item, offsetAmount);
                record.item.remove();
                if (!offsetItem) return;
                resultPaths.push(...this.convertPaperItemToAppPaths(scope, offsetItem, { pen }));
                offsetItem.remove();
            });

            this.clearPaperBooleanScope(scope);
            return resultPaths.length ? resultPaths : null;
        } catch (error) {
            console.warn('Rebuilt offset operation failed.', error);
            this.clearPaperBooleanScope(scope);
            return null;
        }
    }

    applyOffsetOperation(offsetAmount = 2) {
        void offsetAmount;
        this.app?.ui?.logToConsole('Offset Tool: Removed for now while the offset engine is rebuilt.', 'warning');
        return false;
    }

    applyClipperOffsetOperation(selectedEntries, offsetAmount, pen) {
        const clipper = this.getClipperScope();
        if (!clipper || Math.abs(offsetAmount || 0) < 0.0001) return null;
        try {
            const scale = 100000;
            const cleanDistance = Math.max(0.001, Math.min(0.02, Math.abs(offsetAmount) * 0.006)) * scale;
            const arcTolerance = Math.max(0.001, Math.min(0.015, Math.abs(offsetAmount) * 0.008)) * scale;
            const closedPaths = [];
            const openPaths = [];

            selectedEntries.forEach(entry => {
                const clipperPath = this.convertAppPathToClipperPath(entry.path, scale);
                if (!clipperPath || clipperPath.length < 2) return;
                if (this.shouldTreatPathAsClosedForOffset(entry.path)) {
                    closedPaths.push(clipperPath);
                } else {
                    openPaths.push(clipperPath);
                }
            });

            if (!closedPaths.length && !openPaths.length) return null;

            const executeOffset = (useSimplifyClosed) => {
                const co = new clipper.ClipperOffset(2, arcTolerance);

                if (closedPaths.length) {
                    let preparedClosed = clipper.Clipper.CleanPolygons(closedPaths, cleanDistance);
                    if (useSimplifyClosed) {
                        preparedClosed = clipper.Clipper.SimplifyPolygons(preparedClosed, clipper.PolyFillType.pftNonZero);
                    }
                    if (preparedClosed.length) {
                        co.AddPaths(preparedClosed, clipper.JoinType.jtRound, clipper.EndType.etClosedPolygon);
                    }
                }

                if (openPaths.length && offsetAmount > 0) {
                    const preparedOpen = openPaths
                        .map(path => clipper.Clipper.CleanPolygon(path, cleanDistance))
                        .filter(path => Array.isArray(path) && path.length >= 2);
                    if (preparedOpen.length) {
                        co.AddPaths(preparedOpen, clipper.JoinType.jtRound, clipper.EndType.etOpenRound);
                    }
                }

                const solution = new clipper.Paths();
                co.Execute(solution, offsetAmount * scale);
                return solution;
            };

            let solution = executeOffset(false);
            if (!solution.length && closedPaths.length) {
                solution = executeOffset(true);
            }
            const resultPaths = this.buildAppPathsFromClipperPaths(solution, pen, scale);
            return resultPaths.length ? resultPaths : null;
        } catch (error) {
            console.warn('Clipper offset operation failed, falling back to Paper/mask offset.', error);
            return null;
        }
    }

    getBooleanKernelOffsets(radiusCells) {
        const offsets = [];
        const radius = Math.max(0, radiusCells | 0);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (Math.hypot(dx, dy) <= radius + 0.001) {
                    offsets.push([dx, dy]);
                }
            }
        }
        return offsets.length ? offsets : [[0, 0]];
    }

    buildBooleanOffsetMask(selectedEntries, offsetAmount) {
        const boxes = selectedEntries.map(entry => this.getBoundingBox(entry.path)).filter(Boolean);
        if (!boxes.length) return null;

        const box = boxes.reduce((acc, current) => ({
            minX: Math.min(acc.minX, current.minX),
            minY: Math.min(acc.minY, current.minY),
            maxX: Math.max(acc.maxX, current.maxX),
            maxY: Math.max(acc.maxY, current.maxY)
        }));
        const width = Math.max(1, box.maxX - box.minX);
        const height = Math.max(1, box.maxY - box.minY);
        const absOffset = Math.abs(offsetAmount || 0);
        const cellSize = Math.max(0.05, Math.min(0.25, absOffset > 0.001 ? absOffset / 4 : Math.sqrt((width * height) / 220000)));
        const padding = Math.max(cellSize * 3, absOffset + (cellSize * 3));
        const originX = box.minX - padding;
        const originY = box.minY - padding;
        const cols = Math.max(1, Math.ceil((width + (padding * 2)) / cellSize));
        const rows = Math.max(1, Math.ceil((height + (padding * 2)) / cellSize));
        const cells = new Set();

        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const sampleX = originX + ((cx + 0.5) * cellSize);
                const sampleY = originY + ((cy + 0.5) * cellSize);
                const keep = selectedEntries.some(entry => this.isPointInsidePathRegionSet(sampleX, sampleY, entry.path));
                if (keep) cells.add(`${cx},${cy}`);
            }
        }

        if (!cells.size) return null;
        if (absOffset < 0.001) {
            return { originX, originY, cellSize, cols, rows, cells };
        }

        const kernelOffsets = this.getBooleanKernelOffsets(Math.max(1, Math.round(absOffset / cellSize)));
        let adjustedCells = new Set();

        if (offsetAmount >= 0) {
            cells.forEach(key => {
                const [cxRaw, cyRaw] = key.split(',');
                const cx = parseInt(cxRaw, 10);
                const cy = parseInt(cyRaw, 10);
                kernelOffsets.forEach(([dx, dy]) => {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) return;
                    adjustedCells.add(`${nx},${ny}`);
                });
            });
        } else {
            cells.forEach(key => {
                const [cxRaw, cyRaw] = key.split(',');
                const cx = parseInt(cxRaw, 10);
                const cy = parseInt(cyRaw, 10);
                const keep = kernelOffsets.every(([dx, dy]) => {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    return nx >= 0 && ny >= 0 && nx < cols && ny < rows && cells.has(`${nx},${ny}`);
                });
                if (keep) adjustedCells.add(key);
            });
        }

        if (!adjustedCells.size) return null;
        return { originX, originY, cellSize, cols, rows, cells: adjustedCells };
    }

    finalizeBooleanResult(resultPaths, sourceSelection, operation, { keepOriginal = false } = {}) {
        const selectedSet = new Set(sourceSelection);
        if (!keepOriginal) {
            this.paths = this.paths.filter((_, index) => !selectedSet.has(index));
        }
        const groupId = resultPaths.length > 1 ? `group_${Date.now()}_${Math.floor(Math.random() * 1000)}` : null;
        resultPaths.forEach(path => {
            if (groupId) path.groupId = groupId;
            this.paths.push(path);
        });
        this.invalidateFillRegionCache();
        this.selectedPaths = resultPaths.map((_, index) => this.paths.length - resultPaths.length + index);
        this.selectedNodes = [];
        this.saveUndoState();
        this.draw();

        const labels = {
            union: 'Merge',
            intersect: 'Intersect',
            subtract: 'Subtract',
            exclude: 'Exclude',
            offset: 'Offset'
        };
        const verb = keepOriginal ? 'added' : 'created';
        this.app?.ui?.logToConsole(`System: ${labels[operation] || 'Boolean'} operation ${verb} ${resultPaths.length} result shape${resultPaths.length === 1 ? '' : 's'}.`);
        return true;
    }

    applyBooleanOperation(operation, offsetAmount = 2) {
        const validOps = new Set(['union', 'intersect', 'subtract', 'exclude']);
        if (!validOps.has(operation)) return false;
        if (!Array.isArray(this.selectedPaths) || this.selectedPaths.length < 2) {
            this.app?.ui?.logToConsole(
                'Boolean Tool: Select at least two closed shapes first.',
                'error'
            );
            return false;
        }

        const selectedEntries = this.selectedPaths
            .map(idx => ({ idx, path: this.paths[idx] }))
            .filter(entry => entry.path);
        const unsupportedText = selectedEntries.some(entry => entry.path.type === 'text');
        if (unsupportedText) {
            this.app?.ui?.logToConsole('Boolean Tool: Text objects need to be converted to outlines first.', 'error');
            return false;
        }

        const unsupportedOpen = operation !== 'offset' && selectedEntries.some(entry => !this.isPathClosed(entry.path));
        if (unsupportedOpen) {
            this.app?.ui?.logToConsole('Boolean Tool: Only closed shapes can be used for boolean operations.', 'error');
            return false;
        }

        const sortedByStack = [...selectedEntries].sort((left, right) => left.idx - right.idx);
        const topEntry = sortedByStack[sortedByStack.length - 1];
        const pen = topEntry?.path?.pen || selectedEntries[0]?.path?.pen || this.app?.ui?.activeVisualizerPen || 1;
        let resultPaths = this.applyPaperBooleanOperation(operation, sortedByStack, pen);

        if (!resultPaths || !resultPaths.length) {
            const boxes = selectedEntries.map(entry => this.getBoundingBox(entry.path)).filter(Boolean);
            if (!boxes.length) return false;
            const box = boxes.reduce((acc, current) => ({
                minX: Math.min(acc.minX, current.minX),
                minY: Math.min(acc.minY, current.minY),
                maxX: Math.max(acc.maxX, current.maxX),
                maxY: Math.max(acc.maxY, current.maxY)
            }));
            const width = Math.max(1, box.maxX - box.minX);
            const height = Math.max(1, box.maxY - box.minY);
            const area = Math.max(1, width * height);
            const targetCells = 240000;
            const cellSize = Math.max(0.06, Math.min(0.22, Math.sqrt(area / targetCells)));
            const padding = cellSize * 2;
            const originX = box.minX - padding;
            const originY = box.minY - padding;
            const cols = Math.max(1, Math.ceil((width + (padding * 2)) / cellSize));
            const rows = Math.max(1, Math.ceil((height + (padding * 2)) / cellSize));
            const smoothSampleBudget = 180000;
            const enableSmoothContours = ((cols + 1) * (rows + 1)) <= smoothSampleBudget && selectedEntries.length <= 3;
            const samples = enableSmoothContours ? new Array((cols + 1) * (rows + 1)).fill(false) : null;
            const cells = new Set();
            let hasInside = false;
            const baseEntries = sortedByStack.slice(0, -1);

            const computeKeep = (sampleX, sampleY) => {
                const insideMap = selectedEntries.map(entry => this.isPointInsidePathRegionSet(sampleX, sampleY, entry.path));
                if (operation === 'union') {
                    return insideMap.some(Boolean);
                }
                if (operation === 'intersect') {
                    return insideMap.every(Boolean);
                }
                if (operation === 'subtract') {
                    const baseInside = baseEntries.some(entry => this.isPointInsidePathRegionSet(sampleX, sampleY, entry.path));
                    const topInside = topEntry ? this.isPointInsidePathRegionSet(sampleX, sampleY, topEntry.path) : false;
                    return baseInside && !topInside;
                }
                if (operation === 'exclude') {
                    return insideMap.filter(Boolean).length % 2 === 1;
                }
                return false;
            };

            if (samples) {
                for (let gy = 0; gy <= rows; gy++) {
                    for (let gx = 0; gx <= cols; gx++) {
                        const sampleX = originX + (gx * cellSize);
                        const sampleY = originY + (gy * cellSize);
                        const keep = computeKeep(sampleX, sampleY);
                        samples[(gy * (cols + 1)) + gx] = keep;
                        if (keep) hasInside = true;
                    }
                }
            }

            for (let cy = 0; cy < rows; cy++) {
                for (let cx = 0; cx < cols; cx++) {
                    const sampleX = originX + ((cx + 0.5) * cellSize);
                    const sampleY = originY + ((cy + 0.5) * cellSize);
                    if (computeKeep(sampleX, sampleY)) {
                        cells.add(`${cx},${cy}`);
                        hasInside = true;
                    }
                }
            }

            if (!hasInside) {
                this.app?.ui?.logToConsole('Boolean Tool: The operation produced no visible result.', 'error');
                return false;
            }

            resultPaths = this.buildBooleanResultPathsFromMask({ originX, originY, cellSize, cols, rows, samples, cells }, pen);
            if (!resultPaths.length) {
                this.app?.ui?.logToConsole('Boolean Tool: Unable to trace the resulting shape.', 'error');
                return false;
            }
        }
        return this.finalizeBooleanResult(resultPaths, this.selectedPaths, operation);
    }

    getRegionArea(region) {
        if (!region) return Infinity;
        if (region.fillCells instanceof Set && Number.isFinite(region.cellSize) && region.cellSize > 0) {
            return region.fillCells.size * region.cellSize * region.cellSize;
        }
        if (Array.isArray(region.polygon) && region.polygon.length >= 3) {
            const polygonArea = this.getPolygonArea(region.polygon);
            if (polygonArea > 0) return polygonArea;
        }
        if (region.box) {
            return Math.max(0, (region.box.maxX - region.box.minX) * (region.box.maxY - region.box.minY));
        }
        return Infinity;
    }

    getRegionPerimeter(region) {
        if (!region) return Infinity;
        if (Array.isArray(region.polygon) && region.polygon.length >= 2) {
            let perimeter = 0;
            for (let i = 0; i < region.polygon.length; i++) {
                const current = region.polygon[i];
                const next = region.polygon[(i + 1) % region.polygon.length];
                if (!Number.isFinite(current?.x) || !Number.isFinite(current?.y) || !Number.isFinite(next?.x) || !Number.isFinite(next?.y)) continue;
                perimeter += Math.hypot(next.x - current.x, next.y - current.y);
            }
            if (perimeter > 0) return perimeter;
        }
        if (region.box) {
            const width = Math.max(0, region.box.maxX - region.box.minX);
            const height = Math.max(0, region.box.maxY - region.box.minY);
            return (width + height) * 2;
        }
        return Infinity;
    }

    getFillRegionRenderMetrics(region) {
        if (!region?.box) {
            return { areaPx: 0, estimatedThicknessPx: 0 };
        }
        const pxPerMM = Math.max(0.0001, (this.scale || 1) * Math.max(1, this.viewZoom || 1));
        const areaPx = this.getRegionArea(region) * pxPerMM * pxPerMM;
        const perimeterPx = this.getRegionPerimeter(region) * pxPerMM;
        const estimatedThicknessPx = perimeterPx > 0 ? areaPx / perimeterPx : 0;
        return { areaPx, estimatedThicknessPx };
    }

    isExactFillRegion(region) {
        return !!region
            && Array.isArray(region.polygon)
            && region.polygon.length >= 3
            && !(region.fillCells instanceof Set);
    }

    exactRegionHasNestedChildren(region, allRegions = []) {
        if (!this.isExactFillRegion(region) || Array.isArray(region?.holePolygons) && region.holePolygons.length > 0) {
            return false;
        }
        const regionId = region.regionId || `${region.pathIdx}`;
        const regionArea = this.getRegionArea(region);
        return allRegions.some(candidate => {
            if (!this.isExactFillRegion(candidate)) return false;
            const candidateId = candidate.regionId || `${candidate.pathIdx}`;
            if (candidateId === regionId) return false;
            const candidateArea = this.getRegionArea(candidate);
            if (!Number.isFinite(candidateArea) || candidateArea <= 0 || candidateArea >= regionArea) return false;
            const samplePoint = this.getPolygonInteriorPoint(candidate.polygon);
            return !!samplePoint && region.contains(samplePoint.x, samplePoint.y);
        });
    }

    buildNestedExactFillRegion(region, allRegions = []) {
        if (!this.isExactFillRegion(region)) return null;
        const regionId = region.regionId || `${region.pathIdx}`;
        const regionArea = this.getRegionArea(region);
        const candidateChildren = allRegions
            .filter(candidate => {
                if (!this.isExactFillRegion(candidate)) return false;
                const candidateId = candidate.regionId || `${candidate.pathIdx}`;
                if (candidateId === regionId) return false;
                const candidateArea = this.getRegionArea(candidate);
                if (!Number.isFinite(candidateArea) || candidateArea <= 0 || candidateArea >= regionArea) return false;
                if (!candidate.box || !region.box) return false;
                if (candidate.box.minX < region.box.minX || candidate.box.maxX > region.box.maxX) return false;
                if (candidate.box.minY < region.box.minY || candidate.box.maxY > region.box.maxY) return false;
                const samplePoint = this.getPolygonInteriorPoint(candidate.polygon);
                return !!samplePoint && region.contains(samplePoint.x, samplePoint.y);
            })
            .map(candidate => ({
                region: candidate,
                area: this.getRegionArea(candidate),
                samplePoint: this.getPolygonInteriorPoint(candidate.polygon)
            }))
            .filter(candidate => candidate.samplePoint);

        if (!candidateChildren.length) return null;

        const immediateChildren = candidateChildren.filter(candidate => {
            return !candidateChildren.some(other => {
                if (other.region === candidate.region) return false;
                if (other.area <= candidate.area || other.area >= regionArea) return false;
                return other.region.contains(candidate.samplePoint.x, candidate.samplePoint.y);
            });
        });

        if (!immediateChildren.length) return null;

        return {
            regionId: `${regionId}:nested`,
            box: { ...region.box },
            polygon: region.polygon.map(point => ({ ...point })),
            holePolygons: immediateChildren.map(child => child.region.polygon.map(point => ({ ...point }))),
            pathIdx: region.pathIdx,
            path: region.path,
            primaryPathIdx: region.pathIdx,
            contains: (x, y) => {
                if (!region.contains(x, y)) return false;
                return !immediateChildren.some(child => child.region.contains(x, y));
            }
        };
    }

    cloneExactFillRegion(region) {
        if (!this.isExactFillRegion(region)) return null;
        const holePolygons = Array.isArray(region.holePolygons)
            ? region.holePolygons
                .filter(polygon => Array.isArray(polygon) && polygon.length >= 3)
                .map(polygon => polygon.map(point => ({ x: point.x, y: point.y })))
            : [];
        const polygon = region.polygon.map(point => ({ x: point.x, y: point.y }));
        return {
            regionId: region.regionId,
            box: region.box ? { ...region.box } : this.getPolygonBox(polygon),
            polygon,
            holePolygons,
            pathIdx: region.pathIdx,
            path: region.path,
            primaryPathIdx: Number.isInteger(region.primaryPathIdx) ? region.primaryPathIdx : region.pathIdx,
            contains: (x, y) => {
                if (!this.pointInPolygon(x, y, polygon)) return false;
                return !holePolygons.some(hole => this.pointInPolygon(x, y, hole));
            }
        };
    }

    getExactFaceRegionAt(x, y, allRegions = []) {
        const exactContainingRegions = allRegions
            .filter(region => this.isExactFillRegion(region) && region.contains(x, y))
            .sort((a, b) => this.getRegionArea(a) - this.getRegionArea(b));
        if (!exactContainingRegions.length) return null;

        const directExactRegion = exactContainingRegions[0];
        const nestedExactRegion = this.buildNestedExactFillRegion(directExactRegion, allRegions);
        return nestedExactRegion || this.cloneExactFillRegion(directExactRegion) || directExactRegion;
    }

    isFillRegionUsable(region, options = {}) {
        if (!region?.box) return false;
        const { areaPx, estimatedThicknessPx } = this.getFillRegionRenderMetrics(region);
        const minAreaPx = Number.isFinite(options?.minAreaPx) ? options.minAreaPx : 90;
        const minThicknessPx = Number.isFinite(options?.minThicknessPx) ? options.minThicknessPx : 5;
        return areaPx >= minAreaPx && estimatedThicknessPx >= minThicknessPx;
    }

    getFillSignatureAt(x, y, regions) {
        return regions
            .filter(region => region.contains(x, y))
            .map(region => region.regionId || `${region.pathIdx}`)
            .sort((a, b) => String(a).localeCompare(String(b)));
    }

    getFillSignatureKey(signature) {
        return Array.isArray(signature) ? signature.join('|') : '';
    }

    getCompositeFillRegionAt(x, y, regions = null, options = {}) {
        const resolvedRegions = Array.isArray(regions) ? regions : this.getClosedFillRegions();
        if (!resolvedRegions.length) return null;

        const signature = this.getFillSignatureAt(x, y, resolvedRegions);
        if (!signature.length) return null;

        const anchorRegion = options?.anchorRegion || null;
        const anchorArea = this.getRegionArea(anchorRegion);
        const signatureRegions = resolvedRegions.filter(region => signature.includes(region.regionId || `${region.pathIdx}`));
        const relevantSignature = signature.filter(regionId => {
            const region = signatureRegions.find(candidate => (candidate.regionId || `${candidate.pathIdx}`) === regionId);
            if (!region) return false;
            if (anchorRegion && (region.regionId || `${region.pathIdx}`) === (anchorRegion.regionId || `${anchorRegion.pathIdx}`)) return true;
            if (Array.isArray(region.holePolygons) && region.holePolygons.length > 0) return true;
            if (region.isEmbeddedLoop) return true;
            const regionArea = this.getRegionArea(region);
            if (!Number.isFinite(anchorArea) || anchorArea <= 0) return true;
            return regionArea >= Math.max(0.6, anchorArea * 0.12);
        });
        const effectiveSignature = relevantSignature.length ? relevantSignature : signature;
        const targetKey = this.getFillSignatureKey(effectiveSignature);
        const matchesEffectiveSignature = (sampleX, sampleY) => {
            if (anchorRegion && !anchorRegion.contains(sampleX, sampleY)) return false;
            const sampleSignature = this.getFillSignatureAt(sampleX, sampleY, resolvedRegions);
            if (!sampleSignature.length) return false;
            const filteredSampleSignature = sampleSignature.filter(regionId => effectiveSignature.includes(regionId));
            return this.getFillSignatureKey(filteredSampleSignature) === targetKey;
        };
        const intersectionBox = signatureRegions.reduce((box, region) => {
            if (!box) return { ...region.box };
            return {
                minX: Math.max(box.minX, region.box.minX),
                minY: Math.max(box.minY, region.box.minY),
                maxX: Math.min(box.maxX, region.box.maxX),
                maxY: Math.min(box.maxY, region.box.maxY)
            };
        }, null);

        const box = intersectionBox && intersectionBox.minX <= intersectionBox.maxX && intersectionBox.minY <= intersectionBox.maxY
            ? intersectionBox
            : { ...signatureRegions[0].box };

        const spacing = this.app?.ui?.fillBucketSettings?.spacing || 6;
        const pxPerMM = Math.max(0.0001, (this.scale || 1) * Math.max(1, this.viewZoom || 1));
        const regionWidth = Math.max(0.1, box.maxX - box.minX);
        const regionHeight = Math.max(0.1, box.maxY - box.minY);
        const smallestDimension = Math.max(0.1, Math.min(regionWidth, regionHeight));
        const estimatedThicknessMM = Math.max(
            0.05,
            this.getRegionArea(anchorRegion || signatureRegions[0]) / Math.max(0.01, this.getRegionPerimeter(anchorRegion || signatureRegions[0]))
        );
        const prefersFineGrid = smallestDimension < 12 || estimatedThicknessMM < 3.5;
        const cellSize = Math.max(
            0.01,
            Math.min(
                prefersFineGrid ? 0.16 : 0.3,
                (prefersFineGrid ? 3 : 5) / pxPerMM,
                Math.max(prefersFineGrid ? 0.025 : 0.07, spacing / (prefersFineGrid ? 18 : 7)),
                smallestDimension / (prefersFineGrid ? 96 : 32)
            )
        );
        const cols = Math.max(1, Math.ceil((box.maxX - box.minX) / cellSize));
        const rows = Math.max(1, Math.ceil((box.maxY - box.minY) / cellSize));
        const targetCells = new Set();
        const visited = new Set();
        const queue = [];
        const toCellCoord = (px, py) => ({
            cx: Math.max(0, Math.min(cols - 1, Math.floor((px - box.minX) / cellSize))),
            cy: Math.max(0, Math.min(rows - 1, Math.floor((py - box.minY) / cellSize)))
        });
        const toKey = (cx, cy) => `${cx},${cy}`;
        const inBounds = (cx, cy) => cx >= 0 && cy >= 0 && cx < cols && cy < rows;
        const cellCenter = (cx, cy) => ({
            x: box.minX + ((cx + 0.5) * cellSize),
            y: box.minY + ((cy + 0.5) * cellSize)
        });
        const cellSampleOffsets = prefersFineGrid
            ? [
                { ox: 0.5, oy: 0.5 },
                { ox: 0.15, oy: 0.5 },
                { ox: 0.85, oy: 0.5 },
                { ox: 0.2, oy: 0.5 },
                { ox: 0.8, oy: 0.5 },
                { ox: 0.5, oy: 0.2 },
                { ox: 0.5, oy: 0.8 },
                { ox: 0.5, oy: 0.15 },
                { ox: 0.5, oy: 0.85 },
                { ox: 0.2, oy: 0.2 },
                { ox: 0.8, oy: 0.2 },
                { ox: 0.2, oy: 0.8 },
                { ox: 0.8, oy: 0.8 }
            ]
            : [
                { ox: 0.5, oy: 0.5 },
                { ox: 0.25, oy: 0.5 },
                { ox: 0.75, oy: 0.5 },
                { ox: 0.5, oy: 0.25 },
                { ox: 0.5, oy: 0.75 }
            ];
        const targetThreshold = prefersFineGrid ? 1 : 1;
        const matchesTarget = (cx, cy) => {
            let matches = 0;
            for (const offset of cellSampleOffsets) {
                const sample = {
                    x: box.minX + ((cx + offset.ox) * cellSize),
                    y: box.minY + ((cy + offset.oy) * cellSize)
                };
                if (matchesEffectiveSignature(sample.x, sample.y)) {
                    matches++;
                    if (matches >= targetThreshold) return true;
                }
            }
            return false;
        };

        const startCell = toCellCoord(x, y);
        if (!matchesTarget(startCell.cx, startCell.cy)) return null;
        queue.push(startCell);

        while (queue.length > 0) {
            const { cx, cy } = queue.shift();
            const key = toKey(cx, cy);
            if (visited.has(key)) continue;
            visited.add(key);
            if (!matchesTarget(cx, cy)) continue;

            targetCells.add(key);

            [
                { cx: cx + 1, cy },
                { cx: cx - 1, cy },
                { cx, cy: cy + 1 },
                { cx, cy: cy - 1 },
                { cx: cx + 1, cy: cy + 1 },
                { cx: cx + 1, cy: cy - 1 },
                { cx: cx - 1, cy: cy + 1 },
                { cx: cx - 1, cy: cy - 1 }
            ].forEach(next => {
                if (!inBounds(next.cx, next.cy)) return;
                const nextKey = toKey(next.cx, next.cy);
                if (!visited.has(nextKey)) queue.push(next);
            });
        }

        if (!targetCells.size) return null;

        let minCellX = cols - 1;
        let maxCellX = 0;
        let minCellY = rows - 1;
        let maxCellY = 0;
        targetCells.forEach(key => {
            const [cxRaw, cyRaw] = key.split(',');
            const cx = parseInt(cxRaw, 10);
            const cy = parseInt(cyRaw, 10);
            if (cx < minCellX) minCellX = cx;
            if (cx > maxCellX) maxCellX = cx;
            if (cy < minCellY) minCellY = cy;
            if (cy > maxCellY) maxCellY = cy;
        });

        return {
            box: {
                minX: box.minX + (minCellX * cellSize),
                minY: box.minY + (minCellY * cellSize),
                maxX: box.minX + ((maxCellX + 1) * cellSize),
                maxY: box.minY + ((maxCellY + 1) * cellSize)
            },
            gridOriginX: box.minX,
            gridOriginY: box.minY,
            signature: effectiveSignature,
            signatureKey: targetKey,
            primaryPathIdx: signatureRegions[signatureRegions.length - 1]?.pathIdx,
            cellSize,
            fillCells: targetCells,
            contains: (px, py) => {
                if (px < box.minX || px > box.maxX || py < box.minY || py > box.maxY) return false;
                const { cx, cy } = toCellCoord(px, py);
                return targetCells.has(toKey(cx, cy));
            }
        };
    }

    getFillTargetAt(xMM, yMM, options = {}) {
        const allRegions = this.getClosedFillRegions();
        const containingRegions = allRegions.filter(region => region.contains(xMM, yMM));
        if (!containingRegions.length) return null;

        containingRegions.sort((a, b) => {
            if (!!a.isEmbeddedLoop !== !!b.isEmbeddedLoop) return a.isEmbeddedLoop ? -1 : 1;
            return this.getRegionArea(a) - this.getRegionArea(b);
        });

        const directRegion = containingRegions[0];
        const previewOnly = options?.previewOnly === true;
        const exactFaceRegion = this.getExactFaceRegionAt(xMM, yMM, allRegions);
        const usabilityOptions = previewOnly
            ? { minAreaPx: 24, minThicknessPx: 1.4 }
            : { minAreaPx: 24, minThicknessPx: 1.4 };

        if (exactFaceRegion) {
            const exactPathIdx = Number.isInteger(exactFaceRegion.primaryPathIdx)
                ? exactFaceRegion.primaryPathIdx
                : exactFaceRegion?.pathIdx ?? -1;
            return {
                pathIdx: exactPathIdx,
                path: exactPathIdx > -1 ? this.paths[exactPathIdx] : null,
                region: exactFaceRegion
            };
        }

        const directRegionIsExactCompound = Array.isArray(directRegion?.holePolygons) && directRegion.holePolygons.length > 0;
        const shouldTryComposite = !previewOnly && !directRegionIsExactCompound;
        const compositeRegion = shouldTryComposite
            ? this.getCompositeFillRegionAt(xMM, yMM, allRegions, { anchorRegion: directRegion })
            : null;
        const directUsable = this.isFillRegionUsable(directRegion, usabilityOptions);
        const compositeUsable = this.isFillRegionUsable(compositeRegion, usabilityOptions);
        const directArea = this.getRegionArea(directRegion);
        const compositeArea = this.getRegionArea(compositeRegion);
        const shouldPreferDirect = directUsable && (!compositeUsable || directArea <= (compositeArea * 1.35));
        const preferredRegion = shouldPreferDirect
            ? directRegion
            : (compositeUsable ? compositeRegion : directRegion);
        const region = preferredRegion;
        if (!region || !this.isFillRegionUsable(region, usabilityOptions)) return null;
        const pathIdx = Number.isInteger(region.primaryPathIdx) ? region.primaryPathIdx : directRegion?.pathIdx;
        return {
            pathIdx,
            path: pathIdx > -1 ? this.paths[pathIdx] : null,
            region
        };
    }

    drawBucketHoverPreview() {
        if (!this.bucketHoverRegion) return;
        const dpr = window.devicePixelRatio || 1;
        const screenScale = this.scale * this.viewZoom;
        this.ctx.save();
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.fillStyle = 'rgba(96, 165, 250, 0.18)';
        this.ctx.strokeStyle = 'rgba(96, 165, 250, 0.65)';
        this.ctx.lineWidth = 1.5;

        if (Array.isArray(this.bucketHoverRegion?.polygon) && this.bucketHoverRegion.polygon.length >= 3) {
            this.ctx.beginPath();
            const start = this.mmToCanvasPx(this.bucketHoverRegion.polygon[0].x, this.bucketHoverRegion.polygon[0].y);
            this.ctx.moveTo(start.x, start.y);
            for (let i = 1; i < this.bucketHoverRegion.polygon.length; i++) {
                const point = this.bucketHoverRegion.polygon[i];
                const screenPoint = this.mmToCanvasPx(point.x, point.y);
                this.ctx.lineTo(screenPoint.x, screenPoint.y);
            }
            this.ctx.closePath();
            if (Array.isArray(this.bucketHoverRegion.holePolygons)) {
                this.bucketHoverRegion.holePolygons.forEach(holePolygon => {
                    if (!Array.isArray(holePolygon) || holePolygon.length < 3) return;
                    const holeStart = this.mmToCanvasPx(holePolygon[0].x, holePolygon[0].y);
                    this.ctx.moveTo(holeStart.x, holeStart.y);
                    for (let i = 1; i < holePolygon.length; i++) {
                        const point = holePolygon[i];
                        const holePoint = this.mmToCanvasPx(point.x, point.y);
                        this.ctx.lineTo(holePoint.x, holePoint.y);
                    }
                    this.ctx.closePath();
                });
            }
            this.ctx.fill('evenodd');
            this.ctx.stroke();
        } else if (this.bucketHoverRegion?.fillCells && this.bucketHoverRegion?.cellSize) {
            const cellSize = this.bucketHoverRegion.cellSize;
            this.bucketHoverRegion.fillCells.forEach(key => {
                const [cxRaw, cyRaw] = key.split(',');
                const cx = parseInt(cxRaw, 10);
                const cy = parseInt(cyRaw, 10);
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
                const x = this.bucketHoverRegion.gridOriginX + (cx * cellSize);
                const y = this.bucketHoverRegion.gridOriginY + (cy * cellSize);
                const screenPoint = this.mmToCanvasPx(x, y);
                const screenCellSize = Math.max(0.5, cellSize * screenScale);
                this.ctx.fillRect(screenPoint.x, screenPoint.y, screenCellSize, screenCellSize);
            });
        } else if (this.bucketHoverRegion?.box) {
            const screenPoint = this.mmToCanvasPx(this.bucketHoverRegion.box.minX, this.bucketHoverRegion.box.minY);
            this.ctx.fillRect(
                screenPoint.x,
                screenPoint.y,
                Math.max(0.5, (this.bucketHoverRegion.box.maxX - this.bucketHoverRegion.box.minX) * screenScale),
                Math.max(0.5, (this.bucketHoverRegion.box.maxY - this.bucketHoverRegion.box.minY) * screenScale)
            );
        }
        this.ctx.restore();
    }

    buildRegionCoverageMask(region, preferredCellSize = 1) {
        if (!region?.box) return null;

        const desiredCellSize = Math.max(0.18, preferredCellSize || 1);
        if (region.fillCells instanceof Set && Number.isFinite(region.cellSize) && region.cellSize > 0 && region.cellSize <= desiredCellSize * 1.2) {
            return {
                originX: region.gridOriginX ?? region.box.minX,
                originY: region.gridOriginY ?? region.box.minY,
                cellSize: region.cellSize,
                cols: Math.max(1, Math.ceil((region.box.maxX - region.box.minX) / region.cellSize)),
                rows: Math.max(1, Math.ceil((region.box.maxY - region.box.minY) / region.cellSize)),
                cells: new Set(region.fillCells)
            };
        }

        const cellSize = Math.max(0.18, Math.min(desiredCellSize, 1.1));
        const originX = region.box.minX;
        const originY = region.box.minY;
        const cols = Math.max(1, Math.ceil((region.box.maxX - region.box.minX) / cellSize));
        const rows = Math.max(1, Math.ceil((region.box.maxY - region.box.minY) / cellSize));
        const cells = new Set();

        for (let cy = 0; cy < rows; cy++) {
            for (let cx = 0; cx < cols; cx++) {
                const samples = [
                    { x: originX + ((cx + 0.5) * cellSize), y: originY + ((cy + 0.5) * cellSize) },
                    { x: originX + ((cx + 0.25) * cellSize), y: originY + ((cy + 0.5) * cellSize) },
                    { x: originX + ((cx + 0.75) * cellSize), y: originY + ((cy + 0.5) * cellSize) },
                    { x: originX + ((cx + 0.5) * cellSize), y: originY + ((cy + 0.25) * cellSize) },
                    { x: originX + ((cx + 0.5) * cellSize), y: originY + ((cy + 0.75) * cellSize) }
                ];
                if (samples.some(sample => region.contains(sample.x, sample.y))) {
                    cells.add(`${cx},${cy}`);
                }
            }
        }

        return { originX, originY, cellSize, cols, rows, cells };
    }

    getCoverageMaskComponents(mask) {
        if (!mask?.cells || !(mask.cells instanceof Set) || !mask.cells.size) return [];
        const visited = new Set();
        const components = [];
        const neighborOffsets = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [1, -1], [-1, 1], [-1, -1]
        ];

        mask.cells.forEach(startKey => {
            if (visited.has(startKey)) return;
            const queue = [startKey];
            const keys = new Set();
            let minCX = Infinity;
            let minCY = Infinity;
            let maxCX = -Infinity;
            let maxCY = -Infinity;
            visited.add(startKey);

            while (queue.length) {
                const key = queue.shift();
                keys.add(key);
                const [cxRaw, cyRaw] = key.split(',');
                const cx = parseInt(cxRaw, 10);
                const cy = parseInt(cyRaw, 10);
                if (cx < minCX) minCX = cx;
                if (cy < minCY) minCY = cy;
                if (cx > maxCX) maxCX = cx;
                if (cy > maxCY) maxCY = cy;

                neighborOffsets.forEach(([dx, dy]) => {
                    const nextKey = `${cx + dx},${cy + dy}`;
                    if (!mask.cells.has(nextKey) || visited.has(nextKey)) return;
                    visited.add(nextKey);
                    queue.push(nextKey);
                });
            }

            components.push({ keys, minCX, minCY, maxCX, maxCY });
        });

        return components;
    }

    ensureLineCoverageRuns(region, runs, options = {}) {
        if (!region?.box || !Array.isArray(runs) || runs.length === 0) return runs;

        const spacing = Math.max(0.8, options.spacing || 6);
        const angleDeg = Number.isFinite(options.angle) ? options.angle : 0;
        const pen = options.pen || 1;
        const patternName = options.patternName || 'lines';
        const mask = this.buildRegionCoverageMask(region, Math.max(0.22, Math.min(1.0, spacing / 3)));
        if (!mask?.cells?.size) return runs;

        const getCellKeyForPoint = (point) => {
            if (!point) return null;
            const cx = Math.floor((point.x - mask.originX) / mask.cellSize);
            const cy = Math.floor((point.y - mask.originY) / mask.cellSize);
            if (cx < 0 || cy < 0 || cx >= mask.cols || cy >= mask.rows) return null;
            const key = `${cx},${cy}`;
            return mask.cells.has(key) ? key : null;
        };

        const coveredCells = new Set();
        runs.forEach(run => {
            const points = Array.isArray(run?.points) ? run.points : run;
            this.densifyPolyline(points, Math.max(0.18, mask.cellSize * 0.65)).forEach(point => {
                const key = getCellKeyForPoint(point);
                if (key) coveredCells.add(key);
            });
        });

        const angle = angleDeg * Math.PI / 180;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        const augmentedRuns = runs.slice();

        this.getCoverageMaskComponents(mask).forEach(component => {
            if (Array.from(component.keys).some(key => coveredCells.has(key))) return;

            const centerX = mask.originX + (((component.minCX + component.maxCX + 1) * 0.5) * mask.cellSize);
            const centerY = mask.originY + (((component.minCY + component.maxCY + 1) * 0.5) * mask.cellSize);
            const width = (component.maxCX - component.minCX + 1) * mask.cellSize;
            const height = (component.maxCY - component.minCY + 1) * mask.cellSize;
            const length = Math.max(spacing * 0.8, Math.hypot(width, height) + (mask.cellSize * 2));
            const start = { x: centerX - (dx * length), y: centerY - (dy * length) };
            const end = { x: centerX + (dx * length), y: centerY + (dy * length) };
            const clippedRuns = this.clipPolylineToRegion([start, end], region, pen, patternName);
            if (!clippedRuns.length) return;

            let bestRun = null;
            let bestScore = -1;
            clippedRuns.forEach(candidate => {
                const dense = this.densifyPolyline(candidate.points, Math.max(0.18, mask.cellSize * 0.65));
                let score = 0;
                dense.forEach(point => {
                    const key = getCellKeyForPoint(point);
                    if (key && component.keys.has(key)) score++;
                });
                if (score > bestScore) {
                    bestScore = score;
                    bestRun = candidate;
                }
            });

            if (!bestRun || bestScore <= 0) return;
            augmentedRuns.push(bestRun);
            this.densifyPolyline(bestRun.points, Math.max(0.18, mask.cellSize * 0.65)).forEach(point => {
                const key = getCellKeyForPoint(point);
                if (key) coveredCells.add(key);
            });
        });

        return augmentedRuns;
    }

    generateAngledFillPaths(region, options, variant = 'lines') {
        const spacing = Math.max(0.8, options.spacing || 6);
        const angleDeg = options.angle || 0;
        const angle = angleDeg * Math.PI / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const toLocal = (x, y) => ({ u: x * cos + y * sin, v: -x * sin + y * cos });
        const toWorld = (u, v) => ({ x: u * cos - v * sin, y: u * sin + v * cos });
        const corners = [
            { x: region.box.minX, y: region.box.minY },
            { x: region.box.maxX, y: region.box.minY },
            { x: region.box.maxX, y: region.box.maxY },
            { x: region.box.minX, y: region.box.maxY }
        ].map(pt => toLocal(pt.x, pt.y));
        const minU = Math.min(...corners.map(pt => pt.u)) - spacing * 2;
        const maxU = Math.max(...corners.map(pt => pt.u)) + spacing * 2;
        const minV = Math.min(...corners.map(pt => pt.v)) - spacing * 2;
        const maxV = Math.max(...corners.map(pt => pt.v)) + spacing * 2;
        const sampleStep = Math.max(0.6, Math.min(1.5, spacing / 3));
        const created = [];

        if (variant === 'worms') {
            const period = Math.max(spacing * 1.6, 1.6);
            const amplitude = spacing * 0.55;
            const unitGap = Math.max(0.2, period * 0.18);
            for (let v = minV; v <= maxV; v += spacing) {
                let u = minU;
                let toggle = false;
                while (u < maxU) {
                    const startU = u;
                    const endU = Math.min(maxU, startU + period - unitGap);
                    const midU = startU + ((endU - startU) * 0.5);
                    const targetV = toggle ? (v - amplitude) : (v + amplitude);
                    const points = [
                        toWorld(startU, v),
                        toWorld(midU, v),
                        toWorld(midU, targetV),
                        toWorld(endU, targetV)
                    ];
                    created.push(...this.clipPolylineToRegion(points, region, options.pen || 1, 'worms'));
                    toggle = !toggle;
                    u += period;
                }
            }
            return created;
        }

        if (variant === 'pixelwave') {
            const period = Math.max(spacing * 1.4, 1.4);
            const amplitude = spacing * 0.38;
            let rowIndex = 0;
            for (let v = minV; v <= maxV; v += spacing, rowIndex++) {
                const points = [];
                let u = minU + ((rowIndex % 2) * (period * 0.5));
                let currentV = v;
                let toggle = rowIndex % 2 === 1;
                points.push(toWorld(u, currentV));
                while (u < maxU) {
                    const nextU = Math.min(maxU, u + period);
                    points.push(toWorld(nextU, currentV));
                    if (nextU >= maxU) break;
                    currentV = toggle ? (v - amplitude) : (v + amplitude);
                    points.push(toWorld(nextU, currentV));
                    toggle = !toggle;
                    u = nextU;
                }
                created.push(...this.clipPolylineToRegion(points, region, options.pen || 1, 'pixelwave'));
            }
            return created;
        }

        if (variant === 'zigzag') {
            const stepX = Math.max(0.8, spacing);
            const amplitude = Math.max(0.4, stepX * 0.5);
            for (let v = minV - amplitude; v <= maxV + amplitude; v += spacing) {
                const points = [];
                let zig = true;
                for (let u = minU; u <= maxU; u += stepX) {
                    const pointV = zig ? (v - amplitude) : (v + amplitude);
                    points.push(toWorld(u, pointV));
                    zig = !zig;
                }
                if (points.length >= 2) {
                    created.push(...this.clipPolylineToRegion(points, region, options.pen || 1, 'zigzag'));
                }
            }
            return created;
        }

        for (let v = minV; v <= maxV; v += spacing) {
            let run = [];
            for (let u = minU; u <= maxU; u += sampleStep) {
                let offsetV = v;
                if (variant === 'curves') {
                    offsetV = v + Math.sin(u / Math.max(spacing * 1.8, 1)) * spacing * 0.35;
                } else if (variant === 'topography') {
                    offsetV = v + Math.sin((u / Math.max(spacing * 2.8, 1)) + (v / Math.max(spacing * 2.4, 1))) * spacing * 0.28;
                }

                const world = toWorld(u, offsetV);
                if (region.contains(world.x, world.y)) {
                    run.push(world);
                } else if (run.length >= 2) {
                    created.push({
                        type: 'polyline',
                        points: run,
                        pen: options.pen || 1,
                        generatedBy: 'bucket-fill',
                        fillPattern: variant
                    });
                    run = [];
                } else {
                    run = [];
                }
            }
            if (run.length >= 2) {
                created.push({
                    type: 'polyline',
                    points: run,
                    pen: options.pen || 1,
                    generatedBy: 'bucket-fill',
                    fillPattern: variant
                });
            }
        }

        return created;
    }

    generateSerpentineFillPaths(region, options) {
        const lineRuns = this.generateAngledFillPaths(region, options, 'lines')
            .map(path => Array.isArray(path?.points) ? path.points.map(point => ({ x: point.x, y: point.y })) : [])
            .filter(points => points.length >= 2);
        return this.stitchFillRunsIntoContinuousPaths(region, lineRuns, {
            pen: options.pen || 1,
            fillPattern: 'serpentine',
            sampleStep: Math.max(0.3, Math.min(1.2, Math.max(0.8, options.spacing || 6) / 3)),
            spacing: Math.max(0.8, options.spacing || 6)
        });
    }

    stitchFillRunsIntoContinuousPaths(region, runs, options = {}) {
        if (!Array.isArray(runs) || runs.length === 0) return [];
        const pen = options.pen || 1;
        const fillPattern = options.fillPattern || 'serpentine';
        const sampleStep = Math.max(0.2, options.sampleStep || 0.6);
        const joinSpacing = Math.max(0.8, options.joinSpacing || options.spacing || 6);
        const maxJoinDistance = joinSpacing * 2;
        const cleanupJoinDistance = Math.max(0.8, joinSpacing * 1.15);
        const segments = runs
            .map((points, index) => ({
                index,
                points: points.map(point => ({ x: point.x, y: point.y })),
                start: points[0],
                end: points[points.length - 1],
                centerY: points.reduce((sum, point) => sum + point.y, 0) / points.length
            }))
            .filter(segment => segment.points.length >= 2)
            .sort((a, b) => a.centerY - b.centerY || a.start.x - b.start.x);
        if (!segments.length) return [];

        const makeEndpointKey = (segmentIndex, side) => `${segmentIndex}:${side}`;
        const endpointUsage = new Map();
        const connections = new Map();
        const acceptedConnectors = [];
        const parent = segments.map((_, index) => index);
        const find = (index) => {
            let cursor = index;
            while (parent[cursor] !== cursor) {
                parent[cursor] = parent[parent[cursor]];
                cursor = parent[cursor];
            }
            return cursor;
        };
        const unite = (a, b) => {
            const rootA = find(a);
            const rootB = find(b);
            if (rootA !== rootB) parent[rootB] = rootA;
        };
        const pointEpsilon = 0.001;
        const pointsEqual = (left, right, epsilon = pointEpsilon) => {
            if (!left || !right) return false;
            return Math.hypot(left.x - right.x, left.y - right.y) <= epsilon;
        };
        const orientation = (a, b, c) => {
            const value = ((b.y - a.y) * (c.x - b.x)) - ((b.x - a.x) * (c.y - b.y));
            if (Math.abs(value) <= pointEpsilon) return 0;
            return value > 0 ? 1 : 2;
        };
        const onSegment = (a, b, c) => (
            b.x <= Math.max(a.x, c.x) + pointEpsilon
            && b.x >= Math.min(a.x, c.x) - pointEpsilon
            && b.y <= Math.max(a.y, c.y) + pointEpsilon
            && b.y >= Math.min(a.y, c.y) - pointEpsilon
        );
        const segmentsIntersect = (p1, q1, p2, q2) => {
            const o1 = orientation(p1, q1, p2);
            const o2 = orientation(p1, q1, q2);
            const o3 = orientation(p2, q2, p1);
            const o4 = orientation(p2, q2, q1);

            if (o1 !== o2 && o3 !== o4) return true;
            if (o1 === 0 && onSegment(p1, p2, q1)) return true;
            if (o2 === 0 && onSegment(p1, q2, q1)) return true;
            if (o3 === 0 && onSegment(p2, p1, q2)) return true;
            if (o4 === 0 && onSegment(p2, q1, q2)) return true;
            return false;
        };
        const buildEdgesFromPoints = (points = []) => {
            const edges = [];
            for (let i = 1; i < points.length; i++) {
                const start = points[i - 1];
                const end = points[i];
                if (!start || !end || pointsEqual(start, end)) continue;
                edges.push({ start, end });
            }
            return edges;
        };
        const staticEdges = segments.flatMap(segment => buildEdgesFromPoints(segment.points));
        const connectorCrossesExistingGeometry = (connector, allowedEndpoints = []) => {
            const connectorEdges = buildEdgesFromPoints(connector);
            if (!connectorEdges.length) return false;
            const existingEdges = [
                ...staticEdges,
                ...acceptedConnectors.flatMap(points => buildEdgesFromPoints(points))
            ];
            return connectorEdges.some(connectorEdge => existingEdges.some(existingEdge => {
                const sharesAllowedEndpoint = allowedEndpoints.some(endpoint => (
                    pointsEqual(connectorEdge.start, endpoint)
                    || pointsEqual(connectorEdge.end, endpoint)
                    || pointsEqual(existingEdge.start, endpoint)
                    || pointsEqual(existingEdge.end, endpoint)
                ));
                if (sharesAllowedEndpoint) return false;
                return segmentsIntersect(
                    connectorEdge.start,
                    connectorEdge.end,
                    existingEdge.start,
                    existingEdge.end
                );
            }));
        };
        const acceptCandidate = (candidate) => {
            const endpointKey = makeEndpointKey(candidate.a, candidate.sideA);
            const targetKey = makeEndpointKey(candidate.b, candidate.sideB);
            if (endpointUsage.has(endpointKey) || endpointUsage.has(targetKey)) return false;
            if (find(candidate.a) === find(candidate.b)) return false;
            const pointA = candidate.sideA === 'start' ? segments[candidate.a].start : segments[candidate.a].end;
            const pointB = candidate.sideB === 'start' ? segments[candidate.b].start : segments[candidate.b].end;
            if (connectorCrossesExistingGeometry(candidate.connector, [pointA, pointB])) return false;
            endpointUsage.set(endpointKey, true);
            endpointUsage.set(targetKey, true);
            connections.set(endpointKey, {
                segmentIndex: candidate.b,
                side: candidate.sideB,
                connector: candidate.connector
            });
            connections.set(targetKey, {
                segmentIndex: candidate.a,
                side: candidate.sideA,
                connector: candidate.connector.slice().reverse()
            });
            acceptedConnectors.push(candidate.connector.map(point => ({ x: point.x, y: point.y })));
            unite(candidate.a, candidate.b);
            return true;
        };

        const candidates = [];
        for (let i = 0; i < segments.length; i++) {
            for (let j = i + 1; j < segments.length; j++) {
                const segmentA = segments[i];
                const segmentB = segments[j];
                const endpointPairs = [
                    ['start', 'start'],
                    ['start', 'end'],
                    ['end', 'start'],
                    ['end', 'end']
                ];
                endpointPairs.forEach(([sideA, sideB]) => {
                    const pointA = sideA === 'start' ? segmentA.start : segmentA.end;
                    const pointB = sideB === 'start' ? segmentB.start : segmentB.end;
                    const distance = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
                    if (distance > maxJoinDistance) return;
                    const connector = this.sampleLineWithinRegion(pointA, pointB, region, sampleStep);
                    if (!connector || connector.length < 2) return;
                    candidates.push({
                        a: i,
                        b: j,
                        sideA,
                        sideB,
                        distance,
                        averageY: (pointA.y + pointB.y) / 2,
                        connector
                    });
                });
            }
        }

        const candidatesByEndpoint = new Map();
        candidates.forEach(candidate => {
            const keyA = makeEndpointKey(candidate.a, candidate.sideA);
            if (!candidatesByEndpoint.has(keyA)) candidatesByEndpoint.set(keyA, []);
            candidatesByEndpoint.get(keyA).push(candidate);

            const reverseCandidate = {
                a: candidate.b,
                b: candidate.a,
                sideA: candidate.sideB,
                sideB: candidate.sideA,
                distance: candidate.distance,
                averageY: candidate.averageY,
                connector: candidate.connector.slice().reverse()
            };
            const keyB = makeEndpointKey(reverseCandidate.a, reverseCandidate.sideA);
            if (!candidatesByEndpoint.has(keyB)) candidatesByEndpoint.set(keyB, []);
            candidatesByEndpoint.get(keyB).push(reverseCandidate);
        });

        const sortedEndpointKeys = Array.from(candidatesByEndpoint.keys()).sort((leftKey, rightKey) => {
            const [leftIndexRaw, leftSide] = leftKey.split(':');
            const [rightIndexRaw, rightSide] = rightKey.split(':');
            const leftSegment = segments[parseInt(leftIndexRaw, 10)];
            const rightSegment = segments[parseInt(rightIndexRaw, 10)];
            const leftPoint = leftSide === 'start' ? leftSegment.start : leftSegment.end;
            const rightPoint = rightSide === 'start' ? rightSegment.start : rightSegment.end;
            if (Math.abs(leftPoint.y - rightPoint.y) > 0.001) return leftPoint.y - rightPoint.y;
            return rightPoint.x - leftPoint.x;
        });

        sortedEndpointKeys.forEach(endpointKey => {
            if (endpointUsage.has(endpointKey)) return;
            const [segmentIndexRaw, side] = endpointKey.split(':');
            const segmentIndex = parseInt(segmentIndexRaw, 10);
            const segment = segments[segmentIndex];
            const anchorPoint = side === 'start' ? segment.start : segment.end;
            const preferredDirection = side === 'end' ? 1 : -1;
            const candidateList = (candidatesByEndpoint.get(endpointKey) || [])
                .filter(candidate => {
                    const targetKey = makeEndpointKey(candidate.b, candidate.sideB);
                    if (endpointUsage.has(targetKey)) return false;
                    if (find(candidate.a) === find(candidate.b)) return false;
                    return true;
                })
                .sort((left, right) => {
                    const leftPoint = left.sideB === 'start' ? segments[left.b].start : segments[left.b].end;
                    const rightPoint = right.sideB === 'start' ? segments[right.b].start : segments[right.b].end;
                    const leftDelta = leftPoint.x - anchorPoint.x;
                    const rightDelta = rightPoint.x - anchorPoint.x;
                    const leftDirectionScore = preferredDirection > 0 ? (leftDelta >= -0.001 ? 0 : 1) : (leftDelta <= 0.001 ? 0 : 1);
                    const rightDirectionScore = preferredDirection > 0 ? (rightDelta >= -0.001 ? 0 : 1) : (rightDelta <= 0.001 ? 0 : 1);
                    if (leftDirectionScore !== rightDirectionScore) return leftDirectionScore - rightDirectionScore;
                    const leftAxisDistance = Math.abs(leftDelta);
                    const rightAxisDistance = Math.abs(rightDelta);
                    if (Math.abs(leftAxisDistance - rightAxisDistance) > 0.001) return leftAxisDistance - rightAxisDistance;
                    return left.distance - right.distance;
                });

            const bestCandidate = candidateList[0];
            if (!bestCandidate) return;
            acceptCandidate(bestCandidate);
        });

        const cleanupCandidates = candidates
            .filter(candidate => candidate.distance <= cleanupJoinDistance)
            .sort((left, right) => {
                if (Math.abs(left.distance - right.distance) > 0.001) return left.distance - right.distance;
                return left.averageY - right.averageY;
            });

        cleanupCandidates.forEach(candidate => {
            if (endpointUsage.has(makeEndpointKey(candidate.a, candidate.sideA))) return;
            if (endpointUsage.has(makeEndpointKey(candidate.b, candidate.sideB))) return;
            acceptCandidate(candidate);
        });

        const visitedSegments = new Set();
        const builtPaths = [];
        const buildPathFrom = (startIndex, startSide) => {
            let currentIndex = startIndex;
            let entrySide = startSide;
            const points = [];
            while (!visitedSegments.has(currentIndex)) {
                visitedSegments.add(currentIndex);
                const segment = segments[currentIndex];
                const orientedPoints = entrySide === 'start'
                    ? segment.points.slice()
                    : segment.points.slice().reverse();
                if (points.length === 0) {
                    points.push(...orientedPoints);
                } else {
                    points.push(...orientedPoints.slice(1));
                }

                const exitSide = entrySide === 'start' ? 'end' : 'start';
                const connection = connections.get(makeEndpointKey(currentIndex, exitSide));
                if (!connection || visitedSegments.has(connection.segmentIndex)) break;
                points.push(...connection.connector.slice(1));
                entrySide = connection.side === 'start' ? 'start' : 'end';
                currentIndex = connection.segmentIndex;
            }
            return points;
        };

        for (let i = 0; i < segments.length; i++) {
            if (visitedSegments.has(i)) continue;
            const hasStartConnection = connections.has(makeEndpointKey(i, 'start'));
            const hasEndConnection = connections.has(makeEndpointKey(i, 'end'));
            const startSide = hasStartConnection && !hasEndConnection ? 'end' : 'start';
            const points = buildPathFrom(i, startSide);
            if (points.length >= 2) {
                builtPaths.push({
                    type: 'polyline',
                    points,
                    pen,
                    generatedBy: 'bucket-fill',
                    fillPattern
                });
            }
        }

        const postJoinDistance = Math.max(0.8, joinSpacing * 1.5);
        const orientChainPoints = (points, targetSide) => {
            if (!Array.isArray(points) || points.length < 2) return [];
            return targetSide === 'start'
                ? points.slice().reverse()
                : points.slice();
        };
        const activeChains = builtPaths.map((path, index) => ({
            id: index,
            points: path.points.map(point => ({ x: point.x, y: point.y }))
        }));

        while (activeChains.length > 1) {
            const mergeCandidates = [];
            for (let i = 0; i < activeChains.length; i++) {
                for (let j = i + 1; j < activeChains.length; j++) {
                    const chainA = activeChains[i];
                    const chainB = activeChains[j];
                    const endpointPairs = [
                        ['start', 'start'],
                        ['start', 'end'],
                        ['end', 'start'],
                        ['end', 'end']
                    ];
                    endpointPairs.forEach(([sideA, sideB]) => {
                        const pointA = sideA === 'start' ? chainA.points[0] : chainA.points[chainA.points.length - 1];
                        const pointB = sideB === 'start' ? chainB.points[0] : chainB.points[chainB.points.length - 1];
                        const distance = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
                        if (distance > postJoinDistance) return;
                        const connector = this.sampleLineWithinRegion(pointA, pointB, region, sampleStep);
                        if (!connector || connector.length < 2) return;
                        mergeCandidates.push({
                            indexA: i,
                            indexB: j,
                            sideA,
                            sideB,
                            distance,
                            averageY: (pointA.y + pointB.y) / 2,
                            connector
                        });
                    });
                }
            }

            mergeCandidates.sort((left, right) => {
                if (Math.abs(left.distance - right.distance) > 0.001) return left.distance - right.distance;
                return left.averageY - right.averageY;
            });

            const bestMerge = mergeCandidates.find(candidate => {
                const chainA = activeChains[candidate.indexA];
                const chainB = activeChains[candidate.indexB];
                if (!chainA || !chainB) return false;
                const pointA = candidate.sideA === 'start' ? chainA.points[0] : chainA.points[chainA.points.length - 1];
                const pointB = candidate.sideB === 'start' ? chainB.points[0] : chainB.points[chainB.points.length - 1];
                return !connectorCrossesExistingGeometry(candidate.connector, [pointA, pointB]);
            });

            if (!bestMerge) break;

            const chainA = activeChains[bestMerge.indexA];
            const chainB = activeChains[bestMerge.indexB];
            const orientedA = orientChainPoints(chainA.points, bestMerge.sideA);
            const orientedB = bestMerge.sideB === 'start'
                ? chainB.points.slice()
                : chainB.points.slice().reverse();
            const mergedPoints = [
                ...orientedA,
                ...bestMerge.connector.slice(1),
                ...orientedB.slice(1)
            ];
            acceptedConnectors.push(bestMerge.connector.map(point => ({ x: point.x, y: point.y })));

            activeChains.splice(bestMerge.indexB, 1);
            activeChains[bestMerge.indexA] = {
                id: chainA.id,
                points: mergedPoints
            };
        }

        return activeChains
            .filter(chain => Array.isArray(chain.points) && chain.points.length >= 2)
            .map(chain => ({
                type: 'polyline',
                points: chain.points,
                pen,
                generatedBy: 'bucket-fill',
                fillPattern
            }));
    }

    generateCircleFillPaths(region, options) {
        const spacing = Math.max(2, options.spacing || 6);
        const radius = Math.max(0.6, spacing * 0.28);
        const created = [];
        for (let y = region.box.minY + spacing / 2; y <= region.box.maxY - spacing / 2; y += spacing) {
            for (let x = region.box.minX + spacing / 2; x <= region.box.maxX - spacing / 2; x += spacing) {
                if (region.contains(x, y)) {
                    created.push({
                        type: 'circle',
                        x,
                        y,
                        r: radius,
                        pen: options.pen || 1,
                        generatedBy: 'bucket-fill',
                        fillPattern: 'circles'
                    });
                }
            }
        }
        return created;
    }

    findRegionBoundaryPoint(region, insidePoint, outsidePoint, iterations = 12) {
        let inside = { ...insidePoint };
        let outside = { ...outsidePoint };
        for (let i = 0; i < iterations; i++) {
            const mid = {
                x: (inside.x + outside.x) / 2,
                y: (inside.y + outside.y) / 2
            };
            if (region.contains(mid.x, mid.y)) {
                inside = mid;
            } else {
                outside = mid;
            }
        }
        return inside;
    }

    densifyPolyline(points, maxStep = 1) {
        if (!Array.isArray(points) || points.length < 2) return points || [];
        const dense = [points[0]];
        for (let i = 1; i < points.length; i++) {
            const prev = points[i - 1];
            const next = points[i];
            const distance = Math.hypot(next.x - prev.x, next.y - prev.y);
            const steps = Math.max(1, Math.ceil(distance / Math.max(0.2, maxStep)));
            for (let step = 1; step <= steps; step++) {
                const t = step / steps;
                dense.push({
                    x: prev.x + ((next.x - prev.x) * t),
                    y: prev.y + ((next.y - prev.y) * t)
                });
            }
        }
        return dense;
    }

    sampleLineWithinRegion(start, end, region, maxStep = 1) {
        if (!start || !end || !region) return null;
        const distance = Math.hypot(end.x - start.x, end.y - start.y);
        const steps = Math.max(1, Math.ceil(distance / Math.max(0.2, maxStep)));
        const samples = [];
        for (let step = 0; step <= steps; step++) {
            const t = step / steps;
            const point = {
                x: start.x + ((end.x - start.x) * t),
                y: start.y + ((end.y - start.y) * t)
            };
            if (!region.contains(point.x, point.y)) {
                return null;
            }
            samples.push(point);
        }
        return samples;
    }

    clipPolylineToRegion(points, region, pen, patternName) {
        const source = this.densifyPolyline(points, Math.max(0.5, Math.min(2, (region?.cellSize || 1))));
        if (!Array.isArray(source) || source.length < 2) return [];
        const runs = [];
        let run = region.contains(source[0].x, source[0].y) ? [{ ...source[0] }] : [];

        for (let i = 1; i < source.length; i++) {
            const prev = source[i - 1];
            const curr = source[i];
            const prevInside = region.contains(prev.x, prev.y);
            const currInside = region.contains(curr.x, curr.y);

            if (prevInside && currInside) {
                run.push({ ...curr });
                continue;
            }

            if (prevInside && !currInside) {
                run.push(this.findRegionBoundaryPoint(region, prev, curr));
                if (run.length >= 2) {
                    runs.push({
                        type: 'polyline',
                        points: run,
                        pen: pen || 1,
                        generatedBy: 'bucket-fill',
                        fillPattern: patternName
                    });
                }
                run = [];
                continue;
            }

            if (!prevInside && currInside) {
                const entry = this.findRegionBoundaryPoint(region, curr, prev);
                run = [entry, { ...curr }];
                continue;
            }
        }

        if (run.length >= 2) {
            runs.push({
                type: 'polyline',
                points: run,
                pen: pen || 1,
                generatedBy: 'bucket-fill',
                fillPattern: patternName
            });
        }
        return runs;
    }

    createSeededNoise2D(seed = 1) {
        const hash = (x, y) => {
            const n = Math.sin((x * 127.1) + (y * 311.7) + (seed * 74.7)) * 43758.5453123;
            return n - Math.floor(n);
        };
        const smooth = (t) => t * t * (3 - 2 * t);
        return (x, y) => {
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const x1 = x0 + 1;
            const y1 = y0 + 1;
            const sx = smooth(x - x0);
            const sy = smooth(y - y0);
            const n00 = hash(x0, y0);
            const n10 = hash(x1, y0);
            const n01 = hash(x0, y1);
            const n11 = hash(x1, y1);
            const ix0 = n00 + ((n10 - n00) * sx);
            const ix1 = n01 + ((n11 - n01) * sx);
            return ix0 + ((ix1 - ix0) * sy);
        };
    }

    generateTopographyFillPaths(region, options) {
        const spacing = Math.max(0.2, options.spacing || 6);
        const gridStep = Math.max(0.35, Math.min(2.2, spacing * 0.5));
        const width = region.box.maxX - region.box.minX;
        const height = region.box.maxY - region.box.minY;
        const cols = Math.max(4, Math.ceil(width / gridStep));
        const rows = Math.max(4, Math.ceil(height / gridStep));
        const noise = this.createSeededNoise2D(((region.signatureKey || '').length + 1) * 13);
        const field = Array.from({ length: rows + 1 }, (_, y) =>
            Array.from({ length: cols + 1 }, (_, x) => {
                const nx = x / Math.max(1, cols);
                const ny = y / Math.max(1, rows);
                const base = noise(nx * 3.8, ny * 3.8);
                const detail = noise((nx * 9.5) + 17.2, (ny * 9.5) + 11.4) * 0.28;
                return Math.max(0, Math.min(1, base * 0.82 + detail));
            })
        );
        const levels = [];
        const levelCount = Math.max(6, Math.min(80, Math.round(Math.max(width, height) / Math.max(spacing * 1.6, 0.35))));
        for (let i = 1; i <= levelCount; i++) levels.push(i / (levelCount + 1));

        const interpolate = (p1, p2, v1, v2, level) => {
            const denom = (v2 - v1) || 0.000001;
            const t = (level - v1) / denom;
            return {
                x: p1.x + ((p2.x - p1.x) * t),
                y: p1.y + ((p2.y - p1.y) * t)
            };
        };

        const created = [];
        levels.forEach(level => {
            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const x0 = region.box.minX + (x * gridStep);
                    const y0 = region.box.minY + (y * gridStep);
                    const x1 = Math.min(region.box.maxX, x0 + gridStep);
                    const y1 = Math.min(region.box.maxY, y0 + gridStep);
                    const corners = [
                        { x: x0, y: y0, v: field[y][x] },
                        { x: x1, y: y0, v: field[y][x + 1] },
                        { x: x1, y: y1, v: field[y + 1][x + 1] },
                        { x: x0, y: y1, v: field[y + 1][x] }
                    ];
                    const edgePairs = [
                        [corners[0], corners[1]],
                        [corners[1], corners[2]],
                        [corners[2], corners[3]],
                        [corners[3], corners[0]]
                    ];
                    const intersections = [];
                    edgePairs.forEach(([a, b]) => {
                        if ((a.v < level && b.v >= level) || (a.v >= level && b.v < level)) {
                            intersections.push(interpolate(a, b, a.v, b.v, level));
                        }
                    });
                    if (intersections.length === 2) {
                        const mid = {
                            x: (intersections[0].x + intersections[1].x) / 2,
                            y: (intersections[0].y + intersections[1].y) / 2
                        };
                        if (region.contains(mid.x, mid.y)) {
                            created.push({
                                type: 'polyline',
                                points: intersections,
                                pen: options.pen || 1,
                                generatedBy: 'bucket-fill',
                                fillPattern: 'topography'
                            });
                        }
                    } else if (intersections.length === 4) {
                        const pairs = [
                            [intersections[0], intersections[1]],
                            [intersections[2], intersections[3]]
                        ];
                        pairs.forEach(pair => {
                            const mid = {
                                x: (pair[0].x + pair[1].x) / 2,
                                y: (pair[0].y + pair[1].y) / 2
                            };
                            if (region.contains(mid.x, mid.y)) {
                                created.push({
                                    type: 'polyline',
                                    points: pair,
                                    pen: options.pen || 1,
                                    generatedBy: 'bucket-fill',
                                    fillPattern: 'topography'
                                });
                            }
                        });
                    }
                }
            }
        });

        return created;
    }

    generateArcPatternFill(region, options, patternName) {
        const spacing = Math.max(1.2, options.spacing || 6);
        const radius = spacing;
        const stepX = radius * 2;
        const stepY = radius * 0.9;
        const created = [];
        for (let row = 0, y = region.box.minY; y <= region.box.maxY + radius; row++, y += stepY) {
            const offset = row % 2 === 0 ? 0 : radius;
            for (let x = region.box.minX - radius; x <= region.box.maxX + radius; x += stepX) {
                for (let ring = 1; ring <= 3; ring++) {
                    const ringRadius = (radius * ring) / 3;
                    const points = [];
                    for (let i = 0; i <= 18; i++) {
                        const theta = Math.PI - ((i / 18) * Math.PI);
                        points.push({
                            x: x + offset + Math.cos(theta) * ringRadius,
                            y: y + Math.sin(theta) * ringRadius
                        });
                    }
                    created.push(...this.clipPolylineToRegion(points, region, options.pen || 1, patternName));
                }
            }
        }
        return created;
    }

    generateAsanohaFill(region, options) {
        const spacing = Math.max(3, options.spacing || 6);
        const size = spacing * 0.72;
        const created = [];
        for (let row = 0, y = region.box.minY; y <= region.box.maxY + spacing; row++, y += spacing * 1.5) {
            const offset = row % 2 === 0 ? 0 : spacing * 0.86;
            for (let x = region.box.minX; x <= region.box.maxX + spacing; x += spacing * 1.72) {
                const cx = x + offset;
                const cy = y;
                const points = [];
                for (let i = 0; i < 6; i++) {
                    const angle = (-Math.PI / 2) + (i * Math.PI / 3);
                    points.push({ x: cx + Math.cos(angle) * size, y: cy + Math.sin(angle) * size });
                }
                for (let i = 0; i < 6; i++) {
                    const a = points[i];
                    const b = points[(i + 1) % 6];
                    const c = points[(i + 2) % 6];
                    created.push(...this.clipPolylineToRegion([a, b, c], region, options.pen || 1, 'asanoha'));
                    created.push(...this.clipPolylineToRegion([{ x: cx, y: cy }, b], region, options.pen || 1, 'asanoha'));
                }
            }
        }
        return created;
    }

    generateSameKomonFill(region, options) {
        const spacing = Math.max(1.4, options.spacing || 6);
        const radius = Math.max(0.25, spacing * 0.16);
        const created = [];
        for (let row = 0, y = region.box.minY + spacing / 2; y <= region.box.maxY - spacing / 2; row++, y += spacing * 0.95) {
            const offset = row % 2 === 0 ? 0 : spacing * 0.5;
            for (let x = region.box.minX + spacing / 2; x <= region.box.maxX - spacing / 2; x += spacing) {
                const cx = x + offset;
                if (!region.contains(cx, y)) continue;
                created.push({
                    type: 'circle',
                    x: cx,
                    y,
                    r: radius,
                    pen: options.pen || 1,
                    generatedBy: 'bucket-fill',
                    fillPattern: 'samekomon'
                });
            }
        }
        return created;
    }

    generateSayagataFill(region, options) {
        const spacing = Math.max(3, options.spacing || 6);
        const cell = spacing * 1.2;
        const created = [];
        for (let y = region.box.minY - cell; y <= region.box.maxY + cell; y += cell * 2) {
            for (let x = region.box.minX - cell; x <= region.box.maxX + cell; x += cell * 2) {
                const pts = [
                    { x, y: y + cell },
                    { x: x + cell, y: y + cell },
                    { x: x + cell, y },
                    { x: x + (cell * 2), y },
                    { x: x + (cell * 2), y: y + cell },
                    { x: x + cell, y: y + cell },
                    { x: x + cell, y: y + (cell * 2) },
                    { x, y: y + (cell * 2) }
                ];
                created.push(...this.clipPolylineToRegion(pts, region, options.pen || 1, 'sayagata'));
            }
        }
        return created;
    }

    generateKagomeFill(region, options) {
        const spacing = Math.max(3, options.spacing || 6);
        const size = spacing * 0.9;
        const stepX = size * Math.sqrt(3);
        const stepY = size * 1.5;
        const created = [];
        for (let row = 0, y = region.box.minY - size; y <= region.box.maxY + size; row++, y += stepY) {
            const offset = row % 2 === 0 ? 0 : stepX / 2;
            for (let x = region.box.minX - stepX; x <= region.box.maxX + stepX; x += stepX) {
                const cx = x + offset;
                const up = [
                    { x: cx, y: y - size },
                    { x: cx - (stepX / 2), y: y + (size / 2) },
                    { x: cx + (stepX / 2), y: y + (size / 2) },
                    { x: cx, y: y - size }
                ];
                const down = [
                    { x: cx, y: y + size },
                    { x: cx - (stepX / 2), y: y - (size / 2) },
                    { x: cx + (stepX / 2), y: y - (size / 2) },
                    { x: cx, y: y + size }
                ];
                created.push(...this.clipPolylineToRegion(up, region, options.pen || 1, 'kagome'));
                created.push(...this.clipPolylineToRegion(down, region, options.pen || 1, 'kagome'));
            }
        }
        return created;
    }

    generateBucketFillPaths(region, options) {
        switch (options.pattern) {
            case 'serpentine':
                return this.generateSerpentineFillPaths(region, options);
            case 'crosshatch':
                return [
                    ...this.generateAngledFillPaths(region, options, 'lines'),
                    ...this.generateAngledFillPaths(region, { ...options, angle: (options.angle || 0) + 90 }, 'lines')
                ];
            case 'worms':
                return this.generateAngledFillPaths(region, options, 'worms');
            case 'pixelwave':
                return this.generateAngledFillPaths(region, options, 'pixelwave');
            case 'zigzag':
                return this.generateAngledFillPaths(region, options, 'zigzag');
            case 'curves':
                return this.generateAngledFillPaths(region, options, 'curves');
            case 'circles':
                return this.generateCircleFillPaths(region, options);
            case 'topography':
                return this.generateTopographyFillPaths(region, options);
            case 'seigaiha':
                return this.generateArcPatternFill(region, options, 'seigaiha');
            case 'asanoha':
                return this.generateAsanohaFill(region, options);
            case 'samekomon':
                return this.generateSameKomonFill(region, options);
            case 'sayagata':
                return this.generateSayagataFill(region, options);
            case 'kagome':
                return this.generateKagomeFill(region, options);
            case 'lines':
            default:
                return this.generateAngledFillPaths(region, options, 'lines');
        }
    }

    async applyBucketFillAt(xMM, yMM) {
        const target = this.getFillTargetAt(xMM, yMM);
        if (!target) {
            if (this.app?.ui) this.app.ui.logToConsole('System: Pattern bucket works on closed shapes only.');
            return false;
        }

        const options = this.app?.ui?.fillBucketSettings || { pattern: 'lines', spacing: 6, angle: 45, pen: 1, groupPatterns: true };
        const fillPaths = this.generateBucketFillPaths(target.region, options);
        if (!Array.isArray(fillPaths) || fillPaths.length === 0) {
            if (this.app?.ui) this.app.ui.logToConsole('System: No fill paths were generated for that area.');
            return false;
        }
        this.ensureUndoCheckpoint();
        const groupId = options.groupPatterns === false ? null : `fill_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        fillPaths.forEach(path => {
            if (groupId) path.groupId = groupId;
            else delete path.groupId;
            delete path.parentGroupId;
            this.paths.push(path);
        });
        this.selectedPaths = fillPaths.map((_, index) => this.paths.length - fillPaths.length + index);
        this.selectedNodes = [];
        this.saveUndoState();
        this.draw();
        if (this.app?.ui) {
            this.app.ui.logToConsole(`System: Generated ${fillPaths.length} ${options.pattern} fill paths.`);
            this.app.ui.updatePatternPanelState();
        }
        return true;
    }

    hitTestResizeGroup(indices, xMM, yMM) {
        const box = this.getGroupBoundingBox(indices);
        if (!box) return -1;
        const tol = 5;
        const corners = [
            { x: box.minX, y: box.minY },                      // 0: Top-Left
            { x: box.minX + (box.maxX - box.minX) / 2, y: box.minY }, // 1: Top-Mid
            { x: box.maxX, y: box.minY },                      // 2: Top-Right
            { x: box.maxX, y: box.minY + (box.maxY - box.minY) / 2 }, // 3: Mid-Right
            { x: box.maxX, y: box.maxY },                      // 4: Bottom-Right
            { x: box.minX + (box.maxX - box.minX) / 2, y: box.maxY }, // 5: Bottom-Mid
            { x: box.minX, y: box.maxY },                      // 6: Bottom-Left
            { x: box.minX, y: box.minY + (box.maxY - box.minY) / 2 }  // 7: Mid-Left
        ];
        for (let i = 0; i < corners.length; i++) {
            if (Math.abs(corners[i].x - xMM) <= tol && Math.abs(corners[i].y - yMM) <= tol) return i;
        }
        return -1;
    }

    init() {
        if (!this.eventsBound) {
            if (this.canvas) {
                this.bindEvents();
            }
        }

        this.refreshPaperSettings();

        // Dynamically resize when panel changes size (GridStack)
        if (this.canvas && this.canvas.parentElement) {
            const resizeObserver = new ResizeObserver(() => {
                this.resize();
                this.draw(true);
            });
            resizeObserver.observe(this.canvas.parentElement);
        }

        this.resize();
        this.loadSavedState(); // Restore from localStorage on startup
        if (!this.persistenceEventsBound) {
            this.persistenceEventsBound = true;
            window.addEventListener('beforeunload', () => this.saveCurrentStateIfChanged());
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.saveCurrentStateIfChanged();
            });
        }
        this.draw(true);
    }

    refreshPaperSettings() {
        this.paperDims = this.app?.getPaperSizeMap?.() || {
            A3: { name: 'A3', width: 420, height: 297 },
            A4: { name: 'A4', width: 297, height: 210 },
            A5: { name: 'A5', width: 210, height: 148 }
        };
        this.paperSize = this.app?.settings?.paperSize || this.paperSize || 'A3';
        if (this.paperSize !== 'Max' && !this.paperDims[this.paperSize]) {
            this.paperSize = 'A3';
        }

        const select = document.getElementById('sel-paper-size');
        if (select) {
            const optionKeys = [...Object.keys(this.paperDims), 'Max'];
            const previousValue = this.paperSize;
            select.innerHTML = '';
            optionKeys.forEach(key => {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = key;
                select.appendChild(opt);
            });
            const customOption = document.createElement('option');
            customOption.value = '__custom__';
            customOption.textContent = 'Custom...';
            select.appendChild(customOption);
            select.value = optionKeys.includes(previousValue) ? previousValue : 'A3';
            this.paperSize = select.value;
            this.setPaperDropdownDetailMode(false);
        }
    }

    setPaperDropdownDetailMode(showDetails) {
        const select = document.getElementById('sel-paper-size');
        if (!select) return;
        select.style.width = showDetails ? '220px' : '74px';

        Array.from(select.options).forEach(option => {
            const key = option.value;
            if (key === '__custom__') {
                option.textContent = 'Custom...';
                return;
            }
            if (key === 'Max') {
                option.textContent = 'Max';
                return;
            }
            const dims = this.paperDims[key];
            if (!dims) {
                option.textContent = key;
                return;
            }
            option.textContent = showDetails
                ? `${key} (${dims.width} x ${dims.height} mm)`
                : key;
        });
    }

    getPaperDimensions(sizeName = this.paperSize) {
        if (sizeName === 'Max') {
            return { width: this.bedWidth, height: this.bedHeight };
        }

        const preset = this.paperDims[sizeName] || this.paperDims.A3;
        return {
            width: preset?.width || 420,
            height: preset?.height || 297
        };
    }

    handleResize() {
        this.resize();
        this.draw(true);
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const dpr = window.devicePixelRatio || 1;
        const parentRect = parent.getBoundingClientRect();
        const rectW = parentRect.width || parent.clientWidth;
        const rectH = parentRect.height || parent.clientHeight;

        const scale = Math.min(
            rectW / this.bedWidth,
            rectH / this.bedHeight
        );

        this.pixelW = rectW;
        this.pixelH = rectH;
        this.scale = scale;
        this.bedRenderWidthPx = this.bedWidth * scale;
        this.bedRenderHeightPx = this.bedHeight * scale;
        this.viewportHorizontalShift = 0;
        this.viewportVerticalShift = Math.max(0, rectH - this.bedRenderHeightPx);

        this.canvas.width = this.pixelW * dpr;
        this.canvas.height = this.pixelH * dpr;
        this.canvas.style.width = `${this.pixelW}px`;
        this.canvas.style.height = `${this.pixelH}px`;

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Reset transform and apply DPR
        this.clearBucketHoverPreview();
    }

    draw(immediate = false) {
        if (immediate) {
            this.drawFramePending = false;
            this._renderCanvas();
            return;
        }

        if (this.drawFramePending) return;
        this.drawFramePending = true;
        requestAnimationFrame(() => {
            this.drawFramePending = false;
            this._renderCanvas();
        });
    }

    _renderCanvas() {
        if (!this.ctx) return;
        const showMachineOutput = this.app?.ui?.currentVisualizerView === 'machine-output';
        this.ctx.save(); // Save default unscaled state
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Bottom-left anchor logic: keep the machine origin fixed to the lower-left of the viewport.
        const { mmToPx, horizontalShift, verticalShift } = this.getViewportTransform();

        // Apply panning and zooming transformations
        this.ctx.translate(this.viewOffsetX + horizontalShift, this.viewOffsetY + verticalShift);
        this.ctx.scale(this.viewZoom, this.viewZoom);

        const bedPixelW = this.bedWidth * mmToPx;
        const bedPixelH = this.bedHeight * mmToPx;

        // Draw outer dark grey background filling the infinite canvas bounds (visualizer backdrop)
        // We make it huge to cover panning
        this.ctx.fillStyle = '#1e293b'; // Tailwind slate-800
        this.ctx.fillRect(-10000, -10000, 20000, 20000);

        // Draw fixed Bed background (white area) representing the actual physical space
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = 'rgba(0,0,0,0.5)';
        this.ctx.shadowBlur = 15;
        this.ctx.fillRect(0, 0, bedPixelW, bedPixelH);

        // Reset shadow
        this.ctx.shadowColor = 'transparent';
        this.ctx.shadowBlur = 0;

        // Draw grid
        this.ctx.strokeStyle = '#f1f5f9';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();

        for (let x = 0; x <= this.bedWidth; x += this.gridSize) {
            this.ctx.moveTo(x * mmToPx, 0);
            this.ctx.lineTo(x * mmToPx, bedPixelH);
        }
        // Draw grid from bottom-up to ensure bottom-left origin visually
        for (let y = this.bedHeight; y >= 0; y -= this.gridSize) {
            const py = y * mmToPx;
            this.ctx.moveTo(0, py);
            this.ctx.lineTo(bedPixelW, py);
        }
        this.ctx.stroke();

        // Draw fixed Bed bounding box edge
        this.ctx.strokeStyle = '#94a3b8';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(0, 0, bedPixelW, bedPixelH);

        // Draw Paper Size over origin (Bottom-Left matched visually)
        // Wait, physical DXY places bottom-left origin in bottom-left corner.
        // Screen canvas places 0,0 at top-left.
        // Let's draw paper attached to bottom left (x=0, y=maxY).
        const pSize = this.getPaperDimensions(this.paperSize);
        const pWPx = pSize.width * mmToPx;
        const pHPx = pSize.height * mmToPx;

        // origin bottom-left means Y is bedPixelH - pHPx
        const startY = bedPixelH - pHPx;

        // Apply Margins
        const marginX = this.app?.settings?.marginX || 0;
        const marginY = this.app?.settings?.marginY || 0;
        const pxMarginX = marginX * mmToPx;
        const pxMarginY = marginY * mmToPx;

        // Label
        this.ctx.fillStyle = '#94a3b8';
        this.ctx.font = 'bold 24px var(--font-ui)';
        this.ctx.fillText(this.paperSize, pxMarginX + 20, startY - pxMarginY + pHPx - 20);

        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = 'rgba(0,0,0,0.5)';
        this.ctx.shadowBlur = 10;
        this.ctx.shadowOffsetX = 3;
        this.ctx.shadowOffsetY = 3;
        this.ctx.fillRect(pxMarginX, startY - pxMarginY, pWPx, pHPx);

        // Reset shadow
        this.ctx.shadowColor = 'transparent';

        // Plaeholder origin
        this.ctx.fillStyle = '#ef4444';
        this.ctx.beginPath();
        this.ctx.arc(pxMarginX, bedPixelH - pxMarginY, 5, 0, Math.PI * 2);
        this.ctx.fill();

        this.drawPaths();
        if (!showMachineOutput) {
            this.drawBucketHoverPreview();
        }

        // Draw Snap Hint
        if (!showMachineOutput && this.snapPoint) {
            this.ctx.strokeStyle = '#22c55e'; // green-500
            this.ctx.fillStyle = '#22c55e';
            this.ctx.lineWidth = 2 / this.viewZoom;
            this.ctx.beginPath();
            const size = 10 / (mmToPx * this.viewZoom);
            this.ctx.moveTo(this.snapPoint.x * mmToPx - size, this.snapPoint.y * mmToPx);
            this.ctx.lineTo(this.snapPoint.x * mmToPx + size, this.snapPoint.y * mmToPx);
            this.ctx.moveTo(this.snapPoint.x * mmToPx, this.snapPoint.y * mmToPx - size);
            this.ctx.lineTo(this.snapPoint.x * mmToPx, this.snapPoint.y * mmToPx + size);
            this.ctx.stroke();
        }

        this.ctx.restore(); // CRITICAL: Stop transformation accumulation
        this.drawPatternPreviewOverlay();
        this.drawSelectionOverlay();
        this.drawLiveTrackerOverlay(mmToPx, horizontalShift, verticalShift);
        this.drawPredictedCrosshair(mmToPx, horizontalShift, verticalShift);
        const isInteracting = this.isDragging || this.isRotating || this.isPanning || this.isMarqueeSelecting || this.isCreatingShape;
        if (!isInteracting && this.app.ui && this.app.ui.updateSelectionSizeControls) {
            this.app.ui.updateSelectionSizeControls();
        }
    }

    drawPatternPreviewOverlay() {
        const showMachineOutput = this.app?.ui?.currentVisualizerView === 'machine-output';
        if (showMachineOutput || !Array.isArray(this.patternPreviewPaths) || this.patternPreviewPaths.length === 0) return;

        const drawPolyline = (points) => {
            if (!Array.isArray(points) || points.length < 2) return;
            const start = this.mmToCanvasPx(points[0].x, points[0].y);
            this.ctx.beginPath();
            this.ctx.moveTo(start.x, start.y);
            for (let i = 1; i < points.length; i++) {
                const screen = this.mmToCanvasPx(points[i].x, points[i].y);
                this.ctx.lineTo(screen.x, screen.y);
            }
            this.ctx.stroke();
        };

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
        this.ctx.lineWidth = 1.25;
        this.ctx.setLineDash([5, 5]);

        this.patternPreviewPaths.forEach(path => {
            if (!path) return;
            if (path.type === 'circle') {
                const center = this.mmToCanvasPx(path.x, path.y);
                const edge = this.mmToCanvasPx(path.x + (path.r || 0), path.y);
                const radiusPx = Math.abs(edge.x - center.x);
                this.ctx.beginPath();
                this.ctx.arc(center.x, center.y, radiusPx, 0, Math.PI * 2);
                this.ctx.stroke();
                return;
            }

            if (path.type === 'rectangle') {
                const topLeft = this.mmToCanvasPx(path.x, path.y);
                const bottomRight = this.mmToCanvasPx(path.x + (path.w || 0.1), path.y + (path.h || 0.1));
                this.ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
                return;
            }

            if (path.type === 'text') {
                this.ctx.restore();
                this.ctx.save();
                this.ctx.translate(this.viewOffsetX + this.viewportHorizontalShift, this.viewOffsetY + this.viewportVerticalShift);
                this.ctx.scale(this.viewZoom, this.viewZoom);
                this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
                this.ctx.lineWidth = 1.25 / Math.max(0.01, this.viewZoom);
                this.ctx.setLineDash([5 / Math.max(0.01, this.viewZoom), 5 / Math.max(0.01, this.viewZoom)]);
                this.normalizeTextPath(path);
                this.drawVectorText(path, this.scale, false);
                this.ctx.restore();
                this.ctx.save();
                this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)';
                this.ctx.lineWidth = 1.25;
                this.ctx.setLineDash([5, 5]);
                return;
            }

            const tracePoints = this.getPathTracePoints(path);
            drawPolyline(tracePoints);
        });

        this.ctx.restore();
    }

    drawSelectionOverlay() {
        const showMachineOutput = this.app?.ui?.currentVisualizerView === 'machine-output';
        if (showMachineOutput) return;

        const selectToolActive = this.app?.ui?.activeTool === 'select' && this.selectedPaths.length >= 1;
        const warpToolActive = this.app?.ui?.activeTool === 'warp' && this.selectedPaths.length >= 1;
        if (!selectToolActive && !warpToolActive) return;

        const selectionNodeSizePx = 8;
        const drawHandle = (point, strokeStyle) => {
            if (!point) return;
            const screen = this.mmToCanvasPx(point.x, point.y);
            this.ctx.strokeStyle = strokeStyle;
            this.ctx.fillStyle = '#ffffff';
            this.ctx.strokeRect(
                screen.x - (selectionNodeSizePx / 2),
                screen.y - (selectionNodeSizePx / 2),
                selectionNodeSizePx,
                selectionNodeSizePx
            );
            this.ctx.fillRect(
                screen.x - (selectionNodeSizePx / 2),
                screen.y - (selectionNodeSizePx / 2),
                selectionNodeSizePx,
                selectionNodeSizePx
            );
        };

        this.ctx.save();
        this.ctx.lineWidth = 1.25;
        this.ctx.setLineDash([]);

        if (selectToolActive) {
            const selectionBox = this.getGroupBoundingBox(this.selectedPaths);
            if (selectionBox) {
                const topLeft = this.mmToCanvasPx(selectionBox.minX, selectionBox.minY);
                const bottomRight = this.mmToCanvasPx(selectionBox.maxX, selectionBox.maxY);
                const widthPx = bottomRight.x - topLeft.x;
                const heightPx = bottomRight.y - topLeft.y;
                const selectionCorners = [
                    { x: selectionBox.minX, y: selectionBox.minY },
                    { x: selectionBox.minX + ((selectionBox.maxX - selectionBox.minX) / 2), y: selectionBox.minY },
                    { x: selectionBox.maxX, y: selectionBox.minY },
                    { x: selectionBox.maxX, y: selectionBox.minY + ((selectionBox.maxY - selectionBox.minY) / 2) },
                    { x: selectionBox.maxX, y: selectionBox.maxY },
                    { x: selectionBox.minX + ((selectionBox.maxX - selectionBox.minX) / 2), y: selectionBox.maxY },
                    { x: selectionBox.minX, y: selectionBox.maxY },
                    { x: selectionBox.minX, y: selectionBox.minY + ((selectionBox.maxY - selectionBox.minY) / 2) }
                ];

                this.ctx.strokeStyle = '#3b82f6';
                this.ctx.shadowColor = 'rgba(59, 130, 246, 0.28)';
                this.ctx.shadowBlur = 6;
                this.ctx.strokeRect(topLeft.x, topLeft.y, widthPx, heightPx);
                this.ctx.shadowBlur = 0;
                selectionCorners.forEach(point => drawHandle(point, '#3b82f6'));

                const tm = this.mmToCanvasPx(selectionCorners[1].x, selectionCorners[1].y);
                const stalkLen = 20;
                this.ctx.beginPath();
                this.ctx.moveTo(tm.x, tm.y);
                this.ctx.lineTo(tm.x, tm.y - stalkLen);
                this.ctx.stroke();
                this.ctx.beginPath();
                this.ctx.arc(tm.x, tm.y - stalkLen, selectionNodeSizePx / 2, 0, Math.PI * 2);
                this.ctx.fillStyle = '#ffffff';
                this.ctx.fill();
                this.ctx.stroke();
            }
        }

        if (warpToolActive) {
            const warpSelectionBox = this.warpOriginalBox || this.getGroupBoundingBox(this.selectedPaths);
            const warpHandles = warpSelectionBox
                ? (this.warpHandlePositions || this.getEightHandlePositions(warpSelectionBox))
                : null;
            if (warpSelectionBox && warpHandles) {
                const topLeft = this.mmToCanvasPx(warpSelectionBox.minX, warpSelectionBox.minY);
                const bottomRight = this.mmToCanvasPx(warpSelectionBox.maxX, warpSelectionBox.maxY);
                this.ctx.strokeStyle = '#22c55e';
                this.ctx.setLineDash([6, 4]);
                this.ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
                this.ctx.setLineDash([]);
                warpHandles.forEach((point, handleIndex) => {
                    drawHandle(point, handleIndex === this.warpActiveHandleIndex ? '#f59e0b' : '#22c55e');
                });
            }
        }

        this.ctx.restore();
    }

    drawLiveTrackerOverlay(mmToPx, horizontalShift = 0, verticalShift = 0) {
        if (!this.liveTrackerOverlay || !this.liveTrackerOverlay.targetPoint) return;
        const point = this.liveTrackerOverlay.targetPoint;
        const x = (point.x * mmToPx * this.viewZoom) + this.viewOffsetX + horizontalShift;
        const y = (point.y * mmToPx * this.viewZoom) + this.viewOffsetY + verticalShift;
        const label = this.liveTrackerOverlay.activePen ? `Pen ${this.liveTrackerOverlay.activePen}` : 'Pen Up';

        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(x, y, 7, 0, Math.PI * 2);
        this.ctx.fillStyle = this.liveTrackerOverlay.activePen ? 'rgba(16, 185, 129, 0.95)' : 'rgba(245, 158, 11, 0.95)';
        this.ctx.fill();
        this.ctx.lineWidth = 2;
        this.ctx.strokeStyle = '#f8fafc';
        this.ctx.stroke();
        this.ctx.font = '12px Outfit, sans-serif';
        this.ctx.fillStyle = '#f8fafc';
        this.ctx.fillText(`${label} ${this.liveTrackerOverlay.label || ''}`.trim(), x + 12, y - 10);
        this.ctx.restore();
    }

    drawPredictedCrosshair(mmToPx, horizontalShift = 0, verticalShift = 0) {
        if (!this.app?.settings || this.app.settings.showPredictedCrosshair === false) return;
        if (!this.app?.serial || !this.app.serial.getEstimatedPosition) return;

        const predicted = this.app.serial.getEstimatedPosition();
        if (!predicted) return;

        const targetPoint = this.app?.hpgl?.inverseTransformOutputPoint
            ? this.app.hpgl.inverseTransformOutputPoint(predicted.x, predicted.y)
            : { x: predicted.x, y: predicted.y };
        if (!this.displayedCrosshairPoint) {
            this.displayedCrosshairPoint = { ...targetPoint };
        } else {
            const dx = targetPoint.x - this.displayedCrosshairPoint.x;
            const dy = targetPoint.y - this.displayedCrosshairPoint.y;
            const distance = Math.hypot(dx, dy);
            if (distance < 0.05) {
                this.displayedCrosshairPoint = { ...targetPoint };
            } else {
                const lerp = Math.min(0.35, Math.max(0.12, distance * 0.08));
                this.displayedCrosshairPoint.x += dx * lerp;
                this.displayedCrosshairPoint.y += dy * lerp;
                this.draw();
            }
        }

        const x = (this.displayedCrosshairPoint.x * mmToPx * this.viewZoom) + this.viewOffsetX + horizontalShift;
        const y = (this.displayedCrosshairPoint.y * mmToPx * this.viewZoom) + this.viewOffsetY + verticalShift;
        const size = 10;

        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
        this.ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
        this.ctx.lineWidth = 1.5;

        this.ctx.beginPath();
        this.ctx.arc(x, y, size, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.moveTo(x - (size * 1.8), y);
        this.ctx.lineTo(x + (size * 1.8), y);
        this.ctx.moveTo(x, y - (size * 1.8));
        this.ctx.lineTo(x, y + (size * 1.8));
        this.ctx.stroke();
        this.ctx.restore();
    }

    drawSinglePathSelectionHighlight(path, mmToPx) {
        if (!path) return;
        this.ctx.save();
        this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.95)';
        this.ctx.lineWidth = 1 / this.viewZoom;
        this.ctx.shadowColor = 'rgba(59, 130, 246, 0.28)';
        this.ctx.shadowBlur = 8;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        if (path.type === 'circle') {
            this.ctx.beginPath();
            this.ctx.arc(path.x * mmToPx, path.y * mmToPx, path.r * mmToPx, 0, Math.PI * 2);
            this.ctx.stroke();
            this.ctx.restore();
            return;
        }

        if (path.type === 'rectangle') {
            this.ctx.strokeRect(path.x * mmToPx, path.y * mmToPx, (path.w || 0.1) * mmToPx, (path.h || 0.1) * mmToPx);
            this.ctx.restore();
            return;
        }

        if (path.type === 'text') {
            this.normalizeTextPath(path);
            this.drawVectorText(path, mmToPx, false);
            this.ctx.restore();
            return;
        }

        if (path.type === 'line' || path.type === 'polyline' || path.type === 'path') {
            const tracePoints = this.getPathTracePoints(path);
            if (!tracePoints.length) {
                this.ctx.restore();
                return;
            }
            this.ctx.beginPath();
            if (Array.isArray(path.segments) && path.segments.length > 0 && Math.abs(path.curve || 0) < 0.001 && !this.pathHasArcSegments(path)) {
                path.segments.forEach(segment => {
                    if (segment.type === 'M') this.ctx.moveTo(segment.x * mmToPx, segment.y * mmToPx);
                    else if (segment.type === 'L') this.ctx.lineTo(segment.x * mmToPx, segment.y * mmToPx);
                    else if (segment.type === 'C') this.ctx.bezierCurveTo(segment.x1 * mmToPx, segment.y1 * mmToPx, segment.x2 * mmToPx, segment.y2 * mmToPx, segment.x * mmToPx, segment.y * mmToPx);
                    else if (segment.type === 'Q') this.ctx.quadraticCurveTo(segment.x1 * mmToPx, segment.y1 * mmToPx, segment.x * mmToPx, segment.y * mmToPx);
                    else if (segment.type === 'Z') this.ctx.closePath();
                });
            } else {
                this.ctx.moveTo(tracePoints[0].x * mmToPx, tracePoints[0].y * mmToPx);
                for (let i = 1; i < tracePoints.length; i++) {
                    this.ctx.lineTo(tracePoints[i].x * mmToPx, tracePoints[i].y * mmToPx);
                }
            }
            this.ctx.stroke();
        }

        this.ctx.restore();
    }

    drawPaths() {
        const showMachineOutput = this.app?.ui?.currentVisualizerView === 'machine-output';
        const mmToPx = this.scale;
        const renderPaths = showMachineOutput ? this.buildMachineOutputPreviewPaths() : this.paths;
        const selectedPathSet = showMachineOutput ? new Set() : new Set(this.selectedPaths);
        const selectedNodeSet = showMachineOutput ? new Set() : new Set(this.selectedNodes.map(node => `${node.pathIdx}:${node.nodeIdx}`));
        const selectToolActive = !showMachineOutput && this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1;
        const warpToolActive = !showMachineOutput && this.app.ui.activeTool === 'warp' && this.selectedPaths.length >= 1;
        const nodeToolActive = !showMachineOutput && this.app.ui.activeTool === 'node';
        const selectionBox = selectToolActive ? this.getGroupBoundingBox(this.selectedPaths) : null;
        const warpSelectionBox = warpToolActive ? (this.warpOriginalBox || this.getGroupBoundingBox(this.selectedPaths)) : null;
        const selectionNodeSize = 8 / (mmToPx * this.viewZoom);
        const selectionCorners = selectionBox ? [
            { x: selectionBox.minX, y: selectionBox.minY },
            { x: selectionBox.minX + (selectionBox.maxX - selectionBox.minX) / 2, y: selectionBox.minY },
            { x: selectionBox.maxX, y: selectionBox.minY },
            { x: selectionBox.maxX, y: selectionBox.minY + (selectionBox.maxY - selectionBox.minY) / 2 },
            { x: selectionBox.maxX, y: selectionBox.maxY },
            { x: selectionBox.minX + (selectionBox.maxX - selectionBox.minX) / 2, y: selectionBox.maxY },
            { x: selectionBox.minX, y: selectionBox.maxY },
            { x: selectionBox.minX, y: selectionBox.minY + (selectionBox.maxY - selectionBox.minY) / 2 }
        ] : null;
        const warpHandles = warpSelectionBox
            ? (this.warpHandlePositions || this.getEightHandlePositions(warpSelectionBox))
            : null;
        if (showMachineOutput) {
            this.ctx.lineCap = 'butt';
            this.ctx.lineJoin = 'miter';
            this.ctx.miterLimit = 6;
        } else {
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
        }

        renderPaths.forEach((p, index) => {
            // Match canvas stroke color and thickness to assigned visualizer pen
            const penCfg = this.app.ui.visPenConfig[(p.pen || 1) - 1] || { color: '#3b82f6', thickness: 0.3 };

            // Skip rendering if layer is toggled off
            if (penCfg.visible === false) return;

            let baseOpacity = this.simulationActive ? 0.25 : 1.0;
            if (p.opacity !== undefined) {
                baseOpacity = p.opacity; // Allow paths to override opacity (e.g., String Art)
            }

            const rgbaColor = this.hexToRGBA(penCfg.color, baseOpacity);

            this.ctx.strokeStyle = rgbaColor;
            this.ctx.fillStyle = rgbaColor;

            let strokeWidth = penCfg.thickness;
            if (p.lineWidth !== undefined) {
                strokeWidth = p.lineWidth / mmToPx; // customWidth was passed as pixels, convert back for internal math
            }

            this.ctx.lineWidth = Math.max(0.1 / this.viewZoom, strokeWidth * mmToPx);

            // Selection highlight + tool-specific rendering
            if (selectedPathSet.has(index)) {
                if (nodeToolActive) {
                    // Draw Nodes
                    this.ctx.fillStyle = '#ffffff';
                    this.ctx.strokeStyle = '#3b82f6';
                    this.ctx.lineWidth = 1 / this.viewZoom;
                    const nodeSize = 6 / (mmToPx * this.viewZoom);

                    const drawNode = (nIdx, x, y) => {
                        const isSelected = selectedNodeSet.has(`${index}:${nIdx}`);
                        this.ctx.fillStyle = isSelected ? '#ef4444' : '#ffffff';
                        this.ctx.strokeRect(x * mmToPx - nodeSize / 2, y * mmToPx - nodeSize / 2, nodeSize, nodeSize);
                        this.ctx.fillRect(x * mmToPx - nodeSize / 2, y * mmToPx - nodeSize / 2, nodeSize, nodeSize);
                    };

                    if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                        if (p.segments) {
                            p.segments.forEach((s, j) => {
                                if (s.x !== undefined) drawNode(j, s.x, s.y);

                                // Draw handle arms and control points
                                this.ctx.save();
                                this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
                                this.ctx.setLineDash([2, 2]);

                                if (s.type === 'Q' || s.type === 'C') {
                                    // Draw Handle 1 for Q and C
                                    const prevX = (j > 0 && p.segments[j - 1].x !== undefined) ? p.segments[j - 1].x : p.points[0].x;
                                    const prevY = (j > 0 && p.segments[j - 1].y !== undefined) ? p.segments[j - 1].y : p.points[0].y;
                                    this.ctx.beginPath();
                                    this.ctx.moveTo(prevX * mmToPx, prevY * mmToPx);
                                    this.ctx.lineTo(s.x1 * mmToPx, s.y1 * mmToPx);
                                    this.ctx.stroke();
                                    drawNode(j + 10000, s.x1, s.y1); // Offset ID for handle 1

                                    if (s.type === 'C') {
                                        // Draw Handle 2 for C
                                        this.ctx.beginPath();
                                        this.ctx.moveTo(s.x * mmToPx, s.y * mmToPx);
                                        this.ctx.lineTo(s.x2 * mmToPx, s.y2 * mmToPx);
                                        this.ctx.stroke();
                                        drawNode(j + 20000, s.x2, s.y2); // Offset ID for handle 2
                                    }
                                }
                                this.ctx.restore();
                            });
                        } else {
                            p.points.forEach((pt, j) => drawNode(j, pt.x, pt.y));
                        }
                    } else if (p.type === 'circle') {
                        drawNode(0, p.x, p.y);
                    }
                } else if (warpToolActive && warpSelectionBox && warpHandles) {
                    if (index === this.selectedPaths[0]) {
                        this.ctx.strokeStyle = '#22c55e';
                        this.ctx.lineWidth = 1 / this.viewZoom;
                        this.ctx.setLineDash([6 / this.viewZoom, 4 / this.viewZoom]);
                        this.ctx.strokeRect(
                            warpSelectionBox.minX * mmToPx,
                            warpSelectionBox.minY * mmToPx,
                            (warpSelectionBox.maxX - warpSelectionBox.minX) * mmToPx,
                            (warpSelectionBox.maxY - warpSelectionBox.minY) * mmToPx
                        );
                        this.ctx.setLineDash([]);
                        this.ctx.fillStyle = '#ffffff';
                        warpHandles.forEach((handle, handleIndex) => {
                            const activeHandle = handleIndex === this.warpActiveHandleIndex;
                            this.ctx.strokeStyle = activeHandle ? '#f59e0b' : '#22c55e';
                            this.ctx.lineWidth = 1 / this.viewZoom;
                            this.ctx.strokeRect(
                                (handle.x - selectionNodeSize / 2) * mmToPx,
                                (handle.y - selectionNodeSize / 2) * mmToPx,
                                selectionNodeSize * mmToPx,
                                selectionNodeSize * mmToPx
                            );
                            this.ctx.fillRect(
                                (handle.x - selectionNodeSize / 2) * mmToPx,
                                (handle.y - selectionNodeSize / 2) * mmToPx,
                                selectionNodeSize * mmToPx,
                                selectionNodeSize * mmToPx
                            );
                        });
                    }
                } else if (selectToolActive && selectionBox && selectionCorners) {
                    if (index === this.selectedPaths[0]) {
                        this.ctx.strokeStyle = '#3b82f6';
                        this.ctx.lineWidth = 1 / this.viewZoom;
                        this.ctx.strokeRect(
                            selectionBox.minX * mmToPx,
                            selectionBox.minY * mmToPx,
                            (selectionBox.maxX - selectionBox.minX) * mmToPx,
                            (selectionBox.maxY - selectionBox.minY) * mmToPx
                        );

                        this.ctx.fillStyle = '#ffffff';
                        selectionCorners.forEach(c => {
                            this.ctx.strokeRect(
                                (c.x - selectionNodeSize / 2) * mmToPx,
                                (c.y - selectionNodeSize / 2) * mmToPx,
                                selectionNodeSize * mmToPx,
                                selectionNodeSize * mmToPx
                            );
                            this.ctx.fillRect(
                                (c.x - selectionNodeSize / 2) * mmToPx,
                                (c.y - selectionNodeSize / 2) * mmToPx,
                                selectionNodeSize * mmToPx,
                                selectionNodeSize * mmToPx
                            );
                        });

                        // Draw Rotation Handle (Stalk + Circle) at Top-Mid
                        const tm = selectionCorners[1];
                        const stalkLen = 20 / (mmToPx * this.viewZoom);
                        this.ctx.beginPath();
                        this.ctx.moveTo(tm.x * mmToPx, tm.y * mmToPx);
                        this.ctx.lineTo(tm.x * mmToPx, (tm.y - stalkLen) * mmToPx);
                        this.ctx.stroke();

                        this.ctx.beginPath();
                        this.ctx.arc(tm.x * mmToPx, (tm.y - stalkLen) * mmToPx, selectionNodeSize / 2 * mmToPx, 0, Math.PI * 2);
                        this.ctx.fill();
                        this.ctx.stroke();
                    }
                } else {
                    this.ctx.shadowColor = 'rgba(59, 130, 246, 0.4)';
                    this.ctx.shadowBlur = 4;
                    this.ctx.lineWidth = Math.max(0.2 / this.viewZoom, (penCfg.thickness + 0.1) * mmToPx);
                }
            } else {
                this.ctx.shadowColor = 'transparent';
                this.ctx.shadowBlur = 0;
            }

            if (p.type === 'circle') {
                this.ctx.beginPath();
                this.ctx.arc(p.x * mmToPx, p.y * mmToPx, p.r * mmToPx, 0, Math.PI * 2);
                this.ctx.stroke();
            } else if (p.type === 'rectangle') {
                this.ctx.strokeRect(p.x * mmToPx, p.y * mmToPx, (p.w || 0.1) * mmToPx, (p.h || 0.1) * mmToPx);
            } else if (p.type === 'text') {
                this.normalizeTextPath(p);
                this.drawVectorText(p, mmToPx, index === this.editingPathIdx);
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                const tracePoints = this.getPathTracePoints(p);
                if (!tracePoints.length) return;
                this.ctx.beginPath();
                if (Array.isArray(p.segments) && p.segments.length > 0 && Math.abs(p.curve || 0) < 0.001 && !this.pathHasArcSegments(p)) {
                    p.segments.forEach(s => {
                        if (s.type === 'M') this.ctx.moveTo(s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'L') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'C') this.ctx.bezierCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x2 * mmToPx, s.y2 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'Q') this.ctx.quadraticCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'Z') this.ctx.closePath();
                    });
                } else {
                    this.ctx.moveTo(tracePoints[0].x * mmToPx, tracePoints[0].y * mmToPx);
                    for (let i = 1; i < tracePoints.length; i++) {
                        this.ctx.lineTo(tracePoints[i].x * mmToPx, tracePoints[i].y * mmToPx);
                    }
                }
                this.ctx.stroke();
            }
        });

        if (!showMachineOutput && selectedPathSet.size > 0) {
            this.selectedPaths.forEach(pathIdx => {
                const path = this.paths[pathIdx];
                if (!path) return;
                this.drawSinglePathSelectionHighlight(path, mmToPx);
            });
        }

        if (!showMachineOutput && selectToolActive && selectionBox && selectionCorners) {
            this.ctx.save();
            this.ctx.strokeStyle = '#3b82f6';
            this.ctx.fillStyle = '#ffffff';
            this.ctx.lineWidth = 1 / this.viewZoom;
            this.ctx.setLineDash([]);
            this.ctx.strokeRect(
                selectionBox.minX * mmToPx,
                selectionBox.minY * mmToPx,
                (selectionBox.maxX - selectionBox.minX) * mmToPx,
                (selectionBox.maxY - selectionBox.minY) * mmToPx
            );
            selectionCorners.forEach(c => {
                this.ctx.strokeRect(
                    (c.x - selectionNodeSize / 2) * mmToPx,
                    (c.y - selectionNodeSize / 2) * mmToPx,
                    selectionNodeSize * mmToPx,
                    selectionNodeSize * mmToPx
                );
                this.ctx.fillRect(
                    (c.x - selectionNodeSize / 2) * mmToPx,
                    (c.y - selectionNodeSize / 2) * mmToPx,
                    selectionNodeSize * mmToPx,
                    selectionNodeSize * mmToPx
                );
            });

            const tm = selectionCorners[1];
            const stalkLen = 20 / (mmToPx * this.viewZoom);
            this.ctx.beginPath();
            this.ctx.moveTo(tm.x * mmToPx, tm.y * mmToPx);
            this.ctx.lineTo(tm.x * mmToPx, (tm.y - stalkLen) * mmToPx);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(tm.x * mmToPx, (tm.y - stalkLen) * mmToPx, selectionNodeSize / 2 * mmToPx, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
            this.ctx.restore();
        }

        if (!showMachineOutput && warpToolActive && warpSelectionBox && warpHandles) {
            this.ctx.save();
            this.ctx.strokeStyle = '#22c55e';
            this.ctx.fillStyle = '#ffffff';
            this.ctx.lineWidth = 1 / this.viewZoom;
            this.ctx.setLineDash([6 / this.viewZoom, 4 / this.viewZoom]);
            this.ctx.strokeRect(
                warpSelectionBox.minX * mmToPx,
                warpSelectionBox.minY * mmToPx,
                (warpSelectionBox.maxX - warpSelectionBox.minX) * mmToPx,
                (warpSelectionBox.maxY - warpSelectionBox.minY) * mmToPx
            );
            this.ctx.setLineDash([]);
            warpHandles.forEach((handle, handleIndex) => {
                const activeHandle = handleIndex === this.warpActiveHandleIndex;
                this.ctx.strokeStyle = activeHandle ? '#f59e0b' : '#22c55e';
                this.ctx.strokeRect(
                    (handle.x - selectionNodeSize / 2) * mmToPx,
                    (handle.y - selectionNodeSize / 2) * mmToPx,
                    selectionNodeSize * mmToPx,
                    selectionNodeSize * mmToPx
                );
                this.ctx.fillRect(
                    (handle.x - selectionNodeSize / 2) * mmToPx,
                    (handle.y - selectionNodeSize / 2) * mmToPx,
                    selectionNodeSize * mmToPx,
                    selectionNodeSize * mmToPx
                );
            });
            this.ctx.restore();
        }

        if (!showMachineOutput && this.isCreatingBezier && this.currentBezierPathIdx >= 0) {
            const activePath = this.paths[this.currentBezierPathIdx];
            const previewStart = activePath?.points?.[activePath.points.length - 1];
            const previewEnd = this.bezierPreviewPoint;
            if (previewStart && previewEnd && Math.hypot(previewEnd.x - previewStart.x, previewEnd.y - previewStart.y) > 0.01) {
                this.ctx.save();
                this.ctx.setLineDash([4, 4]);
                this.ctx.strokeStyle = 'rgba(37, 99, 235, 0.75)';
                this.ctx.lineWidth = Math.max(0.15 / this.viewZoom, 0.45 * mmToPx);
                this.ctx.beginPath();
                this.ctx.moveTo(previewStart.x * mmToPx, previewStart.y * mmToPx);
                this.ctx.lineTo(previewEnd.x * mmToPx, previewEnd.y * mmToPx);
                this.ctx.stroke();
                this.ctx.restore();
            }
        }

        // Draw Pattern Preview
        if (!showMachineOutput) {
            this.ctx.save();
            this.ctx.setLineDash([5, 5]);
            this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
            this.patternPreviewPaths.forEach(p => {
                if (p.type === 'circle') {
                    this.ctx.beginPath();
                    this.ctx.arc(p.x * mmToPx, p.y * mmToPx, p.r * mmToPx, 0, Math.PI * 2);
                    this.ctx.stroke();
                } else if (p.type === 'rectangle') {
                    this.ctx.strokeRect(p.x * mmToPx, p.y * mmToPx, (p.w || 0.1) * mmToPx, (p.h || 0.1) * mmToPx);
                } else if (p.type === 'text') {
                    this.normalizeTextPath(p);
                    this.drawVectorText(p, mmToPx, false);
                } else if (p.points || p.type === 'path') {
                    const tracePoints = this.getPathTracePoints(p);
                    if (!tracePoints.length) return;
                    this.ctx.beginPath();
                    if (Array.isArray(p.segments) && p.segments.length > 0 && Math.abs(p.curve || 0) < 0.001 && !this.pathHasArcSegments(p)) {
                        p.segments.forEach(s => {
                            if (s.type === 'M') this.ctx.moveTo(s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'L') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'C') this.ctx.bezierCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x2 * mmToPx, s.y2 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'Q') this.ctx.quadraticCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'Z') this.ctx.closePath();
                        });
                    } else {
                        this.ctx.moveTo(tracePoints[0].x * mmToPx, tracePoints[0].y * mmToPx);
                        for (let i = 1; i < tracePoints.length; i++) {
                            this.ctx.lineTo(tracePoints[i].x * mmToPx, tracePoints[i].y * mmToPx);
                        }
                    }
                    this.ctx.stroke();
                }
            });
            this.ctx.restore();
            this.ctx.setLineDash([]); // Reset line dash after pattern preview
        }

        // Draw Simulation Overlay
        if (this.simulationActive) {
            let remainingDistance = this.simulationProgress;
            for (let i = 0; i < this.simulationRoute.length && remainingDistance > 0; i++) {
                const segment = this.simulationRoute[i];
                const drawLength = Math.min(remainingDistance, segment.length);
                const penCfg = this.app.ui.visPenConfig[(segment.pen || 1) - 1] || { color: '#3b82f6', thickness: 0.3 };

                if (segment.penDown && penCfg.visible === false) {
                    remainingDistance -= drawLength;
                    continue;
                }

                this.ctx.strokeStyle = segment.penDown ? penCfg.color : 'rgba(148, 163, 184, 0.6)';
                this.ctx.lineWidth = segment.penDown
                    ? Math.max(0.5, penCfg.thickness * mmToPx)
                    : Math.max(0.35, 0.18 * mmToPx);
                this.ctx.shadowColor = 'transparent';
                this.ctx.shadowBlur = 0;
                this.ctx.setLineDash(segment.penDown ? [] : [6 / Math.max(1, this.viewZoom), 5 / Math.max(1, this.viewZoom)]);
                this.ctx.beginPath();
                this.ctx.moveTo(segment.x1 * mmToPx, segment.y1 * mmToPx);

                if (drawLength >= segment.length) {
                    this.ctx.lineTo(segment.x2 * mmToPx, segment.y2 * mmToPx);
                } else {
                    const t = segment.length > 0 ? drawLength / segment.length : 1;
                    const x = segment.x1 + ((segment.x2 - segment.x1) * t);
                    const y = segment.y1 + ((segment.y2 - segment.y1) * t);
                    this.ctx.lineTo(x * mmToPx, y * mmToPx);
                }

                this.ctx.stroke();
                remainingDistance -= drawLength;
            }
            this.ctx.setLineDash([]);
        }

        // Draw Marquee Box on Top
        if (this.isMarqueeSelecting) {
            this.ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'; // Tailwind blue-500 w/ opacity
            this.ctx.strokeStyle = '#3b82f6';
            this.ctx.lineWidth = 1;
            const mw = (this.marqueeEndX - this.dragStartX) * mmToPx;
            const mh = (this.marqueeEndY - this.dragStartY) * mmToPx;
            this.ctx.fillRect(this.dragStartX * mmToPx, this.dragStartY * mmToPx, mw, mh);
            this.ctx.strokeRect(this.dragStartX * mmToPx, this.dragStartY * mmToPx, mw, mh);
        }

        this.ctx.restore(); // Restore context to avoid accumulating transformations
    }

    buildMachineOutputPreviewPaths() {
        const hpgl = this.app?.hpgl;
        if (!hpgl) return this.paths;

        const previewPaths = [];
        const pushPolyline = (points, pen) => {
            if (!Array.isArray(points) || points.length < 2) return;
            previewPaths.push({ type: 'polyline', points, pen });
        };
        this.paths.forEach((path) => {
            if (!path) return;
            const pen = path.pen || 1;

            if (path.type === 'circle') {
                const steps = 96;
                const points = [];
                for (let i = 0; i <= steps; i++) {
                    const angle = (i / steps) * Math.PI * 2;
                    points.push({
                        x: path.x + Math.cos(angle) * path.r,
                        y: path.y + Math.sin(angle) * path.r
                    });
                }
                pushPolyline(points, pen);
                return;
            }

            if (path.type === 'rectangle') {
                const points = hpgl.getRectanglePoints(path.x, path.y, path.x + (path.w || 0), path.y + (path.h || 0));
                pushPolyline(points, pen);
                return;
            }

            if (path.type === 'text') {
                this.normalizeTextPath(path);
                if (this.isCreativeTextPath(path) && typeof CreativeTextEngine !== 'undefined') {
                    CreativeTextEngine.buildPlotLoops(path).forEach(loop => pushPolyline(loop, pen));
                } else {
                    this.getVectorTextSegments(path).forEach(segment => {
                        pushPolyline([
                            { x: segment.x1, y: segment.y1 },
                            { x: segment.x2, y: segment.y2 }
                        ], pen);
                    });
                }
                return;
            }

            if (path.type === 'line' || path.type === 'polyline' || path.type === 'path') {
                let tracePoints = null;
                if (path.machinePreviewSource?.kind === 'dxfBulgePolyline') {
                    tracePoints = hpgl._buildDXFPolylinePoints(
                        path.machinePreviewSource.vertices || [],
                        !!path.machinePreviewSource.isClosed
                    );
                } else if (path.machinePreviewSource?.kind === 'dxfSpline') {
                    tracePoints = hpgl._sampleDXFSplineDefinition(path.machinePreviewSource);
                } else {
                    tracePoints = hpgl.getExportTracePointsForPath(path);
                }
                if (Array.isArray(tracePoints) && tracePoints.length >= 2) {
                    pushPolyline(tracePoints.map(point => ({ x: point.x, y: point.y })), pen);
                }
            }
        });

        return previewPaths;
    }

    drawVectorText(p, mmToPx, isEditing) {
        this.normalizeTextPath(p);
        if (this.isCreativeTextPath(p) && typeof CreativeTextEngine !== 'undefined') {
            CreativeTextEngine.draw(this.ctx, p, mmToPx, this.viewZoom, isEditing, this.cursorBlink);
            return;
        }

        if (typeof HandwritingLibrary === 'undefined') {
            // Fallback to basic text if library not loaded
            const fontSizePx = Math.max(12, (p.fontSize || 10) * mmToPx);
            const drawAngle = this.normalizeTextRotation(p.rotation || 0) * (Math.PI / 180);
            this.ctx.save();
            this.ctx.translate(p.x * mmToPx, p.y * mmToPx);
            this.ctx.rotate(drawAngle);
            this.ctx.font = `${fontSizePx}px "JetBrains Mono", monospace`;
            this.ctx.fillText(p.text, 0, 0);
            this.ctx.restore();
            return;
        }

        const style = 'plotter';
        const glyphLibrary = HandwritingLibrary[style];

        // Roland S command: n=0 -> 0.8mm, n=3 (S3) -> 3.2mm
        const nAtSize = Math.max(0, Math.min(127, Math.round((p.fontSize || 10) / 0.8) - 1));
        const h = (nAtSize + 1) * 0.8;
        const totalStep = (nAtSize + 1) * 0.6;

        const nRotate = this.normalizeTextRotation(p.rotation || 0) / 90;
        const drawAngle = nRotate * (Math.PI / 2);

        this.ctx.save();
        this.ctx.translate(p.x * mmToPx, p.y * mmToPx);
        this.ctx.rotate(drawAngle);

        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.ctx.beginPath();
        for (let i = 0; i < p.text.length; i++) {
            const char = p.text[i];
            const glyph = glyphLibrary[char] || glyphLibrary['?'];
            if (!glyph) continue;

            let strokes = glyph;
            if (Array.isArray(glyph) && Array.isArray(glyph[0]) && Array.isArray(glyph[0][0]) && typeof glyph[0][0][0] === 'object') {
                strokes = glyph[0];
            }

            const xOffset = i * totalStep;
            strokes.forEach(stroke => {
                if (stroke.length < 2) return;
                // Font data is usually in {x,y} objects. 
                // Roland height is (n+1)*0.8. Scale coordinates by h.
                this.ctx.moveTo((xOffset + stroke[0].x * h) * mmToPx, (stroke[0].y - 1) * h * mmToPx);
                for (let j = 1; j < stroke.length; j++) {
                    this.ctx.lineTo((xOffset + stroke[j].x * h) * mmToPx, (stroke[j].y - 1) * h * mmToPx);
                }
            });
        }
        this.ctx.stroke();

        if (isEditing && this.cursorBlink) {
            const cursorX = p.text.length * totalStep;
            this.ctx.fillStyle = '#ef4444';
            this.ctx.fillRect(cursorX * mmToPx + 2, -h * mmToPx * 0.9, 2 / this.viewZoom, h * mmToPx);
        }

        this.ctx.restore();
    }

    getVectorTextSegments(p) {
        if (!p || p.type !== 'text') return [];
        this.normalizeTextPath(p);
        if (this.isCreativeTextPath(p) && typeof CreativeTextEngine !== 'undefined') {
            return CreativeTextEngine.getSegments(p);
        }
        if (typeof HandwritingLibrary === 'undefined') return [];

        const style = 'plotter';
        const glyphLibrary = HandwritingLibrary[style];
        if (!glyphLibrary) return [];

        const normalizedRotation = this.normalizeTextRotation(p.rotation || 0);
        const cacheKey = `${p.text || ''}|${p.fontSize || 10}|${normalizedRotation}|${p.x}|${p.y}`;
        if (p._vectorTextCache && p._vectorTextCache.key === cacheKey) {
            return p._vectorTextCache.segments;
        }

        const nAtSize = Math.max(0, Math.min(127, Math.round((p.fontSize || 10) / 0.8) - 1));
        const h = (nAtSize + 1) * 0.8;
        const totalStep = (nAtSize + 1) * 0.6;
        const angle = normalizedRotation * (Math.PI / 180);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const segments = [];

        const rotatePoint = (x, y) => ({
            x: p.x + (x * cosA - y * sinA),
            y: p.y + (x * sinA + y * cosA)
        });

        for (let i = 0; i < p.text.length; i++) {
            const char = p.text[i];
            const glyph = glyphLibrary[char] || glyphLibrary['?'];
            if (!glyph) continue;

            let strokes = glyph;
            if (Array.isArray(glyph) && Array.isArray(glyph[0]) && Array.isArray(glyph[0][0]) && typeof glyph[0][0][0] === 'object') {
                strokes = glyph[0];
            }

            const xOffset = i * totalStep;
            strokes.forEach(stroke => {
                if (!Array.isArray(stroke) || stroke.length < 2) return;
                for (let j = 1; j < stroke.length; j++) {
                    const start = rotatePoint(
                        xOffset + stroke[j - 1].x * h,
                        (stroke[j - 1].y - 1) * h
                    );
                    const end = rotatePoint(
                        xOffset + stroke[j].x * h,
                        (stroke[j].y - 1) * h
                    );
                    segments.push({
                        x1: start.x,
                        y1: start.y,
                        x2: end.x,
                        y2: end.y
                    });
                }
            });
        }

        p._vectorTextCache = {
            key: cacheKey,
            segments
        };
        return segments;
    }

    explodeSelectedCreativeText() {
        if (!Array.isArray(this.selectedPaths) || this.selectedPaths.length === 0 || typeof CreativeTextEngine === 'undefined') {
            return 0;
        }

        const selectedSet = new Set(this.selectedPaths);
        const rebuiltPaths = [];
        const nextSelected = [];
        let explodedCount = 0;

        this.paths.forEach((path, index) => {
            if (selectedSet.has(index) && this.isCreativeTextPath(path)) {
                const explodedPaths = CreativeTextEngine.explodeToPaths(path);
                if (explodedPaths.length > 0) {
                    const startIndex = rebuiltPaths.length;
                    rebuiltPaths.push(...explodedPaths);
                    explodedPaths.forEach((_, offset) => nextSelected.push(startIndex + offset));
                    explodedCount += 1;
                    return;
                }
            }

            const nextIndex = rebuiltPaths.length;
            rebuiltPaths.push(path);
            if (selectedSet.has(index)) nextSelected.push(nextIndex);
        });

        if (explodedCount > 0) {
            this.paths = rebuiltPaths;
            this.selectedPaths = nextSelected;
            this.editingPathIdx = -1;
            this.saveUndoState();
            this.app?.ui?.logToConsole(`System: Exploded ${explodedCount} creative text object(s) into editable outlines.`);
            this.draw();
        }

        return explodedCount;
    }

    addPath(pathData) {
        this.paths.push(pathData);
        this.saveUndoState();
        this.draw();
    }

    hexToRGBA(hex, opacity) {
        let r = 0, g = 0, b = 0;
        if (hex.length === 4) {
            r = parseInt(hex[1] + hex[1], 16);
            g = parseInt(hex[2] + hex[2], 16);
            b = parseInt(hex[3] + hex[3], 16);
        } else if (hex.length === 7) {
            r = parseInt(hex.substring(1, 3), 16);
            g = parseInt(hex.substring(3, 5), 16);
            b = parseInt(hex.substring(5, 7), 16);
        }
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    refreshSimulationButton() {
        const btn = document.getElementById('btn-simulate');
        if (!btn) return;
        if (this.simulationActive) {
            btn.textContent = 'Stop';
            btn.title = 'Stop simulation';
            btn.style.background = 'var(--danger)';
            btn.style.color = 'white';
        } else {
            btn.textContent = 'Simulate';
            btn.title = 'Simulate Plotter Movement';
            btn.style.background = 'var(--accent-blue)';
            btn.style.color = 'white';
        }
    }

    stopSimulation(reason = 'stopped') {
        if (!this.simulationActive && reason !== 'complete') {
            this.refreshSimulationButton();
            return false;
        }

        this.simulationActive = false;
        this.simulationProgress = 0;
        this.simulationLastTimestamp = 0;
        this.refreshSimulationButton();
        this.draw();

        if (reason === 'stopped') {
            this.app?.ui?.logToConsole('System: Plot simulation stopped.');
        } else if (reason === 'escape') {
            this.app?.ui?.logToConsole('System: Plot simulation stopped with Escape.');
        } else if (reason === 'complete') {
            this.app?.ui?.logToConsole('System: Simulation complete.');
        }

        return true;
    }

    startSimulation() {
        if (this.paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to simulate.');
            return;
        }

        if (this.simulationActive) {
            this.stopSimulation('stopped');
            return;
        }

        this.simulationRoute = this.buildSimulationRoute();
        this.simulationRouteLength = this.simulationRoute.reduce((sum, segment) => sum + segment.length, 0);
        if (this.simulationRouteLength <= 0) {
            this.simulationActive = false;
            this.simulationProgress = 0;
            this.app.ui.logToConsole('System: No drawable motion found for simulation.', 'error');
            return;
        }

        this.simulationActive = true;
        this.simulationProgress = 0;
        this.simulationLastTimestamp = 0;
        this.refreshSimulationButton();
        const toSimMachinePoint = (point) => {
            if (!point) return null;
            if (this.app?.hpgl?.transformOutputPoint) {
                return this.app.hpgl.transformOutputPoint(point.x, point.y);
            }
            return point;
        };

        if (this.simulationRoute[0] && this.app?.serial?.setEstimatedPosition) {
            const startPoint = toSimMachinePoint({ x: this.simulationRoute[0].x1, y: this.simulationRoute[0].y1 });
            if (startPoint) this.app.serial.setEstimatedPosition(startPoint.x, startPoint.y);
        }
        this.app.ui.logToConsole('System: Plot simulation started.');

        const tick = (timestamp) => {
            if (!this.simulationActive) return;

            if (!this.simulationLastTimestamp) this.simulationLastTimestamp = timestamp;
            const deltaSeconds = Math.max(0, (timestamp - this.simulationLastTimestamp) / 1000);
            this.simulationLastTimestamp = timestamp;
            const effectiveSpeed = Math.min(
                this.simulationSpeed * (this.simulationSpeedMultiplier || 1),
                this.simulationMaxSpeedMmPerMin / 60
            );
            this.simulationProgress += effectiveSpeed * deltaSeconds;

            const currentPos = this.getSimulationPositionAtDistance(this.simulationProgress);
            if (currentPos && this.app?.serial?.setEstimatedPosition) {
                const machinePoint = toSimMachinePoint(currentPos);
                if (machinePoint) this.app.serial.setEstimatedPosition(machinePoint.x, machinePoint.y);
            } else {
                this.draw();
            }

            if (this.simulationProgress >= this.simulationRouteLength) {
                const finalSegment = this.simulationRoute[this.simulationRoute.length - 1];
                if (finalSegment && this.app?.serial?.setEstimatedPosition) {
                    const finalPoint = toSimMachinePoint({ x: finalSegment.x2, y: finalSegment.y2 });
                    if (finalPoint) this.app.serial.setEstimatedPosition(finalPoint.x, finalPoint.y);
                }
                this.stopSimulation('complete');
            } else {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
    }

    buildSimulationRoute() {
        const segments = [];
        const addSegment = (x1, y1, x2, y2, pen, penDown = true) => {
            const length = Math.hypot(x2 - x1, y2 - y1);
            if (!Number.isFinite(length) || length <= 0) return;
            segments.push({ x1, y1, x2, y2, length, pen: pen || 1, penDown });
        };

        const optimizedPlotItems = this.app?.hpgl?.optimizePlotPaths
            ? this.app.hpgl.optimizePlotPaths(this.paths)
            : this.paths.map(path => ({ path }));

        let currentPoint = null;
        optimizedPlotItems.forEach(item => {
            const path = item.path;
            const pen = path.pen || 1;
            let tracePoints = Array.isArray(item.plotPoints) && item.plotPoints.length >= 2
                ? item.plotPoints
                : null;

            if (!tracePoints || tracePoints.length < 2) {
                if (path.type === 'circle' || path.type === 'rectangle' || path.type === 'line' || path.type === 'polyline' || path.type === 'path') {
                    tracePoints = this.app?.hpgl?.getExportTracePointsForPath?.(path) || null;
                } else if (path.type === 'text') {
                    const textSegments = this.getVectorTextSegments(path);
                    if (Array.isArray(textSegments) && textSegments.length > 0) {
                        textSegments.forEach(segment => {
                            const start = { x: segment.x1, y: segment.y1 };
                            const end = { x: segment.x2, y: segment.y2 };
                            if (currentPoint && Math.hypot(currentPoint.x - start.x, currentPoint.y - start.y) > 0.001) {
                                addSegment(currentPoint.x, currentPoint.y, start.x, start.y, pen, false);
                            }
                            addSegment(start.x, start.y, end.x, end.y, pen, true);
                            currentPoint = end;
                        });
                    }
                    return;
                }
            }

            if (!Array.isArray(tracePoints) || tracePoints.length < 2) return;

            const firstPoint = tracePoints[0];
            if (currentPoint && Math.hypot(currentPoint.x - firstPoint.x, currentPoint.y - firstPoint.y) > 0.001) {
                addSegment(currentPoint.x, currentPoint.y, firstPoint.x, firstPoint.y, pen, false);
            }

            for (let i = 1; i < tracePoints.length; i++) {
                addSegment(tracePoints[i - 1].x, tracePoints[i - 1].y, tracePoints[i].x, tracePoints[i].y, pen, true);
            }
            currentPoint = tracePoints[tracePoints.length - 1];
        });

        return segments;
    }

    getSimulationPositionAtDistance(distance) {
        if (!this.simulationRoute.length) return null;

        let remaining = Math.max(0, distance);
        for (let i = 0; i < this.simulationRoute.length; i++) {
            const segment = this.simulationRoute[i];
            if (remaining <= segment.length) {
                const t = segment.length > 0 ? remaining / segment.length : 1;
                return {
                    x: segment.x1 + ((segment.x2 - segment.x1) * t),
                    y: segment.y1 + ((segment.y2 - segment.y1) * t)
                };
            }
            remaining -= segment.length;
        }

        const lastSegment = this.simulationRoute[this.simulationRoute.length - 1];
        return lastSegment ? { x: lastSegment.x2, y: lastSegment.y2 } : null;
    }

    groupSelectedPaths() {
        if (this.selectedPaths.length < 2) return;
        const groupId = 'group_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
        this.selectedPaths.forEach(idx => {
            this.paths[idx].groupId = groupId;
        });
        this.saveUndoState();
        this.app.ui.logToConsole(`System: Grouped ${this.selectedPaths.length} objects.`);
        this.draw();
    }

    ungroupSelectedPaths() {
        if (this.selectedPaths.length === 0) return;
        let count = 0;
        const parentGroupsToClear = new Set();
        const groupsToClear = new Set();
        this.selectedPaths.forEach(idx => {
            if (this.paths[idx].parentGroupId) {
                parentGroupsToClear.add(this.paths[idx].parentGroupId);
            } else if (this.paths[idx].groupId) {
                groupsToClear.add(this.paths[idx].groupId);
            }
        });

        this.paths.forEach(p => {
            if (parentGroupsToClear.size > 0 && parentGroupsToClear.has(p.parentGroupId)) {
                delete p.parentGroupId;
                count++;
            } else if (groupsToClear.has(p.groupId)) {
                delete p.groupId;
                count++;
            }
        });

        if (count > 0) {
            this.saveUndoState();
            this.app.ui.logToConsole(`System: Ungrouped ${count} objects.`);
            this.draw();
        }
    }

    expandSelectionToGroups() {
        const parentGroupIds = new Set();
        const groupIds = new Set();
        this.selectedPaths.forEach(idx => {
            if (this.paths[idx].parentGroupId) parentGroupIds.add(this.paths[idx].parentGroupId);
            else if (this.paths[idx].groupId) groupIds.add(this.paths[idx].groupId);
        });

        if (parentGroupIds.size === 0 && groupIds.size === 0) return;

        const newIndices = new Set(this.selectedPaths);
        this.paths.forEach((p, i) => {
            if (parentGroupIds.size > 0) {
                if (p.parentGroupId && parentGroupIds.has(p.parentGroupId)) {
                    newIndices.add(i);
                }
            } else if (p.groupId && groupIds.has(p.groupId)) {
                newIndices.add(i);
            }
        });
        this.selectedPaths = Array.from(newIndices);
    }
}
