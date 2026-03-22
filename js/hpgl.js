class HpglParser {
    constructor(app) {
        this.app = app;
        this.currentPen = 1;

        // Roland units: 1 plotter unit = 0.025 mm
        this.UNITS_PER_MM = 40;
    }

    setCurrentPen(penNumber) {
        this.currentPen = penNumber;
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
            `PA${x},${y};`,
            `CI${r};`
        ];
    }

    generateRectangle(x1MM, y1MM, x2MM, y2MM) {
        const x1 = Math.round(x1MM * this.UNITS_PER_MM);
        const y1 = Math.round(y1MM * this.UNITS_PER_MM);
        const x2 = Math.round(x2MM * this.UNITS_PER_MM);
        const y2 = Math.round(y2MM * this.UNITS_PER_MM);

        return [
            `PA${x1},${y1};`,
            `EA${x2},${y2};`
        ];
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

    generatePolylineCommands(points) {
        if (!points || points.length < 2) return [];

        const transformedPts = this.transformOutputPoints(points);
        const commands = [];

        for (let i = 0; i < transformedPts.length; i++) {
            const ux = Math.round(transformedPts[i].x * this.UNITS_PER_MM);
            const uy = Math.round(transformedPts[i].y * this.UNITS_PER_MM);

            if (i === 0) {
                commands.push(`PU${ux},${uy};`);
                commands.push('PD;');
            } else {
                commands.push(`PA${ux},${uy};`);
            }
        }

        commands.push('PU;');
        return commands;
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

        // 1. Group paths by pen to minimize pen changes
        const groupedPaths = [];
        const pens = [...new Set(paths.map(p => p.pen || 1))].sort((a, b) => a - b);
        pens.forEach(penID => {
            paths.forEach(p => {
                if ((p.pen || 1) === penID) groupedPaths.push(p);
            });
        });

        let hpglCommands = ["IN;DT\x03;"]; // Initialize and set label terminator to ETX (CHR 3)
        let lastPen = -1;

        groupedPaths.forEach(p => {
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
                hpglCommands.push('PU;');
            } else if (p.type === 'text') {
                hpglCommands = hpglCommands.concat(this.generateText(p.text, p.x, p.y, p.fontSize || 10, p.rotation || 0));
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path' || p.type === 'rectangle') {
                const pts = p.type === 'rectangle' ? [
                    { x: p.x, y: p.y },
                    { x: p.x + (p.w || 0), y: p.y },
                    { x: p.x + (p.w || 0), y: p.y + (p.h || 0) },
                    { x: p.x, y: p.y + (p.h || 0) },
                    { x: p.x, y: p.y }
                ] : p.points;

                if (pts && pts.length >= 2) {
                    hpglCommands = hpglCommands.concat(this.generatePolylineCommands(pts));
                }
            }
        });

        hpglCommands.push("SP0;"); // Pen home
        return hpglCommands.join("\n");
    }

    // Generate HPGL from abstract paths and send to Serial Queue
    generateFromPaths(paths) {
        if (!paths || paths.length === 0) {
            this.app.ui.logToConsole('System: No paths to plot.');
            return false;
        }

        // 1. Group paths by pen to minimize pen changes
        const groupedPaths = [];
        const pens = [...new Set(paths.map(p => p.pen || 1))].sort((a, b) => a - b);
        pens.forEach(penID => {
            paths.forEach(p => {
                if ((p.pen || 1) === penID) groupedPaths.push(p);
            });
        });

        let hpglQueue = ["IN;DT\x03;"]; // Initialize and set label terminator to ETX (CHR 3)
        let commandsFound = 0;
        let lastPen = -1;

        groupedPaths.forEach(p => {
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
                hpglQueue.push('PU;');
                commandsFound++;
            } else if (p.type === 'text') {
                hpglQueue = hpglQueue.concat(this.generateText(p.text, p.x, p.y, p.fontSize || 10, p.rotation || 0));
                commandsFound++;
            } else if (p.type === 'line' || p.type === 'polyline' || p.type === 'path' || p.type === 'rectangle') {
                const pts = p.type === 'rectangle' ? [
                    { x: p.x, y: p.y },
                    { x: p.x + (p.w || 0), y: p.y },
                    { x: p.x + (p.w || 0), y: p.y + (p.h || 0) },
                    { x: p.x, y: p.y + (p.h || 0) },
                    { x: p.x, y: p.y }
                ] : p.points;

                if (pts && pts.length >= 2) {
                    hpglQueue = hpglQueue.concat(this.generatePolylineCommands(pts));
                    commandsFound += pts.length;
                }
            }
        });

        this.app.serial.queueCommands(hpglQueue);
        this.app.ui.logToConsole(`System: Generated ${hpglQueue.length} HPGL commands from Canvas.`);
        return true;
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
        const processElement = (el) => {
            let pts = [];
            const tag = el.tagName.toLowerCase();

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
                const steps = Math.max(12, Math.ceil(32 * ((this.app.settings.importResolution || 15) / 15)));
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
                allPaths.push(segment);
            });
        };

        // Recursive traversal (basic, ignoring transforms for now but flattened)
        const walk = (node) => {
            if (node.nodeType !== 1) return;
            processElement(node);
            node.childNodes.forEach(walk);
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

        const visPen = this.app.ui.activeVisualizerPen || 1;

        // Ensure the active visualiser pen layer is visible so imports don't appear 'blank'
        if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[visPen - 1]) {
            this.app.ui.visPenConfig[visPen - 1].visible = true;
            this.app.ui.saveWorkspaceState();
            this.app.ui.updateVisualizerPalette();
        }
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

            this.app.canvas.addPath({
                type: scaledSegments ? 'path' : 'polyline',
                points: scaledPoly,
                segments: scaledSegments,
                pen: visPen
            });
            pointsCount += scaledPoly.length;

            if (i % 100 === 0) {
                const prog = 10 + Math.floor((i / allPaths.length) * 90);
                this.app.ui.updateLoading(prog, `Adding paths: ${i}/${allPaths.length}`);
                // Yield to UI
                await new Promise(r => setTimeout(r, 0));
            }
        }

        this.app.ui.logToConsole(`System: Imported SVG (x${scale.toFixed(2)}). Centered. ${pointsCount} points across ${allPaths.length} paths.`);
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
                const pts = [];

                for (const vRaw of obj.vertexRaws) {
                    const vp = extractProps(vRaw);
                    const x = vp[10]?.[0];
                    const y = vp[20]?.[0];
                    if (Number.isFinite(x) && Number.isFinite(y)) {
                        const p = this._applyDXFTransform({ x, y }, tf);
                        pts.push(p);
                        updateBounds(p.x, p.y);
                    }
                }

                const closedFlag = headerProps[70]?.[0];
                const isClosed = Number.isFinite(closedFlag) && ((closedFlag & 1) === 1);
                if (pts.length > 1) {
                    if (isClosed && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y)) {
                        pts.push({ ...pts[0] });
                    }
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

        this.finalizeImport(allPaths, minX, minY, maxX, maxY, 'DXF');
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
            const pts = [];
            for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
                const x = xs[i], y = ys[i];
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    const p = apply({ x, y });
                    pts.push(p);
                    updateBounds(p.x, p.y);
                }
            }
            if (pts.length > 1) allPaths.push(pts);
            return;
        }

        if (type === 'CIRCLE' || type === 'ARC') {
            const cx = props[10]?.[0], cy = props[20]?.[0], r = props[40]?.[0];
            if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;

            const s = (type === 'ARC' ? (props[50]?.[0] || 0) : 0) * Math.PI / 180;
            let e = (type === 'ARC' ? (props[51]?.[0] || 360) : 360) * Math.PI / 180;
            if (e < s) e += Math.PI * 2;

            const arc = [];
            const res = this.app.settings.importResolution || 15;
            const steps = Math.max(12, Math.ceil(((e - s) / (Math.PI / 18)) * (res / 15)));

            for (let j = 0; j <= steps; j++) {
                const a = s + (e - s) * (j / steps);
                const p = apply({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
                arc.push(p);
                updateBounds(p.x, p.y);
            }
            allPaths.push(arc);
            return;
        }

        if (type === 'SPLINE') {
            // Many DXFs provide control points as repeating 10/20 pairs.
            // We'll approximate by connecting them (good enough for plotting and preview).
            const xs = props[10] || [];
            const ys = props[20] || [];
            const pts = [];

            for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
                const x = xs[i], y = ys[i];
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    const p = apply({ x, y });
                    pts.push(p);
                    updateBounds(p.x, p.y);
                }
            }

            if (pts.length > 1) {
                const closedFlag = props[70]?.[0];
                const isClosed = Number.isFinite(closedFlag) && ((closedFlag & 1) === 1);
                if (isClosed && (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y)) {
                    pts.push({ ...pts[0] });
                }
                allPaths.push(pts);
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

    finalizeImport(allPaths, minX, minY, maxX, maxY, formatName) {
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

        const visPen = this.app.ui.activeVisualizerPen || 1;

        // Ensure the active visualiser pen layer is visible so imports don't appear 'blank'
        if (this.app && this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[visPen - 1]) {
            this.app.ui.visPenConfig[visPen - 1].visible = true;
            this.app.ui.saveWorkspaceState();
            this.app.ui.updateVisualizerPalette();
        }
        let pointsCount = 0;
        const groupId = 'import_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        allPaths.forEach(poly => {
            if (Array.isArray(poly)) {
                // Simple point array
                const scaledPoly = poly.map(p => ({
                    x: (p.x * scale) + offsetX,
                    y: (p.y * scale) + offsetY
                }));
                this.app.canvas.addPath({ type: 'polyline', points: scaledPoly, pen: visPen, groupId });
                pointsCount += scaledPoly.length;
            } else if (poly.points) {
                // Object with points and native curve segments
                const scaledPoly = poly.points.map(p => ({
                    x: (p.x * scale) + offsetX,
                    y: (p.y * scale) + offsetY
                }));

                let scaledSegments = null;
                if (poly.segments) {
                    scaledSegments = poly.segments.map(s => {
                        const scaled = { ...s };
                        // Scale Endpoints
                        if (s.x !== undefined) { scaled.x = (s.x * scale) + offsetX; scaled.y = (s.y * scale) + offsetY; }
                        // Scale Handle 1
                        if (s.x1 !== undefined) { scaled.x1 = (s.x1 * scale) + offsetX; scaled.y1 = (s.y1 * scale) + offsetY; }
                        // Scale Handle 2
                        if (s.x2 !== undefined) { scaled.x2 = (s.x2 * scale) + offsetX; scaled.y2 = (s.y2 * scale) + offsetY; }
                        // Scale Arc settings
                        if (s.rx !== undefined) { scaled.rx = s.rx * scale; scaled.ry = s.ry * scale; }
                        return scaled;
                    });
                }

                const pathObj = { type: 'polyline', points: scaledPoly, pen: visPen, groupId };
                if (scaledSegments) pathObj.segments = scaledSegments;
                this.app.canvas.addPath(pathObj);
                pointsCount += scaledPoly.length;
            }
        });

        this.app.ui.logToConsole(`System: Imported ${formatName} (x${scale.toFixed(2)}). Centered. ${pointsCount} points across ${allPaths.length} paths.`);
    }
}
