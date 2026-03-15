class SerialManager {
    constructor(app) {
        this.app = app;
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.isConnected = false;

        this.queue = [];
        this.isStreaming = false;
        this.isHold = false;

        this.indicatorEls = Array.from(document.querySelectorAll('[data-stream-indicator]'));
        this.linesStatEls = Array.from(document.querySelectorAll('[data-stat="lines"]'));
        this.queueStatEls = Array.from(document.querySelectorAll('[data-stat="queue"]'));

        this._bindControls();
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
            this.app.updateConnectionState(true);
            this.app.ui.logToConsole(`Connected at ${baudRate} baud`);
            this.setTrafficLight('green');

            // Set up streams
            this._startReading();
            this.writer = this.port.writable.getWriter();

            // Initialize plotter
            this.sendManualCommand('IN;');

        } catch (err) {
            this.app.ui.logToConsole(`Error: ${err.message}`, 'error');
        }
    }

    async disconnect() {
        this.isConnected = false;
        this.isStreaming = false;
        this.queue = [];
        this.updateStats();

        if (this.reader) {
            await this.reader.cancel();
            this.reader = null;
        }
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        if (this.port) {
            await this.port.close();
            this.port = null;
        }

        this.app.updateConnectionState(false);
        this.app.ui.logToConsole('Disconnected.');
        this.setTrafficLight('red');
    }

    async _startReading() {
        const textDecoder = new TextDecoderStream();
        this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
        this.reader = textDecoder.readable.getReader();

        try {
            while (true) {
                const { value, done } = await this.reader.read();
                if (done) break;
                if (value) {
                    this.app.ui.logToConsole(`RX: ${value.trim()}`);
                    // Minimal response tracking could go here
                }
            }
        } catch (error) {
            // Read error
        } finally {
            this.reader.releaseLock();
        }
    }

    async sendManualCommand(cmd) {
        if (!this.writer) return;
        const out = cmd.endsWith(';') ? cmd : cmd + ';';
        this.app.ui.logToConsole(out, 'tx');

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
            const cmd = this.queue.shift();
            await this.sendManualCommand(cmd);
            this.commandDelay = 50; // Default fast delay

            this.incrementLinesStat();
            this.updateStats();

            // Configurable delay based on "Machine Send Speed" setting to prevent buffer overflow
            // In a real robust system, XON/XOFF parsing or buffer polling via 'OA;' would be needed,
            // but for generic web usb/serial a configurable blind delay is often the fallback.
            await new Promise(r => setTimeout(r, this.commandDelay));
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
