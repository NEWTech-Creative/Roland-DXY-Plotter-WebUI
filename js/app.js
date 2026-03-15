class App {
    constructor() {
        this.ui = new UIController(this);
        this.serial = new SerialManager(this);
        this.canvas = new CanvasManager(this);
        this.patterns = new PatternGenerator(this);
        this.hpgl = new HpglParser(this);

        this.settings = {
            theme: 'dark-theme',
            handshake: 'normal',
            speed: 'fast',
            bedWidth: 432,
            bedHeight: 297,
            marginX: 15,
            marginY: 10,
            importResolution: 15,
            simBackgroundOpacity: 0.25,
            panelVisibility: {
                'panel-connection': true,
                'panel-machine-jog': true,
                'panel-console': true,
                'panel-visualiser': true,
                'panel-patterns': true,
                'panel-handwriting': true,
                'panel-image-vector': true
            }
        };

        this.loadSettings();

        // Run all component initialization
        this.init();

        this.ui.logToConsole('System: Application Initialized.');
    }

    init() {
        this.ui.initGridStack();
        this.ui.initPenSlots();

        // Sync canvas with loaded settings
        if (this.settings) {
            this.canvas.bedWidth = this.settings.bedWidth || 432;
            this.canvas.bedHeight = this.settings.bedHeight || 297;
            if (this.serial) this.serial.setSpeedDelay(this.settings.speed || 'fast');
        }

        this.canvas.init();
        this.canvas.loadSavedState(); // Restore local persist
        this.bindEvents();
        this.initHandwriting();
        this.initImageVector();
    }

    loadSettings() {
        try {
            const saved = localStorage.getItem('dxySettings');
            if (saved) {
                this.settings = { ...this.settings, ...JSON.parse(saved) };
            }
            document.body.className = this.settings.theme;
        } catch (e) {
            // Settings fail
        }
    }

    saveSettings() {
        try {
            localStorage.setItem('dxySettings', JSON.stringify(this.settings));
            document.body.className = this.settings.theme;
        } catch (e) {
            // Save fail
        }
    }

    bindEvents() {
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
                this.serial.sendManualCommand('PU;');
            } else {
                this.ui.logToConsole('Error: Printer not connected.', 'error');
            }
        });

        document.getElementById('btn-pen-down').addEventListener('click', () => {
            if (this.serial && this.serial.isConnected) {
                this.serial.sendManualCommand('PD;');
            } else {
                this.ui.logToConsole('Error: Printer not connected.', 'error');
            }
        });

        // Layout events
        document.getElementById('btn-new').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the canvas?')) {
                this.canvas.clear();
                this.ui.logToConsole('System: Canvas cleared.');
            }
        });
        document.getElementById('btn-save').addEventListener('click', () => {
            this.saveProject();
        });

        // File Loading / Import
        document.getElementById('btn-upload').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.svg,.dxf,.hpgl,.dxyweb';
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

        document.getElementById('btn-export').addEventListener('click', () => {
            const hpgl = this.hpgl.exportHPGL(this.canvas.paths);
            if (hpgl) {
                const blob = new Blob([hpgl], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `plotter_export_${new Date().getTime()}.hpgl`;
                a.click();
                URL.revokeObjectURL(url);
                this.ui.logToConsole('System: HPGL file exported successfully.');
            }
        });

        document.getElementById('btn-simulate').addEventListener('click', () => {
            this.canvas.startSimulation();
        });

        document.getElementById('btn-simulate-speed').addEventListener('click', (e) => {
            if (!this.canvas.simulationSpeedMultiplier) this.canvas.simulationSpeedMultiplier = 1;

            if (this.canvas.simulationSpeedMultiplier < 1000) {
                this.canvas.simulationSpeedMultiplier *= 10;
                e.target.style.background = 'var(--accent-blue)';
                e.target.style.color = 'white';
                e.target.innerText = `x${this.canvas.simulationSpeedMultiplier}`;
            } else {
                this.canvas.simulationSpeedMultiplier = 1;
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

    saveProject() {
        try {
            const projectData = {
                version: '1.0',
                appName: 'RolandPlotterWeb',
                timestamp: new Date().toISOString(),
                paths: this.canvas.paths,
                penConfig: this.ui.visPenConfig,
                settings: this.settings
            };

            const json = JSON.stringify(projectData, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `plotter_project_${new Date().getTime()}.dxyweb`;
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
                    this.saveSettings();

                    // Apply immediate settings
                    if (this.canvas) {
                        this.canvas.bedWidth = this.settings.bedWidth || 432;
                        this.canvas.bedHeight = this.settings.bedHeight || 297;
                        this.canvas.resize();
                    }
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
