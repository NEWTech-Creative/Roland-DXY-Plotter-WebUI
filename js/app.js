class App {
    constructor() {
        this.ui = new UIController(this);
        this.serial = new SerialManager(this);
        this.canvas = new CanvasManager(this);
        this.patterns = new PatternGenerator(this);
        this.hpgl = new HpglParser(this);
        this.liveTracker = new LiveTrackerController(this);

        this.settings = {
            model: '1200',
            theme: 'dark-theme',
            handshake: 'normal',
            speed: 'fast',
            streamPerformanceMode: true,
            bedWidth: 432,
            bedHeight: 297,
            marginX: 15,
            marginY: 10,
            outputFlipHorizontal: false,
            outputFlipVertical: true,
            showPredictedCrosshair: true,
            showStartupMessage: true,
            useInternalCurveEngine: false,
            importResolution: 130,
            simBackgroundOpacity: 0.25,
            paperSize: 'A3',
            customPaperSizes: [],
            creativePanelsTabbed: true,
            panelVisibility: {
                'panel-connection': true,
                'panel-machine-jog': true,
                'panel-console': true,
                'panel-visualiser': true,
                'panel-patterns': true,
                'panel-handwriting': true,
                'panel-image-vector': true,
                'panel-3d-vector': true,
                'panel-live-tracker': true
            },
            liveTracker: {}
        };

        this.loadSettings();

        // Run all component initialization
        this.init();

        this.ui.logToConsole('System: Application Initialized.');
    }

    init() {
        this.ui.initGridStack();
        this.ui.initPenSlots();
        if (typeof CreativeTextEngine !== 'undefined') {
            void CreativeTextEngine.hydratePersistedFonts().then((restoredFonts) => {
                if (restoredFonts.length > 0) {
                    this.ui.refreshCreativeFontOptions?.();
                    this.ui.refreshTextToolMenuState?.();
                    this.canvas.draw?.();
                    this.ui.logToConsole(`System: Restored ${restoredFonts.length} cached creative font(s).`);
                }
            });
        }

        const modelSelect = document.getElementById('sel-model');
        if (modelSelect) {
            modelSelect.value = this.settings.model || '1200';
            if (!modelSelect.value) {
                modelSelect.value = '1200';
                this.settings.model = '1200';
            }
        }

        this.applyMachineProfile(false);
        this.refreshMachineUI();

        // Sync canvas with loaded settings
        if (this.settings) {
            this.canvas.bedWidth = this.settings.bedWidth || this.getMachineProfile().bedWidth;
            this.canvas.bedHeight = this.settings.bedHeight || this.getMachineProfile().bedHeight;
            if (this.serial) this.serial.setSpeedDelay(this.settings.speed || 'fast');
        }

        this.canvas.init();
        this.canvas.loadSavedState(); // Restore local persist
        this.bindEvents();
        this.initHandwriting();
        this.initImageVector();
        this.init3DVector();
        this.liveTracker.init();
        this.ui.showStartupModal();
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('dxySettings');
            if (saved) {
                this.settings = { ...this.settings, ...JSON.parse(saved) };
            }
            this.settings.customPaperSizes = this.normalizeCustomPaperSizes(this.settings.customPaperSizes);
            if (!this.isValidPaperSize(this.settings.paperSize)) {
                this.settings.paperSize = 'A3';
            }
            if (!['test', '1100', '1200', '1300'].includes(this.settings.model)) {
                this.settings.model = '1200';
                this.settings.bedWidth = 432;
                this.settings.bedHeight = 297;
            }
            document.body.className = this.settings.theme;
        } catch (e) {
            // Settings fail
        }
    }

    saveSettings() {
        try {
            this.settings.customPaperSizes = this.normalizeCustomPaperSizes(this.settings.customPaperSizes);
            if (!this.isValidPaperSize(this.settings.paperSize)) {
                this.settings.paperSize = 'A3';
            }
            localStorage.setItem('dxySettings', JSON.stringify(this.settings));
            document.body.className = this.settings.theme;
        } catch (e) {
            // Save fail
        }
    }

    getBuiltInPaperSizes() {
        return {
            A3: { name: 'A3', width: 420, height: 297 },
            A4: { name: 'A4', width: 297, height: 210 },
            A5: { name: 'A5', width: 210, height: 148 }
        };
    }

    normalizeCustomPaperSizes(customPaperSizes = []) {
        const reservedNames = new Set(['A3', 'A4', 'A5', 'MAX', 'CUSTOM']);
        const normalized = [];
        const seenNames = new Set();

        (Array.isArray(customPaperSizes) ? customPaperSizes : []).forEach(entry => {
            const rawName = typeof entry?.name === 'string' ? entry.name.trim() : '';
            const upperName = rawName.toUpperCase();
            const width = Number(entry?.width);
            const height = Number(entry?.height);
            if (!rawName || reservedNames.has(upperName) || seenNames.has(upperName)) return;
            if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
            normalized.push({
                name: rawName,
                width: Math.round(width * 1000) / 1000,
                height: Math.round(height * 1000) / 1000
            });
            seenNames.add(upperName);
        });

        return normalized;
    }

    getPaperSizeMap() {
        const paperMap = { ...this.getBuiltInPaperSizes() };
        this.normalizeCustomPaperSizes(this.settings.customPaperSizes).forEach(size => {
            paperMap[size.name] = { ...size };
        });
        return paperMap;
    }

    isValidPaperSize(name) {
        if (name === 'Max') return true;
        return Object.prototype.hasOwnProperty.call(this.getPaperSizeMap(), name || '');
    }

    buildWorkspaceBackupData() {
        return {
            version: '1.1',
            appName: 'RolandPlotterWeb',
            timestamp: new Date().toISOString(),
            paths: this.canvas.paths,
            penConfig: this.ui.visPenConfig,
            settings: {
                ...this.settings,
                customPaperSizes: this.normalizeCustomPaperSizes(this.settings.customPaperSizes)
            },
            workspaceState: this.ui.getWorkspaceBackupState()
        };
    }

    getMachineProfile(model = this.settings.model) {
        const profiles = {
            'test': {
                id: 'test',
                label: 'Test / Null Plotter',
                bedWidth: 432,
                bedHeight: 297,
                importExtensions: ['.svg', '.dxf', '.hpgl', '.dxyweb'],
                commandPlaceholder: 'Enter HPGL command for test output (e.g. PU;)...'
            },
            '1100': {
                id: '1100',
                label: 'DXY 1100',
                bedWidth: 432,
                bedHeight: 297,
                importExtensions: ['.svg', '.dxf', '.hpgl', '.dxyweb'],
                commandPlaceholder: 'Enter HPGL command (e.g. PU;)...'
            },
            '1200': {
                id: '1200',
                label: 'DXY 1200',
                bedWidth: 432,
                bedHeight: 297,
                importExtensions: ['.svg', '.dxf', '.hpgl', '.dxyweb'],
                commandPlaceholder: 'Enter HPGL command (e.g. PU;)...'
            },
            '1300': {
                id: '1300',
                label: 'DXY 1300',
                bedWidth: 432,
                bedHeight: 297,
                importExtensions: ['.svg', '.dxf', '.hpgl', '.dxyweb'],
                commandPlaceholder: 'Enter HPGL command (e.g. PU;)...'
            }
        };

        return profiles[model] || profiles['1200'];
    }

    applyMachineProfile(resetWorkArea = true) {
        const profile = this.getMachineProfile();
        if (resetWorkArea) {
            this.settings.bedWidth = profile.bedWidth;
            this.settings.bedHeight = profile.bedHeight;
        } else {
            if (!Number.isFinite(this.settings.bedWidth)) this.settings.bedWidth = profile.bedWidth;
            if (!Number.isFinite(this.settings.bedHeight)) this.settings.bedHeight = profile.bedHeight;
        }

        if (this.canvas) {
            this.canvas.bedWidth = this.settings.bedWidth;
            this.canvas.bedHeight = this.settings.bedHeight;
        }
    }

    refreshMachineUI() {
        const profile = this.getMachineProfile();
        const input = document.getElementById('hpgl-input');
        const penUpBtn = document.getElementById('btn-pen-up');
        const penDownBtn = document.getElementById('btn-pen-down');

        if (input) input.placeholder = profile.commandPlaceholder;
        if (penUpBtn) {
            penUpBtn.textContent = 'Pen Up';
            penUpBtn.title = 'Send PU; command';
        }
        if (penDownBtn) {
            penDownBtn.textContent = 'Pen Down';
            penDownBtn.title = 'Send PD; command';
        }
    }

    bindEvents() {
        const modelSelect = document.getElementById('sel-model');
        if (modelSelect) {
            modelSelect.addEventListener('change', () => {
                this.settings.model = modelSelect.value || '1200';
                this.applyMachineProfile(true);
                this.refreshMachineUI();
                this.saveSettings();
                if (this.canvas) {
                    this.canvas.resize();
                    this.canvas.draw(true);
                }
                this.ui.logToConsole(`System: ${this.getMachineProfile().label} workspace set to ${this.settings.bedWidth} x ${this.settings.bedHeight} mm.`);
            });
        }

        // Connection events
        document.getElementById('btn-connect').addEventListener('click', () => {
            if (this.serial.isConnected) {
                this.serial.disconnect();
            } else {
                this.serial.connect();
            }
        });

        document.getElementById('btn-pen-up').addEventListener('click', () => {
            if (this.serial && this.serial.isConnected) {
                this.serial.sendPenUpCommand();
            } else {
                this.ui.logToConsole('Error: Printer not connected.', 'error');
            }
        });

        document.getElementById('btn-pen-down').addEventListener('click', () => {
            if (this.serial && this.serial.isConnected) {
                this.serial.sendPenDownCommand();
            } else {
                this.ui.logToConsole('Error: Printer not connected.', 'error');
            }
        });

        // Layout events
        document.getElementById('btn-new').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the canvas?')) {
                this.liveTracker?.stopCameraAndOverlay?.();
                this.canvas.clear();
                this.ui.logToConsole('System: Canvas cleared.');
            }
        });
        document.getElementById('btn-save').addEventListener('click', () => {
            this.saveProject();
        });

        // File Loading / Import
        document.getElementById('btn-upload').addEventListener('click', () => {
            const profile = this.getMachineProfile();
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = profile.importExtensions.join(',');
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;

                const ext = file.name.split('.').pop().toLowerCase();

                if (ext === 'dxyweb') {
                    this.loadProject(file);
                    return;
                }

                const reader = new FileReader();
                reader.onload = async evt => {
                    const content = evt.target.result;
                    this.ui.showLoading(ext.toUpperCase() + ' Import...');
                    try {
                        if (ext === 'svg') {
                            await this.hpgl.parseSVG(content);
                        } else if (ext === 'dxf') {
                            await this.hpgl.parseDXF(content);
                        } else if (ext === 'hpgl') {
                            await this.hpgl.parseHPGL(content);
                        }
                    } catch (err) {
                        this.ui.logToConsole(`Error importing: ${err.message}`, 'error');
                    } finally {
                        this.ui.hideLoading();
                    }
                };

                reader.readAsText(file);
            };
            input.click();
        });

        const exportFormatSelect = document.getElementById('sel-export-format');
        if (exportFormatSelect) {
            exportFormatSelect.addEventListener('change', () => {
                const exportFormat = exportFormatSelect.value;
                if (!exportFormat) return;

                const exporters = {
                    hpgl: () => ({
                        content: this.hpgl.exportHPGL(this.canvas.paths),
                        extension: 'hpgl',
                        label: 'HPGL'
                    }),
                    gcode: () => ({
                        content: this.hpgl.exportGCode(this.canvas.paths),
                        extension: 'gcode',
                        label: 'GCODE'
                    }),
                    svg: () => ({
                        content: this.hpgl.exportSVG(this.canvas.paths),
                        extension: 'svg',
                        label: 'SVG'
                    })
                };
                const exporter = exporters[exportFormat] || exporters.hpgl;
                const output = exporter();
                if (output && output.content) {
                    const mimeType = output.extension === 'svg' ? 'image/svg+xml' : 'text/plain';
                    const blob = new Blob([output.content], { type: mimeType });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `plotter_export_${new Date().getTime()}.${output.extension}`;
                    a.click();
                    URL.revokeObjectURL(url);
                    this.ui.logToConsole(`System: ${output.label} file exported successfully.`);
                }
                exportFormatSelect.value = '';
            });
        }

        document.getElementById('btn-simulate').addEventListener('click', () => {
            this.canvas.startSimulation();
        });
        this.canvas.refreshSimulationButton();

        document.getElementById('btn-simulate-speed').addEventListener('click', (e) => {
            if (!this.canvas.simulationSpeedMultiplier) this.canvas.simulationSpeedMultiplier = 1;
            const speedSteps = [1, 2, 5, 10, 20, 50, 100];
            const currentIndex = speedSteps.indexOf(this.canvas.simulationSpeedMultiplier);
            const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % speedSteps.length;
            this.canvas.simulationSpeedMultiplier = speedSteps[nextIndex];

            if (this.canvas.simulationSpeedMultiplier > 1) {
                e.target.style.background = 'var(--accent-blue)';
                e.target.style.color = 'white';
                e.target.innerText = `x${this.canvas.simulationSpeedMultiplier}`;
            } else {
                e.target.style.background = 'transparent';
                e.target.style.color = 'var(--text-main)';
                e.target.innerText = 'x1';
            }
        });

        // Window resize
        window.addEventListener('resize', () => {
            this.canvas.handleResize();
        });
    }

    clearWorkspaceForLiveTracker() {
        if (this.serial) {
            this.serial.queue = [];
            this.serial.updateStats?.();
        }
        if (this.canvas) {
            this.canvas.clearForLiveTracker?.();
        }
        if (this.ui) {
            this.ui.clearPatternPreview?.();
        }
    }

    isWorkspaceEmptyForLiveTracker() {
        if (!this.canvas) return true;
        return this.canvas.isWorkspaceEmptyForLiveTracker?.() !== false
            && (!this.serial || (this.serial.queue?.length || 0) === 0);
    }

    // Global State Updates
    updateConnectionState(isConnected) {
        const btn = document.getElementById('btn-connect');
        const badge = document.getElementById('global-status');

        if (isConnected) {
            btn.textContent = 'Disconnect';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-danger');

            badge.textContent = 'Connected';
            badge.classList.remove('disconnected');
            badge.classList.add('connected');

            this.ui.enableRunControls();
        } else {
            btn.textContent = 'Connect USB Serial';
            btn.classList.remove('btn-danger');
            btn.classList.add('btn-primary');

            badge.textContent = 'Disconnected';
            badge.classList.remove('connected');
            badge.classList.add('disconnected');

            this.ui.disableRunControls();
        }
    }

    initHandwriting() {
        if (typeof HandwritingPanel !== 'undefined') {
            this.handwritingPanel = new HandwritingPanel(this);
        }
    }

    initImageVector() {
        if (typeof ImageVectorPanel !== 'undefined') {
            this.imageVectorPanel = new ImageVectorPanel(this);
        }
    }

    init3DVector() {
        if (typeof Vector3DPanel !== 'undefined') {
            this.vector3DPanel = new Vector3DPanel(this);
        }
    }

    saveProject(filePrefix = 'plotter_project') {
        try {
            const projectData = this.buildWorkspaceBackupData();

            const json = JSON.stringify(projectData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filePrefix}_${new Date().getTime()}.dxyweb`;
            a.click();
            URL.revokeObjectURL(url);
            this.ui.logToConsole('System: Project file (.dxyweb) exported successfully.');
        } catch (err) {
            this.ui.logToConsole('Error saving project: ' + err.message, 'error');
        }
    }

    async loadProject(file) {
        this.ui.showLoading('Loading Project...');
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);

                // Basic validation
                if (!data.paths && !data.settings) {
                    throw new Error('Invalid project file format.');
                }

                if (data.paths) {
                    this.canvas.paths = data.paths;
                }

                if (data.penConfig) {
                    this.ui.visPenConfig = data.penConfig;
                    this.ui.initPenSlots();
                    this.ui.saveWorkspaceState();
                }

                if (data.settings) {
                    this.settings = { ...this.settings, ...data.settings };
                    this.settings.customPaperSizes = this.normalizeCustomPaperSizes(this.settings.customPaperSizes);
                    if (!this.isValidPaperSize(this.settings.paperSize)) {
                        this.settings.paperSize = 'A3';
                    }
                    if (!['test', '1100', '1200', '1300'].includes(this.settings.model)) {
                        this.settings.model = '1200';
                        this.settings.bedWidth = 432;
                        this.settings.bedHeight = 297;
                    }
                    this.applyMachineProfile(false);
                    this.saveSettings();

                    // Apply immediate settings
                    this.refreshMachineUI();
                    if (this.canvas) {
                        this.canvas.bedWidth = this.settings.bedWidth || this.getMachineProfile().bedWidth;
                        this.canvas.bedHeight = this.settings.bedHeight || this.getMachineProfile().bedHeight;
                        this.canvas.refreshPaperSettings?.();
                        this.canvas.resize();
                    }
                }

                if (data.workspaceState) {
                    this.ui.applyWorkspaceBackupState(data.workspaceState);
                }

                this.canvas.draw();
                this.ui.logToConsole('System: Project loaded successfully from .dxyweb file.');
            } catch (err) {
                this.ui.logToConsole('Error loading project: ' + err.message, 'error');
            } finally {
                this.ui.hideLoading();
            }
        };
        reader.onerror = () => {
            this.ui.logToConsole('Error reading file.', 'error');
            this.ui.hideLoading();
        };
        reader.readAsText(file);
    }
}

// Start app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.plotterApp = new App();
});
