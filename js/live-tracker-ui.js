class LiveTrackerUI {
    constructor(app) {
        this.app = app;
        this.fingerNames = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
        this.penContainer = document.getElementById('live-tracker-pen-settings');
        this.validationEl = document.getElementById('live-tracker-validation');
        this.statusTextEl = document.getElementById('live-tracker-status-text');
        this.speedLightEl = document.getElementById('live-tracker-speed-light');
        this.speedTextEl = document.getElementById('live-tracker-speed-text');
        this.overlayHost = document.getElementById('live-tracker-overlay-host');
        this.overlayShell = document.getElementById('live-tracker-video-shell');
        this.overlayVideo = document.getElementById('live-tracker-video');
        this.overlayCanvas = document.getElementById('live-tracker-video-canvas');
        this.overlayStatus = document.getElementById('live-tracker-overlay-status');
        this.cameraNameEl = document.getElementById('live-tracker-camera-name');
        this.overlaySelected = false;
        this.bindOverlayInteractions();
    }

    getDefaultSettings() {
        return {
            enabled: false,
            mirror: true,
            videoOpacity: 60,
            videoSize: 48,
            movementSource: 'index',
            smoothing: 0.45,
            minMoveThreshold: 1.2,
            maxSpeed: 65,
            gestureHoldTime: 100,
            invalidGestureGraceMs: 140,
            outputInterval: 33,
            penChangeDelayMs: 2500,
            cameraDeviceId: '',
            penGestureEnabled: true,
            showDebug: false,
            showLabels: true,
            highlightActivePoint: true,
            gesturePresetVersion: 2,
            overlay: { left: 24, top: 24, width: 320, height: 240 },
            penAssignments: [
                ['Thumb'],
                ['Thumb', 'Index'],
                ['Thumb', 'Index', 'Middle'],
                ['Thumb', 'Index', 'Middle', 'Ring'],
                ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'],
                ['Thumb', 'Pinky'],
                ['Index', 'Pinky'],
                ['Index', 'Middle']
            ]
        };
    }

    hydrateSettings(input = {}) {
        const defaults = this.getDefaultSettings();
        const merged = { ...defaults, ...input, overlay: { ...defaults.overlay, ...(input.overlay || {}) } };
        const shouldMigratePreset = Number(input.gesturePresetVersion || 0) !== defaults.gesturePresetVersion;
        merged.penAssignments = !shouldMigratePreset && Array.isArray(input.penAssignments) && input.penAssignments.length === 8
            ? input.penAssignments.map(item => Array.isArray(item) && item.length ? item.slice(0, 5) : ['Index'])
            : defaults.penAssignments;
        merged.gesturePresetVersion = defaults.gesturePresetVersion;
        merged.outputInterval = Math.min(200, Math.max(10, Number(merged.outputInterval || defaults.outputInterval)));
        merged.maxSpeed = Math.max(5, Number(merged.maxSpeed || defaults.maxSpeed));
        merged.minMoveThreshold = Math.max(0.1, Number(merged.minMoveThreshold || defaults.minMoveThreshold));
        merged.smoothing = Math.min(0.95, Math.max(0, Number(merged.smoothing ?? defaults.smoothing)));
        merged.gestureHoldTime = Math.min(500, Math.max(100, Number(merged.gestureHoldTime || defaults.gestureHoldTime)));
        return merged;
    }

    bind(controller) {
        this.controller = controller;
        this.settings = this.hydrateSettings(this.app?.settings?.liveTracker || {});
        this.renderAssignments();
        this.applySettingsToForm();
        this.bindForm();
        this.applyOverlayLayout();
        this.applyVideoPresentation();
        this.updateValidation(this.validateAssignments(this.settings.penAssignments));
    }

    bindForm() {
        const bind = (id, eventName, assign) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener(eventName, () => {
                assign(el);
                this.commitSettings();
            });
        };

        bind('input-live-tracker-enabled', 'change', el => { this.settings.enabled = el.checked; });
        bind('input-live-tracker-mirror', 'change', el => { this.settings.mirror = el.checked; this.applyVideoPresentation(); });
        bind('input-live-tracker-show-debug', 'change', el => { this.settings.showDebug = el.checked; });
        bind('input-live-tracker-show-labels', 'change', el => { this.settings.showLabels = el.checked; });
        bind('input-live-tracker-highlight-point', 'change', el => { this.settings.highlightActivePoint = el.checked; });
        bind('input-live-tracker-pen-gesture-enable', 'change', el => { this.settings.penGestureEnabled = el.checked; });
        bind('sel-live-tracker-movement-source', 'change', el => { this.settings.movementSource = el.value; });
        bind('input-live-tracker-gesture-hold', 'input', el => { this.settings.gestureHoldTime = Number(el.value); });
        bind('input-live-tracker-smoothing', 'input', el => { this.settings.smoothing = Number(el.value); });
        bind('input-live-tracker-min-move', 'input', el => { this.settings.minMoveThreshold = Number(el.value); });
        bind('input-live-tracker-max-speed', 'input', el => { this.settings.maxSpeed = Number(el.value); });
        bind('input-live-tracker-output-interval', 'input', el => { this.settings.outputInterval = Number(el.value); });
        bind('input-live-tracker-video-opacity', 'input', el => { this.settings.videoOpacity = Number(el.value); this.applyVideoPresentation(); });
        bind('input-live-tracker-video-size', 'input', el => {
            this.settings.videoSize = Number(el.value);
            this.resizeOverlayFromSetting();
            this.applyOverlayLayout();
        });

        const cameraBtn = document.getElementById('btn-live-tracker-camera');
        if (cameraBtn) {
            cameraBtn.addEventListener('click', async () => {
                await this.controller.startCamera();
            });
        }

        const clearBtn = document.getElementById('btn-live-tracker-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.controller.clearCanvas());
        }

        const nextCameraBtn = document.getElementById('btn-live-tracker-next-camera');
        if (nextCameraBtn) {
            nextCameraBtn.addEventListener('click', async () => {
                await this.controller.cycleCameraDevice();
            });
        }
    }

    applySettingsToForm() {
        const byId = id => document.getElementById(id);
        if (byId('input-live-tracker-enabled')) byId('input-live-tracker-enabled').checked = !!this.settings.enabled;
        if (byId('input-live-tracker-mirror')) byId('input-live-tracker-mirror').checked = !!this.settings.mirror;
        if (byId('input-live-tracker-show-debug')) byId('input-live-tracker-show-debug').checked = !!this.settings.showDebug;
        if (byId('input-live-tracker-show-labels')) byId('input-live-tracker-show-labels').checked = this.settings.showLabels !== false;
        if (byId('input-live-tracker-highlight-point')) byId('input-live-tracker-highlight-point').checked = this.settings.highlightActivePoint !== false;
        if (byId('input-live-tracker-pen-gesture-enable')) byId('input-live-tracker-pen-gesture-enable').checked = this.settings.penGestureEnabled !== false;
        if (byId('sel-live-tracker-movement-source')) byId('sel-live-tracker-movement-source').value = this.settings.movementSource;
        if (byId('input-live-tracker-gesture-hold')) byId('input-live-tracker-gesture-hold').value = String(this.settings.gestureHoldTime);
        if (byId('input-live-tracker-smoothing')) byId('input-live-tracker-smoothing').value = String(this.settings.smoothing);
        if (byId('input-live-tracker-min-move')) byId('input-live-tracker-min-move').value = String(this.settings.minMoveThreshold);
        if (byId('input-live-tracker-max-speed')) byId('input-live-tracker-max-speed').value = String(this.settings.maxSpeed);
        if (byId('input-live-tracker-output-interval')) byId('input-live-tracker-output-interval').value = String(this.settings.outputInterval);
        if (byId('input-live-tracker-video-opacity')) byId('input-live-tracker-video-opacity').value = String(this.settings.videoOpacity);
        if (byId('input-live-tracker-video-size')) byId('input-live-tracker-video-size').value = String(this.settings.videoSize);
        this.setCameraLabel('Default Camera');
    }

    setCameraLabel(label = '') {
        if (!this.cameraNameEl) return;
        this.cameraNameEl.textContent = label || 'Default Camera';
    }

    renderAssignments() {
        if (!this.penContainer) return;
        this.penContainer.innerHTML = '';
        this.settings.penAssignments.forEach((assignment, penIndex) => {
            const row = document.createElement('div');
            row.className = 'live-tracker-pen-row';
            row.dataset.pen = String(penIndex + 1);

            const header = document.createElement('div');
            header.className = 'live-tracker-pen-row-header';
            header.innerHTML = `<strong>Pen ${penIndex + 1}</strong><button type="button" class="btn btn-secondary btn-live-tracker-add">Add Finger</button>`;
            row.appendChild(header);

            const fingerList = document.createElement('div');
            fingerList.className = 'live-tracker-finger-list';
            row.appendChild(fingerList);

            const pillList = document.createElement('div');
            pillList.className = 'live-tracker-pill-list';
            row.appendChild(pillList);

            const renderFingerRows = () => {
                fingerList.innerHTML = '';
                pillList.innerHTML = '';
                this.settings.penAssignments[penIndex].forEach((fingerName, fingerIndex) => {
                    const fingerRow = document.createElement('div');
                    fingerRow.className = 'live-tracker-finger-row';
                    const select = document.createElement('select');
                    this.fingerNames.forEach(name => {
                        const option = document.createElement('option');
                        option.value = name;
                        option.textContent = name;
                        if (name === fingerName) option.selected = true;
                        select.appendChild(option);
                    });
                    select.addEventListener('change', () => {
                        this.settings.penAssignments[penIndex][fingerIndex] = select.value;
                        this.commitSettings();
                        this.renderAssignments();
                    });

                    const removeBtn = document.createElement('button');
                    removeBtn.type = 'button';
                    removeBtn.className = 'btn btn-secondary';
                    removeBtn.textContent = 'Remove';
                    removeBtn.disabled = this.settings.penAssignments[penIndex].length <= 1;
                    removeBtn.addEventListener('click', () => {
                        if (this.settings.penAssignments[penIndex].length <= 1) return;
                        this.settings.penAssignments[penIndex].splice(fingerIndex, 1);
                        this.commitSettings();
                        this.renderAssignments();
                    });

                    fingerRow.appendChild(select);
                    fingerRow.appendChild(removeBtn);
                    fingerList.appendChild(fingerRow);

                    const pill = document.createElement('span');
                    pill.className = 'live-tracker-pill';
                    pill.textContent = fingerName;
                    pillList.appendChild(pill);
                });
            };

            header.querySelector('.btn-live-tracker-add').addEventListener('click', () => {
                if (this.settings.penAssignments[penIndex].length >= 5) return;
                this.settings.penAssignments[penIndex].push(this.fingerNames[0]);
                this.commitSettings();
                this.renderAssignments();
            });

            renderFingerRows();
            this.penContainer.appendChild(row);
        });
    }

    normalizeAssignment(assignment = []) {
        return Array.from(new Set(assignment.filter(name => this.fingerNames.includes(name)))).sort();
    }

    validateAssignments(assignments = this.settings.penAssignments) {
        const comboMap = new Map();
        const issues = [];
        const duplicates = new Set();

        assignments.forEach((assignment, index) => {
            const normalized = this.normalizeAssignment(assignment);
            if (normalized.length === 0) {
                issues.push(`Pen ${index + 1} must have at least one finger assigned.`);
            }
            if (normalized.length !== assignment.length) {
                issues.push(`Pen ${index + 1} contains duplicate fingers. Each finger can appear only once per pen.`);
            }
            const key = normalized.join('+');
            if (!key) return;
            if (comboMap.has(key)) {
                duplicates.add(comboMap.get(key));
                duplicates.add(index);
            } else {
                comboMap.set(key, index);
            }
        });

        if (duplicates.size > 0) {
            issues.push('Duplicate finger combinations detected. Each pen must use a unique finger setup before Live Tracker can run.');
        }

        return {
            valid: issues.length === 0,
            issues,
            duplicatePens: duplicates,
            normalizedAssignments: assignments.map(item => this.normalizeAssignment(item))
        };
    }

    updateValidation(validation) {
        const activeValidation = validation || this.validateAssignments(this.settings.penAssignments);
        const rows = Array.from(this.penContainer?.querySelectorAll('.live-tracker-pen-row') || []);
        rows.forEach((row, index) => {
            row.classList.toggle('invalid', activeValidation.duplicatePens.has(index));
        });

        if (!this.validationEl) return;
        if (activeValidation.valid) {
            this.validationEl.classList.add('hidden');
            this.validationEl.textContent = '';
            return;
        }

        this.validationEl.classList.remove('hidden');
        this.validationEl.textContent = activeValidation.issues[0];
    }

    commitSettings() {
        this.settings = this.hydrateSettings(this.settings);
        this.app.settings.liveTracker = this.settings;
        this.app.saveSettings();
        const validation = this.validateAssignments(this.settings.penAssignments);
        this.updateValidation(validation);
        if (this.controller?.handleSettingsChanged) {
            this.controller.handleSettingsChanged(this.settings, validation);
        }
    }

    setStatus(text) {
        if (this.statusTextEl) this.statusTextEl.textContent = text;
        if (this.overlayStatus) this.overlayStatus.textContent = text;
    }

    setSpeedState(light, text) {
        if (this.speedLightEl) this.speedLightEl.className = `traffic-light ${light || 'red'}`;
        if (this.speedTextEl) this.speedTextEl.textContent = text || 'No motion';
    }

    showOverlay(visible) {
        if (!this.overlayHost) return;
        this.overlayHost.classList.toggle('hidden', !visible);
        this.setOverlaySelected(false);
    }

    setOverlaySelected(selected) {
        this.overlaySelected = !!selected;
        if (this.overlayShell) {
            this.overlayShell.classList.toggle('selected', this.overlaySelected);
        }
    }

    isOverlayVisible() {
        return !!this.overlayHost && !this.overlayHost.classList.contains('hidden');
    }

    applyVideoPresentation() {
        if (!this.overlayVideo) return;
        this.overlayVideo.style.opacity = `${Math.min(100, Math.max(0, Number(this.settings.videoOpacity || 0))) / 100}`;
        this.overlayVideo.style.transform = this.settings.mirror ? 'scaleX(-1)' : 'scaleX(1)';
    }

    resizeOverlayFromSetting() {
        const container = document.querySelector('.canvas-container');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const maxWidth = Math.max(220, rect.width * (Math.min(100, Math.max(25, this.settings.videoSize)) / 100));
        this.settings.overlay.width = Math.min(maxWidth, rect.width - 20);
        this.settings.overlay.height = this.settings.overlay.width * 0.75;
    }

    applyOverlayLayout() {
        if (!this.overlayShell) return;
        const overlay = this.settings.overlay || {};
        this.overlayShell.style.left = `${overlay.left || 24}px`;
        this.overlayShell.style.top = `${overlay.top || 24}px`;
        this.overlayShell.style.width = `${overlay.width || 320}px`;
        this.overlayShell.style.height = `${overlay.height || 240}px`;
    }

    bindOverlayInteractions() {
        if (!this.overlayShell) return;
        const resizeHandles = Array.from(this.overlayShell.querySelectorAll('[data-live-tracker-resize]'));
        let dragState = null;

        document.addEventListener('keydown', (event) => {
            if (!this.overlaySelected || !this.isOverlayVisible()) return;
            if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'SELECT')) return;
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            event.preventDefault();
            this.controller?.stopCameraAndOverlay?.();
        });

        document.addEventListener('pointerdown', (event) => {
            if (!this.overlaySelected) return;
            if (this.overlayShell.contains(event.target)) return;
            this.setOverlaySelected(false);
        });

        const onMove = (event) => {
            if (!dragState) return;
            const container = document.querySelector('.canvas-container')?.getBoundingClientRect();
            if (!container) return;

            if (dragState.mode === 'move') {
                this.settings.overlay.left = Math.max(0, Math.min(container.width - this.overlayShell.offsetWidth, dragState.startLeft + (event.clientX - dragState.startX)));
                this.settings.overlay.top = Math.max(0, Math.min(container.height - this.overlayShell.offsetHeight, dragState.startTop + (event.clientY - dragState.startY)));
            } else {
                const dx = event.clientX - dragState.startX;
                const dy = event.clientY - dragState.startY;
                let nextLeft = dragState.startLeft;
                let nextTop = dragState.startTop;
                let nextWidth = dragState.startWidth;
                let nextHeight = dragState.startHeight;
                const dir = dragState.direction;

                if (dir.includes('e')) nextWidth = dragState.startWidth + dx;
                if (dir.includes('s')) nextHeight = dragState.startHeight + dy;
                if (dir.includes('w')) {
                    nextWidth = dragState.startWidth - dx;
                    nextLeft = dragState.startLeft + dx;
                }
                if (dir.includes('n')) {
                    nextHeight = dragState.startHeight - dy;
                    nextTop = dragState.startTop + dy;
                }

                if (nextWidth < 220) {
                    if (dir.includes('w')) nextLeft -= (220 - nextWidth);
                    nextWidth = 220;
                }
                if (nextHeight < 165) {
                    if (dir.includes('n')) nextTop -= (165 - nextHeight);
                    nextHeight = 165;
                }

                nextLeft = Math.max(0, Math.min(nextLeft, container.width - nextWidth));
                nextTop = Math.max(0, Math.min(nextTop, container.height - nextHeight));
                nextWidth = Math.min(nextWidth, container.width - nextLeft);
                nextHeight = Math.min(nextHeight, container.height - nextTop);

                this.settings.overlay.left = nextLeft;
                this.settings.overlay.top = nextTop;
                this.settings.overlay.width = nextWidth;
                this.settings.overlay.height = nextHeight;
            }

            this.applyOverlayLayout();
        };

        const onUp = () => {
            if (!dragState) return;
            dragState = null;
            this.commitSettings();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        this.overlayShell.addEventListener('pointerdown', (event) => {
            this.setOverlaySelected(true);
            if (event.target.closest('[data-live-tracker-resize]')) return;
            dragState = {
                mode: 'move',
                startX: event.clientX,
                startY: event.clientY,
                startLeft: this.settings.overlay.left || 24,
                startTop: this.settings.overlay.top || 24
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
        });

        resizeHandles.forEach(handle => {
            handle.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                dragState = {
                    mode: 'resize',
                    direction: handle.dataset.liveTrackerResize || 'se',
                    startX: event.clientX,
                    startY: event.clientY,
                    startLeft: this.settings.overlay.left || 24,
                    startTop: this.settings.overlay.top || 24,
                    startWidth: this.settings.overlay.width || 320,
                    startHeight: this.settings.overlay.height || 240
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
        });
    }
}
