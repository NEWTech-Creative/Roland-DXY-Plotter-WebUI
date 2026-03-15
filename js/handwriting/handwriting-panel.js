/**
 * Handwriting Panel UI Controller
 */
class HandwritingPanel {
    constructor(app) {
        this.app = app;
        console.log('HandwritingPanel: Constructor started');
        this.engine = new HandwritingEngine();
        this.engine.init(HandwritingLibrary);
        this.lastResult = null;
        this.previewVisible = true;

        this._bindEvents();
        console.log('HandwritingPanel: Initialized.');
    }

    _bindEvents() {
        const btnGenerate = document.getElementById('btn-hw-generate');
        const btnRegenerate = document.getElementById('btn-hw-regenerate');
        const btnAddToBed = document.getElementById('btn-hw-add');
        const btnExportSVG = document.getElementById('btn-hw-export');

        if (btnGenerate) btnGenerate.onclick = () => this.generatePreview();
        if (btnRegenerate) {
            btnRegenerate.onclick = () => {
                const seedInput = document.getElementById('input-hw-seed');
                if (seedInput) {
                    seedInput.value = Math.floor(Math.random() * 10000);
                    this.generatePreview();
                }
            };
        }
        if (btnAddToBed) btnAddToBed.onclick = () => this.addToBed();
        if (btnExportSVG) btnExportSVG.onclick = () => this.exportSVG();

        // Update value labels & Trigger change
        const sliders = ['input-hw-slant', 'input-hw-messiness', 'input-hw-char-height', 'input-hw-line-spacing', 'input-hw-char-spacing'];
        sliders.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.oninput = (e) => {
                    const valEl = document.getElementById(id.replace('input', 'val'));
                    if (valEl) valEl.textContent = e.target.value;
                };
                el.onchange = () => this.generatePreview();
            }
        });

        const selects = ['sel-hw-style'];
        selects.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.onchange = () => this.generatePreview();
        });

        const seedInput = document.getElementById('input-hw-seed');
        if (seedInput) seedInput.onchange = () => this.generatePreview();
    }

    getOptions() {
        const getVal = (id, def) => {
            const val = parseFloat(document.getElementById(id).value);
            return isNaN(val) ? def : val;
        };
        const getIntVal = (id, def) => {
            const val = parseInt(document.getElementById(id).value);
            return isNaN(val) ? def : val;
        };

        return {
            style: document.getElementById('sel-hw-style').value || 'print',
            seed: getIntVal('input-hw-seed', 1234),
            slant: getVal('input-hw-slant', 0),
            messiness: getVal('input-hw-messiness', 0),
            characterHeight: getVal('input-hw-char-height', 6),
            lineSpacing: getVal('input-hw-line-spacing', 10),
            characterSpacing: getVal('input-hw-char-spacing', 0),
            pageWidth: getVal('input-hw-width', 210),
            pageHeight: getVal('input-hw-height', 297)
        };
    }

    generatePreview() {
        const textEl = document.getElementById('input-hw-text');
        const text = textEl ? textEl.value : "";
        console.log('HandwritingPanel: Generating preview for text:', text);
        if (!text) {
            console.warn('HandwritingPanel: No text entered.');
            return;
        }

        const options = this.getOptions();
        console.log('HandwritingPanel: Using options:', options);

        try {
            this.lastResult = this.engine.generate(text, options);
            console.log('HandwritingPanel: Generation result:', this.lastResult);
            this.renderPreview();
        } catch (err) {
            console.error('HandwritingPanel: Generation failed:', err);
        }
    }

    renderPreview() {
        const previewContainer = document.getElementById('hw-preview-container');
        if (!previewContainer || !this.lastResult) return;

        const options = this.getOptions();
        const svg = this.engine.export.toSVG(this.lastResult, options);

        // Add faint baseline guides to SVG for preview
        let guides = '';
        if (this.previewVisible) {
            for (let y = options.characterHeight * 1.0; y < options.pageHeight; y += options.lineSpacing) {
                guides += `<line x1="0" y1="${y}" x2="${options.pageWidth}" y2="${y}" stroke="#ddd" stroke-dasharray="2,2" />\n`;
            }
        }

        const finalSvg = svg
            .replace('<svg ', '<svg style="border: 1px solid #ccc; box-shadow: 0 4px 12px rgba(0,0,0,0.08);" ')
            .replace('</svg>', guides + '</svg>');
        previewContainer.innerHTML = finalSvg;
    }

    addToBed() {
        if (!this.lastResult) {
            const text = document.getElementById('input-hw-text').value;
            if (!text) return;
            this.generatePreview();
        }

        const vectorObj = this.engine.export.toVectorObject(this.lastResult);

        // Use the application's canvas manager to add the object
        if (this.app.canvas) {
            if (!vectorObj.children || vectorObj.children.length === 0) return;

            // Calculate bounding box of the entire handwriting text
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            vectorObj.children.forEach(child => {
                if (child.points) {
                    child.points.forEach(p => {
                        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                    });
                }
            });

            // Calculate exact center shift needed
            const w = maxX - minX;
            const h = maxY - minY;
            const bedCenterX = this.app.canvas.bedWidth / 2;
            const bedCenterY = this.app.canvas.bedHeight / 2;

            const shiftX = bedCenterX - (minX + w / 2);
            const shiftY = bedCenterY - (minY + h / 2);

            const penIdx = this.app.ui.activeVisualizerPen || 1;
            const groupId = 'hw_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

            vectorObj.children.forEach(child => {
                child.pen = penIdx;
                child.groupId = groupId; // Auto-group the strokes
                if (child.points) {
                    child.points.forEach(p => {
                        p.x += shiftX;
                        p.y += shiftY;
                    });
                }
                this.app.canvas.addPath(child);
            });

            this.app.canvas.saveUndoState();
            this.app.canvas.draw();
            this.app.ui.logToConsole('System: Handwriting added to canvas and centered.');
        }
    }

    exportSVG() {
        if (!this.lastResult) return;
        const options = this.getOptions();
        const svg = this.engine.export.toSVG(this.lastResult, options);

        const blob = new Blob([svg], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'handwriting.svg';
        a.click();
        URL.revokeObjectURL(url);
    }
}
