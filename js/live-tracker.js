class LiveTrackerController {
    constructor(app) {
        this.app = app;
        this.ui = new LiveTrackerUI(app);
        this.mapper = new LiveTrackerMapper(app);
        this.hpgl = new LiveTrackerHpgl(app);
        this.vision = new LiveTrackerVision(app, {
            onUpdate: (result) => this.handleVisionUpdate(result),
            onStatus: (status) => this.ui.setStatus(status)
        });

        this.settings = this.ui.hydrateSettings(this.app?.settings?.liveTracker || {});
        this.validation = this.ui.validateAssignments(this.settings.penAssignments);
        this.cameraActive = false;
        this.outputState = 'idle';
        this.outputTimer = 0;
        this.outputTickBusy = false;
        this.latestVision = null;
        this.activePen = null;
        this.selectedPen = Number(this.app?.hpgl?.currentPen || 1);
        this.penIsDown = false;
        this.lastStreamedVisualPoint = null;
        this.gestureActionChain = Promise.resolve();
        this.lastImmediateCommandState = 'idle';
        this.confirmedGestureState = 'idle';
        this.pendingGestureState = 'idle';
        this.pendingGestureSince = 0;
        this.lastDesiredGestureState = 'idle';
        this.gestureActionInFlight = false;
        this.availableCameraDevices = [];
        this.currentCameraIndex = -1;
    }

    init() {
        this.ui.bind(this);
        this.handleSettingsChanged(this.ui.settings, this.validation);
        this.ui.setStatus('Camera idle');
        this.ui.setSpeedState('red', 'No motion');
        this.refreshCameraDevices().catch(() => { });
    }

    isModeEnabled() {
        return !!this.settings.enabled;
    }

    isActiveOrPaused() {
        return this.outputState === 'running' || this.outputState === 'paused';
    }

    async startCamera() {
        if (this.cameraActive) {
            this.ui.showOverlay(true);
            return;
        }
        try {
            await this.vision.start(this.settings.cameraDeviceId || '');
            this.cameraActive = true;
            this.ui.showOverlay(true);
            this.ui.applyVideoPresentation();
            await this.refreshCameraDevices();
            this.ui.setStatus('Camera live');
            this.app.ui.logToConsole('System: Live Tracker camera started.');
        } catch (error) {
            this.cameraActive = false;
            this.ui.setStatus('Camera failed');
            this.app.ui.logToConsole(`Error: ${error.message}`, 'error');
        }
    }

    async refreshCameraDevices() {
        try {
            const devices = await this.vision.getVideoDevices();
            this.availableCameraDevices = devices.slice();
            const currentTrack = this.vision.stream?.getVideoTracks?.()?.[0] || null;
            const currentSettings = currentTrack?.getSettings?.() || {};
            const currentDeviceId = currentSettings.deviceId || '';
            const labels = devices.map((device, index) => device.label || `Camera ${index + 1}`);
            const effectiveDeviceId = currentDeviceId || this.settings.cameraDeviceId || '';
            if (effectiveDeviceId && this.settings.cameraDeviceId !== effectiveDeviceId) {
                this.settings.cameraDeviceId = effectiveDeviceId;
                this.app.settings.liveTracker = this.settings;
                this.app.saveSettings();
            }
            const selectedDeviceId = effectiveDeviceId;
            const selectedDevice = devices.find(device => device.deviceId === selectedDeviceId) || null;
            this.currentCameraIndex = selectedDevice
                ? devices.findIndex(device => device.deviceId === selectedDevice.deviceId)
                : (devices.length ? 0 : -1);
            this.ui.setCameraLabel(selectedDevice?.label || (devices[0]?.label || 'Default Camera'));
            this.app.ui.logToConsole(`System: Cameras found (${devices.length}): ${labels.join(', ') || 'None'}.`);
        } catch (error) {
            this.app.ui.logToConsole(`System: Unable to enumerate cameras. ${error.message}`, 'error');
        }
    }

    async cycleCameraDevice() {
        await this.refreshCameraDevices();
        if (!this.availableCameraDevices.length) {
            this.app.ui.logToConsole('System: No additional cameras found.');
            return;
        }

        const nextIndex = this.currentCameraIndex >= 0
            ? ((this.currentCameraIndex + 1) % this.availableCameraDevices.length)
            : 0;
        const nextDevice = this.availableCameraDevices[nextIndex];
        if (!nextDevice) return;

        this.settings.cameraDeviceId = nextDevice.deviceId || '';
        this.app.settings.liveTracker = this.settings;
        this.app.saveSettings();
        this.currentCameraIndex = nextIndex;
        this.ui.setCameraLabel(nextDevice.label || `Camera ${nextIndex + 1}`);
        this.app.ui.logToConsole(`System: Switched Live Tracker camera to ${nextDevice.label || `Camera ${nextIndex + 1}`}.`);

        if (this.cameraActive) {
            this.stopCamera();
            await this.startCamera();
        }
    }

    stopCamera() {
        this.vision.stop();
        this.cameraActive = false;
        this.ui.showOverlay(false);
        this.ui.setStatus('Camera idle');
    }

    stopCameraAndOverlay() {
        this.handleCancel();
        this.stopCamera();
        this.app.canvas.setLiveTrackerOverlay?.(null);
        this.app.ui.logToConsole('System: Live Tracker camera overlay removed.');
    }

    clearCanvas() {
        if (this.isActiveOrPaused()) this.handleCancel();
        this.app.clearWorkspaceForLiveTracker?.();
        this.app.ui.logToConsole('System: Live Tracker canvas cleared.');
    }

    handleSettingsChanged(settings, validation) {
        this.settings = this.ui.hydrateSettings(settings || {});
        this.validation = validation || this.ui.validateAssignments(this.settings.penAssignments);
        this.ui.updateValidation(this.validation);
        this.ui.applyVideoPresentation();
        this.ui.applyOverlayLayout();
        if (this.outputState === 'running') this.scheduleNextTick();
    }

    getCurrentValidationMessage() {
        if (!this.cameraActive) return 'Live Tracker requires an active webcam. Click Start Camera first.';
        if (!this.isModeEnabled()) return 'Enable Tracker Mode before using the main Run button for Live Tracker.';
        if (!this.validation.valid) return this.validation.issues[0];
        if (!this.app.isWorkspaceEmptyForLiveTracker?.()) {
            return 'Live Tracker requires an empty canvas. Please clear all items before starting.';
        }
        return '';
    }

    async handleRunRequest() {
        const blockingMessage = this.getCurrentValidationMessage();
        if (blockingMessage) {
            this.ui.updateValidation({
                ...this.validation,
                valid: false,
                issues: [blockingMessage],
                duplicatePens: this.validation.duplicatePens || new Set(),
                normalizedAssignments: this.validation.normalizedAssignments || []
            });
            this.app.ui.logToConsole(`Error: ${blockingMessage}`, 'error');
            return false;
        }

        this.outputState = 'running';
        this.mapper.reset();
        this.outputTickBusy = false;
        this.gestureActionChain = Promise.resolve();
        this.selectedPen = Number(this.app?.hpgl?.currentPen || this.selectedPen || 1);
        this.activePen = this.selectedPen;
        this.penIsDown = false;
        this.lastStreamedVisualPoint = null;
        this.lastImmediateCommandState = 'idle';
        this.confirmedGestureState = 'idle';
        this.pendingGestureState = 'idle';
        this.pendingGestureSince = 0;
        this.lastDesiredGestureState = 'idle';
        this.gestureActionInFlight = false;
        this.app.canvas.startLiveTrackerSession?.();
        this.ui.setStatus('Tracking live');
        this.app.ui.logToConsole('System: Live Tracker output started from main Run control.');
        if (this.latestVision?.hasHand) {
            this.syncImmediateGestureState(this.latestVision);
        }
        this.scheduleNextTick(0);
        return true;
    }

    handleHold() {
        if (!this.isActiveOrPaused()) return false;
        this.outputState = 'paused';
        if (this.outputTimer) clearTimeout(this.outputTimer);
        this.outputTimer = 0;
        this.forcePenUp();
        this.app.canvas.finishLiveTrackerStroke?.();
        this.ui.setStatus('Tracking paused');
        this.app.ui.logToConsole('System: Live Tracker paused.');
        return true;
    }

    handleCancel() {
        if (!this.isActiveOrPaused()) return false;
        if (this.outputTimer) clearTimeout(this.outputTimer);
        this.outputTimer = 0;
        this.outputState = 'idle';
        this.forcePenUp();
        this.selectedPen = this.getCurrentPenNumber();
        this.activePen = null;
        this.penIsDown = false;
        this.lastStreamedVisualPoint = null;
        this.outputTickBusy = false;
        this.gestureActionChain = Promise.resolve();
        this.lastImmediateCommandState = 'idle';
        this.confirmedGestureState = 'idle';
        this.pendingGestureState = 'idle';
        this.pendingGestureSince = 0;
        this.lastDesiredGestureState = 'idle';
        this.gestureActionInFlight = false;
        this.mapper.reset();
        this.app.canvas.finishLiveTrackerStroke?.();
        this.app.canvas.setLiveTrackerOverlay?.(null);
        this.ui.setStatus(this.cameraActive ? 'Camera live' : 'Camera idle');
        this.ui.setSpeedState('red', 'Stopped');
        this.app.ui.logToConsole('System: Live Tracker cancelled.');
        return true;
    }

    scheduleNextTick(delayMs = null) {
        if (this.outputState !== 'running') return;
        if (this.outputTimer) clearTimeout(this.outputTimer);
        const interval = Math.min(200, Math.max(10, Number(delayMs ?? this.settings.outputInterval ?? 33)));
        this.outputTimer = setTimeout(async () => {
            this.outputTimer = 0;
            if (this.outputState !== 'running') return;
            if (this.outputTickBusy) {
                this.scheduleNextTick();
                return;
            }
            this.outputTickBusy = true;
            try {
                await this.outputTick();
            } catch (error) {
                this.app.ui.logToConsole(`Error: ${error.message}`, 'error');
                this.handleCancel();
                return;
            } finally {
                this.outputTickBusy = false;
            }
            this.scheduleNextTick();
        }, interval);
    }

    async forcePenUp() {
        await this.hpgl.penUp();
        this.penIsDown = false;
    }

    async forcePenDown() {
        await this.hpgl.penDown();
        this.penIsDown = true;
    }

    queueGestureAction(action) {
        this.gestureActionChain = this.gestureActionChain
            .then(async () => {
                if (this.outputState !== 'running') return;
                this.gestureActionInFlight = true;
                try {
                    await action();
                } finally {
                    this.gestureActionInFlight = false;
                }
            })
            .catch(error => {
                this.gestureActionInFlight = false;
                this.app.ui.logToConsole(`Error: ${error.message}`, 'error');
            });
        return this.gestureActionChain;
    }

    markGestureStateUp() {
        this.confirmedGestureState = 'up';
        this.pendingGestureState = 'up';
        this.lastImmediateCommandState = 'up';
        this.lastDesiredGestureState = 'up';
        this.pendingGestureSince = performance.now();
    }

    getMappingSettings() {
        const overlay = this.settings?.overlay || {};
        const overlayWidth = Number(overlay.width) || 320;
        const overlayHeight = Number(overlay.height) || 240;
        return {
            ...this.settings,
            trackingBounds: {
                left: Number(overlay.left) || 0,
                top: Number(overlay.top) || 0,
                width: overlayWidth,
                height: overlayHeight
            }
        };
    }

    mapCurrentLatestPoint() {
        if (!this.latestVision?.normalizedPoint) return null;
        return this.mapper.mapLatest(this.latestVision.normalizedPoint, this.getMappingSettings(), performance.now());
    }

    getCurrentPenNumber() {
        return Number(this.selectedPen || this.activePen || this.app?.hpgl?.currentPen || 1);
    }

    async changeToPenNow(targetPen) {
        if (targetPen == null || !this.settings.penGestureEnabled) return;
        await this.forcePenUp();
        await this.hpgl.selectPen(targetPen);
        this.app.ui.logToConsole(`System: Live Tracker changing to Pen ${targetPen}.`);
        this.selectedPen = targetPen;
        this.activePen = targetPen;
        this.app.hpgl.setCurrentPen?.(targetPen);
        this.app.canvas.finishLiveTrackerStroke?.();
    }

    updateGestureState(result) {
        const extendedFingers = result?.fingerStates?.extendedFingers || [];
        const fingerStates = result?.fingerStates?.states || {};
        const isFist = result?.fingerStates?.closedFist === true;
        const backOfHand = result?.handPresentation?.backOfHand === true;
        const gestureKey = extendedFingers.slice().sort().join('+');

        if (backOfHand) {
            const matchIndex = this.validation.normalizedAssignments.findIndex(item => item.slice().sort().join('+') === gestureKey);
            if (matchIndex === -1) {
                return { mode: 'select', targetPen: null, label: 'Back of Hand', stable: false };
            }
            return { mode: 'select', targetPen: matchIndex + 1, label: `Select Pen ${matchIndex + 1}`, stable: true };
        }

        if (isFist) {
            return { mode: 'move', targetPen: null, label: 'Closed Fist', stable: true };
        }

        if (fingerStates.Index === true) {
            const drawPen = this.getCurrentPenNumber();
            return { mode: 'draw', targetPen: drawPen, label: `Draw Pen ${drawPen}`, stable: true };
        }

        return { mode: 'move', targetPen: null, label: 'Move / Pen Up', stable: false };
    }

    syncImmediateGestureState(result) {
        if (this.outputState !== 'running') return;
        const gesture = result?.gesture || null;
        if (!gesture) return;

        let desiredState = 'up';
        if (result?.hasHand && result?.confidence && gesture.stable) {
            if (gesture.mode === 'select' && gesture.targetPen != null) {
                desiredState = `select:${gesture.targetPen}`;
            } else if (gesture.mode === 'draw') {
                desiredState = `draw:${this.getCurrentPenNumber()}`;
            }
        }

        const now = performance.now();
        const holdMs = Math.max(100, Number(this.settings.gestureHoldTime || 100));
        if (desiredState !== this.pendingGestureState) {
            this.pendingGestureState = desiredState;
            this.pendingGestureSince = now;
        }
        if (desiredState !== this.lastDesiredGestureState) {
            this.lastDesiredGestureState = desiredState;
        }

        result.pendingActionLabel = desiredState === 'up'
            ? 'Pen Up'
            : (desiredState.startsWith('select:')
                ? `Select Pen ${desiredState.split(':')[1]}`
                : `Draw Pen ${desiredState.split(':')[1]}`);
        result.confirmedActionLabel = this.confirmedGestureState === 'idle'
            ? 'None'
            : (this.confirmedGestureState === 'up'
                ? 'Pen Up'
                : (this.confirmedGestureState.startsWith('select:')
                    ? `Select Pen ${this.confirmedGestureState.split(':')[1]}`
                    : `Draw Pen ${this.confirmedGestureState.split(':')[1]}`));

        if ((now - this.pendingGestureSince) < holdMs) return;
        if (desiredState === this.confirmedGestureState) return;
        if (desiredState === this.lastImmediateCommandState) return;

        this.confirmedGestureState = desiredState;
        this.lastImmediateCommandState = desiredState;
        this.app.canvas.finishLiveTrackerStroke?.();

        if (desiredState === 'up') {
            this.queueGestureAction(async () => {
                await this.forcePenUp();
                this.app.canvas.finishLiveTrackerStroke?.();
                this.app.ui.logToConsole('System: Live Tracker pen up.');
            });
            return;
        }

        this.queueGestureAction(async () => {
            if (desiredState.startsWith('select:')) {
                const targetPen = Number(desiredState.split(':')[1]);
                await this.changeToPenNow(targetPen);
                return;
            }

            const targetPen = Number(desiredState.split(':')[1] || this.getCurrentPenNumber());
            if (this.activePen !== targetPen) {
                await this.changeToPenNow(targetPen);
            }
            if (!this.penIsDown || this.confirmedGestureState.startsWith('draw:')) {
                await this.forcePenDown();
                this.app.ui.logToConsole(`System: Live Tracker pen down on Pen ${targetPen}.`);
            }
        });
    }

    handleVisionUpdate(result) {
        this.latestVision = result;
        if (!result?.hasHand) {
            this.app.canvas.setLiveTrackerOverlay?.({
                tracking: false,
                label: 'No hand detected'
            });
            this.ui.setStatus(this.cameraActive ? 'No hand detected' : 'Camera idle');
            this.ui.setSpeedState('red', 'Tracking lost');
            if (this.isActiveOrPaused()) {
                this.markGestureStateUp();
                this.forcePenUp();
                this.app.canvas.finishLiveTrackerStroke?.();
            }
            this.vision.drawOverlay({ landmarks: null }, this.getVisionOverlaySettings());
            return;
        }

        const sourcePoint = result.landmarks[8];
        const extendedFingers = result.fingerStates?.extendedFingers || [];
        const gesture = this.updateGestureState(result);
        const normalizedPoint = this.vision.normalizePoint(sourcePoint, this.settings.mirror);
        const detectedFingerLabel = result.fingerStates?.closedFist
            ? 'Closed Fist'
            : (extendedFingers.length ? extendedFingers.join(' + ') : 'None');

        result.normalizedPoint = normalizedPoint;
        result.detectedFingerLabel = detectedFingerLabel;
        result.gestureLabel = `${result.handPresentation?.label || 'Hand'}: ${gesture.label}`;
        result.activePenLabel = gesture.mode === 'select'
            ? (gesture.targetPen ? `Select Pen ${gesture.targetPen}` : 'Pen Select Mode')
            : (gesture.mode === 'draw' ? `Draw Pen ${this.getCurrentPenNumber()}` : 'Pen Up / Move');
        result.gesture = gesture;

        this.app.canvas.setLiveTrackerOverlay?.({
            tracking: true,
            label: gesture.label,
            activePen: gesture.targetPen
        });
        this.ui.setStatus(this.outputState === 'running' ? 'Tracking live' : (this.outputState === 'paused' ? 'Tracking paused' : 'Camera ready'));
        this.vision.drawOverlay(result, this.getVisionOverlaySettings());
        this.syncImmediateGestureState(result);
    }

    getVisionOverlaySettings() {
        return {
            mirror: this.settings.mirror,
            showDebug: this.settings.showDebug,
            showLabels: this.settings.showLabels,
            highlightActive: this.settings.highlightActivePoint,
            movementSource: 'index'
        };
    }

    async outputTick() {
        if (this.outputState !== 'running' || !this.latestVision?.hasHand) return;
        if (this.gestureActionInFlight) return;
        const now = performance.now();
        const mapped = this.mapper.mapLatest(this.latestVision.normalizedPoint, this.getMappingSettings(), now);
        if (!mapped) return;

        const gesture = this.latestVision.gesture || { mode: 'move', targetPen: null, label: 'Move / Pen Up', stable: false };
        this.ui.setSpeedState(mapped.light, `${mapped.speed.toFixed(1)} mm/s`);
        this.app.canvas.setLiveTrackerOverlay?.({
            tracking: true,
            targetPoint: mapped.visualPoint,
            label: gesture.label,
            activePen: this.activePen
        });

        if (!mapped.thresholdMet && this.lastStreamedVisualPoint) return;

        const shouldDraw = this.penIsDown && this.confirmedGestureState.startsWith('draw:');
        await this.hpgl.moveTo(mapped.machinePoint, shouldDraw);

        if (shouldDraw) {
            this.app.canvas.appendLiveTrackerPoint?.(mapped.visualPoint, this.activePen || 1);
        } else {
            this.app.canvas.finishLiveTrackerStroke?.();
        }

        this.lastStreamedVisualPoint = { ...mapped.visualPoint };
        this.mapper.commitOutput(mapped, now);
    }
}
