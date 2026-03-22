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
        this.estimatedPosition = { x: 0, y: 0 };
        this.estimatedAbsoluteMode = true;

        this.queue = [];
        this.isStreaming = false;
        this.isHold = false;

        this.indicatorEls = Array.from(document.querySelectorAll('[data-stream-indicator]'));
        this.linesStatEls = Array.from(document.querySelectorAll('[data-stat="lines"]'));
        this.queueStatEls = Array.from(document.querySelectorAll('[data-stat="queue"]'));
        this.positionXEl = document.getElementById('stat-pos-x');
        this.positionYEl = document.getElementById('stat-pos-y');

        this._bindControls();
        this.updatePredictedPositionReadout();
    }

    async connect() {
        if (!('serial' in navigator)) {
            this.app.ui.logToConsole('Web Serial API not supported in this browser.', 'error');
            return;
        }

        try {
            const baudRateStr = document.getElementById('sel-baud').value;
            const baudRate = parseInt(baudRateStr, 10) || 9600;

            this.port = await navigator.serial.requestPort();

            const handshake = this.app.settings.handshake || 'normal';
            // Open the serial port with the chosen baud rate and flow control if 'normal'
            await this.port.open({
                baudRate: baudRate,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                flowControl: handshake === 'normal' ? 'hardware' : 'none'
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

            this.isConnected = true;
            this.softwareFlowPaused = false;
            this.rxLineBuffer = '';
            this.estimatedPosition = { x: 0, y: 0 };
            this.estimatedAbsoluteMode = true;
            this.app.updateConnectionState(true);
            this.app.ui.logToConsole(`Connected at ${baudRate} baud`);
            this.setTrafficLight('green');

            // Set up streams
            this.readLoopPromise = this._startReading();
            this.writer = this.port.writable.getWriter();

            // Initialize plotter
            this.sendManualCommand('IN;');

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
        this.queue = [];
        this.updateStats();

        try {
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
            this.estimatedPosition = { x: 0, y: 0 };
            this.estimatedAbsoluteMode = true;
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
                this._flushResumeWaiters();
                this.app.ui.logToConsole('RX: <XON>', 'info');
                continue;
            }

            if (byte === 0x13) {
                this._flushPrintableBytes(printableBytes, textDecoder);
                this.softwareFlowPaused = true;
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
        if (this.app?.canvas) {
            this.app.canvas.draw();
        }
    }

    updatePredictedPositionReadout() {
        if (this.positionXEl) this.positionXEl.textContent = this.estimatedPosition.x.toFixed(1);
        if (this.positionYEl) this.positionYEl.textContent = this.estimatedPosition.y.toFixed(1);
    }

    _parseHpglNumbers(raw = '') {
        return raw
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(value => parseFloat(value))
            .filter(value => Number.isFinite(value));
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
        }
    }

    async sendManualCommand(cmd) {
        if (!this.writer) return;
        const out = cmd.endsWith(';') ? cmd : cmd + ';';
        this.app.ui.logToConsole(out, 'tx');

        out.split(';')
            .map(part => part.trim())
            .filter(Boolean)
            .forEach(part => this._updateEstimatedPositionFromCommand(`${part};`));

        const encoder = new TextEncoder();
        await this.writer.write(encoder.encode(out + '\r\n'));
    }

    // Queue management
    queueCommands(cmds) {
        this.queue = this.queue.concat(cmds);
        this.updateStats();
    }

    async runStream() {
        if (!this.isConnected || this.queue.length === 0) return;
        this.isStreaming = true;
        this.isHold = false;
        this.setTrafficLight('green');

        while (this.queue.length > 0 && this.isStreaming && !this.isHold) {
            if (this.softwareFlowPaused) {
                this.setTrafficLight('orange');
                await this.waitForSoftwareFlowResume();
                if (!this.isStreaming || this.isHold) break;
                this.setTrafficLight('green');
            }

            const cmd = this.queue.shift();
            await this.sendManualCommand(cmd);

            this.incrementLinesStat();
            this.updateStats();

            // Configurable delay based on "Machine Send Speed" setting to prevent buffer overflow
            // In a real robust system, XON/XOFF parsing or buffer polling via 'OA;' would be needed,
            // but for generic web usb/serial a configurable blind delay is often the fallback.
            await new Promise(r => setTimeout(r, this.commandDelay || 50));
        }

        if (this.queue.length === 0) {
            this.isStreaming = false;
            this.app.ui.logToConsole('System: Plotting complete.');
        }
    }

    _bindControls() {
        document.querySelectorAll('[data-stream-action]').forEach(button => {
            button.addEventListener('click', () => {
                const action = button.dataset.streamAction;
                if (action === 'run') {
                    this.queue = []; // Clear queue to ensure we only run the current canvas state
                    if (this.app.hpgl.generateFromPaths(this.app.canvas.paths)) {
                        this.runStream();
                    }
                    return;
                }

                if (action === 'hold') {
                    this.isHold = true;
                    this.setTrafficLight('orange');
                    this.app.ui.logToConsole('System: Stream paused.');
                    return;
                }

                if (action === 'cancel') {
                    this.isStreaming = false;
                    this.isHold = false;
                    this.queue = [];
                    this.updateStats();
                    this.setTrafficLight('green'); // Ready again
                    this.app.ui.logToConsole('System: Stream cancelled.');
                }
            });
        });
    }

    async sendJogCommand(dxMM, dyMM) {
        if (!this.writer) return false;

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
        await this.sendManualCommand(`PR${unitsX},${unitsY};`);
        this.setEstimatedPosition(nextX, nextY);
        return true;
    }

    async sendHomeCommand() {
        if (!this.writer) return false;
        await this.sendManualCommand('PU;PA0,0;');
        this.setEstimatedPosition(0, 0);
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
