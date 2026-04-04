class LiveTrackerHpgl {
    constructor(app) {
        this.app = app;
    }

    toUnits(point) {
        const scale = this.app?.hpgl?.UNITS_PER_MM || 40;
        return {
            x: Math.round(point.x * scale),
            y: Math.round(point.y * scale)
        };
    }

    buildMoveCommand(machinePoint, penDown = false) {
        const units = this.toUnits(machinePoint);
        return `${penDown ? 'PD' : 'PU'}${units.x},${units.y};`;
    }

    async moveTo(machinePoint, penDown = false) {
        if (!this.app?.serial) return false;
        await this.app.serial.sendManualCommand(
            this.buildMoveCommand(machinePoint, penDown),
            { preview: false, estimatedPosition: machinePoint }
        );
        return true;
    }

    async penUp() {
        if (!this.app?.serial) return false;
        await this.app.serial.sendManualCommand('PU;', { preview: false });
        return true;
    }

    async penDown() {
        if (!this.app?.serial) return false;
        await this.app.serial.sendManualCommand('PD;', { preview: false });
        return true;
    }

    async selectPen(penNumber) {
        if (!this.app?.serial) return false;
        await this.app.serial.sendManualCommand(`SP${penNumber};`, { preview: false });
        return true;
    }

    async performPenChange(nextPen, machinePoint, enablePenMotion = true) {
        await this.penUp();
        await this.selectPen(nextPen);
        await this.moveTo(machinePoint, false);
        if (enablePenMotion) {
            await this.penDown();
        }
    }
}
