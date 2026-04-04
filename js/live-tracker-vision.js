class LiveTrackerVision {
    constructor(app, options = {}) {
        this.app = app;
        this.onUpdate = options.onUpdate || (() => { });
        this.onStatus = options.onStatus || (() => { });
        this.videoEl = document.getElementById('live-tracker-video');
        this.overlayCanvas = document.getElementById('live-tracker-video-canvas');
        this.overlayCtx = this.overlayCanvas ? this.overlayCanvas.getContext('2d') : null;
        this.stream = null;
        this.handLandmarker = null;
        this.running = false;
        this.rafId = 0;
        this.lastVideoTime = -1;
        this.deviceChangeHandler = null;
    }

    async ensureModel() {
        if (this.handLandmarker) return this.handLandmarker;
        this.onStatus('Loading hand tracker model...');
        const mpVision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
        const vision = await mpVision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
        this.handLandmarker = await mpVision.HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
            },
            numHands: 2,
            runningMode: 'VIDEO',
            minHandDetectionConfidence: 0.55,
            minHandPresenceConfidence: 0.55,
            minTrackingConfidence: 0.55
        });
        return this.handLandmarker;
    }

    async getVideoDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(device => device.kind === 'videoinput');
        const merged = [];
        const seenKeys = new Set();

        const addDevice = (device) => {
            if (!device) return;
            const key = `${device.deviceId || ''}|${device.label || ''}|${device.groupId || ''}`;
            if (seenKeys.has(key)) return;
            seenKeys.add(key);
            merged.push(device);
        };

        videoInputs.forEach(device => {
            addDevice(device);
        });

        const currentTrack = this.stream?.getVideoTracks?.()?.[0] || null;
        const currentSettings = currentTrack?.getSettings?.() || {};
        if (currentTrack) {
            addDevice({
                kind: 'videoinput',
                deviceId: currentSettings.deviceId || '__current_camera__',
                groupId: currentSettings.groupId || '',
                label: currentTrack.label || 'Current Camera'
            });
        }

        return merged;
    }

    async start(deviceId = '') {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Webcam access is not supported in this browser.');
        }

        await this.ensureModel();
        const constraints = deviceId
            ? { video: { deviceId: { exact: deviceId } }, audio: false }
            : { video: { facingMode: 'user' }, audio: false };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.videoEl.srcObject = this.stream;
        await this.videoEl.play();
        this.running = true;
        this.lastVideoTime = -1;
        this.bindDeviceChangeListener();
        this.onStatus('Camera live');
        this.loop();
    }

    stop() {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        if (this.videoEl) {
            this.videoEl.pause();
            this.videoEl.srcObject = null;
        }
        this.unbindDeviceChangeListener();
        this.clearOverlay();
        this.onStatus('Camera idle');
    }

    bindDeviceChangeListener() {
        if (!navigator.mediaDevices?.addEventListener || this.deviceChangeHandler) return;
        this.deviceChangeHandler = async () => {
            try {
                const devices = await this.getVideoDevices();
                this.onStatus(`Camera live (${devices.length} found)`);
            } catch (_) {
                // ignore device refresh errors
            }
        };
        navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeHandler);
    }

    unbindDeviceChangeListener() {
        if (!navigator.mediaDevices?.removeEventListener || !this.deviceChangeHandler) return;
        navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler);
        this.deviceChangeHandler = null;
    }

    clearOverlay() {
        if (!this.overlayCtx || !this.overlayCanvas) return;
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    resizeOverlay() {
        if (!this.overlayCanvas || !this.videoEl) return;
        const stage = this.overlayCanvas.parentElement;
        const width = Math.round(stage?.clientWidth || this.videoEl.clientWidth || this.videoEl.videoWidth || 640);
        const height = Math.round(stage?.clientHeight || this.videoEl.clientHeight || this.videoEl.videoHeight || 480);
        if (this.overlayCanvas.width !== width) this.overlayCanvas.width = width;
        if (this.overlayCanvas.height !== height) this.overlayCanvas.height = height;
    }

    getDisplayedVideoRect() {
        const canvasWidth = this.overlayCanvas?.width || 1;
        const canvasHeight = this.overlayCanvas?.height || 1;
        const videoWidth = this.videoEl?.videoWidth || canvasWidth;
        const videoHeight = this.videoEl?.videoHeight || canvasHeight;
        const canvasAspect = canvasWidth / canvasHeight;
        const videoAspect = videoWidth / videoHeight;

        if (!Number.isFinite(canvasAspect) || !Number.isFinite(videoAspect) || canvasAspect <= 0 || videoAspect <= 0) {
            return { left: 0, top: 0, width: canvasWidth, height: canvasHeight };
        }

        if (videoAspect > canvasAspect) {
            const width = canvasWidth;
            const height = width / videoAspect;
            return {
                left: 0,
                top: (canvasHeight - height) / 2,
                width,
                height
            };
        }

        const height = canvasHeight;
        const width = height * videoAspect;
        return {
            left: (canvasWidth - width) / 2,
            top: 0,
            width,
            height
        };
    }

    getFingerStates(landmarks, handedness = 'Right') {
        const wrist = landmarks[0];
        const thumbCmc = landmarks[1];
        const thumbMcp = landmarks[2];
        const thumbTip = landmarks[4];
        const thumbIp = landmarks[3];
        const indexTip = landmarks[8];
        const indexPip = landmarks[6];
        const indexMcp = landmarks[5];
        const middleTip = landmarks[12];
        const middlePip = landmarks[10];
        const middleMcp = landmarks[9];
        const ringTip = landmarks[16];
        const ringPip = landmarks[14];
        const ringMcp = landmarks[13];
        const pinkyTip = landmarks[20];
        const pinkyPip = landmarks[18];
        const pinkyMcp = landmarks[17];

        const pointDistance = (a, b) => Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
        const isStraight = (a, b, c) => {
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const bcx = c.x - b.x;
            const bcy = c.y - b.y;
            const abLen = Math.hypot(abx, aby) || 1;
            const bcLen = Math.hypot(bcx, bcy) || 1;
            const dot = (abx * bcx) + (aby * bcy);
            return (dot / (abLen * bcLen)) > 0.55;
        };
        const fingerUp = (tip, pip, mcp) => {
            const verticalOpen = tip.y < pip.y - 0.012 && pip.y < mcp.y + 0.01;
            const tipToWrist = pointDistance(tip, wrist);
            const pipToWrist = pointDistance(pip, wrist);
            const mcpToWrist = pointDistance(mcp, wrist);
            const distanceOpen = tipToWrist > pipToWrist + 0.012 && tipToWrist > mcpToWrist + 0.025;
            const foldedNearPalm = tipToWrist < mcpToWrist + 0.012;
            const straight = isStraight(mcp, pip, tip);
            if (foldedNearPalm) return false;
            return (verticalOpen && distanceOpen) || (distanceOpen && straight);
        };

        const thumbToWrist = pointDistance(thumbTip, wrist);
        const thumbIpToWrist = pointDistance(thumbIp, wrist);
        const thumbMcpToWrist = pointDistance(thumbMcp, wrist);
        const thumbPalmDistance = pointDistance(thumbTip, indexMcp);
        const thumbBaseDistance = pointDistance(thumbMcp, indexMcp);
        const thumbStraight = isStraight(thumbCmc, thumbIp, thumbTip);
        const thumbLateral = handedness === 'Left'
            ? thumbTip.x > thumbIp.x + 0.008
            : thumbTip.x < thumbIp.x - 0.008;
        const thumbOpenDistance = thumbToWrist > thumbIpToWrist + 0.008 && thumbToWrist > thumbMcpToWrist + 0.022;
        const thumbFoldedNearPalm = thumbToWrist < thumbMcpToWrist + 0.012 && thumbPalmDistance < thumbBaseDistance + 0.012;
        const thumbVisibleSpread =
            thumbPalmDistance > thumbBaseDistance + 0.018 ||
            pointDistance(thumbTip, thumbMcp) > pointDistance(thumbIp, thumbMcp) + 0.02 ||
            Math.abs(thumbTip.x - thumbMcp.x) > 0.035 ||
            Math.abs(thumbTip.y - thumbMcp.y) > 0.04;
        const thumbExtended = !thumbFoldedNearPalm && thumbOpenDistance && thumbVisibleSpread && (thumbStraight || thumbLateral);

        const states = {
            Thumb: thumbExtended,
            Index: fingerUp(indexTip, indexPip, indexMcp),
            Middle: fingerUp(middleTip, middlePip, middleMcp),
            Ring: fingerUp(ringTip, ringPip, ringMcp),
            Pinky: fingerUp(pinkyTip, pinkyPip, pinkyMcp)
        };

        const extendedCount = Object.values(states).filter(Boolean).length;
        const fingertipDistance = [thumbTip, indexTip, middleTip, ringTip, pinkyTip]
            .map(point => Math.hypot(point.x - wrist.x, point.y - wrist.y));
        const averageDistance = fingertipDistance.reduce((sum, value) => sum + value, 0) / fingertipDistance.length;
        const compactHand = averageDistance < 0.19 && fingertipDistance.filter(distance => distance < 0.2).length >= 4;
        const closedFist = extendedCount === 0 && compactHand;

        return {
            states,
            closedFist,
            extendedFingers: Object.entries(states).filter(([, up]) => up).map(([name]) => name)
        };
    }

    normalizePoint(point, mirrored) {
        return {
            x: mirrored ? (1 - point.x) : point.x,
            y: point.y
        };
    }

    getHandPresentation(landmarks, handedness = 'Right') {
        const wrist = landmarks[0];
        const indexMcp = landmarks[5];
        const pinkyMcp = landmarks[17];
        const ax = indexMcp.x - wrist.x;
        const ay = indexMcp.y - wrist.y;
        const bx = pinkyMcp.x - wrist.x;
        const by = pinkyMcp.y - wrist.y;
        const normalZ = (ax * by) - (ay * bx);
        const backOfHand = handedness === 'Right' ? normalZ > 0 : normalZ < 0;

        return {
            normalZ,
            backOfHand,
            label: backOfHand ? 'Back of Hand' : 'Palm / Front'
        };
    }

    drawOverlay(result, settings = {}) {
        if (!this.overlayCtx || !this.overlayCanvas) return;
        this.resizeOverlay();
        this.clearOverlay();
        if (!result?.landmarks?.length) return;

        const ctx = this.overlayCtx;
        const width = this.overlayCanvas.width;
        const height = this.overlayCanvas.height;
        const showDebug = settings.showDebug === true;
        const showLabels = settings.showLabels !== false;
        const highlightActive = settings.highlightActive !== false;
        const activeSource = settings.movementSource === 'wrist' ? 'Wrist' : 'Index';
        const mirror = settings.mirror === true;
        const displayRect = this.getDisplayedVideoRect();
        const markerSize = 8;
        const markerHalf = markerSize / 2;
        const labelOffsetX = 10;
        const labelOffsetY = 6;

        const keyPoints = [
            { name: 'Wrist', index: 0 },
            { name: 'Thumb', index: 4 },
            { name: 'Index', index: 8 },
            { name: 'Middle', index: 12 },
            { name: 'Ring', index: 16 },
            { name: 'Pinky', index: 20 }
        ];

        keyPoints.forEach(item => {
            if (!showDebug && item.name !== 'Wrist' && item.name !== activeSource) return;
            const landmark = result.landmarks[item.index];
            if (!landmark) return;
            const x = displayRect.left + ((mirror ? (1 - landmark.x) : landmark.x) * displayRect.width);
            const y = displayRect.top + (landmark.y * displayRect.height);
            const isActive = highlightActive && item.name === activeSource;
            const fingerState = item.name === 'Wrist' ? null : result.fingerStates?.states?.[item.name];
            ctx.beginPath();
            ctx.lineWidth = isActive ? 2 : 1.5;
            ctx.strokeStyle = isActive ? '#f59e0b' : (fingerState ? '#22c55e' : '#ef4444');
            ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
            ctx.rect(x - markerHalf, y - markerHalf, markerSize, markerSize);
            ctx.fill();
            ctx.stroke();

            if (showLabels) {
                ctx.font = '10px Outfit, sans-serif';
                ctx.fillStyle = '#f8fafc';
                const suffix = item.name === 'Wrist' ? '' : (fingerState ? ' Up' : ' Down');
                ctx.fillText(`${item.name}${suffix}`, x + labelOffsetX, y - labelOffsetY);
            }
        });

        if (showLabels) {
            ctx.font = '11px Outfit, sans-serif';
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(`Detected: ${result.detectedFingerLabel || 'None'}`, 12, height - 60);
            ctx.fillText(`Gesture: ${result.gestureLabel || 'None'}`, 12, height - 44);
            ctx.fillText(`Pending: ${result.pendingActionLabel || result.activePenLabel || 'Up / Move'}`, 12, height - 28);
            ctx.fillText(`Action: ${result.activePenLabel || 'Up / Move'}`, 12, height - 10);
        }
    }

    loop() {
        if (!this.running || !this.handLandmarker || !this.videoEl) return;
        this.rafId = requestAnimationFrame(() => this.loop());
        if (this.videoEl.readyState < 2) return;
        if (this.videoEl.currentTime === this.lastVideoTime) return;
        this.lastVideoTime = this.videoEl.currentTime;
        this.resizeOverlay();

        const detection = this.handLandmarker.detectForVideo(this.videoEl, performance.now());
        const hands = (detection?.landmarks || []).map((landmarks, index) => ({
            landmarks,
            handedness: detection?.handednesses?.[index]?.[0]?.categoryName || 'Right',
            score: detection?.handednesses?.[index]?.[0]?.score || 0
        }));
        const selected = hands.find(hand => hand.handedness === 'Right') || hands[0] || null;
        const landmarks = selected?.landmarks || null;
        const handedness = selected?.handedness || 'Right';

        if (!landmarks) {
            this.onUpdate({ hasHand: false, landmarks: null, gestureLabel: 'No hand' });
            return;
        }

        const fingerStates = this.getFingerStates(landmarks, handedness);
        const handPresentation = this.getHandPresentation(landmarks, handedness);
        this.onUpdate({
            hasHand: true,
            handedness,
            landmarks,
            confidence: 1,
            fingerStates,
            handPresentation
        });
    }
}
