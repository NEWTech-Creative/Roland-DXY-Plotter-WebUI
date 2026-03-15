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
        this.paperDims = { 'A3': { w: 420, h: 297 }, 'A4': { w: 297, h: 210 }, 'A5': { w: 210, h: 148 } };

        this.snapThreshold = 5; // mm
        this.snapPoint = null; // {x, y} for visual hint

        this.paths = []; // abstract paths to draw

        // CAD Edit State
        this.selectedPaths = []; // Array of indices of selected paths
        this.selectedNodes = []; // Array of {pathIdx, nodeIdx} for multi-node editing
        this.activeShapeType = 'circle'; // 'circle', 'rectangle', 'line'
        this.isCreatingShape = false;
        this.currentShapeIdx = -1;
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
        this.simulationProgress = 0; // index into flattened simulation points
        this.simulationPaths = [];
        this.simulationSpeed = 5; // mm per frame approx

        this.simulationSpeedMultiplier = 1;

        this.patternPreviewPaths = [];
        this.editingPathIdx = -1;
        this.cursorBlink = true;
        this.drawFramePending = false;
        this.cursorTimer = setInterval(() => { this.cursorBlink = !this.cursorBlink; if (this.editingPathIdx !== -1) this.draw(); }, 500);
    }

    clear() {
        this.paths = []; // Array of path objects
        this.selectedPaths = [];
        this.draggingNodeIndex = -1;

        // Panning and Zooming State
        this.viewOffsetX = 0;
        this.viewOffsetY = 0;
        this.viewZoom = 1;

        this.saveUndoState();
        this.draw();
    }

    saveUndoState() {
        this.undoStack.push(JSON.stringify(this.paths));
        this.redoStack = []; // Clear redo stack on new action
        if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
        this.saveCurrentState(); // Also persist to localStorage on edit
    }

    saveCurrentState() {
        try {
            localStorage.setItem('canvasBackup', JSON.stringify(this.paths));
        } catch (e) {
            // Persist fail
        }
    }

    loadSavedState() {
        try {
            const saved = localStorage.getItem('canvasBackup');
            if (saved) {
                this.paths = JSON.parse(saved);
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
        if (this.undoStack.length > 1) {
            const current = this.undoStack.pop();
            this.redoStack.push(current);
            const prev = this.undoStack[this.undoStack.length - 1];
            this.paths = JSON.parse(prev);
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Undo action performed.');
        } else if (this.undoStack.length === 1) {
            const current = this.undoStack.pop();
            this.redoStack.push(current);
            this.paths = [];
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Undo back to empty canvas.');
        }
    }

    redo() {
        if (this.redoStack.length > 0) {
            const next = this.redoStack.pop();
            this.undoStack.push(next);
            this.paths = JSON.parse(next);
            this.selectedPaths = [];
            this.draw();
            if (this.app.ui) this.app.ui.logToConsole('System: Redo action performed.');
        }
    }

    addPath(pathObj) {
        this.paths.push(pathObj);
        this.saveUndoState();
        this.draw();
    }

    cancelCurrentOperation() {
        if (this.isCreatingShape && this.currentShapeIdx !== -1) {
            this.paths.splice(this.currentShapeIdx, 1);
            this.selectedPaths = []; // Clear selection if we were drawing
            this.app.ui.logToConsole('System: Shape drawing cancelled.');
        }

        this.isCreatingShape = false;
        this.currentShapeIdx = -1;
        this.isDragging = false;
        this.isRotating = false;
        this.isMarqueeSelecting = false;
        this.snapPoint = null;

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
            this.paperSize = e.target.value;
            this.handleResize(); // re-draw
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
                        // Offset paste slightly right and down (approx +10mm)
                        if (clone.type === 'circle' || clone.type === 'text') {
                            clone.x += 10; clone.y += 10;
                        } else if (clone.type === 'line' || clone.type === 'polyline' || clone.type === 'path') {
                            clone.points.forEach(pt => { pt.x += 10; pt.y += 10; });
                        }
                        this.paths.push(clone);
                        this.selectedPaths.push(this.paths.length - 1);
                    });

                    // Also offset the buffer again in case of multi-pastes
                    this.copyBuffer.forEach(p => {
                        if (p.type === 'circle' || p.type === 'text') {
                            p.x += 10; p.y += 10;
                        } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                            p.points.forEach(pt => { pt.x += 10; pt.y += 10; });
                        }
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
            if (!checkTarget(e)) return;

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

            // Toggle Panning on Middle Mouse
            if (e.button === 1 || (this.app.ui.activeTool === 'select' || this.app.ui.activeTool === 'node' || this.app.ui.activeTool === 'shape')) {
                if (this.app.ui.activeTool === 'node' && this.selectedPaths.length >= 1) {
                    // Check if clicked exactly on a node
                    let clickedPathIdx = -1;
                    let clickedNodeIdx = -1;

                    for (let i = 0; i < this.selectedPaths.length; i++) {
                        const selIdx = this.selectedPaths[i];
                        const nIdx = this.hitTestNodes(this.paths[selIdx], pos.xMM, pos.yMM);
                        if (nIdx > -1) {
                            clickedPathIdx = selIdx;
                            clickedNodeIdx = nIdx;
                            break;
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
                        this.isCreatingShape = false;
                        this.currentShapeIdx = -1;
                        this.saveUndoState();
                        this.app.ui.logToConsole('System: Shape finalized.');
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
            if (!this.isPanning && !this.isMarqueeSelecting && !this.isDragging && !this.isCreatingShape) {
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

            // Set Cursor
            let cursor = 'default';
            if (this.isPanning) cursor = 'grabbing';
            else if (this.isRotating) cursor = 'alias';
            else if (this.isDragging) cursor = 'move';
            else if (this.isMarqueeSelecting) cursor = 'crosshair';
            else if (this.editingPathIdx !== -1) cursor = 'text'; // Text editing cursor
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
                    p.x = Math.min(pos.xMM, this.dragStartX);
                    p.y = Math.min(pos.yMM, this.dragStartY);
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

        // Centering logic (same as in draw)
        const mmToPx = this.scale;
        const horizontalShift = Math.max(0, (this.pixelW - (this.bedWidth * mmToPx)) / 2);
        const verticalShift = Math.max(0, this.pixelH - (this.bedHeight * mmToPx));

        // Reverse translate and zoom
        const transformedPx = (px - this.viewOffsetX - horizontalShift) / this.viewZoom;
        const transformedPy = (py - this.viewOffsetY - verticalShift) / this.viewZoom;

        const xMM = transformedPx / this.scale;
        const yMM = transformedPy / this.scale;

        return { xMM, yMM };
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
                if (Math.abs(dist - p.r) <= tol || dist <= tol) return i;
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
                for (let j = 0; j < p.points.length - 1; j++) {
                    const p1 = p.points[j];
                    const p2 = p.points[j + 1];
                    const d = this.distToSegment({ x: xMM, y: yMM }, p1, p2);
                    if (d <= tol) return i;
                }
            } else if (p.type === 'text') {
                const box = this.getBoundingBox(p);
                if (box && xMM >= box.minX - 2 && xMM <= box.maxX + 2 && yMM >= box.minY - 2 && yMM <= box.maxY + 2) {
                    return i;
                }
            } else if (p.type === 'rectangle') {
                const box = { minX: p.x, minY: p.y, maxX: p.x + (p.w || 0), maxY: p.y + (p.h || 0) };
                if (xMM >= box.minX - 2 && xMM <= box.maxX + 2 && yMM >= box.minY - 2 && yMM <= box.maxY + 2) {
                    return i;
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

    hitTestNodes(p, xMM, yMM) {
        const tol = 5; // 5mm tolerance for grabbing nodes
        if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') {
            if (p.segments) {
                for (let i = 0; i < p.segments.length; i++) {
                    const s = p.segments[i];
                    if (s.x !== undefined && Math.abs(s.x - xMM) <= tol && Math.abs(s.y - yMM) <= tol) return i;
                    if ((s.type === 'Q' || s.type === 'C') && Math.abs(s.x1 - xMM) <= tol && Math.abs(s.y1 - yMM) <= tol) return i + 10000;
                    if (s.type === 'C' && Math.abs(s.x2 - xMM) <= tol && Math.abs(s.y2 - yMM) <= tol) return i + 20000;
                }
            } else {
                for (let i = 0; i < p.points.length; i++) {
                    const pt = p.points[i];
                    if (Math.abs(pt.x - xMM) <= tol && Math.abs(pt.y - yMM) <= tol) return i;
                }
            }
        } else if (p.type === 'circle') {
            if (Math.abs(p.x - xMM) <= tol && Math.abs(p.y - yMM) <= tol) return 0; // Center
            if (Math.abs((p.x + p.r) - xMM) <= tol && Math.abs(p.y - yMM) <= tol) return 1; // Edge
        }
        return -1;
    }

    getBoundingBox(p) {
        if (p.type === 'circle') {
            return { minX: p.x - p.r, minY: p.y - p.r, maxX: p.x + p.r, maxY: p.y + p.r };
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
        let bestDist = this.snapThreshold;
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
        this.draw(true);
    }

    handleResize() {
        this.resize();
        this.draw(true);
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;

        const dpr = window.devicePixelRatio || 1;
        const rectW = parent.clientWidth;
        const rectH = parent.clientHeight;

        const scale = Math.min(
            rectW / this.bedWidth,
            rectH / this.bedHeight
        );

        this.pixelW = rectW;
        this.pixelH = rectH;
        this.scale = scale;

        this.canvas.width = this.pixelW * dpr;
        this.canvas.height = this.pixelH * dpr;
        this.canvas.style.width = `${this.pixelW}px`;
        this.canvas.style.height = `${this.pixelH}px`;

        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Reset transform and apply DPR
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
        this.ctx.save(); // Save default unscaled state
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Bottom-align / Centering logic: if bed is smaller than container, push it to bottom/center
        const mmToPx = this.scale;
        // Horizontal centering if bed is narrower than parent
        const horizontalShift = Math.max(0, (this.pixelW - (this.bedWidth * mmToPx)) / 2);
        const verticalShift = Math.max(0, this.pixelH - (this.bedHeight * mmToPx));

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
        const pSize = this.paperDims[this.paperSize] || this.paperDims['A3'];
        const pWPx = pSize.w * mmToPx;
        const pHPx = pSize.h * mmToPx;

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

        // Draw Snap Hint
        if (this.snapPoint) {
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
        const isInteracting = this.isDragging || this.isRotating || this.isPanning || this.isMarqueeSelecting || this.isCreatingShape;
        if (!isInteracting && this.app.ui && this.app.ui.updateSelectionSizeControls) {
            this.app.ui.updateSelectionSizeControls();
        }
    }

    drawPaths() {
        const mmToPx = this.scale;
        const selectedPathSet = new Set(this.selectedPaths);
        const selectedNodeSet = new Set(this.selectedNodes.map(node => `${node.pathIdx}:${node.nodeIdx}`));
        const selectToolActive = this.app.ui.activeTool === 'select' && this.selectedPaths.length >= 1;
        const nodeToolActive = this.app.ui.activeTool === 'node';
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
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.paths.forEach((p, index) => {
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

        // Draw Pattern Preview
        this.ctx.save();
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
        this.patternPreviewPaths.forEach(p => {
            if (p.type === 'circle') {
                this.ctx.beginPath();
                this.ctx.arc(p.x * mmToPx, p.y * mmToPx, p.r * mmToPx, 0, Math.PI * 2);
                this.ctx.stroke();
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

        // Draw Simulation Overlay
        if (this.simulationActive) {
            // Group paths by pen to reflect actual plotter execution order
            const simPaths = [];
            const pens = [...new Set(this.paths.map(p => p.pen || 1))].sort((a, b) => a - b);
            pens.forEach(penID => {
                this.paths.forEach(p => {
                    if ((p.pen || 1) === penID) simPaths.push(p);
                });
            });

            let currentPathIdx = 0;
            let pointsToDraw = this.simulationProgress;

            while (pointsToDraw > 0 && currentPathIdx < simPaths.length) {
                const p = simPaths[currentPathIdx];
                const penCfg = this.app.ui.visPenConfig[(p.pen || 1) - 1] || { color: '#3b82f6', thickness: 0.3 };

                // Skip rendering if layer is toggled off
                if (penCfg.visible === false) {
                    currentPathIdx++;
                    continue;
                }

                this.ctx.strokeStyle = penCfg.color;
                this.ctx.fillStyle = penCfg.color;
                this.ctx.lineWidth = Math.max(0.5, penCfg.thickness * mmToPx);
                this.ctx.shadowColor = 'transparent';
                this.ctx.shadowBlur = 0;

                if (p.type === 'circle') {
                    this.ctx.beginPath();
                    this.ctx.arc(p.x * mmToPx, p.y * mmToPx, p.r * mmToPx, 0, Math.PI * 2);
                    this.ctx.stroke();
                    pointsToDraw -= 32; // estimation
                } else if (p.type === 'rectangle') {
                    this.ctx.strokeRect(p.x * mmToPx, p.y * mmToPx, (p.w || 0.1) * mmToPx, (p.h || 0.1) * mmToPx);
                    pointsToDraw -= 4;
                } else if (p.type === 'text') {
                    const textSegments = this.getVectorTextSegments(p);
                    if (textSegments.length > 0) {
                        const segmentsToDraw = Math.min(pointsToDraw, textSegments.length);
                        this.ctx.beginPath();
                        for (let i = 0; i < segmentsToDraw; i++) {
                            const segment = textSegments[i];
                            this.ctx.moveTo(segment.x1 * mmToPx, segment.y1 * mmToPx);
                            this.ctx.lineTo(segment.x2 * mmToPx, segment.y2 * mmToPx);
                        }
                        this.ctx.stroke();
                        pointsToDraw -= segmentsToDraw;
                    } else {
                        const fontSizePx = Math.max(12, (p.fontSize || 10) * mmToPx);
                        const drawAngle = this.normalizeTextRotation(p.rotation || 0) * (Math.PI / 180);
                        this.ctx.save();
                        this.ctx.translate(p.x * mmToPx, p.y * mmToPx);
                        this.ctx.rotate(drawAngle);
                        this.ctx.font = `${fontSizePx}px "JetBrains Mono", monospace`;
                        this.ctx.fillText(p.text, 0, 0);
                        this.ctx.restore();
                        pointsToDraw -= 10;
                    }
                } else if (p.points && p.points.length >= 2) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(p.points[0].x * mmToPx, p.points[0].y * mmToPx);
                    for (let i = 1; i < p.points.length; i++) {
                        if (pointsToDraw <= 0) break;
                        this.ctx.lineTo(p.points[i].x * mmToPx, p.points[i].y * mmToPx);
                        pointsToDraw--;
                    }
                    this.ctx.stroke();
                }
                currentPathIdx++;
            }
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
            this.draw();
            return;
        }

        this.simulationActive = true;
        this.simulationProgress = 0;
        this.app.ui.logToConsole('System: Plot simulation started.');

        const tick = () => {
            if (!this.simulationActive) return;

            this.simulationProgress += (0.5 * (this.simulationSpeedMultiplier || 1)); // Slower base speed
            this.draw();

            let total = 0;
            this.paths.forEach(p => {
                if (p.type === 'circle') total += 32;
                else if (p.type === 'rectangle') total += 4;
                else if (p.type === 'text') total += Math.max(10, this.getVectorTextSegments(p).length);
                else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path') total += (p.points.length - 1);
            });

            if (this.simulationProgress >= total + 20) {
                this.simulationActive = false;
                this.simulationProgress = 0;
                this.draw();
                this.app.ui.logToConsole('System: Simulation complete.');
            } else {
                requestAnimationFrame(tick);
            }
        };
        requestAnimationFrame(tick);
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
