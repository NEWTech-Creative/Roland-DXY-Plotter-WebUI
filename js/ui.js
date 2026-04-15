class UIController {
    constructor(app) {
        this.app = app;
        this.penColors = ['#1e1e1e', '#e11d48', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#ea580c', '#0ea5e9']; // Default 8 pens
        this.visPenConfig = this.penColors.map(c => ({ color: c, thickness: 0.3 })); // Context configs
        this.activeTool = 'select'; // select, text, shape, bezier, node, bucket, warp, boolean
        this.bezierToolMode = 'curves';
        this.activeVisualizerPen = 1;
        this.fillBucketSettings = {
            pattern: 'lines',
            spacing: 6,
            angle: 45,
            pen: 1,
            groupPatterns: true
        };
        this.textToolSettings = {
            mode: 'roland',
            creativeFontId: 'bungee',
            fontSize: 10,
            rotation: 0,
            letterSpacing: 0,
            curve: 0
        };
        this.textToolPersistTimer = null;
        this.jogStepSize = 1; // Default Small (1mm)
        this.layoutVersion = 2;
        this.gridBaseColumns = 12;
        this.gridMinPanelWidth = 320;
        this.currentGridColumns = this.gridBaseColumns;
        this.baseGridLayout = [];
        this.legacyDefaultLayout = [
            { id: 'panel-connection', x: 0, y: 0, w: 3, h: 4 },
            { id: 'panel-machine-jog', x: 0, y: 4, w: 3, h: 5 },
            { id: 'panel-console', x: 9, y: 0, w: 3, h: 13 },
            { id: 'panel-visualiser', x: 3, y: 0, w: 6, h: 11 },
            { id: 'panel-patterns', x: 9, y: 13, w: 3, h: 10 },
            { id: 'panel-handwriting', x: 3, y: 11, w: 6, h: 8 },
            { id: 'panel-image-vector', x: 3, y: 19, w: 6, h: 12 },
            { id: 'panel-3d-vector', x: 3, y: 31, w: 6, h: 12 }
        ];
        this.defaultGridLayout = [
            { id: 'panel-connection', x: 0, y: 0, w: 2, h: 4 },
            { id: 'panel-machine-jog', x: 0, y: 4, w: 2, h: 4 },
            { id: 'panel-console', x: 0, y: 8, w: 2, h: 7 },
            { id: 'panel-visualiser', x: 2, y: 0, w: 5, h: 8 },
            { id: 'panel-live-tracker', x: 8, y: 0, w: 2, h: 7 },
            { id: 'panel-handwriting', x: 2, y: 8, w: 3, h: 7 },
            { id: 'panel-image-vector', x: 5, y: 8, w: 3, h: 7 },
            { id: 'panel-patterns', x: 8, y: 8, w: 2, h: 7 },
            { id: 'panel-3d-vector', x: 2, y: 15, w: 8, h: 8 }
        ];
        this.panelDefinitions = [
            { id: 'panel-connection', label: 'Connection', alwaysVisible: true },
            { id: 'panel-machine-jog', label: 'Machine & Jog' },
            { id: 'panel-console', label: 'Command Log' },
            { id: 'panel-visualiser', label: 'Visualiser' },
            { id: 'panel-live-tracker', label: 'Live Finger Tracker' },
            { id: 'panel-patterns', label: 'Pattern Generator' },
            { id: 'panel-handwriting', label: 'Handwriting Generator' },
            { id: 'panel-image-vector', label: 'Image to Vector' },
            { id: 'panel-3d-vector', label: '3D Vector' }
        ];
        this.creativeTabHostId = 'panel-creative-tabs';
        this.creativeTabHostLayout = { id: this.creativeTabHostId, x: 2, y: 8, w: 8, h: 15 };
        this.creativePanelDefinitions = this._getDefaultCreativePanelDefinitions();
        this.activeCreativeTabId = this.creativePanelDefinitions[0].id;
        this.draggingCreativeTabId = null;
        this.gridResizeTimer = null;
        this.gridAutoSaveTimer = null;
        this.isApplyingResponsiveLayout = false;
        this.isLoadingGridLayout = false;
        this.isApplyingPanelVisibility = false;
        this.isUpdatingSelectionSizeControls = false;
        this.visualizerToolbarItems = [];
        this.visualizerToolbarResizeObserver = null;
        this.currentVisualizerView = 'workspace';

        this.loadWorkspaceState();
        this._bindInput();
        this._bindTools();
        this._bindStartupModal();
        this._bindMachineSetupHelp();
        this._bindSettings();
        this._bindCustomPaperModal();
        this._bindImportResolutionMenu();
        this._bindJog();
        this._bindPatterns();
        this._bindFillBucketMenu();
        this._bindBooleanMenu();
        this._bindBezierToolMenu();
        this._bindTextToolMenu();
        this._bindSelectionSizeControls();
        this._bindVisualizerToolbarOverflow();
        this._bindPredictedCrosshairToggle();
        this._bindVisualizerViewToggle();
        this._bindToolHoverLabels();
        // HandwritingPanel is initialized by its own window.load listener in handwriting-panel.js

        // Close visualizer pop-out menus as soon as the user clicks elsewhere.
        window.addEventListener('pointerdown', (e) => {
            const penMenu = document.getElementById('vis-pen-menu');
            const textMenu = document.getElementById('text-tool-menu');
            const bezierMenu = document.getElementById('bezier-tool-menu');
            const shapeMenu = document.getElementById('shape-type-menu');
            const fillBucketMenu = document.getElementById('fill-bucket-menu');
            const booleanToolMenu = document.getElementById('boolean-tool-menu');
            const importResolutionMenu = document.getElementById('import-resolution-menu');
            const overflowMenu = document.getElementById('vis-toolbar-overflow-menu');
            const overflowBtn = document.getElementById('btn-vis-toolbar-more');

            if (penMenu && !penMenu.classList.contains('hidden')) {
                if (!penMenu.contains(e.target) && !e.target.closest('.vis-color-btn')) {
                    penMenu.classList.add('hidden');
                }
            }
            if (textMenu && !textMenu.classList.contains('hidden')) {
                if (!textMenu.contains(e.target) && !e.target.closest('[data-tool="text"]')) {
                    textMenu.classList.add('hidden');
                    this.syncSpecialToolHighlights();
                }
            }
            if (bezierMenu && !bezierMenu.classList.contains('hidden')) {
                if (!bezierMenu.contains(e.target) && !e.target.closest('[data-tool="bezier"]')) {
                    bezierMenu.classList.add('hidden');
                    this.syncSpecialToolHighlights();
                }
            }
            if (shapeMenu && !shapeMenu.classList.contains('hidden')) {
                if (!shapeMenu.contains(e.target) && !e.target.closest('[data-tool="shape"]')) {
                    shapeMenu.classList.add('hidden');
                    this.syncSpecialToolHighlights();
                }
            }
            if (fillBucketMenu && !fillBucketMenu.classList.contains('hidden')) {
                if (!fillBucketMenu.contains(e.target) && !e.target.closest('[data-tool="bucket"]')) {
                    fillBucketMenu.classList.add('hidden');
                }
            }
            if (booleanToolMenu && !booleanToolMenu.classList.contains('hidden')) {
                if (!booleanToolMenu.contains(e.target) && !e.target.closest('[data-tool="boolean"]')) {
                    booleanToolMenu.classList.add('hidden');
                    this.syncSpecialToolHighlights();
                }
            }
            if (importResolutionMenu && !importResolutionMenu.classList.contains('hidden')) {
                if (!importResolutionMenu.contains(e.target) && !e.target.closest('#btn-import-resolution')) {
                    importResolutionMenu.classList.add('hidden');
                }
            }
            if (overflowMenu && overflowBtn && !overflowMenu.classList.contains('hidden')) {
                if (!overflowMenu.contains(e.target) && !overflowBtn.contains(e.target)) {
                    overflowMenu.classList.add('hidden');
                }
            }
        });
    }

    setToolMenuHighlight(toolName, isOpen) {
        const button = document.querySelector(`.tool-btn[data-tool="${toolName}"]`);
        if (!button) return;
        button.classList.toggle('menu-open', !!isOpen);
    }

    syncSpecialToolHighlights() {
        this.setToolMenuHighlight('text', !document.getElementById('text-tool-menu')?.classList.contains('hidden'));
        this.setToolMenuHighlight('bezier', !document.getElementById('bezier-tool-menu')?.classList.contains('hidden'));
        this.setToolMenuHighlight('shape', !document.getElementById('shape-type-menu')?.classList.contains('hidden'));
        this.setToolMenuHighlight('boolean', !document.getElementById('boolean-tool-menu')?.classList.contains('hidden'));
    }

    loadWorkspaceState() {
        try {
            const savedPens = localStorage.getItem('visPenConfig');
            if (savedPens) this.visPenConfig = JSON.parse(savedPens);

            const savedPalette = localStorage.getItem('penColors');
            if (savedPalette) this.penColors = JSON.parse(savedPalette);

            const savedActive = localStorage.getItem('activeVisualizerPen');
            if (savedActive) this.activeVisualizerPen = parseInt(savedActive, 10);
            const savedVisualizerView = localStorage.getItem('visualizerViewMode');
            if (savedVisualizerView === 'machine-output' || savedVisualizerView === 'workspace') {
                this.currentVisualizerView = savedVisualizerView;
            }
            const savedTextSettings = localStorage.getItem('textToolSettings');
            if (savedTextSettings) {
                this.textToolSettings = {
                    ...this.textToolSettings,
                    ...JSON.parse(savedTextSettings)
                };
            }
            if (!this.textToolSettings.mode) this.textToolSettings.mode = 'roland';
            if (!this.textToolSettings.creativeFontId) this.textToolSettings.creativeFontId = 'bungee';
            if (!Number.isFinite(this.textToolSettings.letterSpacing)) this.textToolSettings.letterSpacing = 0;
            if (!Number.isFinite(this.textToolSettings.curve)) this.textToolSettings.curve = 0;
            const savedCreativePanelOrder = localStorage.getItem('creativePanelOrder');
            if (savedCreativePanelOrder) {
                this._applySavedCreativePanelOrder(JSON.parse(savedCreativePanelOrder));
            }


            // Normalise pen config: ensure each pen has required fields and sane visibility.
            if (Array.isArray(this.visPenConfig)) {
                for (let i = 0; i < 8; i++) {
                    if (!this.visPenConfig[i]) this.visPenConfig[i] = { color: this.penColors[i] || '#2563eb', thickness: 0.3, visible: true };
                    if (this.visPenConfig[i].color == null) this.visPenConfig[i].color = this.penColors[i] || '#2563eb';
                    if (this.visPenConfig[i].thickness == null) this.visPenConfig[i].thickness = 0.3;
                    if (this.visPenConfig[i].visible !== false) this.visPenConfig[i].visible = true;
                }
                const anyVisible = this.visPenConfig.some(p => p && p.visible !== false);
                if (!anyVisible) {
                    this.visPenConfig.forEach(p => { if (p) p.visible = true; });
                }
            }
        } catch (e) { console.error('Workspace load fail:', e); }
    }

    saveWorkspaceState() {
        try {
            localStorage.setItem('visPenConfig', JSON.stringify(this.visPenConfig));
            localStorage.setItem('penColors', JSON.stringify(this.penColors));
            localStorage.setItem('activeVisualizerPen', this.activeVisualizerPen.toString());
            localStorage.setItem('visualizerViewMode', this.currentVisualizerView);
            localStorage.setItem('textToolSettings', JSON.stringify(this.textToolSettings));
            localStorage.setItem('creativePanelOrder', JSON.stringify(this._getCreativePanelOrder()));
        } catch (e) { console.error('Workspace save fail:', e); }
    }

    getWorkspaceBackupState() {
        return {
            penConfig: this.visPenConfig,
            penColors: this.penColors,
            activeVisualizerPen: this.activeVisualizerPen,
            visualizerViewMode: this.currentVisualizerView,
            creativePanelOrder: this._getCreativePanelOrder(),
            plotterLayout: localStorage.getItem('plotterLayout'),
            plotterLayoutVersion: localStorage.getItem('plotterLayoutVersion')
        };
    }

    applyWorkspaceBackupState(workspaceState = {}) {
        try {
            if (Array.isArray(workspaceState.penColors)) {
                this.penColors = workspaceState.penColors;
                localStorage.setItem('penColors', JSON.stringify(this.penColors));
            }
            if (Array.isArray(workspaceState.penConfig)) {
                this.visPenConfig = workspaceState.penConfig;
                localStorage.setItem('visPenConfig', JSON.stringify(this.visPenConfig));
            }
            if (Number.isFinite(Number(workspaceState.activeVisualizerPen))) {
                this.activeVisualizerPen = parseInt(workspaceState.activeVisualizerPen, 10);
                localStorage.setItem('activeVisualizerPen', String(this.activeVisualizerPen));
            }
            if (workspaceState.visualizerViewMode === 'machine-output' || workspaceState.visualizerViewMode === 'workspace') {
                this.currentVisualizerView = workspaceState.visualizerViewMode;
                localStorage.setItem('visualizerViewMode', this.currentVisualizerView);
            }
            if (Array.isArray(workspaceState.creativePanelOrder) && workspaceState.creativePanelOrder.length) {
                this._applySavedCreativePanelOrder(workspaceState.creativePanelOrder);
                localStorage.setItem('creativePanelOrder', JSON.stringify(this._getCreativePanelOrder()));
            }
            if (typeof workspaceState.plotterLayout === 'string' && workspaceState.plotterLayout.trim()) {
                localStorage.setItem('plotterLayout', workspaceState.plotterLayout);
            }
            if (workspaceState.plotterLayoutVersion != null) {
                localStorage.setItem('plotterLayoutVersion', String(workspaceState.plotterLayoutVersion));
            }

            this.initPenSlots();
            this.refreshVisualizerViewToggleButton();

            const savedLayout = this.getSavedLayout();
            if (savedLayout.length) {
                this.baseGridLayout = savedLayout;
                this.applyResponsiveGridLayout();
            }
            this.applyPanelVisibilitySettings();
            this.refreshImportResolutionControl();
            this.app.canvas?.refreshPaperSettings?.();
            this.app.canvas?.draw?.();
        } catch (e) {
            console.error('Workspace restore fail:', e);
        }
    }

    refreshVisualizerViewToggleButton() {
        const toggleBtn = document.getElementById('btn-toggle-visualizer-view');
        const labelEl = document.getElementById('visualizer-view-label');
        const canvasContainer = document.querySelector('#panel-visualiser .canvas-container');
        const visualiserPanel = document.querySelector('#panel-visualiser .grid-stack-item-content');
        if (!toggleBtn || !labelEl) return;
        const isMachineOutput = this.currentVisualizerView === 'machine-output';
        labelEl.textContent = isMachineOutput ? 'Machine' : 'Workspace';
        toggleBtn.classList.toggle('active', isMachineOutput);
        toggleBtn.classList.toggle('machine-view-active', isMachineOutput);
        canvasContainer?.classList.toggle('machine-view-active', isMachineOutput);
        visualiserPanel?.classList.toggle('machine-view-active', isMachineOutput);
        toggleBtn.title = isMachineOutput
            ? 'Show editable workspace view'
            : 'Show machine output view';
    }

    refreshImportResolutionControl() {
        const input = document.getElementById('input-import-resolution');
        const valueLabel = document.getElementById('val-import-resolution');
        const buttonLabel = document.getElementById('import-resolution-label');
        const triggerButton = document.getElementById('btn-import-resolution');
        const resolution = this.app?.settings?.importResolution || 85;
        const disabled = this.app?.settings?.useInternalCurveEngine === true;

        if (input) {
            input.value = resolution;
            input.disabled = disabled;
        }
        if (valueLabel) valueLabel.textContent = String(resolution);
        if (buttonLabel) buttonLabel.textContent = `Curve ${resolution}`;
        if (triggerButton) {
            triggerButton.classList.toggle('disabled', disabled);
            triggerButton.title = disabled
                ? 'Curve resolution is disabled while the DXY internal curve function is on'
                : 'Adjust machine curve resolution';
        }
    }

    _bindImportResolutionMenu() {
        const triggerButton = document.getElementById('btn-import-resolution');
        const menu = document.getElementById('import-resolution-menu');
        const closeButton = document.getElementById('btn-close-import-resolution');
        const input = document.getElementById('input-import-resolution');
        const valueLabel = document.getElementById('val-import-resolution');

        if (!triggerButton || !menu || !input) return;

        const positionMenu = () => {
            const btnRect = triggerButton.getBoundingClientRect();
            const panel = triggerButton.closest('.grid-stack-item-content') || triggerButton.closest('.grid-stack-item') || document.body;
            const panelRect = panel.getBoundingClientRect();
            const gap = 10;

            if (menu.parentElement !== panel) panel.appendChild(menu);
            menu.classList.remove('hidden');
            menu.style.visibility = 'hidden';
            menu.style.position = 'absolute';

            const menuWidth = menu.offsetWidth;
            const menuHeight = menu.offsetHeight;
            const panelWidth = panelRect.width;
            const panelHeight = panelRect.height;

            let left = btnRect.left - panelRect.left;
            let top = (btnRect.bottom - panelRect.top) + gap;

            if (left + menuWidth > panelWidth - gap) left = panelWidth - menuWidth - gap;
            if (left < gap) left = gap;
            if (top + menuHeight > panelHeight - gap) top = (btnRect.top - panelRect.top) - menuHeight - gap;
            if (top < gap) top = gap;

            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
            menu.style.right = 'auto';
            menu.style.bottom = 'auto';
            menu.style.visibility = '';
        };

        triggerButton.onclick = () => {
            if (this.app?.settings?.useInternalCurveEngine === true) {
                this.logToConsole('System: Curve resolution is disabled while the DXY internal curve function is enabled.');
                return;
            }
            if (!menu.classList.contains('hidden')) {
                menu.classList.add('hidden');
                return;
            }
            this.refreshImportResolutionControl();
            positionMenu();
        };

        if (closeButton) closeButton.onclick = () => menu.classList.add('hidden');

        input.oninput = (e) => {
            const value = parseInt(e.target.value, 10) || 85;
            if (valueLabel) valueLabel.textContent = String(value);
            this.app.settings.importResolution = value;
            this.app.saveSettings();
            this.refreshImportResolutionControl();
            this.app.canvas?.draw?.(true);
        };

        this.refreshImportResolutionControl();
    }

    openCustomPaperModal() {
        const modal = document.getElementById('custom-paper-modal');
        const inputName = document.getElementById('input-custom-paper-name');
        const inputWidth = document.getElementById('input-custom-paper-width');
        const inputHeight = document.getElementById('input-custom-paper-height');
        if (!modal) return;
        if (inputName) inputName.value = '';
        if (inputWidth) inputWidth.value = '';
        if (inputHeight) inputHeight.value = '';
        modal.classList.remove('hidden');
        inputName?.focus?.();
    }

    closeCustomPaperModal() {
        const modal = document.getElementById('custom-paper-modal');
        if (modal) modal.classList.add('hidden');
    }

    saveCustomPaperFromModal() {
        const inputName = document.getElementById('input-custom-paper-name');
        const inputWidth = document.getElementById('input-custom-paper-width');
        const inputHeight = document.getElementById('input-custom-paper-height');
        const name = inputName ? inputName.value.trim() : '';
        const width = inputWidth ? parseFloat(inputWidth.value) : NaN;
        const height = inputHeight ? parseFloat(inputHeight.value) : NaN;
        const invalidReserved = ['A3', 'A4', 'A5', 'MAX', 'CUSTOM'].includes(name.toUpperCase());
        const existingCustom = (this.app.settings.customPaperSizes || []).filter(size => size.name.toUpperCase() !== name.toUpperCase());
        const normalized = this.app.normalizeCustomPaperSizes([...existingCustom, { name, width, height }]);
        const exists = normalized.some(size => size.name.toUpperCase() === name.toUpperCase());

        if (!name || invalidReserved || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !exists) {
            this.logToConsole('Error: Enter a unique paper label plus valid width and height in mm.', 'error');
            return false;
        }

        this.app.settings.customPaperSizes = normalized;
        this.app.settings.paperSize = name;
        this.app.saveSettings();
        this.app.canvas?.refreshPaperSettings?.();
        this.app.canvas?.handleResize?.();
        this.closeCustomPaperModal();
        this.logToConsole(`System: Custom paper "${name}" added to the paper size list.`);
        return true;
    }

    _bindCustomPaperModal() {
        const btnClose = document.getElementById('btn-close-custom-paper');
        const btnSave = document.getElementById('btn-save-custom-paper');
        const inputName = document.getElementById('input-custom-paper-name');
        const inputWidth = document.getElementById('input-custom-paper-width');
        const inputHeight = document.getElementById('input-custom-paper-height');

        if (btnClose) btnClose.onclick = () => this.closeCustomPaperModal();
        if (btnSave) btnSave.onclick = () => this.saveCustomPaperFromModal();
        [inputName, inputWidth, inputHeight].forEach(input => {
            if (!input) return;
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.saveCustomPaperFromModal();
                }
            });
        });
    }

    _bindVisualizerViewToggle() {
        const toggleBtn = document.getElementById('btn-toggle-visualizer-view');
        if (!toggleBtn) return;

        toggleBtn.addEventListener('click', () => {
            this.currentVisualizerView = this.currentVisualizerView === 'machine-output'
                ? 'workspace'
                : 'machine-output';
            this.refreshVisualizerViewToggleButton();
            this.saveWorkspaceState();
            if (this.app.canvas) {
                this.app.canvas.displayedCrosshairPoint = null;
            }
            this.app.canvas?.draw?.();
            this.logToConsole(
                this.currentVisualizerView === 'machine-output'
                    ? 'System: Visualiser now shows flattened machine-output geometry in workspace orientation.'
                    : 'System: Visualiser returned to editable workspace view.'
            );
        });

        this.refreshVisualizerViewToggleButton();
    }

    showLoading(title = 'Importing File...') {
        const overlay = document.getElementById('loading-overlay');
        const titleEl = document.getElementById('loading-title');
        const bar = document.getElementById('loading-bar');
        const status = document.getElementById('loading-status');

        if (overlay) {
            overlay.style.display = 'flex';
            if (titleEl) titleEl.innerText = title;
            if (bar) bar.style.width = '0%';
            if (status) status.innerText = 'Initializing...';
        }
    }

    updateLoading(progress, statusText) {
        const bar = document.getElementById('loading-bar');
        const status = document.getElementById('loading-status');
        if (bar) bar.style.width = `${progress}%`;
        if (status && statusText) status.innerText = statusText;
    }

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    initGridStack() {
        const savedLayout = this.getSavedLayout();
        if (savedLayout.length) {
            this.applyLayoutToElements(savedLayout);
            this.baseGridLayout = this._sortLayout(savedLayout);
        }

        this.grid = GridStack.init({
            column: this.gridBaseColumns,
            cellHeight: 80,
            margin: 10,
            handle: '.panel-header',
            animate: true,
            float: true,
            disableOneColumnMode: true
        });
        ['change', 'dragstop', 'resizestop'].forEach(eventName => {
            this.grid.on(eventName, () => this.scheduleLayoutSave());
        });
        ['dropped', 'drag', 'resize'].forEach(eventName => {
            this.grid.on(eventName, () => this.scheduleLayoutSave());
        });
        if (!savedLayout.length) this.loadLayout();
        this.captureBaseGridLayout();
        this.applyPanelVisibilitySettings();
        this.applyResponsiveGridLayout();
        window.addEventListener('resize', () => {
            clearTimeout(this.gridResizeTimer);
            this.gridResizeTimer = setTimeout(() => this.applyResponsiveGridLayout(), 120);
        });
        window.addEventListener('beforeunload', () => this.forceLayoutSave());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.forceLayoutSave();
        });
    }

    saveLayout(silent = false) {
        const visibleLayout = [];
        this.grid.engine.nodes.forEach(n => {
            if (n.el && n.el.id) {
                visibleLayout.push(this._normalizeNodeToBaseLayout(n));
            }
        });
        const hiddenLayout = this.baseGridLayout.filter(item => !this._isPanelVisible(item.id));
        const normalizedLayout = this._collapseTrailingPanelGap([...visibleLayout, ...hiddenLayout]);
        localStorage.setItem('plotterLayout', JSON.stringify(normalizedLayout));
        localStorage.setItem('plotterLayoutVersion', String(this.layoutVersion));
        this.baseGridLayout = normalizedLayout;
        if (!silent) this.logToConsole('System: Layout saved.');
    }

    getSavedLayout() {
        try {
            const saved = localStorage.getItem('plotterLayout');
            if (!saved) return [];
            const layout = JSON.parse(saved);
            if (!Array.isArray(layout)) return [];

            const savedVersion = parseInt(localStorage.getItem('plotterLayoutVersion') || '0', 10);
            if (savedVersion < this.layoutVersion && this._layoutsMatch(layout, this.legacyDefaultLayout)) {
                const migratedLayout = this.defaultGridLayout.map(item => ({ ...item }));
                localStorage.setItem('plotterLayout', JSON.stringify(migratedLayout));
                localStorage.setItem('plotterLayoutVersion', String(this.layoutVersion));
                return migratedLayout;
            }

            localStorage.setItem('plotterLayoutVersion', String(this.layoutVersion));
            return this._collapseTrailingPanelGap(layout);
        } catch (e) {
            return [];
        }
    }

    _layoutsMatch(a, b) {
        const normalizedA = this._sortLayout(a || []);
        const normalizedB = this._sortLayout(b || []);
        if (normalizedA.length !== normalizedB.length) return false;

        return normalizedA.every((item, index) => {
            const other = normalizedB[index];
            return item.id === other.id
                && item.x === other.x
                && item.y === other.y
                && item.w === other.w
                && item.h === other.h;
        });
    }

    applyLayoutToElements(layout) {
        layout.forEach(item => {
            if (!item || !item.id) return;
            const el = document.getElementById(item.id);
            if (!el) return;
            el.setAttribute('gs-x', item.x);
            el.setAttribute('gs-y', item.y);
            el.setAttribute('gs-w', item.w);
            el.setAttribute('gs-h', item.h);
        });
    }

    scheduleLayoutSave() {
        if (this.isApplyingResponsiveLayout || this.isLoadingGridLayout || this.isApplyingPanelVisibility) return;
        clearTimeout(this.gridAutoSaveTimer);
        this.gridAutoSaveTimer = setTimeout(() => {
            if (this.isApplyingResponsiveLayout || this.isLoadingGridLayout || this.isApplyingPanelVisibility) return;
            this.saveLayout(true);
        }, 80);
    }

    forceLayoutSave() {
        clearTimeout(this.gridAutoSaveTimer);
        if (this.isApplyingResponsiveLayout || this.isLoadingGridLayout || this.isApplyingPanelVisibility) return;
        this.saveLayout(true);
    }

    loadLayout() {
        const saved = localStorage.getItem('plotterLayout');
        if (saved) {
            try {
                const layout = this._sortLayout(JSON.parse(saved));
                const normalizedLayout = this._collapseTrailingPanelGap(layout);
                this.isLoadingGridLayout = true;
                this._applyGridLayout(normalizedLayout);
                this.isLoadingGridLayout = false;
                this.baseGridLayout = normalizedLayout;
                this.logToConsole('System: Layout restored cleanly.');
            } catch (e) {
                this.isLoadingGridLayout = false;
            }
        }
    }

    resetLayout() {
        localStorage.removeItem('plotterLayout');
        localStorage.removeItem('plotterLayoutVersion');
        location.reload();
    }

    resetApplicationToDefaults() {
        [
            'dxySettings',
            'canvasBackup',
            'visPenConfig',
            'penColors',
            'activeVisualizerPen',
            'visualizerViewMode',
            'plotterLayout',
            'plotterLayoutVersion'
        ].forEach(key => localStorage.removeItem(key));

        location.reload();
    }

    captureBaseGridLayout() {
        if (this.baseGridLayout.length) return;
        const layout = [];
        this.grid.engine.nodes.forEach(n => {
            if (n.el && n.el.id) {
                layout.push(this._normalizeNodeToBaseLayout(n));
            }
        });
        this.baseGridLayout = this._collapseTrailingPanelGap(layout);
    }

    applyResponsiveGridLayout() {
        if (!this.grid || !this.grid.el) return;
        const targetColumns = this._getResponsiveColumnCount();
        const sourceLayout = this.baseGridLayout.length ? this.baseGridLayout : this._getCurrentBaseLayout();
        const visibleSourceLayout = this._getVisibleLayout(sourceLayout);
        if (!visibleSourceLayout.length) return;

        this.isApplyingResponsiveLayout = true;
        try {
            if (typeof this.grid.float === 'function') {
                this.grid.float(true);
            }
            if (typeof this.grid.column === 'function' && this.currentGridColumns !== targetColumns) {
                this.grid.column(targetColumns);
            }

            const packedLayout = targetColumns === this.gridBaseColumns
                ? this._sortLayout(visibleSourceLayout).map(item => ({ ...item }))
                : this._projectLayoutToColumns(visibleSourceLayout, targetColumns);
            this.currentGridColumns = targetColumns;

            this._applyGridLayout(packedLayout);
        } finally {
            this.isApplyingResponsiveLayout = false;
        }
    }

    _getResponsiveColumnCount() {
        const width = this.grid && this.grid.el ? this.grid.el.clientWidth : window.innerWidth;
        return Math.max(1, Math.min(this.gridBaseColumns, Math.floor(width / this.gridMinPanelWidth) || 1));
    }

    _getCurrentBaseLayout() {
        const layout = [];
        this.grid.engine.nodes.forEach(n => {
            if (n.el && n.el.id) {
                layout.push(this._normalizeNodeToBaseLayout(n));
            }
        });
        return this._collapseTrailingPanelGap(layout);
    }

    _normalizeNodeToBaseLayout(node) {
        const scale = this.gridBaseColumns / Math.max(1, this.currentGridColumns || this.gridBaseColumns);
        const width = Math.max(1, Math.min(this.gridBaseColumns, Math.round(node.w * scale)));
        const x = Math.max(0, Math.min(this.gridBaseColumns - width, Math.round(node.x * scale)));
        return { id: node.el.id, x, y: Math.max(0, Math.round(node.y)), w: width, h: node.h };
    }

    _projectLayoutToColumns(layout, columns) {
        const placed = [];

        this._sortLayout(layout).forEach(item => {
            const width = Math.max(1, Math.min(columns, Math.round((item.w / this.gridBaseColumns) * columns) || 1));
            const desiredX = Math.max(0, Math.round((item.x / this.gridBaseColumns) * columns));
            let x = Math.min(desiredX, columns - width);
            let y = Math.max(0, item.y);

            if (desiredX + width > columns) {
                x = 0;
            }

            let overlap = this._findLayoutOverlap(placed, { x, y, w: width, h: item.h });
            while (overlap) {
                y = overlap.y + overlap.h;
                overlap = this._findLayoutOverlap(placed, { x, y, w: width, h: item.h });
            }

            placed.push({
                id: item.id,
                x,
                y,
                w: width,
                h: item.h
            });
        });

        return placed;
    }

    _sortLayout(layout) {
        return [...layout].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    }

    _getDefaultPanelVisibility() {
        return this.panelDefinitions.reduce((acc, panel) => {
            acc[panel.id] = true;
            return acc;
        }, {});
    }

    _getPanelVisibilitySettings() {
        const defaults = this._getDefaultPanelVisibility();
        const configured = this.app.settings.panelVisibility || {};
        return {
            ...defaults,
            ...configured,
            'panel-connection': true
        };
    }

    _isCreativeTabModeEnabled() {
        return this.app?.settings?.creativePanelsTabbed === true;
    }

    _getDefaultCreativePanelDefinitions() {
        return [
            { id: 'panel-image-vector', label: 'Image to Vector' },
            { id: 'panel-patterns', label: 'Pattern Generator' },
            { id: 'panel-handwriting', label: 'Handwriting Generator' },
            { id: 'panel-3d-vector', label: '3D Vector' },
            { id: 'panel-live-tracker', label: 'Live Finger Tracker' }
        ];
    }

    _getCreativePanelOrder() {
        return this.creativePanelDefinitions.map(panel => panel.id);
    }

    _applySavedCreativePanelOrder(savedOrder) {
        if (!Array.isArray(savedOrder) || !savedOrder.length) return;
        const knownPanels = new Map(this._getDefaultCreativePanelDefinitions().map(panel => [panel.id, { ...panel }]));
        const orderedPanels = [];
        savedOrder.forEach(panelId => {
            if (!knownPanels.has(panelId)) return;
            orderedPanels.push(knownPanels.get(panelId));
            knownPanels.delete(panelId);
        });
        this.creativePanelDefinitions = [...orderedPanels, ...knownPanels.values()];
        if (!this.creativePanelDefinitions.some(panel => panel.id === this.activeCreativeTabId)) {
            this.activeCreativeTabId = this.creativePanelDefinitions[0]?.id || null;
        }
    }

    _moveCreativePanelBefore(movedPanelId, targetPanelId) {
        if (!movedPanelId || !targetPanelId || movedPanelId === targetPanelId) return false;
        const movedIndex = this.creativePanelDefinitions.findIndex(panel => panel.id === movedPanelId);
        const targetIndex = this.creativePanelDefinitions.findIndex(panel => panel.id === targetPanelId);
        if (movedIndex < 0 || targetIndex < 0) return false;

        const [movedPanel] = this.creativePanelDefinitions.splice(movedIndex, 1);
        const nextTargetIndex = this.creativePanelDefinitions.findIndex(panel => panel.id === targetPanelId);
        this.creativePanelDefinitions.splice(nextTargetIndex, 0, movedPanel);
        return true;
    }

    _isCreativeToolPanel(panelId) {
        return this.creativePanelDefinitions.some(panel => panel.id === panelId);
    }

    _getCreativePanelBaseVisibility(panelId) {
        return this._getPanelVisibilitySettings()[panelId] !== false;
    }

    _getVisibleCreativePanels() {
        return this.creativePanelDefinitions.filter(panel => this._getCreativePanelBaseVisibility(panel.id));
    }

    _isPanelVisible(panelId) {
        if (panelId === this.creativeTabHostId) {
            return this._isCreativeTabModeEnabled() && this._getVisibleCreativePanels().length > 0;
        }
        if (this._isCreativeToolPanel(panelId) && this._isCreativeTabModeEnabled()) {
            return false;
        }
        return !!this._getPanelVisibilitySettings()[panelId];
    }

    _getVisibleLayout(layout) {
        return this._sortLayout(layout.filter(item => this._isPanelVisible(item.id)));
    }

    _isGridWidgetActive(el) {
        return !!(this.grid && this.grid.engine && this.grid.engine.nodes || []).find(node => node.el === el);
    }

    _getManagedPanels() {
        return [
            ...this.panelDefinitions,
            { id: this.creativeTabHostId, label: 'Creative Tools' }
        ];
    }

    _findLayoutEntry(panelId) {
        return this.baseGridLayout.find(item => item.id === panelId)
            || this.defaultGridLayout.find(item => item.id === panelId)
            || (panelId === this.creativeTabHostId ? this.creativeTabHostLayout : null);
    }

    _getCreativeTabPaneId(panelId) {
        return `creative-tab-pane-${panelId}`;
    }

    _getPanelBodyNode(panelId) {
        const pane = document.getElementById(this._getCreativeTabPaneId(panelId));
        const paneBody = pane ? Array.from(pane.children).find(child => child.classList?.contains('panel-body')) : null;
        if (paneBody) return paneBody;

        const panel = document.getElementById(panelId);
        const panelContent = panel?.querySelector('.grid-stack-item-content');
        return panelContent
            ? Array.from(panelContent.children).find(child => child.classList?.contains('panel-body'))
            : null;
    }

    _syncCreativeTabsDom() {
        const host = document.getElementById(this.creativeTabHostId);
        const tabBar = document.getElementById('creative-tab-bar');
        const tabContent = document.getElementById('creative-tab-content');
        if (!host || !tabBar || !tabContent) return;

        if (!this._isCreativeTabModeEnabled()) {
            this.creativePanelDefinitions.forEach(panel => {
                const body = this._getPanelBodyNode(panel.id);
                const panelContent = document.getElementById(panel.id)?.querySelector('.grid-stack-item-content');
                if (body && panelContent && body.parentElement !== panelContent) {
                    panelContent.appendChild(body);
                }
            });
            tabBar.innerHTML = '';
            tabContent.innerHTML = '';
            return;
        }

        this.creativePanelDefinitions.forEach(panel => {
            const body = this._getPanelBodyNode(panel.id);
            if (!body) return;

            let pane = document.getElementById(this._getCreativeTabPaneId(panel.id));
            if (!pane) {
                pane = document.createElement('section');
                pane.id = this._getCreativeTabPaneId(panel.id);
                pane.className = 'creative-tab-pane hidden';
                pane.dataset.panelId = panel.id;
                tabContent.appendChild(pane);
            }

            if (body.parentElement !== pane) {
                pane.appendChild(body);
            }
        });

        this._renderCreativeTabs();
    }

    _renderCreativeTabs() {
        const tabBar = document.getElementById('creative-tab-bar');
        const tabContent = document.getElementById('creative-tab-content');
        if (!tabBar || !tabContent) return;

        const visiblePanels = this._getVisibleCreativePanels();
        if (!visiblePanels.length) {
            this.activeCreativeTabId = null;
            tabBar.innerHTML = '';
            Array.from(tabContent.children).forEach(pane => pane.classList.add('hidden'));
            return;
        }

        if (!visiblePanels.some(panel => panel.id === this.activeCreativeTabId)) {
            this.activeCreativeTabId = visiblePanels[0].id;
        }

        tabBar.innerHTML = '';
        visiblePanels.forEach(panel => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `creative-tab-btn${panel.id === this.activeCreativeTabId ? ' active' : ''}`;
            button.textContent = panel.label;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', panel.id === this.activeCreativeTabId ? 'true' : 'false');
            button.dataset.panelId = panel.id;
            button.draggable = true;
            button.addEventListener('click', () => this._setActiveCreativeTab(panel.id));
            button.addEventListener('dragstart', (event) => {
                this.draggingCreativeTabId = panel.id;
                button.classList.add('dragging');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', panel.id);
                }
            });
            button.addEventListener('dragover', (event) => {
                if (!this.draggingCreativeTabId || this.draggingCreativeTabId === panel.id) return;
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                }
                button.classList.add('drag-target');
            });
            button.addEventListener('dragleave', () => {
                button.classList.remove('drag-target');
            });
            button.addEventListener('drop', (event) => {
                if (!this.draggingCreativeTabId || this.draggingCreativeTabId === panel.id) return;
                event.preventDefault();
                button.classList.remove('drag-target');
                if (this._moveCreativePanelBefore(this.draggingCreativeTabId, panel.id)) {
                    this.saveWorkspaceState();
                    this._renderCreativeTabs();
                }
            });
            button.addEventListener('dragend', () => {
                this.draggingCreativeTabId = null;
                tabBar.querySelectorAll('.creative-tab-btn').forEach(tab => {
                    tab.classList.remove('dragging', 'drag-target');
                });
            });
            tabBar.appendChild(button);
        });

        Array.from(tabContent.children).forEach(pane => {
            const isActive = pane.dataset.panelId === this.activeCreativeTabId;
            pane.classList.toggle('hidden', !isActive);
            pane.classList.toggle('active', isActive);
        });

        if (this.activeCreativeTabId) {
            this._refreshCreativeTabPanel(this.activeCreativeTabId);
        }
    }

    _setActiveCreativeTab(panelId) {
        if (!panelId || panelId === this.activeCreativeTabId) return;
        this.activeCreativeTabId = panelId;
        this._renderCreativeTabs();
    }

    _refreshCreativeTabPanel(panelId) {
        window.requestAnimationFrame(() => {
            window.dispatchEvent(new Event('resize'));
            this.app.canvas?.handleResize?.();

            if (panelId === 'panel-3d-vector') {
                this.app.vector3DPanel?._resizeRenderer?.();
                this.app.vector3DPanel?.refreshPreview?.();
            }
            if (panelId === 'panel-image-vector') {
                this.app.imageVectorPanel?.drawPreview?.();
            }
            if (panelId === 'panel-handwriting') {
                this.app.handwritingPanel?.renderPreview?.();
            }
            if (panelId === 'panel-live-tracker') {
                this.app.liveTracker?.ui?.applyOverlayLayout?.();
                this.app.liveTracker?.ui?.applyVideoPresentation?.();
            }
        });
    }

    applyPanelVisibilitySettings() {
        if (!this.grid) return;

        this._syncCreativeTabsDom();
        this.isApplyingPanelVisibility = true;
        if (typeof this.grid.batchUpdate === 'function') this.grid.batchUpdate(true);
        try {
            this._getManagedPanels().forEach(panel => {
                const el = document.getElementById(panel.id);
                if (!el) return;

                const shouldShow = panel.alwaysVisible ? true : this._isPanelVisible(panel.id);
                const isActive = this._isGridWidgetActive(el);

                if (!shouldShow && isActive) {
                    this.grid.removeWidget(el, false, false);
                    el.style.display = 'none';
                    el.dataset.panelHidden = 'true';
                    return;
                }

                if (shouldShow && !isActive) {
                    const savedLayout = this._findLayoutEntry(panel.id);
                    if (savedLayout) {
                        el.setAttribute('gs-x', savedLayout.x);
                        el.setAttribute('gs-y', savedLayout.y);
                        el.setAttribute('gs-w', savedLayout.w);
                        el.setAttribute('gs-h', savedLayout.h);
                    }
                    el.style.display = '';
                    delete el.dataset.panelHidden;
                    this.grid.makeWidget(el);
                    if (savedLayout) {
                        this.grid.update(el, savedLayout);
                    }
                    return;
                }

                if (shouldShow) {
                    el.style.display = '';
                    delete el.dataset.panelHidden;
                }
            });
        } finally {
            if (typeof this.grid.batchUpdate === 'function') this.grid.batchUpdate(false);
            this.isApplyingPanelVisibility = false;
        }

        if (this._isCreativeTabModeEnabled()) {
            this._renderCreativeTabs();
        }
    }

    _findLayoutOverlap(layout, candidate) {
        return layout.find(item => {
            const xOverlap = candidate.x < item.x + item.w && candidate.x + candidate.w > item.x;
            const yOverlap = candidate.y < item.y + item.h && candidate.y + candidate.h > item.y;
            return xOverlap && yOverlap;
        }) || null;
    }

    _collapseTrailingPanelGap(layout) {
        const sortedLayout = this._sortLayout(layout).map(item => ({ ...item }));
        if (sortedLayout.length < 2) return sortedLayout;

        const lastRowY = Math.max(...sortedLayout.map(item => item.y));
        const bottomPanels = sortedLayout.filter(item => item.y === lastRowY);
        if (bottomPanels.length !== 1) return sortedLayout;

        const trailingPanel = bottomPanels[0];
        const panelsAbove = sortedLayout.filter(item => item.id !== trailingPanel.id);
        const stackedY = Math.max(...panelsAbove.map(item => item.y + item.h), 0);

        if (trailingPanel.y <= stackedY) return sortedLayout;

        return this._sortLayout(sortedLayout.map(item => (
            item.id === trailingPanel.id
                ? { ...item, y: stackedY }
                : item
        )));
    }

    _applyGridLayout(layout) {
        if (!this.grid || !Array.isArray(layout)) return;
        if (typeof this.grid.batchUpdate === 'function') this.grid.batchUpdate(true);
        try {
            layout.forEach(item => {
                if (!item || !item.id) return;
                const el = document.getElementById(item.id);
                if (el) {
                    this.grid.update(el, { x: item.x, y: item.y, w: item.w, h: item.h });
                }
            });
        } finally {
            if (typeof this.grid.batchUpdate === 'function') this.grid.batchUpdate(false);
        }
    }

    initPenSlots() {
        this.updateVisualizerPalette();
    }

    setActiveVisualizerPen(penNumber, persist = true) {
        const nextPen = Math.max(1, Math.min(8, Number(penNumber) || 1));
        this.activeVisualizerPen = nextPen;
        this.updateVisualizerPalette();
        if (persist) this.saveWorkspaceState();
    }

    updateVisualizerPalette() {
        const visPalette = document.getElementById('vis-palette');
        const penStack = document.getElementById('vis-pen-stack');
        if (!visPalette || !penStack) return;
        const toolStack = document.getElementById('vis-tool-stack');
        const bucketBtn = document.getElementById('btn-fill-bucket');
        visPalette.innerHTML = '';
        if (toolStack) visPalette.appendChild(toolStack);
        if (bucketBtn) visPalette.appendChild(bucketBtn);
        visPalette.appendChild(penStack);
        penStack.innerHTML = '';

        for (let i = 7; i >= 0; i--) {
            const btn = document.createElement('div');
            btn.className = 'vis-color-btn';
            if (i + 1 === this.activeVisualizerPen) btn.classList.add('active');
            btn.style.backgroundColor = this.visPenConfig[i].color;
            btn.title = `Pen ${i + 1}`;

            if (this.visPenConfig[i].visible === false) {
                btn.style.opacity = '0.3';
                btn.innerHTML = '✕';
            }

            btn.addEventListener('click', () => {
                this.activeVisualizerPen = i + 1;

                if (this.app.canvas.selectedPaths.length > 0) {
                    this.app.canvas.selectedPaths.forEach(idx => {
                        this.app.canvas.paths[idx].pen = this.activeVisualizerPen;
                    });
                    this.app.canvas.draw();
                }

                this.showPenMenu(i + 1, btn);
                this.updateVisualizerPalette();
                this.saveWorkspaceState();
            });

            penStack.appendChild(btn);
        }
        this.refreshFillBucketPenOptions();
    }

    showPenMenu(penIdx, targetBtn) {
        const menu = document.getElementById('vis-pen-menu');
        if (!menu || !targetBtn) return;

        this.activeVisualizerPen = penIdx;
        const config = this.visPenConfig[penIdx - 1];

        document.getElementById('vis-pen-menu-title').textContent = `Pen ${penIdx} Settings`;
        document.getElementById('input-pen-color').value = config.color;
        document.getElementById('input-pen-thick').value = config.thickness;
        document.getElementById('input-pen-visible').checked = config.visible !== false;

        const btnRect = targetBtn.getBoundingClientRect();
        const panel = targetBtn.closest('.grid-stack-item-content') || targetBtn.closest('.grid-stack-item') || document.body;
        const panelRect = panel.getBoundingClientRect();
        const gap = 10;

        if (menu.parentElement !== panel) {
            panel.appendChild(menu);
        }

        menu.classList.remove('hidden');
        menu.style.visibility = 'hidden';
        menu.style.position = 'absolute';
        const menuHeight = menu.offsetHeight;
        const menuWidth = menu.offsetWidth;
        const panelWidth = panelRect.width;
        const panelHeight = panelRect.height;

        let left = (btnRect.right - panelRect.left) + gap;
        let top = btnRect.top - panelRect.top;

        if (left + menuWidth > panelWidth - gap) {
            left = (btnRect.left - panelRect.left) - menuWidth - gap;
        }
        if (left < gap) {
            left = Math.max(gap, Math.min(left, panelWidth - menuWidth - gap));
        }

        if (top + menuHeight > panelHeight - gap) {
            top = panelHeight - menuHeight - gap;
        }
        if (top < gap) top = gap;

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.style.visibility = '';

        // Bind internal menu actions once
        document.getElementById('btn-close-pen-menu').onclick = () => menu.classList.add('hidden');
        document.getElementById('input-pen-color').onchange = (e) => {
            config.color = e.target.value;
            this.updateVisualizerPalette();
            this.saveWorkspaceState();
            this.app.canvas.draw();
        };
        document.getElementById('input-pen-thick').oninput = (e) => {
            config.thickness = parseFloat(e.target.value);
            this.saveWorkspaceState();
            this.app.canvas.draw();
        };
        document.getElementById('input-pen-visible').onchange = (e) => {
            config.visible = e.target.checked;
            this.updateVisualizerPalette();
            this.saveWorkspaceState();
            this.app.canvas.draw();
        };
        document.getElementById('btn-pen-goto').onclick = () => {
            if (this.app.serial.isConnected) {
                if (this.app.isGrblMachine && this.app.isGrblMachine()) {
                    this.logToConsole('System: Pen slot selection is only used for HPGL pen changers.');
                    return;
                }
                this.app.serial.sendManualCommand(`SP${penIdx};`);
            }
        };
    }

    _bindSettings() {
        const modal = document.getElementById('settings-modal');
        const btnSettings = document.getElementById('btn-settings');
        const btnClose = document.getElementById('btn-close-settings');
        const btnSave = document.getElementById('btn-save-settings');
        const btnResetDefaults = document.getElementById('btn-reset-settings');
        const selTheme = document.getElementById('sel-theme');
        const selHandshake = document.getElementById('sel-handshake');
        const selSpeed = document.getElementById('sel-speed');
        const inputBedW = document.getElementById('input-bed-w');
        const inputBedH = document.getElementById('input-bed-h');
        const inputSimOpacity = document.getElementById('input-sim-opacity');
        const valSimOpacity = document.getElementById('val-sim-opacity');
        const inputUseInternalCurveEngine = document.getElementById('input-use-internal-curve-engine');
        const inputCreativeTabsMode = document.getElementById('input-creative-tabs-mode');
        const inputMarginX = document.getElementById('input-margin-x');
        const inputMarginY = document.getElementById('input-margin-y');
        const inputOutputFlipX = document.getElementById('input-output-flip-x');
        const inputOutputFlipY = document.getElementById('input-output-flip-y');
        const btnBackupWorkspace = document.getElementById('btn-backup-workspace');
        const btnLoadWorkspace = document.getElementById('btn-load-workspace');
        const panelToggleInputs = Array.from(document.querySelectorAll('[data-panel-toggle]'));

        btnSettings.onclick = () => {
            selTheme.value = this.app.settings.theme || 'dark-theme';
            if (selHandshake) selHandshake.value = this.app.settings.handshake || 'normal';
            if (selSpeed) selSpeed.value = this.app.settings.speed || 'fast';
            if (inputBedW) inputBedW.value = this.app.settings.bedWidth || this.app.getMachineProfile().bedWidth;
            if (inputBedH) inputBedH.value = this.app.settings.bedHeight || this.app.getMachineProfile().bedHeight;
            if (inputSimOpacity) {
                inputSimOpacity.value = this.app.settings.simBackgroundOpacity || 0.25;
                if (valSimOpacity) valSimOpacity.textContent = inputSimOpacity.value;
            }
            if (inputUseInternalCurveEngine) {
                inputUseInternalCurveEngine.checked = this.app.settings.useInternalCurveEngine !== false;
            }
            if (inputCreativeTabsMode) {
                inputCreativeTabsMode.checked = this._isCreativeTabModeEnabled();
            }
            if (inputMarginX) inputMarginX.value = this.app.settings.marginX || 15;
            if (inputMarginY) inputMarginY.value = this.app.settings.marginY || 10;
            if (inputOutputFlipX) inputOutputFlipX.checked = this.app.settings.outputFlipHorizontal === true;
            if (inputOutputFlipY) inputOutputFlipY.checked = this.app.settings.outputFlipVertical === false;
            const visibility = this._getPanelVisibilitySettings();
            panelToggleInputs.forEach(input => {
                input.checked = visibility[input.dataset.panelToggle] !== false;
            });
            modal.classList.remove('hidden');
        };

        if (inputSimOpacity) {
            inputSimOpacity.oninput = (e) => {
                if (valSimOpacity) valSimOpacity.textContent = e.target.value;
            };
        }

        if (inputUseInternalCurveEngine) {
            inputUseInternalCurveEngine.onchange = () => {
                this.refreshImportResolutionControl();
            };
        }

        if (btnBackupWorkspace) {
            btnBackupWorkspace.onclick = () => {
                this.app.saveProject('workspace_backup');
            };
        }

        if (btnLoadWorkspace) {
            btnLoadWorkspace.onclick = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.dxyweb,.json';
                input.onchange = e => {
                    const file = e.target.files[0];
                    if (!file) return;
                    this.app.loadProject(file);
                    modal.classList.add('hidden');
                };
                input.click();
            };
        }

        btnClose.onclick = () => modal.classList.add('hidden');
        if (btnResetDefaults) {
            btnResetDefaults.onclick = () => {
                const confirmed = confirm('Reset all settings, clear all graphics, and restore the default layout?');
                if (!confirmed) return;
                this.resetApplicationToDefaults();
            };
        }
        btnSave.onclick = () => {
            this.app.settings.theme = selTheme.value;
            if (selHandshake) this.app.settings.handshake = selHandshake.value;
            if (selSpeed) this.app.settings.speed = selSpeed.value;
            if (inputBedW) this.app.settings.bedWidth = parseFloat(inputBedW.value);
            if (inputBedH) this.app.settings.bedHeight = parseFloat(inputBedH.value);
            if (inputSimOpacity) {
                this.app.settings.simBackgroundOpacity = parseFloat(inputSimOpacity.value);
            }
            if (inputUseInternalCurveEngine) {
                this.app.settings.useInternalCurveEngine = inputUseInternalCurveEngine.checked;
            }
            if (inputCreativeTabsMode) {
                this.app.settings.creativePanelsTabbed = inputCreativeTabsMode.checked;
            }
            if (inputMarginX) this.app.settings.marginX = parseFloat(inputMarginX.value);
            if (inputMarginY) this.app.settings.marginY = parseFloat(inputMarginY.value);
            if (inputOutputFlipX) this.app.settings.outputFlipHorizontal = inputOutputFlipX.checked;
            if (inputOutputFlipY) this.app.settings.outputFlipVertical = !inputOutputFlipY.checked;
            if (!this.app.isValidPaperSize(this.app.settings.paperSize)) {
                this.app.settings.paperSize = 'A3';
            }
            this.app.settings.panelVisibility = panelToggleInputs.reduce((acc, input) => {
                acc[input.dataset.panelToggle] = input.disabled ? true : input.checked;
                return acc;
            }, this._getDefaultPanelVisibility());
            this.app.saveSettings();
            this.refreshImportResolutionControl();
            this.applyPanelVisibilitySettings();
            this.applyResponsiveGridLayout();
            this.forceLayoutSave();
            if (this.app.serial) this.app.serial.setSpeedDelay(this.app.settings.speed || 'fast');
            if (this.app.canvas) {
                this.app.canvas.bedWidth = this.app.settings.bedWidth || this.app.getMachineProfile().bedWidth;
                this.app.canvas.bedHeight = this.app.settings.bedHeight || this.app.getMachineProfile().bedHeight;
                this.app.canvas.refreshPaperSettings();
                this.app.canvas.resize();
            }
            modal.classList.add('hidden');
            if (this.app.canvas) this.app.canvas.draw();
        };
    }

    _bindStartupModal() {
        const modal = document.getElementById('startup-modal');
        const btnOk = document.getElementById('btn-startup-ok');
        const inputDontShow = document.getElementById('startup-dont-show');

        if (!modal || !btnOk || !inputDontShow) return;

        btnOk.onclick = () => {
            this.app.settings.showStartupMessage = !inputDontShow.checked;
            this.app.saveSettings();
            modal.classList.add('hidden');
        };
    }

    _bindMachineSetupHelp() {
        const modal = document.getElementById('machine-setup-modal');
        const btnOpen = document.getElementById('btn-machine-setup-help');
        const btnOpenFromStartup = document.getElementById('btn-startup-machine-setup');
        const btnClose = document.getElementById('btn-close-machine-setup');
        const btnOk = document.getElementById('btn-machine-setup-ok');

        if (!modal) return;

        const openModal = () => modal.classList.remove('hidden');
        const closeModal = () => modal.classList.add('hidden');

        if (btnOpen) btnOpen.onclick = openModal;
        if (btnOpenFromStartup) btnOpenFromStartup.onclick = openModal;
        if (btnClose) btnClose.onclick = closeModal;
        if (btnOk) btnOk.onclick = closeModal;
    }

    showStartupModal() {
        const modal = document.getElementById('startup-modal');
        const inputDontShow = document.getElementById('startup-dont-show');

        if (!modal || !inputDontShow) return;
        if (this.app?.settings?.showStartupMessage === false) return;

        inputDontShow.checked = false;
        modal.classList.remove('hidden');
    }

    logToConsole(msg, type = 'info') {
        const consoleEl = document.getElementById('hpgl-console');
        if (!consoleEl) return;
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = `> ${msg}`;
        if (type === 'error') line.style.color = 'var(--danger)';
        if (type === 'tx') line.style.color = 'var(--success)';
        consoleEl.appendChild(line);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    _bindTools() {
        document.querySelectorAll('.tool-btn').forEach(btn => {
            const tool = btn.dataset.tool;

            btn.onclick = (e) => {
                if (!tool) return;
                this.setTool(tool);
                if (tool === 'text') {
                    this.toggleTextToolMenu(btn);
                    e.stopPropagation();
                    return;
                }
                if (tool === 'bezier') {
                    this.toggleBezierToolMenu(btn);
                    e.stopPropagation();
                    return;
                }
                if (tool === 'shape') {
                    this.toggleShapeMenu(btn);
                    e.stopPropagation();
                    return;
                }
                if (tool === 'bucket') {
                    this.showFillBucketMenu(btn);
                    e.stopPropagation();
                    return;
                }
                if (tool === 'boolean') {
                    this.toggleBooleanToolMenu(btn);
                    e.stopPropagation();
                }
            };
        });

        // Bind Undo/Redo Buttons
        const undoBtn = document.getElementById('btn-undo');
        if (undoBtn) undoBtn.onclick = () => this.app.canvas.undo();
        const redoBtn = document.getElementById('btn-redo');
        if (redoBtn) redoBtn.onclick = () => this.app.canvas.redo();

        // Global Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    this.app.canvas.undo();
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    this.app.canvas.redo();
                }
            }
        });

        // Shape type selection
        document.querySelectorAll('.shape-select-btn').forEach(btn => {
            btn.onclick = () => {
                const shape = btn.dataset.shape;
                if (shape && this.app.canvas) {
                    this.app.canvas.activeShapeType = shape;
                    this.setTool('shape');
                    // Update icon
                    const mainBtn = document.getElementById('btn-draw-shape');
                    if (mainBtn) mainBtn.innerHTML = btn.innerHTML;
                }
                document.getElementById('shape-type-menu').classList.add('hidden');
                this.syncSpecialToolHighlights();
            };
        });

        const closeShapeMenu = document.getElementById('btn-close-shape-menu');
        if (closeShapeMenu) {
            closeShapeMenu.onclick = () => document.getElementById('shape-type-menu').classList.add('hidden');
        }
    }

    getVisualizerMenuHost(triggerButton) {
        const wrapper = triggerButton?.closest('.canvas-wrapper');
        const canvasHost = wrapper?.querySelector('.canvas-container');
        return canvasHost
            || triggerButton?.closest('.grid-stack-item-content')
            || triggerButton?.closest('.grid-stack-item')
            || document.body;
    }

    positionMenuWithinHost(triggerButton, menu, options = {}) {
        if (!triggerButton || !menu) return false;

        const host = this.getVisualizerMenuHost(triggerButton);
        const hostRect = host.getBoundingClientRect();
        const btnRect = triggerButton.getBoundingClientRect();
        const gap = options.gap ?? 10;
        const preferredSide = options.preferredSide || 'right';

        if (menu.parentElement !== host) host.appendChild(menu);
        menu.classList.remove('hidden');
        menu.style.visibility = 'hidden';
        menu.style.position = 'absolute';

        const menuWidth = menu.offsetWidth;
        const menuHeight = menu.offsetHeight;
        const hostWidth = hostRect.width;
        const hostHeight = hostRect.height;

        let left = preferredSide === 'left'
            ? (btnRect.left - hostRect.left) - menuWidth - gap
            : (btnRect.right - hostRect.left) + gap;
        let top = btnRect.top - hostRect.top;

        // Palette buttons live outside the canvas host, so start menus inside the canvas area.
        if (left < gap) {
            left = gap;
        }
        if (left + menuWidth > hostWidth - gap) {
            left = (btnRect.left - hostRect.left) - menuWidth - gap;
        }
        left = Math.max(gap, Math.min(left, hostWidth - menuWidth - gap));

        if (top + menuHeight > hostHeight - gap) {
            top = hostHeight - menuHeight - gap;
        }
        top = Math.max(gap, top);

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
        menu.style.right = 'auto';
        menu.style.bottom = 'auto';
        menu.style.visibility = '';
        return true;
    }

    toggleShapeMenu(triggerButton) {
        const menu = document.getElementById('shape-type-menu');
        if (!menu || !triggerButton) return;
        if (!menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            this.syncSpecialToolHighlights();
            return;
        }
        this.positionMenuWithinHost(triggerButton, menu, { preferredSide: 'right' });
        this.syncSpecialToolHighlights();
    }

    _bindBezierToolMenu() {
        const menu = document.getElementById('bezier-tool-menu');
        const closeButton = document.getElementById('btn-close-bezier-tool-menu');
        if (!menu) return;

        const syncButtons = () => {
            menu.querySelectorAll('.bezier-mode-btn').forEach(button => {
                button.classList.toggle('is-selected', button.dataset.bezierMode === this.bezierToolMode);
            });
        };

        if (closeButton) {
            closeButton.onclick = () => {
                menu.classList.add('hidden');
                this.syncSpecialToolHighlights();
            };
        }

        menu.querySelectorAll('.bezier-mode-btn').forEach(button => {
            button.onclick = () => {
                const mode = button.dataset.bezierMode;
                if (!mode) return;
                this.bezierToolMode = mode;
                syncButtons();
                this.setTool('bezier');
                menu.classList.add('hidden');
                this.syncSpecialToolHighlights();
                this.logToConsole(
                    mode === 'free-draw'
                        ? 'System: Bezier tool set to Free Draw mode.'
                        : 'System: Bezier tool set to Bezier Curves mode.'
                );
            };
        });

        syncButtons();
    }

    toggleBezierToolMenu(triggerButton) {
        const menu = document.getElementById('bezier-tool-menu');
        if (!menu || !triggerButton) return;
        if (!menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            this.syncSpecialToolHighlights();
            return;
        }
        menu.querySelectorAll('.bezier-mode-btn').forEach(button => {
            button.classList.toggle('is-selected', button.dataset.bezierMode === this.bezierToolMode);
        });
        this.positionMenuWithinHost(triggerButton, menu, { preferredSide: 'right' });
        this.syncSpecialToolHighlights();
    }

    _bindFillBucketMenu() {
        const menu = document.getElementById('fill-bucket-menu');
        const btnClose = document.getElementById('btn-close-fill-bucket-menu');
        const selPattern = document.getElementById('sel-fill-pattern');
        const inputSpacing = document.getElementById('input-fill-spacing');
        const valSpacing = document.getElementById('val-fill-spacing');
        const inputAngle = document.getElementById('input-fill-angle');
        const valAngle = document.getElementById('val-fill-angle');
        const selPen = document.getElementById('sel-fill-pen');
        const inputGroupPatterns = document.getElementById('input-fill-group-patterns');

        if (!menu) return;

        if (selPattern) {
            selPattern.value = this.fillBucketSettings.pattern;
            selPattern.onchange = () => { this.fillBucketSettings.pattern = selPattern.value; };
        }
        if (inputSpacing && valSpacing) {
            inputSpacing.value = this.fillBucketSettings.spacing;
            valSpacing.textContent = `${this.fillBucketSettings.spacing}`;
            inputSpacing.oninput = () => {
                this.fillBucketSettings.spacing = parseFloat(inputSpacing.value);
                valSpacing.textContent = `${inputSpacing.value}`;
            };
        }
        if (inputAngle && valAngle) {
            inputAngle.value = this.fillBucketSettings.angle;
            valAngle.textContent = `${this.fillBucketSettings.angle}°`;
            inputAngle.oninput = () => {
                this.fillBucketSettings.angle = parseFloat(inputAngle.value);
                valAngle.textContent = `${inputAngle.value}°`;
            };
        }
        if (selPen) {
            this.refreshFillBucketPenOptions();
            selPen.value = String(this.fillBucketSettings.pen);
            selPen.onchange = () => {
                this.fillBucketSettings.pen = parseInt(selPen.value, 10) || 1;
            };
        }
        if (inputGroupPatterns) {
            inputGroupPatterns.checked = this.fillBucketSettings.groupPatterns !== false;
            inputGroupPatterns.onchange = () => {
                this.fillBucketSettings.groupPatterns = inputGroupPatterns.checked;
            };
        }
        if (btnClose) btnClose.onclick = () => menu.classList.add('hidden');
    }

    refreshFillBucketPenOptions() {
        const selPen = document.getElementById('sel-fill-pen');
        if (!selPen) return;

        const currentValue = String(this.fillBucketSettings.pen || 1);
        selPen.innerHTML = '';
        this.visPenConfig.forEach((config, index) => {
            const option = document.createElement('option');
            option.value = String(index + 1);
            option.textContent = `■ Pen ${index + 1}`;
            option.style.color = config.color || '#2563eb';
            selPen.appendChild(option);
        });
        selPen.value = currentValue;
    }

    showFillBucketMenu(x, y) {
        const menu = document.getElementById('fill-bucket-menu');
        if (!menu) return;
        if (x instanceof HTMLElement) {
            this.positionMenuWithinHost(x, menu, { preferredSide: 'right' });
            return;
        }
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.remove('hidden');
    }

    _bindBooleanMenu() {
        const menu = document.getElementById('boolean-tool-menu');
        const closeButton = document.getElementById('btn-close-boolean-tool-menu');
        if (!menu) return;

        if (closeButton) {
            closeButton.onclick = () => {
                menu.classList.add('hidden');
                this.syncSpecialToolHighlights();
            };
        }

        document.querySelectorAll('.boolean-op-btn').forEach(button => {
            button.onclick = () => {
                const op = button.dataset.booleanOp;
                if (!op) return;
                const applied = this.app.canvas?.applyBooleanOperation?.(op);
                if (applied) {
                    menu.classList.add('hidden');
                    this.syncSpecialToolHighlights();
                    this.setTool('select');
                }
            };
        });
    }

    toggleBooleanToolMenu(triggerButton) {
        const menu = document.getElementById('boolean-tool-menu');
        if (!menu || !triggerButton) return;
        if (!menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            this.syncSpecialToolHighlights();
            return;
        }
        this.positionMenuWithinHost(triggerButton, menu, { preferredSide: 'right' });
        this.syncSpecialToolHighlights();
    }

    _bindTextToolMenu() {
        const menu = document.getElementById('text-tool-menu');
        const selectMode = document.getElementById('sel-text-mode');
        const selectFont = document.getElementById('sel-text-creative-font');
        const inputSize = document.getElementById('input-text-font-size');
        const fieldSize = document.getElementById('field-text-font-size');
        const rotationControls = this.ensureTextRotationControls();
        const inputRotation = rotationControls?.input || null;
        const fieldRotation = rotationControls?.valueField || null;
        const inputLetterSpacing = document.getElementById('input-text-letter-spacing');
        const fieldLetterSpacing = document.getElementById('field-text-letter-spacing');
        const inputCurve = document.getElementById('input-text-curve');
        const fieldCurve = document.getElementById('field-text-curve');
        const btnUploadFont = document.getElementById('btn-text-upload-font');
        const btnExplodeSelected = document.getElementById('btn-text-explode-selected');
        const btnResetValues = document.getElementById('btn-text-reset-values');
        const inputUpload = document.getElementById('input-text-font-upload');
        const btnClose = document.getElementById('btn-close-text-tool-menu');
        if (!menu) return;

        const getSelectedEditableText = () => {
            if (!this.app?.canvas || this.app.canvas.selectedPaths.length !== 1) return null;
            const path = this.app.canvas.paths[this.app.canvas.selectedPaths[0]];
            if (!path || path.type !== 'text' || path.exploded === true) return null;
            return path;
        };

        const getSelectedCurvePaths = () => {
            if (!this.app?.canvas || !Array.isArray(this.app.canvas.selectedPaths)) return [];
            return this.app.canvas.selectedPaths
                .map(idx => this.app.canvas.paths[idx])
                .filter(path => path && (path.type === 'text' || ['line', 'polyline', 'path'].includes(path.type)));
        };

        const applySettingsToSelectedText = (persist = false) => {
            const selectedText = getSelectedEditableText();
            if (!selectedText) return;
            selectedText.textMode = this.textToolSettings.mode || 'roland';
            selectedText.fontSize = this.textToolSettings.fontSize || 10;
            selectedText.rotation = this.getTextRotationForMode(
                selectedText.textMode,
                this.textToolSettings.rotation || 0
            );
            selectedText.creativeFontId = this.textToolSettings.creativeFontId || 'bungee';
            selectedText.letterSpacing = this.textToolSettings.letterSpacing || 0;
            selectedText.curve = this.textToolSettings.curve || 0;
            delete selectedText._vectorTextCache;
            delete selectedText._creativeOutlineCache;
            if (persist) this.app.canvas.saveCurrentState?.();
            this.app.canvas.draw?.();
        };

        const applyCurveToSelectedPaths = (persist = false) => {
            const selectedPaths = getSelectedCurvePaths();
            if (!selectedPaths.length) return;
            selectedPaths.forEach(path => {
                path.curve = this.textToolSettings.curve || 0;
                if (path.type === 'text') {
                    delete path._vectorTextCache;
                    delete path._creativeOutlineCache;
                }
            });
            this.app.canvas.invalidateFillRegionCache?.();
            if (persist) this.app.canvas.saveCurrentState?.();
            this.app.canvas.draw?.();
        };

        const persistTextToolState = () => {
            if (this.textToolPersistTimer) {
                clearTimeout(this.textToolPersistTimer);
                this.textToolPersistTimer = null;
            }
            this.saveWorkspaceState();
            this.app.canvas?.saveCurrentState?.();
        };

        const clampControlValue = (value, input, fallback = 0) => {
            const min = Number.isFinite(parseFloat(input?.min)) ? parseFloat(input.min) : Number.NEGATIVE_INFINITY;
            const max = Number.isFinite(parseFloat(input?.max)) ? parseFloat(input.max) : Number.POSITIVE_INFINITY;
            const next = Number.isFinite(value) ? value : fallback;
            return Math.min(max, Math.max(min, next));
        };

        const bindLiveControl = (input, field, onLiveChange, fallback = 0) => {
            if (!input || !field || typeof onLiveChange !== 'function') return;

            const applyRawValue = (rawValue, persist) => {
                const parsedValue = parseFloat(rawValue);
                const nextValue = clampControlValue(parsedValue, input, fallback);
                input.value = String(nextValue);
                field.value = this.formatTextToolValue(nextValue);
                onLiveChange(nextValue, persist);
            };

            input.oninput = () => applyRawValue(input.value, false);
            input.onchange = () => {
                applyRawValue(input.value, true);
                persistTextToolState();
            };
            input.addEventListener('pointerup', persistTextToolState);

            field.addEventListener('input', () => {
                const rawValue = field.value.trim();
                if (rawValue === '' || rawValue === '-' || rawValue === '.' || rawValue === '-.') return;
                applyRawValue(rawValue, false);
            });
            field.addEventListener('change', () => {
                applyRawValue(field.value, true);
                persistTextToolState();
            });
            field.addEventListener('blur', () => {
                applyRawValue(field.value, true);
                persistTextToolState();
            });
        };

        this.refreshCreativeFontOptions();

        if (selectMode) {
            selectMode.value = this.textToolSettings.mode || 'roland';
            selectMode.onchange = () => {
                this.textToolSettings.mode = selectMode.value || 'roland';
                this.textToolSettings.rotation = this.getTextRotationForMode(
                    this.textToolSettings.mode,
                    this.textToolSettings.rotation || 0
                );
                menu.dataset.mode = this.textToolSettings.mode;
                persistTextToolState();
                applySettingsToSelectedText(true);
                this.refreshTextToolMenuState();
            };
        }

        if (selectFont) {
            selectFont.value = this.textToolSettings.creativeFontId || 'bungee';
            selectFont.onchange = () => {
                this.textToolSettings.creativeFontId = selectFont.value || 'bungee';
                persistTextToolState();
                applySettingsToSelectedText(true);
            };
        }

        if (inputSize && fieldSize) {
            inputSize.value = String(this.textToolSettings.fontSize || 10);
            fieldSize.value = this.formatTextToolValue(this.textToolSettings.fontSize || 10);
            bindLiveControl(inputSize, fieldSize, (fontSize, persist) => {
                this.textToolSettings.fontSize = fontSize;
                applySettingsToSelectedText(persist);
            }, 10);
        }

        if (inputRotation && fieldRotation) {
            inputRotation.value = String(this.textToolSettings.rotation || 0);
            fieldRotation.value = this.formatTextToolValue(this.textToolSettings.rotation || 0);
            bindLiveControl(inputRotation, fieldRotation, (nextRotation, persist) => {
                this.textToolSettings.rotation = this.getTextRotationForMode(
                    this.textToolSettings.mode || 'roland',
                    nextRotation
                );
                inputRotation.value = String(this.textToolSettings.rotation);
                fieldRotation.value = this.formatTextToolValue(this.textToolSettings.rotation);
                applySettingsToSelectedText(persist);
            }, 0);
        }

        if (inputLetterSpacing && fieldLetterSpacing) {
            inputLetterSpacing.value = String(this.textToolSettings.letterSpacing || 0);
            fieldLetterSpacing.value = this.formatTextToolValue(this.textToolSettings.letterSpacing || 0);
            bindLiveControl(inputLetterSpacing, fieldLetterSpacing, (letterSpacing, persist) => {
                this.textToolSettings.letterSpacing = letterSpacing;
                applySettingsToSelectedText(persist);
            }, 0);
        }

        if (inputCurve && fieldCurve) {
            inputCurve.value = String(this.textToolSettings.curve || 0);
            fieldCurve.value = this.formatTextToolValue(this.textToolSettings.curve || 0);
            bindLiveControl(inputCurve, fieldCurve, (curve, persist) => {
                this.textToolSettings.curve = curve;
                applyCurveToSelectedPaths(persist);
            }, 0);
        }

        if (btnUploadFont && inputUpload) {
            btnUploadFont.onclick = () => inputUpload.click();
            inputUpload.onchange = async () => {
                const file = inputUpload.files?.[0];
                if (!file || typeof CreativeTextEngine === 'undefined') return;
                try {
                    const fontEntry = await CreativeTextEngine.loadUploadedFont(file);
                    this.textToolSettings.mode = 'creative';
                    this.textToolSettings.creativeFontId = fontEntry.id;
                    this.refreshCreativeFontOptions();
                    this.refreshTextToolMenuState();
                    this.saveWorkspaceState();
                    applySettingsToSelectedText();
                    this.logToConsole(`System: Loaded creative font "${fontEntry.label}" and cached it for future launches.`);
                } catch (error) {
                    this.logToConsole(`Error: ${error.message}`, 'error');
                } finally {
                    inputUpload.value = '';
                }
            };
        }

        if (btnExplodeSelected) {
            btnExplodeSelected.onclick = () => {
                const explodedCount = this.app?.canvas?.explodeSelectedCreativeText?.() || 0;
                if (!explodedCount) {
                    this.logToConsole('System: Select at least one creative text object to explode.');
                }
                this.refreshTextToolMenuState();
            };
        }

        if (btnResetValues) {
            btnResetValues.onclick = () => {
                this.resetTextToolTransientSettings({ persist: true, applyToSelection: true });
            };
        }

        if (btnClose) btnClose.onclick = () => {
            menu.classList.add('hidden');
            this.syncSpecialToolHighlights();
        };
        this.refreshTextToolMenuState();
    }

    toggleTextToolMenu(triggerButton) {
        const menu = document.getElementById('text-tool-menu');
        if (!menu || !triggerButton) return;
        if (!menu.classList.contains('hidden')) {
            menu.classList.add('hidden');
            this.syncSpecialToolHighlights();
            return;
        }
        this.refreshTextToolMenuState();
        this.positionMenuWithinHost(triggerButton, menu, { preferredSide: 'right' });
        this.syncSpecialToolHighlights();
    }

    refreshCreativeFontOptions() {
        const selectFont = document.getElementById('sel-text-creative-font');
        if (!selectFont || typeof CreativeTextEngine === 'undefined') return;

        const currentValue = this.textToolSettings.creativeFontId || 'bungee';
        const fonts = CreativeTextEngine.getAllFonts();
        selectFont.innerHTML = '';
        fonts.forEach(font => {
            const option = document.createElement('option');
            option.value = font.id;
            option.textContent = `${font.label}${font.source === 'upload' ? ' (Uploaded)' : ''}`;
            selectFont.appendChild(option);
        });
        selectFont.value = fonts.some(font => font.id === currentValue) ? currentValue : (fonts[0]?.id || 'bungee');
        this.textToolSettings.creativeFontId = selectFont.value;
    }

    refreshTextToolMenuState() {
        const menu = document.getElementById('text-tool-menu');
        const selectMode = document.getElementById('sel-text-mode');
        const selectFont = document.getElementById('sel-text-creative-font');
        const inputSize = document.getElementById('input-text-font-size');
        const fieldSize = document.getElementById('field-text-font-size');
        const inputRotation = document.getElementById('input-text-rotation');
        const fieldRotation = document.getElementById('field-text-rotation');
        const inputLetterSpacing = document.getElementById('input-text-letter-spacing');
        const fieldLetterSpacing = document.getElementById('field-text-letter-spacing');
        const inputCurve = document.getElementById('input-text-curve');
        const fieldCurve = document.getElementById('field-text-curve');
        const btnExplodeSelected = document.getElementById('btn-text-explode-selected');
        if (!menu) return;

        const selectedText = this.app?.canvas?.selectedPaths?.length === 1
            ? this.app.canvas.paths[this.app.canvas.selectedPaths[0]]
            : null;
        const editableText = selectedText && selectedText.type === 'text' && selectedText.exploded !== true
            ? selectedText
            : null;
        const curveEditablePath = selectedText && (selectedText.type === 'text' || ['line', 'polyline', 'path'].includes(selectedText.type))
            ? selectedText
            : null;

        const state = editableText
            ? {
                mode: editableText.textMode || 'roland',
                creativeFontId: editableText.creativeFontId || this.textToolSettings.creativeFontId || 'bungee',
                fontSize: editableText.fontSize || this.textToolSettings.fontSize || 10,
                rotation: editableText.rotation || 0,
                letterSpacing: editableText.letterSpacing || 0,
                curve: editableText.curve || 0
            }
            : {
                ...this.textToolSettings,
                curve: curveEditablePath?.curve || this.textToolSettings.curve || 0
            };

        menu.dataset.mode = state.mode || 'roland';
        if (selectMode) selectMode.value = state.mode || 'roland';
        this.refreshCreativeFontOptions();
        if (selectFont) selectFont.value = state.creativeFontId || this.textToolSettings.creativeFontId || 'bungee';
        if (inputSize) inputSize.value = String(state.fontSize || 10);
        if (fieldSize) fieldSize.value = this.formatTextToolValue(state.fontSize || 10);
        if (inputRotation) inputRotation.value = String(state.rotation || 0);
        if (fieldRotation) fieldRotation.value = this.formatTextToolValue(state.rotation || 0);
        if (inputLetterSpacing) inputLetterSpacing.value = String(state.letterSpacing || 0);
        if (fieldLetterSpacing) fieldLetterSpacing.value = this.formatTextToolValue(state.letterSpacing || 0);
        if (inputCurve) inputCurve.value = String(state.curve || 0);
        if (fieldCurve) fieldCurve.value = this.formatTextToolValue(state.curve || 0);

        if (btnExplodeSelected) {
            const hasCreativeSelection = !!(this.app?.canvas?.selectedPaths || []).find(idx => {
                const path = this.app.canvas.paths[idx];
                return path?.type === 'text' && path.textMode === 'creative' && path.exploded !== true;
            });
            btnExplodeSelected.disabled = !hasCreativeSelection;
        }
    }

    _bindToolHoverLabels() {
        const toolButtons = document.querySelectorAll('.vis-palette .tool-btn[title]');
        if (!toolButtons.length) return;

        let label = document.getElementById('tool-hover-label');
        if (!label) {
            label = document.createElement('div');
            label.id = 'tool-hover-label';
            label.className = 'tool-hover-label';
            document.body.appendChild(label);
        }

        const showLabel = (button) => {
            const text = button?.getAttribute('title');
            if (!text) return;
            label.textContent = text;
            label.classList.add('visible');
            const rect = button.getBoundingClientRect();
            const labelWidth = label.offsetWidth || 0;
            const labelHeight = label.offsetHeight || 0;
            const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
            const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
            const gap = 12;
            let left = rect.right + gap;
            let top = rect.top + ((rect.height - labelHeight) / 2);

            if (left + labelWidth > viewportWidth - 8) {
                left = Math.max(8, rect.left - labelWidth - gap);
            }
            top = Math.max(8, Math.min(top, viewportHeight - labelHeight - 8));
            label.style.left = `${Math.round(left)}px`;
            label.style.top = `${Math.round(top)}px`;
        };

        const hideLabel = () => {
            label.classList.remove('visible');
        };

        toolButtons.forEach(button => {
            button.addEventListener('mouseenter', () => showLabel(button));
            button.addEventListener('focus', () => showLabel(button));
            button.addEventListener('mouseleave', hideLabel);
            button.addEventListener('blur', hideLabel);
        });

        window.addEventListener('scroll', hideLabel, true);
        window.addEventListener('resize', hideLabel);
    }

    getTextRotationForMode(mode, rotation) {
        const safeRotation = Number.isFinite(rotation) ? rotation : 0;
        if (mode === 'creative') return safeRotation;
        return this.app?.canvas?.normalizeTextRotation?.(safeRotation) ?? safeRotation;
    }

    formatTextToolValue(value) {
        const safeValue = Number.isFinite(value) ? value : 0;
        return safeValue.toFixed(2);
    }

    ensureTextRotationControls() {
        const existingInput = document.getElementById('input-text-rotation');
        const existingField = document.getElementById('field-text-rotation');
        if (existingInput && existingField) {
            return { input: existingInput, valueField: existingField };
        }

        const legacySelect = document.getElementById('sel-text-rotation');
        if (!legacySelect) return null;

        const wrapper = legacySelect.parentElement;
        if (!wrapper) return null;

        const input = document.createElement('input');
        input.type = 'range';
        input.id = 'input-text-rotation';
        input.min = '-180';
        input.max = '180';
        input.step = '1';
        input.value = '0';

        const valueField = document.createElement('input');
        valueField.type = 'number';
        valueField.id = 'field-text-rotation';
        valueField.className = 'text-tool-value-input';
        valueField.min = '-180';
        valueField.max = '180';
        valueField.step = '1';
        valueField.value = '0.00';

        legacySelect.replaceWith(input);
        wrapper.appendChild(valueField);
        return { input, valueField };
    }

    resetTextToolTransientSettings({ persist = false, applyToSelection = false } = {}) {
        this.textToolSettings.rotation = this.getTextRotationForMode(this.textToolSettings.mode || 'roland', 0);
        this.textToolSettings.letterSpacing = 0;
        this.textToolSettings.curve = 0;

        if (persist) {
            this.saveWorkspaceState();
        }

        if (applyToSelection && this.app?.canvas?.selectedPaths?.length === 1) {
            const path = this.app.canvas.paths[this.app.canvas.selectedPaths[0]];
            if (path?.type === 'text' && path.exploded !== true) {
                path.rotation = this.getTextRotationForMode(path.textMode || this.textToolSettings.mode || 'roland', 0);
                path.letterSpacing = 0;
                path.curve = 0;
                delete path._vectorTextCache;
                delete path._creativeOutlineCache;
                this.app.canvas.saveCurrentState?.();
                this.app.canvas.draw?.();
            } else if (path && ['line', 'polyline', 'path'].includes(path.type)) {
                path.curve = 0;
                this.app.canvas.invalidateFillRegionCache?.();
                this.app.canvas.saveCurrentState?.();
                this.app.canvas.draw?.();
            }
        }

        this.refreshTextToolMenuState();
    }

    _bindInput() {
        const input = document.getElementById('hpgl-input');
        if (input) {
            input.onkeyup = (e) => {
                if (e.key === 'Enter') {
                    const cmd = input.value.trim();
                    if (cmd && this.app.serial && this.app.serial.isConnected) {
                        this.app.serial.sendManualCommand(cmd);
                        input.value = '';
                    }
                }
            };
        }
    }

    setTool(toolName) {
        const previousTool = this.activeTool;
        this.activeTool = toolName;
        document.querySelectorAll('.tool-btn').forEach(b => {
            if (b.dataset.tool === toolName) b.classList.add('active');
            else b.classList.remove('active');
        });
        const requiresEditableWorkspace = ['select', 'node', 'warp', 'boolean', 'bucket', 'shape', 'text', 'bezier'].includes(toolName);
        if (requiresEditableWorkspace && this.currentVisualizerView === 'machine-output') {
            this.currentVisualizerView = 'workspace';
            this.refreshVisualizerViewToggleButton();
            this.saveWorkspaceState();
        }
        if (this.app.canvas) {
            this.app.canvas.finishTextEditing?.({ removeIfEmpty: true, save: true });
            if (previousTool === 'bezier' && toolName !== 'bezier' && this.app.canvas.isCreatingBezier) {
                if (this.app.canvas.isFreeDrawBezier) this.app.canvas.finalizeFreeDrawBezierPath(true);
                else this.app.canvas.finalizeBezierPath(true);
            } else {
                this.app.canvas.cancelCurrentOperation();
            }
            this.clearPatternPreview();
            this.app.canvas.draw();
        }
    }

    _bindJog() {
        const jogBtns = {
            'btn-jog-y-plus': { dx: 0, dy: 1 },
            'btn-jog-y-minus': { dx: 0, dy: -1 },
            'btn-jog-x-plus': { dx: 1, dy: 0 },
            'btn-jog-x-minus': { dx: -1, dy: 0 }
        };
        Object.entries(jogBtns).forEach(([id, move]) => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.onclick = async () => {
                    if (this.app.serial.isConnected) {
                        await this.app.serial.sendJogCommand(move.dx * this.jogStepSize, move.dy * this.jogStepSize);
                    } else {
                        this.app.ui.logToConsole('Error: Printer not connected.', 'error');
                    }
                };
            }
        });
        const homeBtn = document.getElementById('btn-jog-home');
        if (homeBtn) {
            homeBtn.onclick = async () => {
                if (this.app.serial.isConnected) {
                    await this.app.serial.sendHomeCommand();
                } else {
                    this.app.ui.logToConsole('Error: Printer not connected.', 'error');
                }
            };
        }
        document.querySelectorAll('.step-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.step-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.jogStepSize = parseInt(btn.dataset.step);
            };
        });
    }

    _bindPatterns() {
        const selType = document.getElementById('sel-pattern-type');
        const controls = document.getElementById('pattern-controls');
        const inputs = [
            'input-pattern-count',
            'input-pattern-spacing',
            'input-pattern-direction',
            'input-pattern-angle',
            'input-pattern-growth',
            'input-pattern-spacing-angle',
            'input-pattern-contour-size',
            'input-pattern-contour-loops',
            'input-pattern-contour-scale',
            'input-pattern-contour-spin',
            'input-pattern-contour-detail',
            'input-pattern-contour-variation'
        ];
        const selects = [
            'sel-pattern-contour-source',
            'sel-pattern-contour-shape'
        ];

        selType.onchange = () => {
            if (selType.value === 'none') controls.classList.add('hidden');
            else controls.classList.remove('hidden');
            this.updatePatternControlVisibility();
            this.updatePatternPreview();
        };

        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.oninput = (e) => {
                const valEl = document.getElementById(id.replace('input', 'val'));
                if (valEl) valEl.textContent = e.target.value;
                this.updatePatternPreview();
            };
        });

        selects.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.onchange = () => {
                this.updatePatternControlVisibility();
                this.updatePatternPreview();
            };
        });

        document.getElementById('btn-apply-pattern').onclick = () => this.applyPattern();
        document.getElementById('btn-cancel-pattern').onclick = () => this.clearPatternPreview();
        this.updatePatternControlVisibility();
    }

    updatePatternControlVisibility() {
        const type = document.getElementById('sel-pattern-type')?.value || 'none';
        const standardControls = document.getElementById('pattern-standard-controls');
        const contourControls = document.getElementById('pattern-contour-controls');
        const contourSource = document.getElementById('sel-pattern-contour-source')?.value || 'preset';
        const shapeGroup = document.getElementById('group-pattern-contour-shape');
        const sizeGroup = document.getElementById('group-pattern-contour-size');
        const detailLabel = document.getElementById('label-pattern-contour-detail');
        const variationLabel = document.getElementById('label-pattern-contour-variation');
        const shape = document.getElementById('sel-pattern-contour-shape')?.value || 'circle';
        const detailInput = document.getElementById('input-pattern-contour-detail');
        const variationInput = document.getElementById('input-pattern-contour-variation');

        if (standardControls) standardControls.classList.toggle('hidden', type === 'continuousContour');
        if (contourControls) contourControls.classList.toggle('hidden', type !== 'continuousContour');
        if (shapeGroup) shapeGroup.classList.toggle('hidden', type !== 'continuousContour' || contourSource === 'selected');
        if (sizeGroup) sizeGroup.classList.toggle('hidden', type !== 'continuousContour' || contourSource === 'selected');

        if (!detailLabel || !variationLabel || !detailInput || !variationInput) return;

        if (shape === 'polygon') {
            detailLabel.innerHTML = 'Sides: <span id="val-pattern-contour-detail">' + detailInput.value + '</span>';
            variationLabel.innerHTML = 'Corner Style: <span id="val-pattern-contour-variation">' + variationInput.value + '</span>';
            variationInput.min = '1';
            variationInput.max = '8';
        } else if (shape === 'star') {
            detailLabel.innerHTML = 'Points: <span id="val-pattern-contour-detail">' + detailInput.value + '</span>';
            variationLabel.innerHTML = 'Inner Ratio: <span id="val-pattern-contour-variation">' + variationInput.value + '</span>';
            variationInput.min = '1';
            variationInput.max = '8';
        } else if (shape === 'rose') {
            detailLabel.innerHTML = 'Petals Numerator: <span id="val-pattern-contour-detail">' + detailInput.value + '</span>';
            variationLabel.innerHTML = 'Petals Denominator: <span id="val-pattern-contour-variation">' + variationInput.value + '</span>';
            variationInput.min = '1';
            variationInput.max = '8';
        } else if (shape === 'heart') {
            detailLabel.innerHTML = 'Heart Detail: <span id="val-pattern-contour-detail">' + detailInput.value + '</span>';
            variationLabel.innerHTML = 'Heart Variation: <span id="val-pattern-contour-variation">' + variationInput.value + '</span>';
            variationInput.min = '1';
            variationInput.max = '8';
        } else {
            detailLabel.innerHTML = 'Lobes / Detail: <span id="val-pattern-contour-detail">' + detailInput.value + '</span>';
            variationLabel.innerHTML = 'Shape Variation: <span id="val-pattern-contour-variation">' + variationInput.value + '</span>';
            variationInput.min = '1';
            variationInput.max = '8';
        }
    }

    _bindPredictedCrosshairToggle() {
        const toggleBtn = document.getElementById('btn-toggle-predicted-crosshair');
        if (!toggleBtn) return;

        const syncState = () => {
            const isVisible = this.app?.settings?.showPredictedCrosshair !== false;
            toggleBtn.classList.toggle('active', isVisible);
            toggleBtn.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
        };

        toggleBtn.onclick = () => {
            if (!this.app.settings) this.app.settings = {};
            this.app.settings.showPredictedCrosshair = this.app.settings.showPredictedCrosshair === false;
            this.app.saveSettings();
            syncState();
            if (this.app.canvas) this.app.canvas.draw();
        };

        syncState();
    }

    _bindSelectionSizeControls() {
        const inputW = document.getElementById('input-selection-width');
        const inputH = document.getElementById('input-selection-height');
        const chkUniform = document.getElementById('chk-selection-uniform');
        if (!inputW || !inputH || !chkUniform) return;

        const applyDimension = (dimension) => {
            if (this.isUpdatingSelectionSizeControls) return;
            if (!this.app.canvas || this.app.canvas.selectedPaths.length === 0) return;

            const widthVal = parseFloat(inputW.value);
            const heightVal = parseFloat(inputH.value);
            const uniform = chkUniform.checked;

            if (dimension === 'width' && Number.isFinite(widthVal)) {
                this.app.canvas.resizeSelectionToDimensions(widthVal, uniform ? null : heightVal, uniform);
            } else if (dimension === 'height' && Number.isFinite(heightVal)) {
                this.app.canvas.resizeSelectionToDimensions(uniform ? null : widthVal, heightVal, uniform);
            }
        };

        inputW.addEventListener('change', () => applyDimension('width'));
        inputH.addEventListener('change', () => applyDimension('height'));
        inputW.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyDimension('width');
        });
        inputH.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') applyDimension('height');
        });
    }

    _bindVisualizerToolbarOverflow() {
        const tools = document.querySelector('#panel-visualiser .header-tools');
        const overflowWrap = tools ? tools.querySelector('.vis-toolbar-overflow') : null;
        const overflowBtn = document.getElementById('btn-vis-toolbar-more');
        const overflowMenu = document.getElementById('vis-toolbar-overflow-menu');
        if (!tools || !overflowWrap || !overflowBtn || !overflowMenu) return;

        this.visualizerToolbarItems = Array.from(tools.children).filter(el => el !== overflowWrap);

        overflowBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (overflowMenu.children.length === 0) return;
            overflowMenu.classList.toggle('hidden');
        };

        const updateOverflow = () => this.updateVisualizerToolbarOverflow();
        window.addEventListener('resize', updateOverflow);
        if (typeof ResizeObserver !== 'undefined') {
            this.visualizerToolbarResizeObserver = new ResizeObserver(updateOverflow);
            this.visualizerToolbarResizeObserver.observe(tools);
            const header = tools.closest('.panel-header');
            if (header) this.visualizerToolbarResizeObserver.observe(header);
        }

        setTimeout(updateOverflow, 0);
    }

    updateVisualizerToolbarOverflow() {
        const tools = document.querySelector('#panel-visualiser .header-tools');
        const overflowWrap = tools ? tools.querySelector('.vis-toolbar-overflow') : null;
        const overflowBtn = document.getElementById('btn-vis-toolbar-more');
        const overflowMenu = document.getElementById('vis-toolbar-overflow-menu');
        if (!tools || !overflowWrap || !overflowBtn || !overflowMenu) return;

        overflowMenu.classList.add('hidden');

        this.visualizerToolbarItems.forEach(item => {
            if (item.parentElement !== tools) {
                tools.insertBefore(item, overflowWrap);
            }
        });

        overflowBtn.classList.add('hidden');
        if (tools.scrollWidth <= tools.clientWidth) return;

        overflowBtn.classList.remove('hidden');
        for (let i = this.visualizerToolbarItems.length - 1; i >= 0 && tools.scrollWidth > tools.clientWidth; i--) {
            const item = this.visualizerToolbarItems[i];
            if (item.parentElement === tools) {
                overflowMenu.prepend(item);
            }
        }

        if (overflowMenu.children.length === 0) {
            overflowBtn.classList.add('hidden');
        }
    }

    updateSelectionSizeControls() {
        const inputW = document.getElementById('input-selection-width');
        const inputH = document.getElementById('input-selection-height');
        if (!inputW || !inputH || !this.app.canvas) return;

        const dims = this.app.canvas.getSelectedDimensions();
        const hasSelection = !!dims && this.app.canvas.selectedPaths.length > 0;

        this.isUpdatingSelectionSizeControls = true;
        inputW.disabled = !hasSelection;
        inputH.disabled = !hasSelection;
        inputW.value = hasSelection ? dims.width.toFixed(1) : '';
        inputH.value = hasSelection ? dims.height.toFixed(1) : '';
        this.isUpdatingSelectionSizeControls = false;
    }

    updatePatternPreview() {
        const type = document.getElementById('sel-pattern-type').value;
        if (type === 'none') {
            this.app.canvas.patternPreviewPaths = [];
            this.app.canvas.draw();
            return;
        }

        if (this.currentVisualizerView === 'machine-output') {
            this.currentVisualizerView = 'workspace';
            this.refreshVisualizerViewToggleButton();
            this.saveWorkspaceState();
        }

        const contourSource = document.getElementById('sel-pattern-contour-source')?.value || 'preset';
        if (type !== 'continuousContour' && this.app.canvas.selectedPaths.length === 0) {
            this.app.canvas.patternPreviewPaths = [];
            this.app.canvas.draw();
            return;
        }
        if (type === 'continuousContour' && contourSource === 'selected' && this.app.canvas.selectedPaths.length === 0) {
            this.app.canvas.patternPreviewPaths = [];
            this.app.canvas.draw();
            return;
        }

        const params = {
            type,
            count: parseInt(document.getElementById('input-pattern-count').value),
            spacing: parseFloat(document.getElementById('input-pattern-spacing').value),
            direction: parseFloat(document.getElementById('input-pattern-direction').value),
            angle: parseFloat(document.getElementById('input-pattern-angle').value),
            growth: parseFloat(document.getElementById('input-pattern-growth').value),
            spacingAngle: parseFloat(document.getElementById('input-pattern-spacing-angle').value),
            contourSource,
            contourShape: document.getElementById('sel-pattern-contour-shape')?.value || 'circle',
            contourSize: parseFloat(document.getElementById('input-pattern-contour-size')?.value || '120'),
            contourLoops: parseInt(document.getElementById('input-pattern-contour-loops')?.value || '18', 10),
            contourScale: parseFloat(document.getElementById('input-pattern-contour-scale')?.value || '6'),
            contourSpin: parseFloat(document.getElementById('input-pattern-contour-spin')?.value || '12'),
            contourDetail: parseInt(document.getElementById('input-pattern-contour-detail')?.value || '6', 10),
            contourVariation: parseInt(document.getElementById('input-pattern-contour-variation')?.value || '2', 10)
        };
        const sourcePaths = this.app.canvas.selectedPaths.map(idx => this.app.canvas.paths[idx]);
        this.app.canvas.patternPreviewPaths = this.app.patterns.generate(sourcePaths, params);
        this.app.canvas.draw();
    }

    applyPattern() {
        if (this.app.canvas.patternPreviewPaths.length > 0) {
            this.app.canvas.ensureUndoCheckpoint();
            this.app.canvas.paths.push(...this.app.canvas.patternPreviewPaths);
            this.app.canvas.patternPreviewPaths = [];
            this.app.canvas.selectedPaths = [];
            this.app.canvas.saveUndoState();
            this.app.canvas.draw();
            document.getElementById('sel-pattern-type').value = 'none';
            document.getElementById('pattern-controls').classList.add('hidden');
        }
    }

    clearPatternPreview() {
        this.app.canvas.patternPreviewPaths = [];
        this.app.canvas.draw();
    }

    updatePatternPanelState() {
        const selType = document.getElementById('sel-pattern-type');
        const hasSelection = this.app.canvas.selectedPaths.length > 0;
        const contourSource = document.getElementById('sel-pattern-contour-source')?.value || 'preset';
        selType.disabled = false;
        this.updateSelectionSizeControls();
        if (!hasSelection && selType.value !== 'continuousContour') {
            selType.value = 'none';
            document.getElementById('pattern-controls').classList.add('hidden');
            this.app.canvas.patternPreviewPaths = [];
        }
        if (!hasSelection && selType.value === 'continuousContour' && contourSource === 'selected') {
            this.app.canvas.patternPreviewPaths = [];
        }
        this.updatePatternControlVisibility();
    }

    enableRunControls() {
        document.querySelectorAll('[data-stream-action]').forEach(btn => {
            btn.disabled = false;
        });
    }

    disableRunControls() {
        document.querySelectorAll('[data-stream-action]').forEach(btn => {
            btn.disabled = true;
        });
    }
}
