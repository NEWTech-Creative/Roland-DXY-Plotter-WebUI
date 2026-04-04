class UIController {
    constructor(app) {
        this.app = app;
        this.penColors = ['#1e1e1e', '#e11d48', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#ea580c', '#0ea5e9']; // Default 8 pens
        this.visPenConfig = this.penColors.map(c => ({ color: c, thickness: 0.3 })); // Context configs
        this.activeTool = 'select'; // select, text, shape, node, bucket
        this.activeVisualizerPen = 1;
        this.fillBucketSettings = {
            pattern: 'lines',
            spacing: 6,
            angle: 45,
            pen: 1,
            groupPatterns: true
        };
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
            { id: 'panel-image-vector', x: 3, y: 19, w: 6, h: 12 }
        ];
        this.defaultGridLayout = [
            { id: 'panel-connection', x: 0, y: 0, w: 2, h: 4 },
            { id: 'panel-machine-jog', x: 0, y: 4, w: 2, h: 4 },
            { id: 'panel-console', x: 0, y: 8, w: 2, h: 7 },
            { id: 'panel-visualiser', x: 2, y: 0, w: 5, h: 8 },
            { id: 'panel-live-tracker', x: 8, y: 0, w: 2, h: 7 },
            { id: 'panel-handwriting', x: 2, y: 8, w: 3, h: 7 },
            { id: 'panel-image-vector', x: 5, y: 8, w: 3, h: 7 },
            { id: 'panel-patterns', x: 8, y: 8, w: 2, h: 7 }
        ];
        this.panelDefinitions = [
            { id: 'panel-connection', label: 'Connection', alwaysVisible: true },
            { id: 'panel-machine-jog', label: 'Machine & Jog' },
            { id: 'panel-console', label: 'Command Log' },
            { id: 'panel-visualiser', label: 'Visualiser' },
            { id: 'panel-live-tracker', label: 'Live Finger Tracker' },
            { id: 'panel-patterns', label: 'Pattern Generator' },
            { id: 'panel-handwriting', label: 'Handwriting Generator' },
            { id: 'panel-image-vector', label: 'Image to Vector' }
        ];
        this.gridResizeTimer = null;
        this.gridAutoSaveTimer = null;
        this.isApplyingResponsiveLayout = false;
        this.isLoadingGridLayout = false;
        this.isApplyingPanelVisibility = false;
        this.isUpdatingSelectionSizeControls = false;
        this.visualizerToolbarItems = [];
        this.visualizerToolbarResizeObserver = null;

        this.loadWorkspaceState();
        this._bindInput();
        this._bindTools();
        this._bindStartupModal();
        this._bindMachineSetupHelp();
        this._bindSettings();
        this._bindJog();
        this._bindPatterns();
        this._bindFillBucketMenu();
        this._bindSelectionSizeControls();
        this._bindVisualizerToolbarOverflow();
        this._bindPredictedCrosshairToggle();
        // HandwritingPanel is initialized by its own window.load listener in handwriting-panel.js

        // Global click listener to close context menus
        window.addEventListener('click', (e) => {
            const penMenu = document.getElementById('vis-pen-menu');
            const shapeMenu = document.getElementById('shape-type-menu');
            const fillBucketMenu = document.getElementById('fill-bucket-menu');
            const overflowMenu = document.getElementById('vis-toolbar-overflow-menu');
            const overflowBtn = document.getElementById('btn-vis-toolbar-more');

            if (penMenu && !penMenu.classList.contains('hidden')) {
                if (!penMenu.contains(e.target) && !e.target.closest('.vis-color-btn')) {
                    penMenu.classList.add('hidden');
                }
            }
            if (shapeMenu && !shapeMenu.classList.contains('hidden')) {
                if (!shapeMenu.contains(e.target) && !e.target.closest('[data-tool="shape"]')) {
                    shapeMenu.classList.add('hidden');
                }
            }
            if (fillBucketMenu && !fillBucketMenu.classList.contains('hidden')) {
                if (!fillBucketMenu.contains(e.target) && !e.target.closest('[data-tool="bucket"]')) {
                    fillBucketMenu.classList.add('hidden');
                }
            }
            if (overflowMenu && overflowBtn && !overflowMenu.classList.contains('hidden')) {
                if (!overflowMenu.contains(e.target) && !overflowBtn.contains(e.target)) {
                    overflowMenu.classList.add('hidden');
                }
            }
        });
    }

    loadWorkspaceState() {
        try {
            const savedPens = localStorage.getItem('visPenConfig');
            if (savedPens) this.visPenConfig = JSON.parse(savedPens);

            const savedPalette = localStorage.getItem('penColors');
            if (savedPalette) this.penColors = JSON.parse(savedPalette);

            const savedActive = localStorage.getItem('activeVisualizerPen');
            if (savedActive) this.activeVisualizerPen = parseInt(savedActive, 10);


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
        } catch (e) { console.error('Workspace save fail:', e); }
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

    _isPanelVisible(panelId) {
        return !!this._getPanelVisibilitySettings()[panelId];
    }

    _getVisibleLayout(layout) {
        return this._sortLayout(layout.filter(item => this._isPanelVisible(item.id)));
    }

    _isGridWidgetActive(el) {
        return !!(this.grid && this.grid.engine && this.grid.engine.nodes || []).find(node => node.el === el);
    }

    applyPanelVisibilitySettings() {
        if (!this.grid) return;

        const visibility = this._getPanelVisibilitySettings();
        this.isApplyingPanelVisibility = true;
        if (typeof this.grid.batchUpdate === 'function') this.grid.batchUpdate(true);
        try {
            this.panelDefinitions.forEach(panel => {
                const el = document.getElementById(panel.id);
                if (!el) return;

                const shouldShow = panel.alwaysVisible ? true : visibility[panel.id] !== false;
                const isActive = this._isGridWidgetActive(el);

                if (!shouldShow && isActive) {
                    this.grid.removeWidget(el, false, false);
                    el.style.display = 'none';
                    el.dataset.panelHidden = 'true';
                    return;
                }

                if (shouldShow && !isActive) {
                    const savedLayout = this.baseGridLayout.find(item => item.id === panel.id);
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
        const inputRes = document.getElementById('input-import-resolution');
        const valRes = document.getElementById('val-import-resolution');
        const inputUseInternalCurveEngine = document.getElementById('input-use-internal-curve-engine');
        const importResolutionGroup = document.getElementById('import-resolution-group');
        const inputMarginX = document.getElementById('input-margin-x');
        const inputMarginY = document.getElementById('input-margin-y');
        const inputOutputFlipX = document.getElementById('input-output-flip-x');
        const inputOutputFlipY = document.getElementById('input-output-flip-y');
        const panelToggleInputs = Array.from(document.querySelectorAll('[data-panel-toggle]'));

        const updateImportResolutionAvailability = () => {
            const useInternalCurveEngine = inputUseInternalCurveEngine ? inputUseInternalCurveEngine.checked : true;
            const isDisabled = useInternalCurveEngine === true;
            if (inputRes) {
                inputRes.disabled = isDisabled;
            }
            if (valRes) {
                valRes.classList.toggle('is-disabled', isDisabled);
            }
            if (importResolutionGroup) {
                importResolutionGroup.classList.toggle('settings-control-disabled', isDisabled);
            }
        };

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
            if (inputRes) {
                inputRes.value = this.app.settings.importResolution || 15;
                if (valRes) valRes.textContent = inputRes.value;
            }
            if (inputUseInternalCurveEngine) {
                inputUseInternalCurveEngine.checked = this.app.settings.useInternalCurveEngine !== false;
            }
            updateImportResolutionAvailability();
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

        if (inputRes) {
            inputRes.oninput = (e) => {
                if (valRes) valRes.textContent = e.target.value;
            };
        }

        if (inputUseInternalCurveEngine) {
            inputUseInternalCurveEngine.onchange = () => {
                updateImportResolutionAvailability();
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
            if (inputRes) {
                this.app.settings.importResolution = parseInt(inputRes.value, 10);
            }
            if (inputUseInternalCurveEngine) {
                this.app.settings.useInternalCurveEngine = inputUseInternalCurveEngine.checked;
            }
            if (inputMarginX) this.app.settings.marginX = parseFloat(inputMarginX.value);
            if (inputMarginY) this.app.settings.marginY = parseFloat(inputMarginY.value);
            if (inputOutputFlipX) this.app.settings.outputFlipHorizontal = inputOutputFlipX.checked;
            if (inputOutputFlipY) this.app.settings.outputFlipVertical = !inputOutputFlipY.checked;
            this.app.settings.panelVisibility = panelToggleInputs.reduce((acc, input) => {
                acc[input.dataset.panelToggle] = input.disabled ? true : input.checked;
                return acc;
            }, this._getDefaultPanelVisibility());
            this.app.saveSettings();
            this.applyPanelVisibilitySettings();
            this.applyResponsiveGridLayout();
            this.forceLayoutSave();
            if (this.app.serial) this.app.serial.setSpeedDelay(this.app.settings.speed || 'fast');
            if (this.app.canvas) {
                this.app.canvas.bedWidth = this.app.settings.bedWidth || this.app.getMachineProfile().bedWidth;
                this.app.canvas.bedHeight = this.app.settings.bedHeight || this.app.getMachineProfile().bedHeight;
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
                if (tool === 'bucket') {
                    const rect = btn.getBoundingClientRect();
                    this.showFillBucketMenu(rect.right + 8, rect.top);
                    e.stopPropagation();
                }
            };

            if (tool === 'shape') {
                let shapeTimer;
                btn.addEventListener('mousedown', (e) => {
                    shapeTimer = setTimeout(() => {
                        this.showShapeMenu(e.clientX, e.clientY);
                        shapeTimer = null;
                    }, 300); // Reduced delay to 300ms for better responsiveness
                });
                btn.addEventListener('mouseup', () => {
                    if (shapeTimer) clearTimeout(shapeTimer);
                });
                btn.addEventListener('mouseleave', () => {
                    if (shapeTimer) clearTimeout(shapeTimer);
                });
            }
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
            };
        });

        const closeShapeMenu = document.getElementById('btn-close-shape-menu');
        if (closeShapeMenu) {
            closeShapeMenu.onclick = () => document.getElementById('shape-type-menu').classList.add('hidden');
        }
    }

    showShapeMenu(x, y) {
        const menu = document.getElementById('shape-type-menu');
        if (!menu) return;
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.remove('hidden');
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
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.classList.remove('hidden');
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
        this.activeTool = toolName;
        document.querySelectorAll('.tool-btn').forEach(b => {
            if (b.dataset.tool === toolName) b.classList.add('active');
            else b.classList.remove('active');
        });
        if (this.app.canvas) {
            this.app.canvas.cancelCurrentOperation();
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
