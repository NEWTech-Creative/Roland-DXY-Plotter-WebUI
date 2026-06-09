class SerialManager {
    constructor(app) {
        this.app = app;
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.readLoopPromise = null;
        this.isConnected = false;
        this.isDisconnecting = false;
        this.rxLineBuffer = '';
        this.softwareFlowPaused = false;
        this.resumeWaiters = [];
        this.hardwareFlowPaused = false;
        this.hardwareFlowSupported = false;
        this.lastSignals = null;
        this.hardwareFlowPollMs = 25;
        this.ctsPriorityByteWindow = 1024;
        this.ctsRecoveryByteWindow = 256;
        this.ctsRecoveryRampMs = 3000;
        this.ctsReadyCooldownMs = 500;
        this.ctsPriorityDrainMs = 40;
        this.bytesSincePriorityCtsPoll = 0;
        this.ctsRecoveryMode = false;
        this.ctsLastHoldAt = 0;
        this.ctsLastReadyAt = 0;
        this.noCtsPacingByteWindow = 256;
        this.noCtsPacingDrainMs = 120;
        this.noCtsMinCommandGapMs = 12;
        this.communicationWriteTimeoutMs = 0;
        this.ctsAutoFallbackTriggered = false;
        this.ctsBlindMoveAcknowledged = false;
        this.noCtsBytesSinceDrain = 0;
        this.noCtsLastWriteAt = 0;
        this.estimatedPosition = { x: 0, y: 0 };
        this.estimatedAbsoluteMode = true;

        this.queue = [];
        this.isStreaming = false;
        this.isHold = false;
        this.runPromise = null;
        this.abortRequested = false;
        this.previewMotionQueue = [];
        this.previewMotionCurrent = null;
        this.previewMotionFrame = null;
        this.previewMotionLastTimestamp = 0;
        this.previewMotionMinSpeed = 12;
        this.previewMotionMaxSpeed = 90;
        this.previewMotionTargetLagSeconds = 1.4;
        this.predictionBlocks = [];
        this.predictionCurrentBlock = null;
        this.predictionCarryoverMs = 0;
        this.predictionReferencePoint = null;
        this.streamBlockTimingSamples = [];
        this.blockTimingAverageMs = 220;
        this.blockTimingAverageDistance = 12;
        this.blockTimingPauseStartedAt = 0;
        this.streamBlocksQueued = 0;
        this.streamingPerfModeActive = false;
        this.streamPreviewEnabled = true;

        this.indicatorEls = Array.from(document.querySelectorAll('[data-stream-indicator]'));
        this.linesStatEls = Array.from(document.querySelectorAll('[data-stat="lines"]'));
        this.queueStatEls = Array.from(document.querySelectorAll('[data-stat="queue"]'));
        this.positionXEls = Array.from(document.querySelectorAll('[data-stat="pos-x"]'));
        this.positionYEls = Array.from(document.querySelectorAll('[data-stat="pos-y"]'));
        this.debugStatEls = Array.from(document.querySelectorAll('[data-debug-stat]'));
        this.debugPanelEl = document.getElementById('serial-debug-panel');
        this.debugLogEl = document.getElementById('serial-debug-log');
        this.serialDebugStats = this.createEmptySerialDebugStats();
        this.serialDebugHistory = [];
        this.debugRepeatActive = false;
        this.debugRepeatStopRequested = false;
        this.debugRepeatPromise = null;
        this.debugStressActive = false;
        this.debugStressStopRequested = false;
        this.debugStressPromise = null;

        this._bindControls();
        this.updatePredictedPositionReadout();
        this.updateSerialDebugStats();
        this.applySerialDebugVisibility();
    }

    isTestMode() {
        return this.app?.settings?.model === 'test';
    }

    getSerialPortFilters() {
        // Focus the Web Serial chooser on the most common USB-to-serial bridges
        // used with plotters instead of showing unrelated serial endpoints.
        return [
            { usbVendorId: 0x1A86 }, // QinHeng / WCH (CH340/CH341)
            { usbVendorId: 0x0403 }, // FTDI
            { usbVendorId: 0x067B }, // Prolific
            { usbVendorId: 0x10C4 }, // Silicon Labs
            { usbVendorId: 0x2341 }, // Arduino
            { usbVendorId: 0x2A03 }, // Arduino SA
            { usbVendorId: 0x0483 }  // STMicroelectronics
        ];
    }

    async connect() {
        if (this.isTestMode()) {
            this.port = null;
            this.reader = null;
            this.readLoopPromise = null;
            this.writer = {
                write: async () => { },
                releaseLock: () => { }
            };
            this.isConnected = true;
            this.softwareFlowPaused = false;
            this.hardwareFlowPaused = false;
            this.hardwareFlowSupported = false;
            this.lastSignals = null;
            this.bytesSincePriorityCtsPoll = 0;
            this.ctsRecoveryMode = false;
            this.ctsLastHoldAt = 0;
            this.ctsLastReadyAt = 0;
            this.noCtsBytesSinceDrain = 0;
            this.noCtsLastWriteAt = 0;
            this.ctsBlindMoveAcknowledged = false;
            this.rxLineBuffer = '';
            this.estimatedPosition = { x: 0, y: 0 };
            this.estimatedAbsoluteMode = true;
            this.clearPreviewMotion(false);
            this.resetStreamPrediction(false);
            this.app.updateConnectionState(true);
            this.app.ui.logToConsole('Connected to Test / Null Plotter. Commands will not be sent to hardware.');
            this.setTrafficLight('green');
            await this.sendManualCommand('IN;', { preview: false, updateEstimatedFromCommand: true });
            return;
        }

        if (!('serial' in navigator)) {
            this.app.ui.logToConsole('Web Serial API not supported in this browser.', 'error');
            return;
        }

        try {
            const baudRateStr = document.getElementById('sel-baud').value;
            const baudRate = parseInt(baudRateStr, 10) || 9600;
            const portFilters = this.getSerialPortFilters();
            this.port = await navigator.serial.requestPort({
                filters: portFilters
            });

            const handshake = this.app.settings.handshake || 'normal';
            const ctsPriorityEnabled = this.app.settings.ctsPriorityEnabled !== false;
            const useHardwareFlowControl = handshake === 'normal' && ctsPriorityEnabled;
            // DXY-1200 DB25 notes from the manual:
            // pin 2 TXD -> host RX, pin 3 RXD <- host TX, pin 7 SG -> host GND.
            // CTS is DXY pin 5 input; if unconnected, the plotter treats CTS as ON.
            // Host adapters without DXY RTS/DTR wired to host CTS should disable CTS priority.
            await this.port.open({
                baudRate: baudRate,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                flowControl: useHardwareFlowControl ? 'hardware' : 'none'
            });

            // If using Y-drop / manual mode, many plotters require DTR/RTS to be asserted manually to begin listening
            if (handshake === 'ydrop') {
                try {
                    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
                    this.app.ui.logToConsole('System: Asserted DTR/RTS for Y-Drop handshake mode.', 'info');
                } catch (e) {
                    this.app.ui.logToConsole('System Warning: Failed to set DTR/RTS signals manually. ' + e.message, 'warning');
                }
            }

            if (useHardwareFlowControl) {
                await this._primeHardwareFlowControl();
            } else if (handshake === 'normal') {
                this.hardwareFlowSupported = false;
                this.hardwareFlowPaused = false;
                this.app.ui.logToConsole(`System: CTS priority disabled. Using no-CTS paced streaming (${this.getNoCtsPacingByteWindow()}B window, ${this.getNoCtsPacingDrainMs()}ms drain).`, 'info');
            }

            this.isConnected = true;
            this.softwareFlowPaused = false;
            this.rxLineBuffer = '';
            this.bytesSincePriorityCtsPoll = 0;
            this.ctsRecoveryMode = false;
            this.ctsLastHoldAt = 0;
            this.ctsLastReadyAt = 0;
            this.noCtsBytesSinceDrain = 0;
            this.noCtsLastWriteAt = 0;
            this.ctsAutoFallbackTriggered = false;
            this.ctsBlindMoveAcknowledged = false;
            this.estimatedPosition = { x: 0, y: 0 };
            this.estimatedAbsoluteMode = true;
            this.clearPreviewMotion(false);
            this.resetStreamPrediction(false);
            this.app.updateConnectionState(true);
            this.app.ui.logToConsole(`Connected at ${baudRate} baud`);
            this.setTrafficLight('green');

            // Set up streams
            this.readLoopPromise = this._startReading();
            this.writer = this.port.writable.getWriter();

            // Initialize machine. preview:false prevents a delayed IN; (e.g. held by CTS) from snapping the crosshair to 0,0 after the user has already moved.
            await this.sendManualCommand('IN;', { preview: false });

        } catch (err) {
            this.app.ui.logToConsole(`Error: ${err.message}`, 'error');
        }
    }

    async disconnect() {
        if (this.isDisconnecting) return;
        this.isDisconnecting = true;
        this.isConnected = false;
        this.isStreaming = false;
        this.isHold = false;
        this.stopSerialDebugRepeat();
        this.stopSerialDebugStress();
        this.queue = [];
        this.updateStats();

        try {
            if (this.isTestMode()) {
                this.app.ui.logToConsole('Disconnected from Test / Null Plotter.');
                return;
            }

            if (this.reader) {
                await this.reader.cancel();
            }

            if (this.readLoopPromise) {
                await this.readLoopPromise.catch(() => {
                    // Expected when the reader is cancelled during disconnect.
                });
                this.readLoopPromise = null;
            }

            if (this.writer) {
                this.writer.releaseLock();
                this.writer = null;
            }

            if (this.port) {
                await this.port.close();
                this.port = null;
            }

            this.app.ui.logToConsole('Disconnected.');
        } catch (err) {
            this.app.ui.logToConsole(`Disconnect warning: ${err.message}`, 'error');
        } finally {
            this.reader = null;
            this.writer = null;
            this.readLoopPromise = null;
            this.port = null;
            this.rxLineBuffer = '';
            this.softwareFlowPaused = false;
            this.hardwareFlowPaused = false;
            this.hardwareFlowSupported = false;
            this.lastSignals = null;
            this.bytesSincePriorityCtsPoll = 0;
            this.ctsRecoveryMode = false;
            this.ctsLastHoldAt = 0;
            this.ctsLastReadyAt = 0;
            this.noCtsBytesSinceDrain = 0;
            this.noCtsLastWriteAt = 0;
            this.ctsAutoFallbackTriggered = false;
            this.ctsBlindMoveAcknowledged = false;
            this.estimatedPosition = { x: 0, y: 0 };
            this.estimatedAbsoluteMode = true;
            this.clearPreviewMotion(false);
            this.resetStreamPrediction(false);
            this._flushResumeWaiters();
            this.app.updateConnectionState(false);
            this.setTrafficLight('red');
            this.isDisconnecting = false;
        }
    }

    async _startReading() {
        const textDecoder = new TextDecoder();
        this.reader = this.port.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    this._handleIncomingChunk(value, textDecoder);
                }
            }
        } catch (error) {
            // Read error
        } finally {
            this._flushRxLineBuffer();
            if (this.reader) {
                this.reader.releaseLock();
            }
        }
    }

    _handleIncomingChunk(value, textDecoder) {
        let printableBytes = [];

        for (const byte of value) {
            if (byte === 0x11) {
                this._flushPrintableBytes(printableBytes, textDecoder);
                this.softwareFlowPaused = false;
                this.handleSoftwareFlowResume();
                this._flushResumeWaiters();
                this.recordSerialDebugFlowSignal('XON');
                this.app.ui.logToConsole('RX: <XON>', 'info');
                continue;
            }

            if (byte === 0x13) {
                this._flushPrintableBytes(printableBytes, textDecoder);
                this.softwareFlowPaused = true;
                this.handleSoftwareFlowPause();
                this.recordSerialDebugFlowSignal('XOFF');
                this.app.ui.logToConsole('RX: <XOFF>', 'info');
                continue;
            }

            printableBytes.push(byte);
        }

        this._flushPrintableBytes(printableBytes, textDecoder);
    }

    _flushPrintableBytes(bytes, textDecoder) {
        if (!bytes || bytes.length === 0) return;

        const decoded = textDecoder.decode(new Uint8Array(bytes), { stream: true });
        if (!decoded) return;

        const normalized = decoded.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const parts = normalized.split('\n');
        this.rxLineBuffer += parts.shift() || '';

        while (parts.length > 0) {
            const nextLine = this.rxLineBuffer + parts.shift();
            const trimmedLine = nextLine.trim();
            if (trimmedLine) {
                this.app.ui.logToConsole(`RX: ${trimmedLine}`);
            }
            this.rxLineBuffer = '';
        }
    }

    _flushRxLineBuffer() {
        const trimmedLine = this.rxLineBuffer.trim();
        if (trimmedLine) {
            this.app.ui.logToConsole(`RX: ${trimmedLine}`);
        }
        this.rxLineBuffer = '';
    }

    _flushResumeWaiters() {
        while (this.resumeWaiters.length > 0) {
            const resolve = this.resumeWaiters.shift();
            resolve();
        }
    }

    waitForSoftwareFlowResume() {
        if (!this.softwareFlowPaused) return Promise.resolve();
        return new Promise(resolve => {
            this.resumeWaiters.push(resolve);
        });
    }

    isHardwareHandshakeEnabled() {
        return (this.app?.settings?.handshake || 'normal') === 'normal'
            && this.app?.settings?.ctsPriorityEnabled !== false
            && !this.isTestMode();
    }

    async _readSignals() {
        if (!this.port || typeof this.port.getSignals !== 'function') return null;
        try {
            const signals = await this.port.getSignals();
            this.lastSignals = signals;
            return signals;
        } catch (error) {
            if (this.hardwareFlowSupported) {
                this.app.ui.logToConsole(`System Warning: Unable to read serial modem signals. ${error.message}`, 'warning');
            }
            this.hardwareFlowSupported = false;
            this.lastSignals = null;
            return null;
        }
    }

    async _primeHardwareFlowControl() {
        const signals = await this._readSignals();
        if (!signals || typeof signals.clearToSend !== 'boolean') {
            this.hardwareFlowSupported = false;
            this.hardwareFlowPaused = false;
            this.app.ui.logToConsole('System: CTS status not exposed by this serial driver/browser. Falling back to paced writes only.', 'warning');
            return;
        }

        this.hardwareFlowSupported = true;
        this.hardwareFlowPaused = signals.clearToSend === false;
        this.app.ui.logToConsole(
            `System: Hardware flow control active. CTS is ${signals.clearToSend ? 'ready' : 'holding'}.`,
            'info'
        );
    }

    async waitForTransmitReady() {
        while (this.isConnected && !this.isHold) {
            if (this.softwareFlowPaused) {
                this.setTrafficLight('orange');
                await this.waitForSoftwareFlowResume();
                continue;
            }

            if (!this.isHardwareHandshakeEnabled()) {
                return true;
            }

            if (!this.hardwareFlowSupported) {
                return true;
            }

            const signals = await this._readSignals();
            if (!signals || typeof signals.clearToSend !== 'boolean') {
                return true;
            }

            const isReady = signals.clearToSend !== false;
            if (isReady) {
                if (this.hardwareFlowPaused) {
                    this.recordSerialDebugCtsSignal(true);
                    this.app.ui.logToConsole('System: CTS asserted. Resuming transmission.', 'info');
                }
                this.hardwareFlowPaused = false;
                return true;
            }

            if (!this.hardwareFlowPaused) {
                this.recordSerialDebugCtsSignal(false);
                this.hardwareFlowPaused = true;
                this.app.ui.logToConsole('System: CTS deasserted. Pausing transmission until plotter is ready.', 'warning');
            }
            this.setTrafficLight('orange');
            await new Promise(resolve => setTimeout(resolve, this.hardwareFlowPollMs));
        }

        return false;
    }

    getActiveCtsPriorityWindow() {
        if (!this.ctsRecoveryMode) return this.ctsPriorityByteWindow;

        if (!this.ctsLastReadyAt) {
            return this.ctsRecoveryByteWindow;
        }

        const elapsedSinceReady = performance.now() - this.ctsLastReadyAt;
        if (elapsedSinceReady >= this.ctsRecoveryRampMs) {
            this.ctsRecoveryMode = false;
            this.appendSerialDebugLog(
                `${this.getSerialDebugTimestamp()} CTS recovery ramp complete; normal ${this.ctsPriorityByteWindow}B window restored.`,
                'flow'
            );
            return this.ctsPriorityByteWindow;
        }

        return this.ctsRecoveryByteWindow;
    }

    async waitForCtsRecoveryCooldown() {
        if (!this.ctsRecoveryMode || !this.ctsLastReadyAt) return;
        const elapsedSinceReady = performance.now() - this.ctsLastReadyAt;
        const remainingMs = this.ctsReadyCooldownMs - elapsedSinceReady;
        if (remainingMs <= 0) return;

        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} CTS recovery cooldown ${Math.ceil(remainingMs)}ms.`,
            'flow'
        );
        await new Promise(resolve => setTimeout(resolve, remainingMs));
    }

    async waitForCtsPriorityWindow(nextByteLength = 0) {
        if (!this.isHardwareHandshakeEnabled() || !this.hardwareFlowSupported) return true;

        await this.waitForCtsRecoveryCooldown();
        const activeWindow = this.getActiveCtsPriorityWindow();
        const projectedBytes = this.bytesSincePriorityCtsPoll + Math.max(0, Number(nextByteLength) || 0);
        if (projectedBytes < activeWindow) return true;

        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} CTS priority poll after ${this.bytesSincePriorityCtsPoll}B window=${activeWindow}B, next=${nextByteLength}B.`,
            'flow'
        );

        await new Promise(resolve => setTimeout(resolve, this.ctsPriorityDrainMs));
        const ready = await this.waitForTransmitReady();
        if (ready) {
            this.bytesSincePriorityCtsPoll = 0;
        }
        return ready;
    }

    shouldUseNoCtsPacing() {
        if (this.isTestMode()) return false;
        return !this.isHardwareHandshakeEnabled() || !this.hardwareFlowSupported;
    }

    getNoCtsPacingByteWindow() {
        const configured = parseInt(this.app?.settings?.noCtsPacingByteWindow, 10);
        const fallback = Number.isFinite(this.noCtsPacingByteWindow) ? this.noCtsPacingByteWindow : 256;
        return Math.max(1, Math.min(4096, Number.isFinite(configured) ? configured : fallback));
    }

    getNoCtsPacingDrainMs() {
        const configured = parseInt(this.app?.settings?.noCtsPacingDrainMs, 10);
        const fallback = Number.isFinite(this.noCtsPacingDrainMs) ? this.noCtsPacingDrainMs : 120;
        return Math.max(0, Math.min(5000, Number.isFinite(configured) ? configured : fallback));
    }

    getNoCtsMinCommandGapMs() {
        const configured = parseInt(this.app?.settings?.noCtsMinCommandGapMs, 10);
        const fallback = Number.isFinite(this.noCtsMinCommandGapMs) ? this.noCtsMinCommandGapMs : 12;
        return Math.max(0, Math.min(1000, Number.isFinite(configured) ? configured : fallback));
    }

    async waitForNoCtsPacing(nextByteLength = 0) {
        if (!this.shouldUseNoCtsPacing()) return true;

        const now = performance.now();
        const elapsedSinceWrite = now - (this.noCtsLastWriteAt || 0);
        const minCommandGapMs = this.getNoCtsMinCommandGapMs();
        if (this.noCtsLastWriteAt && elapsedSinceWrite < minCommandGapMs) {
            await new Promise(resolve => setTimeout(resolve, minCommandGapMs - elapsedSinceWrite));
        }

        const pacingByteWindow = this.getNoCtsPacingByteWindow();
        const pacingDrainMs = this.getNoCtsPacingDrainMs();
        const projectedBytes = this.noCtsBytesSinceDrain + Math.max(0, Number(nextByteLength) || 0);
        if (projectedBytes < pacingByteWindow) return true;

        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} No-CTS pacing drain after ${this.noCtsBytesSinceDrain}B window=${pacingByteWindow}B, next=${nextByteLength}B.`,
            'flow'
        );
        await new Promise(resolve => setTimeout(resolve, pacingDrainMs));
        this.noCtsBytesSinceDrain = 0;
        return true;
    }

    getEstimatedPosition() {
        return { ...this.estimatedPosition };
    }

    setEstimatedPosition(xMM, yMM) {
        const bedWidth = this.app?.settings?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || 297;
        this.estimatedPosition = {
            x: Math.max(0, Math.min(bedWidth, xMM)),
            y: Math.max(0, Math.min(bedHeight, yMM))
        };
        this.updatePredictedPositionReadout();
        if (!this.streamingPerfModeActive && this.app?.canvas) {
            this.app.canvas.draw();
        }
    }

    isStreamPerformanceModeEnabled() {
        return this.app?.settings?.streamPerformanceMode !== false;
    }

    enterStreamPerformanceMode() {
        if (!this.isStreamPerformanceModeEnabled() || this.streamingPerfModeActive) return;
        this.streamingPerfModeActive = true;
        this.streamPreviewEnabled = false;
        this.clearPreviewMotion(false);
        this.resetStreamPrediction(false);
        this.app?.canvas?.suspendBackgroundProcessors?.('stream');
        this.app?.ui?.logToConsole('System: Performance mode enabled for streaming.', 'info');
    }

    exitStreamPerformanceMode() {
        if (!this.streamingPerfModeActive) return;
        this.streamingPerfModeActive = false;
        this.streamPreviewEnabled = true;
        this.app?.canvas?.resumeBackgroundProcessors?.('stream');
        this.app?.canvas?.draw?.();
        this.app?.ui?.logToConsole('System: Performance mode restored after streaming.', 'info');
    }

    updatePredictedPositionReadout() {
        this.positionXEls.forEach(el => { el.textContent = this.estimatedPosition.x.toFixed(1); });
        this.positionYEls.forEach(el => { el.textContent = this.estimatedPosition.y.toFixed(1); });
    }

    _parseHpglNumbers(raw = '') {
        return raw
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(value => parseFloat(value))
            .filter(value => Number.isFinite(value));
    }

    clearPreviewMotion(resetPosition = false) {
        this.previewMotionQueue = [];
        this.previewMotionCurrent = null;
        this.previewMotionLastTimestamp = 0;
        if (this.previewMotionFrame) {
            cancelAnimationFrame(this.previewMotionFrame);
            this.previewMotionFrame = null;
        }
        if (resetPosition) {
            this.setEstimatedPosition(0, 0);
        }
    }

    resetStreamPrediction(resetPosition = false) {
        this.predictionBlocks = [];
        this.predictionCurrentBlock = null;
        this.predictionCarryoverMs = 0;
        this.predictionReferencePoint = null;
        this.streamBlockTimingSamples = [];
        this.blockTimingPauseStartedAt = 0;
        this.streamBlocksQueued = 0;
        if (resetPosition) {
            this.setEstimatedPosition(0, 0);
        }
    }

    handleSoftwareFlowPause() {
        if (!this.isStreaming || this.blockTimingPauseStartedAt) return;
        this.blockTimingPauseStartedAt = performance.now();
    }

    handleSoftwareFlowResume() {
        if (!this.isStreaming || !this.blockTimingPauseStartedAt) return;
        const elapsed = Math.max(1, performance.now() - this.blockTimingPauseStartedAt);
        this.blockTimingPauseStartedAt = 0;
        const sample = this.streamBlockTimingSamples.length > 0 ? this.streamBlockTimingSamples.shift() : null;
        this.blockTimingAverageMs = (this.blockTimingAverageMs * 0.7) + (elapsed * 0.3);
        if (sample && Number.isFinite(sample.distance) && sample.distance > 0) {
            this.blockTimingAverageDistance = (this.blockTimingAverageDistance * 0.7) + (sample.distance * 0.3);
        }
        this.predictionCarryoverMs = Math.max(
            20,
            Math.min(
                this.blockTimingAverageMs * 0.85,
                (elapsed * 0.45) + (this.blockTimingAverageMs * 0.15)
            )
        );
    }

    getPreviewMotionReferencePoint() {
        if (this.previewMotionQueue.length > 0) {
            const tail = this.previewMotionQueue[this.previewMotionQueue.length - 1];
            return { x: tail.x2, y: tail.y2 };
        }
        if (this.previewMotionCurrent) {
            const segment = this.previewMotionCurrent;
            const t = segment.length > 0 ? segment.progress / segment.length : 1;
            return {
                x: segment.x1 + ((segment.x2 - segment.x1) * t),
                y: segment.y1 + ((segment.y2 - segment.y1) * t)
            };
        }
        return this.getEstimatedPosition();
    }

    queuePreviewSegment(x1, y1, x2, y2) {
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (!Number.isFinite(length) || length <= 0) return;
        this.previewMotionQueue.push({ x1, y1, x2, y2, length, progress: 0 });
    }

    _buildMotionSegmentsFromCommand(command, startPoint = null, absoluteModeOverride = null) {
        const trimmed = (command || '').trim();
        if (!trimmed) return { segments: [], startPoint, endPoint: startPoint, absoluteMode: absoluteModeOverride ?? this.estimatedAbsoluteMode };

        const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
        const opcode = normalized.slice(0, 2).toUpperCase();
        const args = normalized.slice(2);
        const numbers = this._parseHpglNumbers(args);
        let absoluteMode = absoluteModeOverride ?? this.estimatedAbsoluteMode;
        let current = startPoint ? { ...startPoint } : this.getEstimatedPosition();
        const segments = [];

        const pushSegment = (next) => {
            if (!next) return;
            const length = Math.hypot(next.x - current.x, next.y - current.y);
            if (Number.isFinite(length) && length > 0.0001) {
                segments.push({ x1: current.x, y1: current.y, x2: next.x, y2: next.y, length });
            }
            current = { ...next };
        };

        if (opcode === 'IN') {
            return {
                segments: [],
                startPoint: startPoint ? { ...startPoint } : this.getEstimatedPosition(),
                endPoint: { x: 0, y: 0 },
                absoluteMode: true
            };
        }

        if (opcode === 'PA') {
            absoluteMode = true;
        } else if (opcode === 'PR') {
            absoluteMode = false;
        }

        if (opcode === 'PU' || opcode === 'PD' || opcode === 'PA' || opcode === 'PR') {
            for (let i = 0; i < numbers.length - 1; i += 2) {
                const next = (opcode === 'PR' || ((opcode === 'PU' || opcode === 'PD') && absoluteMode === false))
                    ? { x: current.x + (numbers[i] / 40), y: current.y + (numbers[i + 1] / 40) }
                    : { x: numbers[i] / 40, y: numbers[i + 1] / 40 };
                pushSegment(next);
            }
            return { segments, startPoint: startPoint ? { ...startPoint } : this.getEstimatedPosition(), endPoint: current, absoluteMode };
        }

        if ((opcode === 'EA' || opcode === 'ER') && numbers.length >= 2) {
            const target = (opcode === 'ER' && absoluteMode === false)
                ? { x: current.x + (numbers[0] / 40), y: current.y + (numbers[1] / 40) }
                : { x: numbers[0] / 40, y: numbers[1] / 40 };
            pushSegment({ x: target.x, y: current.y });
            pushSegment({ x: target.x, y: target.y });
            pushSegment({ x: startPoint ? startPoint.x : this.getEstimatedPosition().x, y: target.y });
            pushSegment(startPoint ? { ...startPoint } : this.getEstimatedPosition());
            return { segments, startPoint: startPoint ? { ...startPoint } : this.getEstimatedPosition(), endPoint: current, absoluteMode };
        }

        if (opcode === 'CI' && numbers.length >= 1) {
            const center = { ...current };
            const radius = numbers[0] / 40;
            if (!Number.isFinite(radius) || radius <= 0) {
                return { segments: [], startPoint: center, endPoint: center, absoluteMode };
            }
            const steps = 72;
            let previous = { x: center.x + radius, y: center.y };
            pushSegment(previous);
            for (let i = 1; i <= steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                const next = {
                    x: center.x + Math.cos(angle) * radius,
                    y: center.y + Math.sin(angle) * radius
                };
                pushSegment(next);
                previous = next;
            }
            pushSegment(center);
            return { segments, startPoint: center, endPoint: center, absoluteMode };
        }

        return { segments: [], startPoint: startPoint ? { ...startPoint } : this.getEstimatedPosition(), endPoint: current, absoluteMode };
    }

    _getPointAtDistanceOnSegments(segments, distance) {
        if (!Array.isArray(segments) || segments.length === 0) return null;
        let remaining = Math.max(0, distance);
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (!segment || !Number.isFinite(segment.length) || segment.length <= 0) continue;
            if (remaining <= segment.length) {
                const t = segment.length > 0 ? (remaining / segment.length) : 1;
                return {
                    x: segment.x1 + ((segment.x2 - segment.x1) * t),
                    y: segment.y1 + ((segment.y2 - segment.y1) * t)
                };
            }
            remaining -= segment.length;
        }
        const last = segments[segments.length - 1];
        return last ? { x: last.x2, y: last.y2 } : null;
    }

    _estimateStreamBlockDurationMs(distance, segmentCount) {
        const safeDistance = Math.max(0, Number(distance) || 0);
        const safeSegments = Math.max(1, Number(segmentCount) || 1);
        const learnedDistance = Math.max(1, this.blockTimingAverageDistance);
        const normalizedDistance = safeDistance > 0 ? (safeDistance / learnedDistance) : 0.35;
        const durationFromAverage = this.blockTimingAverageMs * Math.max(0.35, normalizedDistance);
        const durationFromGeometry = (safeDistance * 16) + (safeSegments * 18);
        return Math.max(40, Math.min(6000, (durationFromAverage * 0.65) + (durationFromGeometry * 0.35)));
    }

    queuePredictedMotionBlock(command, options = {}) {
        if (!this.streamPreviewEnabled) return;
        const parts = this._splitCommands(command)
            .flatMap(rawCommand => this._expandCurveCommand(rawCommand));
        if (parts.length === 0) return;

        let absoluteMode = this.estimatedAbsoluteMode;
        let startPoint = this.predictionReferencePoint ? { ...this.predictionReferencePoint } : this.getEstimatedPosition();
        const segments = [];

        for (const part of parts) {
            const motion = this._buildMotionSegmentsFromCommand(part, startPoint, absoluteMode);
            if (motion.segments.length > 0) {
                segments.push(...motion.segments);
            }
            startPoint = motion.endPoint ? { ...motion.endPoint } : startPoint;
            absoluteMode = motion.absoluteMode;
        }

        this.predictionReferencePoint = startPoint ? { ...startPoint } : this.predictionReferencePoint;
        if (segments.length === 0) return;

        const totalDistance = segments.reduce((sum, segment) => sum + (segment.length || 0), 0);
        const durationMs = this._estimateStreamBlockDurationMs(totalDistance, segments.length);
        const carryoverMs = options.isFirstBlock ? 0 : Math.max(0, this.predictionCarryoverMs || (this.blockTimingAverageMs * 0.25));
        this.predictionBlocks.push({
            segments,
            totalDistance,
            durationMs,
            carryoverMs,
            elapsedMs: 0,
            delayRemainingMs: carryoverMs,
            endPoint: { x: startPoint.x, y: startPoint.y }
        });
        this.streamBlockTimingSamples.push({ distance: totalDistance });
        this.streamBlocksQueued += 1;
        this.predictionCarryoverMs = Math.max(20, this.blockTimingAverageMs * 0.2);
        this.startStreamPredictionLoop();
    }

    startStreamPredictionLoop() {
        if (this.previewMotionFrame) return;

        const tick = (timestamp) => {
            if (!this.predictionCurrentBlock && this.predictionBlocks.length === 0) {
                this.previewMotionFrame = null;
                this.previewMotionLastTimestamp = 0;
                return;
            }

            if (!this.previewMotionLastTimestamp) {
                this.previewMotionLastTimestamp = timestamp;
            }

            let remainingMs = Math.max(0, timestamp - this.previewMotionLastTimestamp);
            this.previewMotionLastTimestamp = timestamp;

            while (remainingMs > 0) {
                if (!this.predictionCurrentBlock) {
                    this.predictionCurrentBlock = this.predictionBlocks.shift() || null;
                    if (!this.predictionCurrentBlock) break;
                }

                const block = this.predictionCurrentBlock;
                if (block.delayRemainingMs > 0) {
                    const pauseStep = Math.min(block.delayRemainingMs, remainingMs);
                    block.delayRemainingMs -= pauseStep;
                    remainingMs -= pauseStep;
                    if (block.delayRemainingMs > 0) break;
                }

                const durationLeft = Math.max(0, block.durationMs - block.elapsedMs);
                if (durationLeft <= 0) {
                    this.setEstimatedPosition(block.endPoint.x, block.endPoint.y);
                    this.predictionCurrentBlock = null;
                    continue;
                }

                const stepMs = Math.min(durationLeft, remainingMs);
                block.elapsedMs += stepMs;
                remainingMs -= stepMs;

                const progress = Math.max(0, Math.min(1, block.elapsedMs / Math.max(1, block.durationMs)));
                const point = this._getPointAtDistanceOnSegments(block.segments, block.totalDistance * progress);
                if (point) {
                    this.setEstimatedPosition(point.x, point.y);
                }

                if (block.elapsedMs >= block.durationMs - 0.0001) {
                    this.setEstimatedPosition(block.endPoint.x, block.endPoint.y);
                    this.predictionCurrentBlock = null;
                }
            }

            this.previewMotionFrame = requestAnimationFrame(tick);
        };

        this.previewMotionFrame = requestAnimationFrame(tick);
    }

    getPreviewBacklogDistance() {
        let total = 0;
        if (this.previewMotionCurrent) {
            total += Math.max(0, this.previewMotionCurrent.length - this.previewMotionCurrent.progress);
        }
        for (const segment of this.previewMotionQueue) {
            total += segment.length;
        }
        return total;
    }

    getAdaptivePreviewMotionSpeed() {
        const backlogDistance = this.getPreviewBacklogDistance();
        if (backlogDistance <= 0.01) {
            return this.previewMotionMinSpeed;
        }

        const targetLagSeconds = (this.softwareFlowPaused || this.hardwareFlowPaused)
            ? this.previewMotionTargetLagSeconds * 1.35
            : this.previewMotionTargetLagSeconds;
        const adaptiveSpeed = backlogDistance / Math.max(0.25, targetLagSeconds);
        return Math.max(
            this.previewMotionMinSpeed,
            Math.min(this.previewMotionMaxSpeed, adaptiveSpeed)
        );
    }

    startPreviewMotionLoop() {
        if (this.previewMotionFrame) return;
        const tick = (timestamp) => {
            if (!this.previewMotionCurrent && this.previewMotionQueue.length === 0) {
                this.previewMotionFrame = null;
                this.previewMotionLastTimestamp = 0;
                return;
            }

            if (!this.previewMotionLastTimestamp) {
                this.previewMotionLastTimestamp = timestamp;
            }
            const previewMotionSpeed = this.getAdaptivePreviewMotionSpeed();
            let remainingDistance = Math.max(0, ((timestamp - this.previewMotionLastTimestamp) / 1000) * previewMotionSpeed);
            this.previewMotionLastTimestamp = timestamp;

            while (remainingDistance > 0 && (this.previewMotionCurrent || this.previewMotionQueue.length > 0)) {
                if (!this.previewMotionCurrent) {
                    this.previewMotionCurrent = this.previewMotionQueue.shift();
                    if (!this.previewMotionCurrent) break;
                }

                const segment = this.previewMotionCurrent;
                const distanceLeft = Math.max(0, segment.length - segment.progress);
                const step = Math.min(distanceLeft, remainingDistance);
                segment.progress += step;
                remainingDistance -= step;

                const t = segment.length > 0 ? segment.progress / segment.length : 1;
                this.setEstimatedPosition(
                    segment.x1 + ((segment.x2 - segment.x1) * t),
                    segment.y1 + ((segment.y2 - segment.y1) * t)
                );

                if (segment.progress >= segment.length - 0.0001) {
                    this.previewMotionCurrent = null;
                }
            }

            this.previewMotionFrame = requestAnimationFrame(tick);
        };

        this.previewMotionFrame = requestAnimationFrame(tick);
    }

    queuePreviewMotionFromCommand(command) {
        if (!this.streamPreviewEnabled) return;
        const trimmed = (command || '').trim();
        if (!trimmed) return;

        const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
        const opcode = normalized.slice(0, 2).toUpperCase();
        const args = normalized.slice(2);
        const numbers = this._parseHpglNumbers(args);

        if (opcode === 'IN') {
            this.estimatedAbsoluteMode = true;
            this.clearPreviewMotion(true);
            return;
        }

        if (opcode === 'PA') {
            this.estimatedAbsoluteMode = true;
        } else if (opcode === 'PR') {
            this.estimatedAbsoluteMode = false;
        }

        if (opcode === 'PU' || opcode === 'PD' || opcode === 'PA' || opcode === 'PR') {
            if (numbers.length < 2) return;
            let current = this.getPreviewMotionReferencePoint();
            for (let i = 0; i < numbers.length - 1; i += 2) {
                const next = (opcode === 'PR' || (opcode === 'PU' || opcode === 'PD') && this.estimatedAbsoluteMode === false)
                    ? { x: current.x + (numbers[i] / 40), y: current.y + (numbers[i + 1] / 40) }
                    : { x: numbers[i] / 40, y: numbers[i + 1] / 40 };
                this.queuePreviewSegment(current.x, current.y, next.x, next.y);
                current = next;
            }
            this.startPreviewMotionLoop();
            return;
        }

        if (opcode === 'EA' || opcode === 'ER') {
            if (numbers.length < 2) return;
            const start = this.getPreviewMotionReferencePoint();
            const target = (opcode === 'ER' && this.estimatedAbsoluteMode === false)
                ? { x: start.x + (numbers[0] / 40), y: start.y + (numbers[1] / 40) }
                : { x: numbers[0] / 40, y: numbers[1] / 40 };
            this.queuePreviewSegment(start.x, start.y, target.x, start.y);
            this.queuePreviewSegment(target.x, start.y, target.x, target.y);
            this.queuePreviewSegment(target.x, target.y, start.x, target.y);
            this.queuePreviewSegment(start.x, target.y, start.x, start.y);
            this.startPreviewMotionLoop();
            return;
        }

        if (opcode === 'CI' && numbers.length >= 1) {
            const center = this.getPreviewMotionReferencePoint();
            const radius = numbers[0] / 40;
            if (!Number.isFinite(radius) || radius <= 0) return;
            let previous = { x: center.x + radius, y: center.y };
            this.queuePreviewSegment(center.x, center.y, previous.x, previous.y);
            const steps = 72;
            for (let i = 1; i <= steps; i++) {
                const angle = (i / steps) * Math.PI * 2;
                const next = {
                    x: center.x + Math.cos(angle) * radius,
                    y: center.y + Math.sin(angle) * radius
                };
                this.queuePreviewSegment(previous.x, previous.y, next.x, next.y);
                previous = next;
            }
            this.queuePreviewSegment(previous.x, previous.y, center.x, center.y);
            this.startPreviewMotionLoop();
        }
    }

    _expandCurveCommand(command) {
        const trimmed = (command || '').trim();
        if (!trimmed) return [];

        const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
        const opcode = normalized.slice(0, 1).toUpperCase();
        if (opcode !== 'Y') return [trimmed.endsWith(';') ? trimmed : `${trimmed};`];

        const args = normalized.slice(1);
        const numbers = this._parseHpglNumbers(args);
        if (numbers.length < 5) return [];

        const coords = numbers.slice(1);
        if (coords.length < 4) return [];

        const points = [];
        for (let i = 0; i < coords.length - 1; i += 2) {
            points.push({
                x: Math.round(coords[i]),
                y: Math.round(coords[i + 1])
            });
        }

        if (points.length < 2) return [];

        const commands = [`PU${points[0].x},${points[0].y};`];
        for (let i = 1; i < points.length; i++) {
            commands.push(`PD${points[i].x},${points[i].y};`);
        }
        commands.push('PU;');
        return commands;
    }

    _splitCommands(commandString) {
        return String(commandString || '')
            .split(';')
            .map(part => part.trim())
            .filter(Boolean)
            .map(part => `${part};`);
    }

    getTransmitChunkSize() {
        const baudRateStr = document.getElementById('sel-baud')?.value;
        const baudRate = parseInt(baudRateStr, 10) || 9600;
        if (baudRate <= 9600) return 12;
        if (baudRate <= 19200) return 18;
        return 24;
    }

    getInterChunkDelayMs(chunkLength = 1) {
        return this.getAutoInterChunkDelayMs(chunkLength);
    }

    getAutoInterChunkDelayMs(chunkLength = 1) {
        const baudRateStr = document.getElementById('sel-baud')?.value;
        const baudRate = parseInt(baudRateStr, 10) || 9600;
        const msPerByte = (10 / baudRate) * 1000;
        return Math.max(2, Math.ceil(msPerByte * Math.max(1, chunkLength) * 0.75));
    }

    getInterCommandDelayMs(command = '') {
        if (this.isHardwareHandshakeEnabled() && this.hardwareFlowSupported) {
            return 0;
        }

        const baseDelay = this.commandDelay || 50;
        const fallbackDelay = this.getAutoInterChunkDelayMs(String(command || '').length || 1);
        return Math.max(baseDelay, fallbackDelay);
    }

    shouldWatchForNoCtsCommunicationStall() {
        return (this.app?.settings?.handshake || 'normal') === 'normal'
            && this.app?.settings?.ctsPriorityEnabled === false
            && !this.isTestMode();
    }

    handleNoCtsCommunicationStall(reason = 'serial communication stalled') {
        if (!this.shouldWatchForNoCtsCommunicationStall()) return false;

        this.ctsAutoFallbackTriggered = true;
        this.isStreaming = false;
        this.isHold = true;
        this.setTrafficLight('orange');
        this.app.ui.logToConsole(
            `System: No serial communication detected (${reason}). CTS priority handshaking remains disabled because you turned it off. Check TX/RX/GND wiring, baud rate, DIP switches, or enable CTS priority manually if using a hardware-handshake cable.`,
            'error'
        );
        return true;
    }

    async writeWithCommunicationWatchdog(bytes, part = '') {
        if (!this.shouldWatchForNoCtsCommunicationStall()) {
            await this.writer.write(bytes);
            return true;
        }

        const timeoutMs = Number(this.communicationWriteTimeoutMs) || 0;
        if (timeoutMs <= 0) {
            await this.writer.write(bytes);
            return true;
        }

        const guardedTimeoutMs = Math.max(500, timeoutMs);
        let timeoutId = null;
        try {
            const writeResult = this.writer.write(bytes).then(() => 'written');
            const timeoutResult = new Promise(resolve => {
                timeoutId = setTimeout(() => resolve('timeout'), guardedTimeoutMs);
            });
            const result = await Promise.race([writeResult, timeoutResult]);
            if (timeoutId) clearTimeout(timeoutId);
            if (result === 'timeout') {
                this.handleNoCtsCommunicationStall(`write timeout after ${guardedTimeoutMs}ms`);
                this.appendSerialDebugLog(
                    `${this.getSerialDebugTimestamp()} No-CTS write stalled${part ? ` ${String(part).slice(0, 60)}` : ''}`,
                    'warning'
                );
                return false;
            }
            return true;
        } catch (error) {
            if (timeoutId) clearTimeout(timeoutId);
            this.handleNoCtsCommunicationStall(error?.message || 'write failed');
            throw error;
        }
    }

    async _writePartWithFlowControl(part, encoder) {
        const bytes = encoder.encode(part);
        while (this.isConnected && !this.isHold) {
            const ready = await this.waitForTransmitReady();
            if (!ready) return false;

            // HPGL commands must stay intact. If XOFF arrives halfway through a
            // coordinate, the browser cannot know which bytes the plotter kept.
            if (this.softwareFlowPaused) {
                this.setTrafficLight('orange');
                await this.waitForSoftwareFlowResume();
                continue;
            }

            const ctsReady = await this.waitForCtsPriorityWindow(bytes.length);
            if (!ctsReady) return false;

            const noCtsReady = await this.waitForNoCtsPacing(bytes.length);
            if (!noCtsReady) return false;

            const writeSucceeded = await this.writeWithCommunicationWatchdog(bytes, part);
            if (!writeSucceeded) return false;
            this.bytesSincePriorityCtsPoll += bytes.length;
            if (this.shouldUseNoCtsPacing()) {
                this.noCtsBytesSinceDrain += bytes.length;
                this.noCtsLastWriteAt = performance.now();
            }
            this.recordSerialDebugTx(bytes.length, part);
            return true;
        }

        return false;
    }

    _updateEstimatedPositionFromCommand(command) {
        const trimmed = (command || '').trim();
        if (!trimmed) return;

        const normalized = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed;
        const opcode = normalized.slice(0, 2).toUpperCase();
        const args = normalized.slice(2);

        if (opcode === 'IN') {
            this.estimatedAbsoluteMode = true;
            this.setEstimatedPosition(0, 0);
            return;
        }

        if (opcode === 'PA') {
            this.estimatedAbsoluteMode = true;
            const numbers = this._parseHpglNumbers(args);
            if (numbers.length >= 2) {
                this.setEstimatedPosition(
                    numbers[numbers.length - 2] / 40,
                    numbers[numbers.length - 1] / 40
                );
            }
            return;
        }

        if (opcode === 'PR') {
            this.estimatedAbsoluteMode = false;
            const numbers = this._parseHpglNumbers(args);
            if (numbers.length >= 2) {
                const current = this.getEstimatedPosition();
                this.setEstimatedPosition(
                    current.x + (numbers[numbers.length - 2] / 40),
                    current.y + (numbers[numbers.length - 1] / 40)
                );
            }
            return;
        }

        if (opcode === 'PU' || opcode === 'PD') {
            const numbers = this._parseHpglNumbers(args);
            if (numbers.length >= 2) {
                if (this.estimatedAbsoluteMode) {
                    this.setEstimatedPosition(
                        numbers[numbers.length - 2] / 40,
                        numbers[numbers.length - 1] / 40
                    );
                } else {
                    const current = this.getEstimatedPosition();
                    this.setEstimatedPosition(
                        current.x + (numbers[numbers.length - 2] / 40),
                        current.y + (numbers[numbers.length - 1] / 40)
                    );
                }
            }
            return;
        }

        if (opcode === 'EA' || opcode === 'ER') {
            const numbers = this._parseHpglNumbers(args);
            if (numbers.length >= 2) {
                if (opcode === 'EA' || this.estimatedAbsoluteMode) {
                    this.setEstimatedPosition(
                        numbers[numbers.length - 2] / 40,
                        numbers[numbers.length - 1] / 40
                    );
                } else {
                    const current = this.getEstimatedPosition();
                    this.setEstimatedPosition(
                        current.x + (numbers[numbers.length - 2] / 40),
                        current.y + (numbers[numbers.length - 1] / 40)
                    );
                }
            }
        }
    }

    async sendManualCommand(cmd, options = {}) {
        if (!this.writer) return false;
        const encoder = new TextEncoder();

        for (const rawCommand of this._splitCommands(cmd)) {
            const expandedCommands = this._expandCurveCommand(rawCommand);
            if (expandedCommands.length === 0) continue;

            for (const part of expandedCommands) {
                let wasTransmitted = this.isTestMode();
                if (!this.isTestMode()) {
                    wasTransmitted = await this._writePartWithFlowControl(part, encoder);
                    if (!wasTransmitted) return false;
                }

                if (wasTransmitted) {
                    this.app.ui.logToConsole(part, options.commandLogType || 'tx');
                }

                // The preview must only follow commands that have actually gone out.
                if (wasTransmitted && options.preview !== false) {
                    this.queuePreviewMotionFromCommand(part);
                }
                if (wasTransmitted && options.updateEstimatedFromCommand === true) {
                    this._updateEstimatedPositionFromCommand(part);
                }
            }
        }
        if (options.estimatedPosition) {
            this.setEstimatedPosition(options.estimatedPosition.x, options.estimatedPosition.y);
        }
        return true;
    }

    async sendPenUpCommand() {
        if (!this.writer) return false;
        await this.sendManualCommand('PU;');
        return true;
    }

    async sendPenDownCommand() {
        if (!this.writer) return false;
        await this.sendManualCommand('PD;');
        return true;
    }

    async _sendRawImmediate(data) {
        if (!this.writer || this.isTestMode()) return false;
        try {
            const encoder = new TextEncoder();
            const bytes = encoder.encode(data);
            await this.writer.write(bytes);
            this.recordSerialDebugTx(bytes.length, data, 'RAW');
            return true;
        } catch (error) {
            this.app.ui.logToConsole(`System Warning: Failed to send abort sequence. ${error.message}`, 'warning');
            return false;
        }
    }

    async sendAbortSequence() {
        if (!this.writer) return false;

        this.abortRequested = true;
        this.isStreaming = false;
        this.isHold = true;
        this.stopSerialDebugRepeat();
        this.stopSerialDebugStress();
        this.queue = [];
        this.softwareFlowPaused = false;
        this.hardwareFlowPaused = false;
        this._flushResumeWaiters();
        this.updateStats();
        this.clearPreviewMotion(false);
        this.resetStreamPrediction(false);

        const activeRun = this.runPromise;
        if (activeRun) {
            await activeRun;
        }

        if (this.isTestMode()) {
            this.setEstimatedPosition(this.estimatedPosition.x, this.estimatedPosition.y);
            this.app.ui.logToConsole('System: Test-mode cancel issued. Stream stopped and pen state reset.');
            return true;
        }

        // Try a layered abort so the plotter stops buffered motion instead of
        // only halting the browser-side queue.
        await this._sendRawImmediate('\x1B.K');
        await this._sendRawImmediate('\x03');
        await this._sendRawImmediate('PU;IN;');

        this.abortRequested = false;
        this.isHold = false;
        this.setTrafficLight('green');
        this.app.ui.logToConsole('System: Emergency cancel sent. Pen-up and reset sequence issued.', 'warning');
        return true;
    }

    // Queue management
    queueCommands(cmds) {
        this.queue = this.queue.concat(cmds);
        this.updateStats();
    }

    async stopStream(clearQueue = true) {
        this.isStreaming = false;
        this.isHold = false;
        this.softwareFlowPaused = false;
        this._flushResumeWaiters();
        if (clearQueue) {
            this.queue = [];
            this.updateStats();
        }
        const activeRun = this.runPromise;
        if (activeRun) {
            await activeRun;
        }
        if (clearQueue) {
            this.clearPreviewMotion(false);
            this.resetStreamPrediction(false);
        }
        this.runPromise = null;
    }

    async runStream() {
        if (!this.isConnected || this.queue.length === 0) return;
        if (this.isStreaming) return this.runPromise;

            this.runPromise = (async () => {
                this.enterStreamPerformanceMode();
                try {
                    this.isStreaming = true;
                    this.isHold = false;
                    this.abortRequested = false;
                    this.hardwareFlowPaused = false;
                    this.resetStreamPrediction(false);
                    this.setTrafficLight('green');
                    let streamedBlockIndex = 0;

                    while (this.queue.length > 0 && this.isStreaming && !this.isHold) {
                        const ready = await this.waitForTransmitReady();
                        if (!ready || !this.isStreaming || this.isHold) break;
                        this.setTrafficLight('green');

                        const cmd = this.queue.shift();
                        const wasSent = await this.sendManualCommand(cmd, { preview: false, commandLogType: 'tx-stream' });
                        if (!wasSent) break;
                        this.queuePredictedMotionBlock(cmd, { isFirstBlock: streamedBlockIndex === 0 });
                        streamedBlockIndex++;

                        this.incrementLinesStat();
                        this.updateStats();

                        // Only pace writes when flow control is unavailable.
                        const interCommandDelayMs = this.getInterCommandDelayMs(cmd);
                        if (interCommandDelayMs > 0) {
                            await new Promise(r => setTimeout(r, interCommandDelayMs));
                        }
                    }

                    this.isStreaming = false;
                    if (this.isHold || this.hardwareFlowPaused || this.softwareFlowPaused) {
                        this.setTrafficLight('orange');
                        return;
                    }

                    if (this.queue.length === 0) {
                        this.app.ui.logToConsole('System: Plotting complete.');
                        this.setTrafficLight('green');
                    }
                } finally {
                    this.exitStreamPerformanceMode();
                }
            })();

        try {
            await this.runPromise;
        } finally {
            this.runPromise = null;
        }
    }

    createEmptySerialDebugStats() {
        return {
            totalBytes: 0,
            lastWriteBytes: 0,
            maxWriteBytes: 0,
            bytesSinceFlow: 0,
            maxBeforeXoff: 0,
            maxBeforeCtsHold: 0,
            xonCount: 0,
            xoffCount: 0,
            ctsReadyCount: 0,
            ctsHoldCount: 0,
            repeatLoops: 0,
            stressWrites: 0,
            eventCount: 0
        };
    }

    resetSerialDebugStats() {
        this.serialDebugStats = this.createEmptySerialDebugStats();
        this.serialDebugHistory = ['Debug counters reset.'];
        if (this.debugLogEl) {
            this.debugLogEl.innerHTML = '<div class="serial-debug-line">Debug counters reset.</div>';
        }
        this.updateSerialDebugStats();
    }

    applySerialDebugVisibility() {
        if (!this.debugPanelEl) return;
        this.debugPanelEl.classList.toggle('hidden', this.app?.settings?.showSerialDebug !== true);
    }

    exportSerialDebugLog() {
        const stats = this.serialDebugStats || this.createEmptySerialDebugStats();
        const lines = [
            'Roland DXY Serial Debug Log',
            `Exported: ${new Date().toISOString()}`,
            '',
            `Total TX bytes: ${stats.totalBytes}`,
            `Last TX bytes: ${stats.lastWriteBytes}`,
            `Max TX bytes: ${stats.maxWriteBytes}`,
            `Bytes since last flow signal: ${stats.bytesSinceFlow}`,
            `Max bytes before XOFF: ${stats.maxBeforeXoff}`,
            `Max bytes before CTS hold: ${stats.maxBeforeCtsHold}`,
            `XON count: ${stats.xonCount}`,
            `XOFF count: ${stats.xoffCount}`,
            `CTS ready count: ${stats.ctsReadyCount}`,
            `CTS hold count: ${stats.ctsHoldCount}`,
            `CTS recovery mode active: ${this.ctsRecoveryMode ? 'yes' : 'no'}`,
            `CTS normal window bytes: ${this.ctsPriorityByteWindow}`,
            `CTS recovery window bytes: ${this.ctsRecoveryByteWindow}`,
            `CTS ready cooldown ms: ${this.ctsReadyCooldownMs}`,
            `CTS recovery ramp ms: ${this.ctsRecoveryRampMs}`,
            `No-CTS pacing active: ${this.shouldUseNoCtsPacing() ? 'yes' : 'no'}`,
            `No-CTS pacing window bytes: ${this.getNoCtsPacingByteWindow()}`,
            `No-CTS pacing drain ms: ${this.getNoCtsPacingDrainMs()}`,
            `No-CTS minimum command gap ms: ${this.getNoCtsMinCommandGapMs()}`,
            `Repeat loops: ${stats.repeatLoops}`,
            `Stress writes: ${stats.stressWrites}`,
            `Exported event lines: ${(this.serialDebugHistory || []).length}`,
            '',
            'Events:'
        ];

        lines.push(...(this.serialDebugHistory || []));

        const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `serial_debug_${new Date().getTime()}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    updateSerialDebugStats() {
        if (!this.debugStatEls || !this.serialDebugStats) return;
        const stats = this.serialDebugStats;
        const values = {
            'total-bytes': stats.totalBytes,
            'last-write-bytes': stats.lastWriteBytes,
            'max-write-bytes': stats.maxWriteBytes,
            'bytes-since-flow': stats.bytesSinceFlow,
            'max-before-xoff': stats.maxBeforeXoff,
            'max-before-cts-hold': stats.maxBeforeCtsHold,
            'xon-count': stats.xonCount,
            'xoff-count': stats.xoffCount,
            'cts-ready-count': stats.ctsReadyCount,
            'cts-hold-count': stats.ctsHoldCount,
            'repeat-loops': stats.repeatLoops,
            'stress-writes': stats.stressWrites
        };
        this.debugStatEls.forEach(el => {
            if (Object.prototype.hasOwnProperty.call(values, el.dataset.debugStat)) {
                el.textContent = values[el.dataset.debugStat];
            }
        });
    }

    appendSerialDebugLog(message, type = 'info') {
        if (!this.serialDebugHistory) this.serialDebugHistory = [];
        this.serialDebugHistory.push(message);
        if (!this.debugLogEl) {
            this.serialDebugStats.eventCount += 1;
            return;
        }
        if (this.serialDebugStats.eventCount === 0) {
            this.debugLogEl.innerHTML = '';
        }
        const line = document.createElement('div');
        line.className = 'serial-debug-line';
        line.textContent = message;
        if (type === 'tx') line.style.color = 'var(--success)';
        if (type === 'flow') line.style.color = 'var(--warning)';
        this.debugLogEl.appendChild(line);
        while (this.debugLogEl.children.length > 120) {
            this.debugLogEl.removeChild(this.debugLogEl.firstChild);
        }
        this.debugLogEl.scrollTop = this.debugLogEl.scrollHeight;
        this.serialDebugStats.eventCount += 1;
    }

    getSerialDebugTimestamp() {
        const now = new Date();
        return now.toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }) + `.${String(now.getMilliseconds()).padStart(3, '0')}`;
    }

    recordSerialDebugTx(byteLength, command = '', label = 'TX') {
        if (!this.serialDebugStats) return;
        const length = Math.max(0, Number(byteLength) || 0);
        const stats = this.serialDebugStats;
        stats.totalBytes += length;
        stats.lastWriteBytes = length;
        stats.maxWriteBytes = Math.max(stats.maxWriteBytes, length);
        stats.bytesSinceFlow += length;
        this.updateSerialDebugStats();

        const compactCommand = String(command || '').replace(/\s+/g, ' ').trim();
        const shownCommand = compactCommand.length > 48 ? `${compactCommand.slice(0, 45)}...` : compactCommand;
        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} ${label} ${length}B total=${stats.totalBytes}${shownCommand ? ` ${shownCommand}` : ''}`,
            'tx'
        );
    }

    recordSerialDebugFlowSignal(signal) {
        if (!this.serialDebugStats) return;
        const stats = this.serialDebugStats;
        const bytesBeforeSignal = stats.bytesSinceFlow;
        if (signal === 'XON') {
            stats.xonCount += 1;
        } else if (signal === 'XOFF') {
            stats.xoffCount += 1;
            stats.maxBeforeXoff = Math.max(stats.maxBeforeXoff, bytesBeforeSignal);
        }
        stats.bytesSinceFlow = 0;
        this.updateSerialDebugStats();
        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} RX <${signal}> after ${bytesBeforeSignal}B total=${stats.totalBytes}`,
            'flow'
        );
    }

    recordSerialDebugCtsSignal(isReady) {
        if (!this.serialDebugStats) return;
        const stats = this.serialDebugStats;
        const bytesBeforeSignal = stats.bytesSinceFlow;
        this.bytesSincePriorityCtsPoll = 0;
        if (isReady) {
            stats.ctsReadyCount += 1;
            this.ctsLastReadyAt = performance.now();
        } else {
            stats.ctsHoldCount += 1;
            stats.maxBeforeCtsHold = Math.max(stats.maxBeforeCtsHold, bytesBeforeSignal);
            this.ctsRecoveryMode = true;
            this.ctsLastHoldAt = performance.now();
            this.ctsLastReadyAt = 0;
        }
        stats.bytesSinceFlow = 0;
        this.updateSerialDebugStats();
        this.appendSerialDebugLog(
            `${this.getSerialDebugTimestamp()} CTS ${isReady ? 'READY' : 'HOLD'} after ${bytesBeforeSignal}B total=${stats.totalBytes}${this.ctsRecoveryMode ? ` recoveryWindow=${this.ctsRecoveryByteWindow}B` : ''}`,
            'flow'
        );
    }

    setSerialDebugRepeatButtons(isRunning) {
        const startButton = document.getElementById('btn-debug-repeat-start');
        const stopButton = document.getElementById('btn-debug-repeat-stop');
        if (startButton) startButton.disabled = isRunning;
        if (stopButton) stopButton.disabled = !isRunning;
    }

    setSerialDebugStressButtons(isRunning) {
        const startButton = document.getElementById('btn-debug-stress-start');
        const stopButton = document.getElementById('btn-debug-stress-stop');
        if (startButton) startButton.disabled = isRunning;
        if (stopButton) stopButton.disabled = !isRunning;
    }

    async startSerialDebugRepeat() {
        if (this.debugRepeatActive) return;
        if (!this.isConnected) {
            this.app.ui.logToConsole('Error: Connect to the plotter before starting the debug repeat.', 'error');
            return;
        }

        this.debugRepeatActive = true;
        this.debugRepeatStopRequested = false;
        this.stopSerialDebugStress();
        this.setSerialDebugRepeatButtons(true);
        this.appendSerialDebugLog(`${this.getSerialDebugTimestamp()} Repeat test started: PU; PR400,0; PR-400,0;`, 'info');

        this.debugRepeatPromise = (async () => {
            try {
                await this.sendManualCommand('PU;', { preview: false, updateEstimatedFromCommand: false });
                let direction = 1;
                while (this.isConnected && !this.debugRepeatStopRequested) {
                    const units = direction * 400;
                    const sent = await this.sendManualCommand(`PR${units},0;`, {
                        preview: false,
                        updateEstimatedFromCommand: false
                    });
                    if (!sent) break;
                    if (direction < 0) {
                        this.serialDebugStats.repeatLoops += 1;
                        this.updateSerialDebugStats();
                    }
                    direction *= -1;
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            } finally {
                this.debugRepeatActive = false;
                this.debugRepeatStopRequested = false;
                this.debugRepeatPromise = null;
                this.setSerialDebugRepeatButtons(false);
                this.appendSerialDebugLog(`${this.getSerialDebugTimestamp()} Repeat test stopped.`, 'info');
            }
        })();

        await this.debugRepeatPromise;
    }

    stopSerialDebugRepeat() {
        this.debugRepeatStopRequested = true;
    }

    async startSerialDebugStress() {
        if (this.debugStressActive) return;
        if (!this.isConnected) {
            this.app.ui.logToConsole('Error: Connect to the plotter before starting the buffer stress test.', 'error');
            return;
        }

        this.stopSerialDebugRepeat();
        this.debugStressActive = true;
        this.debugStressStopRequested = false;
        this.setSerialDebugStressButtons(true);
        this.appendSerialDebugLog(`${this.getSerialDebugTimestamp()} Buffer stress started: no-delay PR400,0 / PR-400,0.`, 'info');

        this.debugStressPromise = (async () => {
            try {
                await this.sendManualCommand('PU;', { preview: false, updateEstimatedFromCommand: false });
                let direction = 1;
                while (this.isConnected && !this.debugStressStopRequested) {
                    const units = direction * 400;
                    const sent = await this.sendManualCommand(`PR${units},0;`, {
                        preview: false,
                        updateEstimatedFromCommand: false
                    });
                    if (!sent) break;
                    this.serialDebugStats.stressWrites += 1;
                    this.updateSerialDebugStats();
                    direction *= -1;
                }
            } finally {
                this.debugStressActive = false;
                this.debugStressStopRequested = false;
                this.debugStressPromise = null;
                this.setSerialDebugStressButtons(false);
                this.appendSerialDebugLog(`${this.getSerialDebugTimestamp()} Buffer stress stopped.`, 'info');
            }
        })();

        await this.debugStressPromise;
    }

    stopSerialDebugStress() {
        this.debugStressStopRequested = true;
    }

    _bindControls() {
        document.querySelectorAll('[data-stream-action]').forEach(button => {
            button.addEventListener('click', async () => {
                const action = button.dataset.streamAction;
                if (action === 'run') {
                    const hasCanvasPaths = Array.isArray(this.app?.canvas?.paths) && this.app.canvas.paths.length > 0;
                    const shouldRunLiveTracker = this.app.liveTracker?.isModeEnabled() && !hasCanvasPaths;

                    if (shouldRunLiveTracker) {
                        await this.stopStream(true);
                        this.isHold = false;
                        await this.app.liveTracker.handleRunRequest();
                        return;
                    }
                    await this.stopStream(true);
                    if (this.app.hpgl.generateFromPaths(this.app.canvas.paths)) {
                        await this.runStream();
                    }
                    return;
                }

                if (action === 'hold') {
                    if (this.app.liveTracker?.isActiveOrPaused()) {
                        this.isStreaming = false;
                        this.app.liveTracker.handleHold();
                        this.isHold = true;
                        this.setTrafficLight('orange');
                        return;
                    }
                    this.isHold = true;
                    this.clearPreviewMotion(false);
                    this.resetStreamPrediction(false);
                    this.setTrafficLight('orange');
                    this.app.ui.logToConsole('System: Stream paused.');
                    return;
                }

                if (action === 'cancel') {
                    if (this.app.liveTracker?.isActiveOrPaused()) {
                        this.isStreaming = false;
                        this.isHold = false;
                        this.app.liveTracker.handleCancel();
                        await this.sendAbortSequence();
                        this.setTrafficLight('green');
                        return;
                    }
                    await this.sendAbortSequence();
                    this.setTrafficLight('green'); // Ready again
                    this.app.ui.logToConsole('System: Stream cancelled.');
                }
            });
        });

        const debugInput = document.getElementById('debug-hpgl-input');
        const debugSendButton = document.getElementById('btn-debug-send');
        const debugResetButton = document.getElementById('btn-debug-reset');
        const debugExportButton = document.getElementById('btn-debug-export');
        const debugRepeatStartButton = document.getElementById('btn-debug-repeat-start');
        const debugRepeatStopButton = document.getElementById('btn-debug-repeat-stop');
        const debugStressStartButton = document.getElementById('btn-debug-stress-start');
        const debugStressStopButton = document.getElementById('btn-debug-stress-stop');
        const sendDebugCommand = async () => {
            const cmd = debugInput?.value?.trim();
            if (!cmd) return;
            if (!this.isConnected) {
                this.app.ui.logToConsole('Error: Connect to the plotter before sending a debug command.', 'error');
                return;
            }
            await this.sendManualCommand(cmd);
            debugInput.value = '';
        };

        if (debugSendButton) {
            debugSendButton.addEventListener('click', sendDebugCommand);
        }
        if (debugInput) {
            debugInput.addEventListener('keyup', event => {
                if (event.key === 'Enter') {
                    sendDebugCommand();
                }
            });
        }
        if (debugResetButton) {
            debugResetButton.addEventListener('click', () => this.resetSerialDebugStats());
        }
        if (debugExportButton) {
            debugExportButton.addEventListener('click', () => this.exportSerialDebugLog());
        }
        if (debugRepeatStartButton) {
            debugRepeatStartButton.addEventListener('click', () => this.startSerialDebugRepeat());
        }
        if (debugRepeatStopButton) {
            debugRepeatStopButton.addEventListener('click', () => this.stopSerialDebugRepeat());
        }
        if (debugStressStartButton) {
            debugStressStartButton.addEventListener('click', () => this.startSerialDebugStress());
        }
        if (debugStressStopButton) {
            debugStressStopButton.addEventListener('click', () => this.stopSerialDebugStress());
        }
    }

    _confirmBlindMove() {
        if (this.ctsBlindMoveAcknowledged) return true;
        if (!this.isHardwareHandshakeEnabled() || !this.hardwareFlowSupported || !this.hardwareFlowPaused) return true;
        const ok = confirm(
            'No CTS handshake received from the plotter.\n\n' +
            'The plotter buffer may be full or the machine may not be ready.\n\n' +
            'Continue sending movement commands blind?'
        );
        if (ok) {
            this.ctsBlindMoveAcknowledged = true;
            // Drop into no-CTS paced mode for this session so writes flow normally
            // and the visual tracker + command log behave as expected.
            this.hardwareFlowSupported = false;
            this.hardwareFlowPaused = false;
            // Persist the choice — disable CTS priority so future connections never block on handshake.
            if (this.app?.settings) {
                this.app.settings.ctsPriorityEnabled = false;
                this.app.saveSettings?.();
            }
            this.app.ui.logToConsole('System: CTS bypassed by user. CTS priority disabled and saved — paced streaming will be used for all future connections.', 'warning');
        }
        return ok;
    }

    async sendJogCommand(dxMM, dyMM) {
        if (!this.writer) return false;
        if (!this._confirmBlindMove()) return false;

        const bedWidth = this.app?.settings?.bedWidth || 432;
        const bedHeight = this.app?.settings?.bedHeight || 297;
        const nextX = Math.max(0, Math.min(bedWidth, this.estimatedPosition.x + dxMM));
        const nextY = Math.max(0, Math.min(bedHeight, this.estimatedPosition.y + dyMM));
        const deltaX = nextX - this.estimatedPosition.x;
        const deltaY = nextY - this.estimatedPosition.y;

        if (deltaX === 0 && deltaY === 0) {
            this.app.ui.logToConsole('System: Jog blocked at machine boundary.');
            return false;
        }

        const unitsX = Math.round(deltaX * 40);
        const unitsY = Math.round(deltaY * 40);
        this.clearPreviewMotion(false);
        this.resetStreamPrediction(false);
        await this.sendManualCommand(`PR${unitsX},${unitsY};`, {
            preview: false,
            updateEstimatedFromCommand: false,
            estimatedPosition: { x: nextX, y: nextY }
        });
        return true;
    }

    async sendHomeCommand() {
        if (!this.writer) return false;
        if (!this._confirmBlindMove()) return false;
        this.clearPreviewMotion(false);
        this.resetStreamPrediction(false);
        await this.sendManualCommand('PU;PA0,0;', {
            preview: false,
            updateEstimatedFromCommand: false,
            estimatedPosition: { x: 0, y: 0 }
        });
        return true;
    }

    setTrafficLight(color) {
        this.indicatorEls.forEach(indicatorEl => {
            indicatorEl.className = indicatorEl.className
                .split(' ')
                .filter(className => !['red', 'orange', 'green'].includes(className))
                .join(' ');
            indicatorEl.classList.add('traffic-light');
            indicatorEl.classList.add(color === 'green' || color === 'orange' ? color : 'red');
        });
    }

    setSpeedDelay(speedString) {
        if (speedString === 'slow') this.commandDelay = 300;
        else if (speedString === 'medium') this.commandDelay = 150;
        else this.commandDelay = 50; // fast
    }

    updateStats() {
        this.queueStatEls.forEach(el => {
            el.textContent = this.queue.length;
        });
    }

    incrementLinesStat() {
        this.linesStatEls.forEach(el => {
            const currentValue = parseInt(el.textContent, 10) || 0;
            el.textContent = currentValue + 1;
        });
    }
}
