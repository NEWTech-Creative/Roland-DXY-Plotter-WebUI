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
        this.closedFillRegionsCache = null;
        this.viewportHorizontalShift = 0;
        this.viewportVerticalShift = 0;
        this.bedRenderWidthPx = 0;
        this.bedRenderHeightPx = 0;
        this.cursorBlink = true;
        this.drawFramePending = false;
        this.lastSavedCanvasJson = '';
        this.persistenceEventsBound = false;
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

    saveUndoState() {
        this.invalidateFillRegionCache();
        this.undoStack.push(JSON.stringify(this.paths));
        this.redoStack = []; // Clear redo stack on new action
        if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
        this.saveCurrentState(); // Also persist to localStorage on edit
    }

    ensureUndoCheckpoint() {
        const current = JSON.stringify(this.paths);
        if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== current) {
            this.undoStack.push(current);
            this.redoStack = [];
            if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
            this.saveCurrentState();
        }
    }

    saveCurrentState() {
        try {
            const serialized = JSON.stringify(this.paths);
            localStorage.setItem('canvasBackup', serialized);
            this.lastSavedCanvasJson = serialized;
        } catch (e) {
            // Persist fail
        }
    }

    saveCurrentStateIfChanged() {
        try {
            const serialized = JSON.stringify(this.paths);
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
                this.lastSavedCanvasJson = saved;
                this.invalidateFillRegionCache();
                this.draw();
                if (this.app && this.app.ui) {
                    this.app.ui.logToConsole('System: Previous canvas drawing restored.');
                }
            }
        } catch (e) {
            // Load fail
        }
    }

    undo() {
        this.resetBezierToolState();
        if (this.undoStack.length > 1) {
            const current = this.undoStack.pop();
            this.redoStack.push(current);
            const prev = this.undoStack[this.undoStack.length - 1];
            this.paths = JSON.parse(prev);
            this.invalidateFillRegionCache();
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Undo action performed.');
        } else if (this.undoStack.length === 1) {
            const current = this.undoStack.pop();
            this.redoStack.push(current);
            this.paths = [];
            this.invalidateFillRegionCache();
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Undo back to empty canvas.');
        }
    }

    redo() {
        this.resetBezierToolState();
        if (this.redoStack.length > 0) {
            const next = this.redoStack.pop();
            this.undoStack.push(next);
            this.paths = JSON.parse(next);
            this.invalidateFillRegionCache();
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Redo action performed.');
        }
    }

    addPath(pathObj) {
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
                    this.finalizeBezierPath(true);
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
                    if (p.text.length === 0) this.paths.splice(this.editingPathIdx, 1);
                    this.editingPathIdx = -1;
                    this.saveCurrentState();
                } else if (e.key === 'Backspace') {
                    p.text = p.text.slice(0, -1);
                    delete p._vectorTextCache;
                    this.saveCurrentState();
                } else if (e.key.length === 1) {
                    p.text += e.key;
                    delete p._vectorTextCache;
                    this.saveCurrentState();
                }
                this.draw();
                return;
            }

            // Escape / Cancel
            if (e.key === 'Escape') {
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
            if (this.app.ui.activeTool === 'bezier' && this.isCreatingBezier) {
                e.preventDefault();
                this.finalizeBezierPath(true);
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
            if (e.button === 1 || (this.app.ui.activeTool === 'select' || this.app.ui.activeTool === 'node' || this.app.ui.activeTool === 'shape')) {
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

                if (this.app.ui.activeTool === 'select') {
                    // 1. Check Resize Handles FIRST
                    if (this.selectedPaths.length >= 1) {
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
                            this.selectedPaths = [];
                            this.editingPathIdx = -1; // Stop editing text if clicked outside
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
            else if (this.isDragging) cursor = 'move';
            else if (this.isMarqueeSelecting) cursor = 'crosshair';
            else if (this.editingPathIdx !== -1) cursor = 'text'; // Text editing cursor
            else if (this.app.ui.activeTool === 'bezier') cursor = 'crosshair';
            else if (this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1) {
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
            } else if (this.hitTest(pos.xMM, pos.yMM) !== -1) {
                cursor = 'pointer';
            }
            this.canvas.style.cursor = cursor;

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
                            p.rotation = this.normalizeTextRotation((orig.rotation || 0) + (deltaAngle * 180 / Math.PI));
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

                if (this.app.ui.activeTool === 'node' && this.selectedNodes.length > 0) {
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
            if (!this.isPanning && !this.isMarqueeSelecting && !this.isDragging) {
                if (!checkTarget(e)) return;
            }

            this.snapPoint = null;

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
                this.saveUndoState(); // Done editing node/drag/resize/rotate
            }
            this.isDragging = false;
            this.isRotating = false;
            this.isMarqueeSelecting = false;

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

    handleCanvasClick(xMM, yMM) {
        const tool = this.app.ui.activeTool;
        if (tool === 'text') {
            const visPen = this.app.ui.activeVisualizerPen || 1;
            this.paths.push({ type: 'text', text: '', x: xMM, y: yMM, pen: visPen, fontSize: 10, rotation: 0 });
            this.editingPathIdx = this.paths.length - 1;
            this.selectedPaths = [this.editingPathIdx];
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
                const hitPoints = (p.type === 'path' && Array.isArray(p.segments) && p.segments.length > 0)
                    ? this.flattenPathForFill(p)
                    : p.points;
                for (let j = 0; j < hitPoints.length - 1; j++) {
                    const p1 = hitPoints[j];
                    const p2 = hitPoints[j + 1];
                    const d = this.distToSegment({ x: xMM, y: yMM }, p1, p2);
                    if (d <= tol) return i;
                }
            } else if (p.type === 'text') {
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
            if (p.points && p.points.length > 0) {
                p.points.forEach(pt => {
                    if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
                    if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
                });
            }
            if (p.segments && p.segments.length > 0) {
                p.segments.forEach(s => {
                    if (s.x !== undefined) {
                        if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
                        if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
                    }
                    if (s.x1 !== undefined) {
                        if (s.x1 < minX) minX = s.x1; if (s.x1 > maxX) maxX = s.x1;
                        if (s.y1 !== undefined) { if (s.y1 < minY) minY = s.y1; if (s.y1 > maxY) maxY = s.y1; }
                    }
                    if (s.x2 !== undefined) {
                        if (s.x2 < minX) minX = s.x2; if (s.x2 > maxX) maxX = s.x2;
                        if (s.y2 !== undefined) { if (s.y2 < minY) minY = s.y2; if (s.y2 > maxY) maxY = s.y2; }
                    }
                });
            }
            if (minX === Infinity) return null;
            return { minX, minY, maxX, maxY };
        } else if (p.type === 'text') {
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

    flattenPathForFill(path) {
        if (!path) return [];
        if (path.type === 'rectangle') {
            return [
                { x: path.x, y: path.y },
                { x: path.x + (path.w || 0), y: path.y },
                { x: path.x + (path.w || 0), y: path.y + (path.h || 0) },
                { x: path.x, y: path.y + (path.h || 0) }
            ];
        }
        if (path.type === 'circle') {
            const points = [];
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
            return points;
        }
        if (path.type === 'path' && Array.isArray(path.segments) && path.segments.length > 0) {
            const points = [];
            let currentPoint = null;
            let subpathStart = null;
            const estimateSegmentSteps = (lengthEstimate, minSteps, maxSteps) => {
                return Math.max(minSteps, Math.min(maxSteps, Math.ceil(Math.max(0.1, lengthEstimate) / 1.2)));
            };
            const addPoint = (pt) => {
                if (!pt) return;
                const prev = points[points.length - 1];
                if (!prev || Math.hypot(prev.x - pt.x, prev.y - pt.y) > 0.01) points.push(pt);
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
                    currentPoint = { x: segment.x, y: segment.y };
                    addPoint(currentPoint);
                } else if (segment.type === 'Z' && subpathStart) {
                    addPoint({ ...subpathStart });
                    currentPoint = { ...subpathStart };
                }
            });
            return points;
        }
        return Array.isArray(path.points) ? path.points.map(pt => ({ x: pt.x, y: pt.y })) : [];
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
                currentPoint = { x: segment.x, y: segment.y };
                addPoint(currentPoint);
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
        this.drawLiveTrackerOverlay(mmToPx, horizontalShift, verticalShift);
        this.drawPredictedCrosshair(mmToPx, horizontalShift, verticalShift);
        const isInteracting = this.isDragging || this.isRotating || this.isPanning || this.isMarqueeSelecting || this.isCreatingShape;
        if (!isInteracting && this.app.ui && this.app.ui.updateSelectionSizeControls) {
            this.app.ui.updateSelectionSizeControls();
        }
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

    drawPaths() {
        const showMachineOutput = this.app?.ui?.currentVisualizerView === 'machine-output';
        const mmToPx = this.scale;
        const renderPaths = showMachineOutput ? this.buildMachineOutputPreviewPaths() : this.paths;
        const selectedPathSet = showMachineOutput ? new Set() : new Set(this.selectedPaths);
        const selectedNodeSet = showMachineOutput ? new Set() : new Set(this.selectedNodes.map(node => `${node.pathIdx}:${node.nodeIdx}`));
        const selectToolActive = !showMachineOutput && this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1;
        const nodeToolActive = !showMachineOutput && this.app.ui.activeTool === 'node';
        const selectionBox = selectToolActive ? this.getGroupBoundingBox(this.selectedPaths) : null;
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
                this.drawVectorText(p, mmToPx, index === this.editingPathIdx);
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                if (!p.points || p.points.length === 0) return;
                this.ctx.beginPath();
                if (p.segments && p.segments.length > 0) {
                    p.segments.forEach(s => {
                        if (s.type === 'M') this.ctx.moveTo(s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'L') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'C') this.ctx.bezierCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x2 * mmToPx, s.y2 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'Q') this.ctx.quadraticCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                        else if (s.type === 'A') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx); // Simplified arc rendering
                        else if (s.type === 'Z') this.ctx.closePath();
                    });
                } else {
                    this.ctx.moveTo(p.points[0].x * mmToPx, p.points[0].y * mmToPx);
                    for (let i = 1; i < p.points.length; i++) {
                        this.ctx.lineTo(p.points[i].x * mmToPx, p.points[i].y * mmToPx);
                    }
                }
                this.ctx.stroke();
            }
        });

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
                    this.drawVectorText(p, mmToPx, false);
                } else if (p.points) {
                    this.ctx.beginPath();
                    if (p.segments && p.segments.length > 0) {
                        p.segments.forEach(s => {
                            if (s.type === 'M') this.ctx.moveTo(s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'L') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'C') this.ctx.bezierCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x2 * mmToPx, s.y2 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'Q') this.ctx.quadraticCurveTo(s.x1 * mmToPx, s.y1 * mmToPx, s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'A') this.ctx.lineTo(s.x * mmToPx, s.y * mmToPx);
                            else if (s.type === 'Z') this.ctx.closePath();
                        });
                    } else {
                        this.ctx.moveTo(p.points[0].x * mmToPx, p.points[0].y * mmToPx);
                        for (let i = 1; i < p.points.length; i++) {
                            this.ctx.lineTo(p.points[i].x * mmToPx, p.points[i].y * mmToPx);
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
                this.getVectorTextSegments(path).forEach(segment => {
                    pushPolyline([
                        { x: segment.x1, y: segment.y1 },
                        { x: segment.x2, y: segment.y2 }
                    ], pen);
                });
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
                    tracePoints = hpgl.getTracePointsForPath(path);
                }
                if (Array.isArray(tracePoints) && tracePoints.length >= 2) {
                    pushPolyline(tracePoints.map(point => ({ x: point.x, y: point.y })), pen);
                }
            }
        });

        return previewPaths;
    }

    drawVectorText(p, mmToPx, isEditing) {
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
        if (typeof HandwritingLibrary === 'undefined' || !p || p.type !== 'text') return [];

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

    startSimulation() {
        if (this.paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to simulate.');
            return;
        }

        if (this.simulationActive) {
            this.simulationActive = false;
            this.simulationLastTimestamp = 0;
            this.draw();
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
                this.simulationActive = false;
                this.simulationProgress = 0;
                this.simulationLastTimestamp = 0;
                this.draw();
                this.app.ui.logToConsole('System: Simulation complete.');
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
