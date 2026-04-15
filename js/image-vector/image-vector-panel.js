class ImageVectorPanel {
    constructor(app) {
        this.app = app;
        this.engine = new ImageVectorEngine(app);
        this.layerColors = ['#ff0000', '#00ff00', '#0000ff'];
        this.currentImage = null;
        this.vectorPaths = [];
        this.isGenerating = false;

        // Zoom/Pan State
        this.scale = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.isPanning = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.showSourceImage = true;

        this.debounceTimer = null;

        this._bindUI();
        this.updateMethodParams(); // Initialize sliders
    }

    _bindUI() {
        const uploadBtn = document.getElementById('iv-upload-btn');
        const uploadZone = document.getElementById('iv-upload-zone');
        const fileInput = document.getElementById('input-iv-image');
        const btnGenerate = document.getElementById('btn-iv-generate');
        const btnAdd = document.getElementById('btn-iv-add');
        const btnClear = document.getElementById('btn-iv-clear');
        const selMethod = document.getElementById('sel-iv-method');
        const previewContainer = document.getElementById('iv-preview-container');

        if (previewContainer) {
            window.addEventListener('resize', () => this.drawPreview());
            if (typeof ResizeObserver !== 'undefined') {
                this.previewResizeObserver = new ResizeObserver(() => this.drawPreview());
                this.previewResizeObserver.observe(previewContainer);
            }
        }

        // File upload handling - Button
        if (uploadBtn) uploadBtn.onclick = () => fileInput.click();

        // Drag and Drop still bound to container/viewport area? 
        // Let's bind to the whole preview container for easier dropping
        if (previewContainer) {
            previewContainer.ondragover = (e) => {
                e.preventDefault();
                previewContainer.style.background = 'rgba(59, 130, 246, 0.08)';
            };
            previewContainer.ondragleave = () => {
                previewContainer.style.background = '';
            };
            previewContainer.ondrop = (e) => {
                e.preventDefault();
                previewContainer.style.background = '';
                if (e.dataTransfer.files.length) {
                    this.handleImageFile(e.dataTransfer.files[0]);
                }
            };
        }

        fileInput.onchange = (e) => {
            if (e.target.files.length) {
                this.handleImageFile(e.target.files[0]);
            }
        };

        // Scroll/Zoom
        if (previewContainer) {
            previewContainer.onwheel = (e) => {
                e.preventDefault();
                const delta = -e.deltaY;
                const factor = Math.pow(1.1, delta / 100);
                const newScale = Math.min(Math.max(this.scale * factor, 0.1), 20);
                const rect = previewContainer.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const worldX = (mouseX - this.offsetX) / this.scale;
                const worldY = (mouseY - this.offsetY) / this.scale;
                this.scale = newScale;
                this.offsetX = mouseX - worldX * this.scale;
                this.offsetY = mouseY - worldY * this.scale;
                this.drawPreview();
            };
        }

        // Pan
        if (previewContainer) {
            previewContainer.onmousedown = (e) => {
                this.isPanning = true;
                this.lastMouseX = e.clientX;
                this.lastMouseY = e.clientY;
                previewContainer.style.cursor = 'grabbing';
            };
        }

        window.addEventListener('mousemove', (e) => {
            if (!this.isPanning) return;
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            this.offsetX += dx;
            this.offsetY += dy;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.drawPreview();
        });

        window.addEventListener('mouseup', () => {
            this.isPanning = false;
            if (previewContainer) previewContainer.style.cursor = 'grab';
        });

        // UI Updates for basic parameters + Auto Generate
        ['input-iv-threshold', 'input-iv-simplify', 'input-iv-contrast'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.oninput = (e) => {
                    const valEl = document.getElementById(id.replace('input', 'val'));
                    if (valEl) valEl.textContent = e.target.value;
                    this.autoGenerate();
                };
            }
        });

        btnGenerate.onclick = () => this.generateVector();
        document.getElementById('btn-iv-add').onclick = () => this.addToBed();
        document.getElementById('btn-iv-clear').onclick = () => this.clear();

        // Bind Visualizer Grouping
        const groupBtn = document.getElementById('btn-group');
        const ungroupBtn = document.getElementById('btn-ungroup');
        if (groupBtn) groupBtn.onclick = () => this.app.canvas.groupSelectedPaths();
        if (ungroupBtn) ungroupBtn.onclick = () => this.app.canvas.ungroupSelectedPaths();

        selMethod.onchange = () => {
            this.updateMethodParams();
            this.generateVector();
        };

        const chkShowImg = document.getElementById('chk-iv-show-img');
        if (chkShowImg) {
            chkShowImg.onchange = (e) => {
                this.showSourceImage = e.target.checked;
                this.drawPreview();
            };
        }

        const selColorMode = document.getElementById('sel-iv-color-mode');
        if (selColorMode) {
            selColorMode.onchange = () => this.generateVector();
        }
    }

    autoGenerate() {
        if (!this.currentImage) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.generateVector();
        }, 300);
    }

    handleImageFile(file) {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                this.currentImage = img;
                this.processLoadedImage();
                this.generateVector();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }

    processLoadedImage() {
        if (!this.currentImage) return;
        const canvas = document.createElement('canvas');
        const ctx = canvas.width > 2000 ? canvas.getContext('2d', { willReadFrequently: true }) : canvas.getContext('2d');
        const maxDim = 1200;
        let w = this.currentImage.width;
        let h = this.currentImage.height;
        if (w > maxDim || h > maxDim) {
            if (w > h) { h = (h / w) * maxDim; w = maxDim; }
            else { w = (w / h) * maxDim; h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(this.currentImage, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        this.engine.setImageData(imageData);

        document.getElementById('iv-stat-pix').textContent = `Pixels: ${Math.round(w)}x${Math.round(h)}`;
        const placeholder = document.getElementById('iv-placeholder');
        if (placeholder) placeholder.classList.add('hidden');

        const container = document.getElementById('iv-preview-container');
        if (!container) return;
        this.scale = Math.min(container.clientWidth / w, container.clientHeight / h);
        this.offsetX = (container.clientWidth - w * this.scale) / 2;
        this.offsetY = (container.clientHeight - h * this.scale) / 2;
        this.vectorPaths = [];
        this.drawPreview();
    }

    drawPreview() {
        const canvas = document.getElementById('iv-preview-canvas');
        const container = document.getElementById('iv-preview-container');
        if (!canvas || !container) return;
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!this.engine.imageData) return;
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        if (this.showSourceImage) {
            const offCanvas = document.createElement('canvas');
            offCanvas.width = this.engine.width;
            offCanvas.height = this.engine.height;
            offCanvas.getContext('2d').putImageData(this.engine.imageData, 0, 0);
            ctx.globalAlpha = 0.2;
            ctx.drawImage(offCanvas, 0, 0);
            ctx.globalAlpha = 1.0;
        }

        if (this.vectorPaths.length > 0) {
            const method = document.getElementById('sel-iv-method') ? document.getElementById('sel-iv-method').value : 'trace';
            let strokeOpacity = 1;
            if (method === 'string') {
                const lineCountEl = document.getElementById('input-iv-lines');
                const totalLines = lineCountEl ? parseInt(lineCountEl.value) : 1000;
                const lineWeight = (this.lastParams && this.lastParams.lineWeight) || 50;
                // Scale opacity by lineWeight and inversely by totalLines
                strokeOpacity = Math.max(0.005, (lineWeight / 100) * (150 / totalLines));
                ctx.strokeStyle = `rgba(59, 130, 246, ${strokeOpacity.toFixed(3)})`;
                ctx.lineWidth = 0.5 / this.scale;
            } else if (method === 'spiral') {
                const previewStrokeWidth = (this.lastParams && this.lastParams.previewStrokeWidth) || 1.2;
                ctx.strokeStyle = '#2563eb';
                ctx.lineWidth = Math.max(0.25, previewStrokeWidth) / this.scale;
            } else {
                ctx.strokeStyle = '#3b82f6';
                ctx.lineWidth = 1 / this.scale;
            }

            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            this.vectorPaths.forEach(path => {
                const points = Array.isArray(path) ? path : path?.points;
                if (!path || ((!points || points.length < 2) && !path.segments)) return;

                // Set color based on path.layer or method
                if (path.layer !== undefined && document.getElementById('sel-iv-color-mode').value === 'color') {
                    let colorHex = this.layerColors[path.layer] || this.layerColors[0];
                    
                    // Convert hex to rgba for string art
                    if (method === 'string') {
                        const r = parseInt(colorHex.slice(1, 3), 16);
                        const g = parseInt(colorHex.slice(3, 5), 16);
                        const b = parseInt(colorHex.slice(5, 7), 16);
                        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${strokeOpacity.toFixed(3)})`;
                    } else {
                        ctx.strokeStyle = colorHex;
                    }
                }

                ctx.beginPath();
                if (path.segments && path.segments.length > 0) {
                    const s0 = path.segments[0];
                    ctx.moveTo(s0.x, s0.y);
                    for (let i = 1; i < path.segments.length; i++) {
                        const seg = path.segments[i];
                        if (seg.type === 'L') ctx.lineTo(seg.x, seg.y);
                        else if (seg.type === 'C') ctx.bezierCurveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y);
                        else if (seg.type === 'Q') ctx.quadraticCurveTo(seg.x1, seg.y1, seg.x, seg.y);
                        else if (seg.type === 'Z') ctx.closePath();
                    }
                } else {
                    ctx.moveTo(points[0].x, points[0].y);
                    for (let i = 1; i < points.length; i++) {
                        ctx.lineTo(points[i].x, points[i].y);
                    }
                }
                ctx.stroke();
            });
        }
        ctx.restore();
    }

    updateMethodParams() {
        const method = document.getElementById('sel-iv-method').value;
        const container = document.getElementById('iv-dynamic-params');
        if (!container) return;
        let html = '';
        const addS = (id, label, min, max, val, step = 1) => {
            html += `<div class="form-group iv-compact-group iv-dynamic-group" id="group-iv-${id}">
                <label id="label-iv-${id}">${label}: <span id="val-iv-${id}">${val}</span></label>
                <input type="range" id="input-iv-${id}" min="${min}" max="${max}" step="${step}" value="${val}" style="width: 100%;">
            </div>`;
        };
        const updateContourFillLabels = () => {
            const fillEl = document.getElementById('input-iv-fill');
            const fillSpacingLabel = document.getElementById('label-iv-fillSpacing');
            const zigzagGroup = document.getElementById('group-iv-zigzagSize');
            const zigzagLabel = document.getElementById('label-iv-zigzagSize');
            if (!fillEl || !fillSpacingLabel || !zigzagGroup || !zigzagLabel) return;

            const fill = fillEl.value || 'none';
            zigzagGroup.style.display = 'none';

            if (fill === 'lines' || fill === 'hatch') {
                fillSpacingLabel.innerHTML = `Line Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
            } else if (fill === 'zigzag') {
                fillSpacingLabel.innerHTML = `Zigzag Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
                zigzagLabel.innerHTML = `Zigzag Size: <span id="val-iv-zigzagSize">${document.getElementById('input-iv-zigzagSize').value}</span>`;
                zigzagGroup.style.display = 'block';
            } else if (fill === 'wave') {
                fillSpacingLabel.innerHTML = `Wave Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
            } else if (fill === 'dots') {
                fillSpacingLabel.innerHTML = `Dot Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
            } else if (fill === 'curly') {
                fillSpacingLabel.innerHTML = `Curl Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
            } else {
                fillSpacingLabel.innerHTML = `Fill Gap: <span id="val-iv-fillSpacing">${document.getElementById('input-iv-fillSpacing').value}</span>`;
            }
        };

        const addSelect = (id, label, options, value) => {
            html += `<div class="form-group iv-compact-group iv-dynamic-group" id="group-iv-${id}">
                <label>${label}</label>
                <select id="input-iv-${id}" style="width: 100%;">${options.map(opt =>
                    `<option value="${opt.value}"${opt.value === value ? ' selected' : ''}>${opt.label}</option>`
                ).join('')}</select>
            </div>`;
        };

        // Hide global sliders when a mode has its own dedicated tone controls.
        const globalVisibility = {
            threshold: !['string', 'spiral'].includes(method),
            contrast: method !== 'string',
            simplify: method !== 'string'
        };
        ['threshold', 'contrast', 'simplify'].forEach(id => {
            const el = document.getElementById('input-iv-' + id);
            if (el && el.parentElement) {
                el.parentElement.style.display = globalVisibility[id] ? 'block' : 'none';
            }
        });

        switch (method) {
            case 'trace':
                addS('traceSpeckle', 'Speckle Filter', 0, 25, 4);
                addS('traceCornerSmooth', 'Corner Smooth', 0, 133, 100, 1);
                break;
            case 'contour':
                addS('spacing', 'Path Detail', 1, 10, 2, 0.5);
                addS('fillSpacing', 'Fill Gap', 2, 25, 8);
                addS('fillAngle', 'Fill Angle', 0, 180, 45, 1);
                html += `<div class="form-group iv-compact-group iv-dynamic-group">
                    <label>Path Style</label>
                    <select id="input-iv-style" style="width: 100%;">
                        <option value="curves">Smooth Curves Only</option>
                        <option value="mixed">Mixed (Lines & Curves)</option>
                        <option value="lines">Straight Angular Lines</option>
                    </select>
                </div>`;
                addS('zigzagSize', 'Zigzag Size', 2, 50, 5, 0.5);
                html += `<div class="form-group iv-compact-group iv-dynamic-group">
                    <label>Fill Pattern</label>
                    <select id="input-iv-fill" style="width: 100%;">
                        <option value="none">None (Outline)</option>
                        <option value="lines">Lines</option>
                        <option value="zigzag">Zigzag</option>
                        <option value="hatch">Cross-Hatch</option>
                        <option value="wave">Waves</option>
                        <option value="dots">Dots</option>
                        <option value="curly">Curly</option>
                    </select>
                </div>`;
                break;
            case 'topo': addS('spacing', 'Path Detail', 1, 10, 2, 0.5); break;
            case 'hatch': addS('spacing', 'Line Spacing', 2, 25, 5); addS('layers', 'Layers', 1, 4, 2); break;
            case 'spiral':
                addSelect('spiralPreset', 'Preset', [
                    { value: 'portraitClean', label: 'Portrait Clean' },
                    { value: 'highDetail', label: 'High Detail' },
                    { value: 'plotterSafe', label: 'Plotter Safe' },
                    { value: 'boldContrast', label: 'Bold Contrast' },
                    { value: 'softEngraving', label: 'Soft Engraving' }
                ], 'portraitClean');
                addS('spacing', 'Spiral Spacing', 1, 20, 4, 0.1);
                addS('turns', 'Number of Turns', 20, 320, 120, 1);
                addS('centerOffsetX', 'Centre Offset X', -100, 100, 0, 1);
                addS('centerOffsetY', 'Centre Offset Y', -100, 100, 0, 1);
                addSelect('direction', 'Direction', [
                    { value: 'cw', label: 'Clockwise' },
                    { value: 'ccw', label: 'Anticlockwise' }
                ], 'cw');
                addS('influence', 'Brightness Influence', 0, 100, 75, 1);
                addS('gamma', 'Gamma', 25, 250, 100, 1);
                addS('minMod', 'Minimum Modulation', 0, 8, 0.3, 0.1);
                addS('maxMod', 'Maximum Modulation', 0, 18, 4.5, 0.1);
                addS('oscAmplitude', 'Oscillation Amplitude', 0, 12, 1.6, 0.1);
                addS('oscFrequency', 'Oscillation Frequency', 0, 20, 7, 0.1);
                addS('previewStrokeWidth', 'Stroke Preview', 0.1, 6, 1.2, 0.1);
                addS('smoothing', 'Smoothing Amount', 0, 100, 58, 1);
                addS('detail', 'Detail Amount', 1, 100, 62, 1);
                addS('margin', 'Edge Margin', 0, 80, 10, 1);
                addSelect('invert', 'Invert Image', [
                    { value: 'false', label: 'Off' },
                    { value: 'true', label: 'On' }
                ], 'false');
                addSelect('cropMode', 'Image Fit', [
                    { value: 'fit', label: 'Fit To Canvas' },
                    { value: 'square', label: 'Crop To Square' }
                ], 'fit');
                break;
            case 'squiggle':
                addS('squiggleLineCount', 'Line Count', 10, 200, 50, 1);
                addS('squiggleFrequency', 'Frequency', 5, 256, 150, 1);
                addS('squiggleAmplitude', 'Amplitude', 0.1, 5, 1, 0.1);
                addS('squiggleSampling', 'Sampling', 0.5, 3, 1, 0.1);
                addSelect('squiggleModulation', 'Modulation', [
                    { value: 'both', label: 'AM + FM' },
                    { value: 'am', label: 'Amplitude Only' },
                    { value: 'fm', label: 'Frequency Only' }
                ], 'both');
                break;
            case 'wave':
                addS('spacing', 'Wave Spacing', 2, 30, 8);
                addS('amplitude', 'Amplitude', 2, 40, 15);
                html += `<div class="form-group iv-compact-group iv-dynamic-group">
                    <label>Path Style</label>
                    <select id="input-iv-style" style="width: 100%;">
                        <option value="curves">Smooth Curves Only</option>
                        <option value="mixed">Mixed (Lines & Curves)</option>
                        <option value="lines">Straight Angular Lines</option>
                    </select>
                </div>`;
                break;
            case 'longwave':
                addS('longWaveSpeed', 'Wave Speed', 1, 100, 20, 1);
                addS('longWaveAmplitude', 'Wave Amplitude', 0, 50, 10, 0.1);
                addS('longWaveStep', 'Step Size', 1, 20, 5, 0.1);
                addS('longWaveSimplify', 'Hysteresis', 1, 50, 10, 0.1);
                addS('longWaveDepth', 'Depth', 1, 8, 3, 1);
                addSelect('longWaveDirection', 'Direction', [
                    { value: 'vertical', label: 'Vertical' },
                    { value: 'horizontal', label: 'Horizontal' },
                    { value: 'both', label: 'Both' }
                ], 'vertical');
                break;
            case 'stipple':
                addS('maxStipples', 'Max Stipples', 100, 10000, 1800, 100);
                addS('minDotSize', 'Min Dot Size', 0.2, 8, 1.5, 0.1);
                addS('dotSizeRange', 'Dot Size Range', 0, 20, 4, 0.1);
                addS('stippleSeed', 'Seed', 0, 999, 1, 1);
                addSelect('stippleType', 'Stipple Type', [
                    { value: 'circles', label: 'Circles' },
                    { value: 'spirals', label: 'Spirals' },
                    { value: 'hexagons', label: 'Hexagons' },
                    { value: 'pentagrams', label: 'Pentagrams' },
                    { value: 'snowflakes', label: 'Snowflakes' }
                ], 'circles');
                break;
            case 'dots':
                addS('dotsResolution', 'Resolution', 1, 20, 2, 1);
                addS('dotsDirection', 'Line Direction', 0, 180, 0, 1);
                addS('dotsSeed', 'Seed', 0, 999, 50, 1);
                addSelect('dotsRandomDirection', 'Random Direction', [
                    { value: 'false', label: 'Off' },
                    { value: 'true', label: 'On' }
                ], 'false');
                break;
            case 'mosaic':
                addS('mosaicScale', 'Scale', 2, 100, 10, 1);
                addS('mosaicHatches', 'Hatches', 2, 10, 6, 1);
                addSelect('mosaicOutlines', 'Outlines', [
                    { value: 'false', label: 'Off' },
                    { value: 'true', label: 'On' }
                ], 'false');
                break;
            case 'woven':
                addS('wovenFrequency', 'Frequency', 5, 256, 24, 1);
                addS('wovenLineCount', 'Line Count', 5, 200, 8, 1);
                addS('wovenSeed', 'Seed', 0, 999, 1, 1);
                addSelect('wovenCosine', 'Cosine Join', [
                    { value: 'false', label: 'Off' },
                    { value: 'true', label: 'On' }
                ], 'false');
                addSelect('wovenRandom', 'Random Swap', [
                    { value: 'false', label: 'Off' },
                    { value: 'true', label: 'On' }
                ], 'false');
                addSelect('wovenPower', 'Power', [
                    { value: '0.5', label: '0.5' },
                    { value: '1', label: '1' },
                    { value: '2', label: '2' },
                    { value: '3', label: '3' }
                ], '2');
                break;
            case 'shape':
                addS('spacing', 'Shape Spacing', 8, 40, 20);
                html += `<div class="form-group iv-compact-group iv-dynamic-group">
                    <label>Shape</label>
                    <select id="input-iv-shape" style="width: 100%;">
                        <option value="rectangle">Square</option>
                        <option value="triangle">Triangle</option>
                        <option value="star">Star</option>
                        <option value="circle">Circle</option>
                    </select>
                </div>`;
                break;
            case 'flow': addS('count', 'Line Count', 100, 3000, 800, 100); addS('steps', 'Line Length', 20, 400, 80); break;
            case 'string':
                addS('pins', 'Pins', 40, 500, 120);
                addS('lines', 'Lines', 100, 6000, 1500);
                addS('lineWeight', 'Line Density', 1, 100, 30);
                addS('saSharp', 'Edge Boost', 0, 100, 50);
                html += `<div class="form-group iv-compact-group iv-dynamic-group">
                    <label>Shape</label>
                    <select id="input-iv-shape" style="width: 100%;">
                        <option value="circle">Circle</option>
                        <option value="rectangle">Rectangle</option>
                        <option value="triangle">Triangle</option>
                    </select>
                </div>`;
                break;
        }
        container.innerHTML = html;
        container.querySelectorAll('input, select').forEach(i => {
            i.oninput = (e) => {
                if (e.target.id.startsWith('input-iv-')) {
                    const valEl = document.getElementById(e.target.id.replace('input', 'val'));
                    if (valEl) valEl.textContent = e.target.value;
                    if (method === 'spiral' && e.target.id === 'input-iv-spiralPreset') {
                        this.applySpiralPreset(e.target.value);
                        return;
                    }
                    if (method === 'contour' && e.target.id === 'input-iv-fill') updateContourFillLabels();
                    this.autoGenerate();
                }
            };
            if (i.tagName === 'SELECT') {
                i.onchange = () => {
                    if (method === 'spiral' && i.id === 'input-iv-spiralPreset') {
                        this.applySpiralPreset(i.value);
                        return;
                    }
                    if (method === 'contour' && i.id === 'input-iv-fill') updateContourFillLabels();
                    this.autoGenerate();
                };
            }
        });
        if (method === 'contour') updateContourFillLabels();
        if (method === 'spiral') this.applySpiralPreset('portraitClean', true);
    }

    getSpiralPresetMap() {
        return {
            portraitClean: {
                contrast: 58,
                spacing: 4.0,
                turns: 120,
                influence: 78,
                gamma: 92,
                minMod: 0.3,
                maxMod: 4.2,
                oscAmplitude: 1.5,
                oscFrequency: 7,
                previewStrokeWidth: 1.1,
                smoothing: 64,
                detail: 62,
                margin: 10,
                direction: 'cw',
                invert: 'false',
                cropMode: 'fit',
                centerOffsetX: 0,
                centerOffsetY: 0
            },
            highDetail: {
                contrast: 66,
                spacing: 2.8,
                turns: 170,
                influence: 88,
                gamma: 86,
                minMod: 0.2,
                maxMod: 3.3,
                oscAmplitude: 1.2,
                oscFrequency: 9.5,
                previewStrokeWidth: 0.9,
                smoothing: 48,
                detail: 90,
                margin: 8,
                direction: 'cw',
                invert: 'false',
                cropMode: 'fit',
                centerOffsetX: 0,
                centerOffsetY: 0
            },
            plotterSafe: {
                contrast: 52,
                spacing: 5.3,
                turns: 92,
                influence: 62,
                gamma: 100,
                minMod: 0.2,
                maxMod: 2.3,
                oscAmplitude: 0.8,
                oscFrequency: 5,
                previewStrokeWidth: 1.4,
                smoothing: 78,
                detail: 48,
                margin: 14,
                direction: 'cw',
                invert: 'false',
                cropMode: 'fit',
                centerOffsetX: 0,
                centerOffsetY: 0
            },
            boldContrast: {
                contrast: 78,
                spacing: 3.5,
                turns: 132,
                influence: 95,
                gamma: 72,
                minMod: 0.5,
                maxMod: 5.4,
                oscAmplitude: 2.1,
                oscFrequency: 8.5,
                previewStrokeWidth: 1.3,
                smoothing: 52,
                detail: 74,
                margin: 9,
                direction: 'cw',
                invert: 'false',
                cropMode: 'square',
                centerOffsetX: 0,
                centerOffsetY: 0
            },
            softEngraving: {
                contrast: 44,
                spacing: 4.8,
                turns: 108,
                influence: 56,
                gamma: 118,
                minMod: 0.15,
                maxMod: 2.7,
                oscAmplitude: 0.9,
                oscFrequency: 4.5,
                previewStrokeWidth: 1.0,
                smoothing: 82,
                detail: 44,
                margin: 12,
                direction: 'cw',
                invert: 'false',
                cropMode: 'fit',
                centerOffsetX: 0,
                centerOffsetY: 0
            }
        };
    }

    applySpiralPreset(presetName, suppressGenerate = false) {
        const preset = this.getSpiralPresetMap()[presetName];
        if (!preset) return;

        Object.entries(preset).forEach(([key, value]) => {
            const input = document.getElementById('input-iv-' + key);
            if (!input) return;
            input.value = value;
            const valueLabel = document.getElementById('val-iv-' + key);
            if (valueLabel) valueLabel.textContent = value;
        });

        const presetSelect = document.getElementById('input-iv-spiralPreset');
        if (presetSelect && presetSelect.value !== presetName) presetSelect.value = presetName;

        if (!suppressGenerate) this.autoGenerate();
    }

    async generateVector() {
        if (!this.currentImage || this.isGenerating) return;
        this.isGenerating = true;

        const btn = document.getElementById('btn-iv-generate');
        const btnT = btn ? btn.textContent : 'Refresh';
        if (btn) {
            btn.textContent = '...';
            btn.disabled = true;
        }

        const method = document.getElementById('sel-iv-method').value;
        const gV = (id, def) => {
            const el = document.getElementById('input-iv-' + id);
            return el ? parseFloat(el.value) : def;
        };

        const params = {
            threshold: gV('threshold', 128),
            contrast: gV('contrast', 50),
            simplify: gV('simplify', 10),
            traceSpeckle: gV('traceSpeckle', 4),
            traceCornerSmooth: gV('traceCornerSmooth', 100),
            spacing: gV('spacing', 5),
            turns: gV('turns', 120),
            squiggleLineCount: gV('squiggleLineCount', 50),
            squiggleFrequency: gV('squiggleFrequency', 150),
            squiggleAmplitude: gV('squiggleAmplitude', 1),
            squiggleSampling: gV('squiggleSampling', 1),
            centerOffsetX: gV('centerOffsetX', 0),
            centerOffsetY: gV('centerOffsetY', 0),
            influence: gV('influence', 75),
            gamma: gV('gamma', 100),
            minMod: gV('minMod', 0.3),
            maxMod: gV('maxMod', 4.5),
            oscAmplitude: gV('oscAmplitude', 1.6),
            oscFrequency: gV('oscFrequency', 7),
            previewStrokeWidth: gV('previewStrokeWidth', 1.2),
            smoothing: gV('smoothing', 58),
            detail: gV('detail', 62),
            margin: gV('margin', 10),
            longWaveSpeed: gV('longWaveSpeed', 20),
            longWaveAmplitude: gV('longWaveAmplitude', 10),
            longWaveStep: gV('longWaveStep', 5),
            longWaveSimplify: gV('longWaveSimplify', 10),
            longWaveDepth: gV('longWaveDepth', 3),
            maxStipples: gV('maxStipples', 1800),
            minDotSize: gV('minDotSize', 1.5),
            dotSizeRange: gV('dotSizeRange', 4),
            stippleSeed: gV('stippleSeed', 1),
            dotsResolution: gV('dotsResolution', 2),
            dotsDirection: gV('dotsDirection', 0),
            dotsSeed: gV('dotsSeed', 50),
            mosaicScale: gV('mosaicScale', 10),
            mosaicHatches: gV('mosaicHatches', 6),
            wovenFrequency: gV('wovenFrequency', 24),
            wovenLineCount: gV('wovenLineCount', 8),
            wovenSeed: gV('wovenSeed', 1),
            amplitude: gV('amplitude', 15),
            layers: gV('layers', 2),
            count: gV('count', 800),
            steps: gV('steps', 80),
            levels: 8,
            pins: gV('pins', 120),
            lines: gV('lines', 1500),
            shape: (document.getElementById('input-iv-shape') || {}).value || 'circle',
            fill: (document.getElementById('input-iv-fill') || {}).value || 'none',
            style: (document.getElementById('input-iv-style') || {}).value || 'curves',
            fillSpacing: gV('fillSpacing', 8),
            fillAngle: gV('fillAngle', 45),
            zigzagSize: gV('zigzagSize', 5),
            lineWeight: gV('lineWeight', 30),
            edgeBoost: gV('saSharp', 50),
            direction: (document.getElementById('input-iv-direction') || {}).value || 'cw',
            invert: ((document.getElementById('input-iv-invert') || {}).value || 'false') === 'true',
            cropMode: (document.getElementById('input-iv-cropMode') || {}).value || 'fit',
            spiralPreset: (document.getElementById('input-iv-spiralPreset') || {}).value || 'portraitClean',
            squiggleModulation: (document.getElementById('input-iv-squiggleModulation') || {}).value || 'both',
            longWaveDirection: (document.getElementById('input-iv-longWaveDirection') || {}).value || 'vertical',
            stippleType: (document.getElementById('input-iv-stippleType') || {}).value || 'circles',
            dotsRandomDirection: ((document.getElementById('input-iv-dotsRandomDirection') || {}).value || 'false') === 'true',
            mosaicOutlines: ((document.getElementById('input-iv-mosaicOutlines') || {}).value || 'false') === 'true',
            wovenCosine: ((document.getElementById('input-iv-wovenCosine') || {}).value || 'false') === 'true',
            wovenRandom: ((document.getElementById('input-iv-wovenRandom') || {}).value || 'false') === 'true',
            wovenPower: parseFloat((document.getElementById('input-iv-wovenPower') || {}).value || '2')
        };

        this.lastParams = params;

        setTimeout(async () => {
            try {
                const colorMode = document.getElementById('sel-iv-color-mode') ? document.getElementById('sel-iv-color-mode').value : 'bw';
                
                if (colorMode === 'color') {
                    // Generate 3 layers
                    const channels = ['r', 'g', 'b'];
                    this.vectorPaths = [];
                    for (let i = 0; i < 3; i++) {
                        const layerParams = { ...params, channel: channels[i], layerIndex: i };
                        const paths = await this.engine.process(method, layerParams);
                        // Tag paths with their layer index
                        paths.forEach(p => p.layer = i);
                        this.vectorPaths.push(...paths);
                    }
                } else {
                    // Standard BW generation
                    const layerParams = { ...params, channel: 'bw', layerIndex: 0 };
                    this.vectorPaths = await this.engine.process(method, layerParams);
                    this.vectorPaths.forEach(p => p.layer = 0);
                }

                this.drawPreview();
                document.getElementById('iv-stat-paths').textContent = `Paths: ${this.vectorPaths.length}`;
                document.getElementById('btn-iv-add').disabled = this.vectorPaths.length === 0;
            } catch (e) {
                console.error(e);
                this.app.ui.logToConsole(`Error: ${e.message}`, 'error');
            } finally {
                this.isGenerating = false;
                if (btn) {
                    btn.textContent = btnT;
                    btn.disabled = false;
                }
            }
        }, 10);
    }

    addToBed() {
        if (!this.vectorPaths.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.vectorPaths.forEach(path => {
            const points = Array.isArray(path) ? path : path?.points;
            if (!Array.isArray(points)) return;
            points.forEach(p => {
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
            });
        });
        if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return;
        const w = maxX - minX, h = maxY - minY;
        const bedW = this.app.canvas.bedWidth, bedH = this.app.canvas.bedHeight;
        let scale = 1.0;
        const targetW = bedW * 0.7, targetH = bedH * 0.7;
        if (w > targetW || h > targetH) scale = Math.min(targetW / w, targetH / h);
        const centerX = bedW / 2;
        const centerY = bedH / 2;
        // Generate a random stable group ID for this import
        const importGroupId = 'import_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

        const tx = centerX - (minX + w / 2) * scale;
        const ty = centerY - (minY + h / 2) * scale;

        const shifted = this.vectorPaths.map(path => {
            const points = Array.isArray(path) ? path : path?.points;
            if (!Array.isArray(points) || points.length < 2) return null;

            const scaledPoints = points.map(p => ({
                x: p.x * scale + tx,
                y: p.y * scale + ty
            }));

            let scaledSegments = null;
            if (path.segments) {
                scaledSegments = path.segments.map(s => {
                    const scaled = { ...s };
                    if (s.x !== undefined) { scaled.x = s.x * scale + tx; scaled.y = s.y * scale + ty; }
                    if (s.x1 !== undefined) { scaled.x1 = s.x1 * scale + tx; scaled.y1 = s.y1 * scale + ty; }
                    if (s.x2 !== undefined) { scaled.x2 = s.x2 * scale + tx; scaled.y2 = s.y2 * scale + ty; }
                    return scaled;
                });
            }

            // Assign subgroup and visualizer pen based on import mode.
            const layerIdx = path.layer || 0;
            const subGroupId = `${importGroupId}_layer${layerIdx}`;

            const colorMode = document.getElementById('sel-iv-color-mode').value;
            let physicalPen = 1;
            if (colorMode === 'color') {
                // Reserve pen 1 for BW imports. RGB layers map to pens 2, 3, and 4.
                physicalPen = layerIdx + 2;

                if (this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[physicalPen - 1]) {
                    this.app.ui.visPenConfig[physicalPen - 1].color = this.layerColors[layerIdx] || this.layerColors[0];
                    this.app.ui.visPenConfig[physicalPen - 1].visible = true;
                }
            } else if (this.app.ui && Array.isArray(this.app.ui.visPenConfig) && this.app.ui.visPenConfig[0]) {
                this.app.ui.visPenConfig[0].visible = true;
            }

            const pathObj = {
                type: scaledSegments ? 'path' : 'polyline',
                groupId: subGroupId,
                parentGroupId: colorMode === 'color' ? importGroupId : undefined,
                points: scaledPoints,
                pen: physicalPen
            };

            if (scaledSegments) pathObj.segments = scaledSegments;
            if (path?.closed === true) pathObj.closed = true;
            return pathObj;
        }).filter(Boolean);
        
        // Refresh the visible pen palette after remapping RGB layers to visualizer pens.
        if (this.app.ui && this.app.ui.updateVisualizerPalette) this.app.ui.updateVisualizerPalette();

        this.app.canvas.paths.push(...shifted);
        this.app.canvas.saveUndoState();
        this.app.canvas.draw();
        this.app.ui.logToConsole(`System: Added ${shifted.length} paths (centered).`);
    }

    clear() {
        this.currentImage = null; this.vectorPaths = []; this.engine.imageData = null;
        this.scale = 1.0;
        this.offsetX = 0;
        this.offsetY = 0;
        this.drawPreview();
        const placeholder = document.getElementById('iv-placeholder');
        if (placeholder) placeholder.classList.remove('hidden');
        document.getElementById('iv-stat-pix').textContent = 'Pixels: 0x0';
        document.getElementById('iv-stat-paths').textContent = 'Paths: 0';
        document.getElementById('btn-iv-add').disabled = true;
    }
}
if (typeof module !== 'undefined') module.exports = ImageVectorPanel;
else window.ImageVectorPanel = ImageVectorPanel;
