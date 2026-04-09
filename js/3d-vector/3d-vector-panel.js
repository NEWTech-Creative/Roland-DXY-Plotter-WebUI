class Vector3DPanel {
    constructor(app) {
        this.app = app;
        this.engine = new Vector3DWrapEngine(app);
        this.THREE = null;
        this.OrbitControls = null;
        this.OBJLoader = null;
        this.STLLoader = null;
        this.ThreeMFLoader = null;
        this.GLTFLoader = null;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.surfaceRoot = null;
        this.surfaceMesh = null;
        this.helperPlaneMesh = null;
        this.wrappedLineGroup = null;
        this.surfaceHighlightGroup = null;
        this.resizeObserver = null;
        this.interactionRenderRaf = 0;
        this.lastInteractionAt = 0;

        this.artworkPolylines = [];
        this.normalizedArtwork = [];
        this.surfaceAssignments = [];
        this.activeImportedFaceSelection = null;
        this.flattenedPaths = [];
        this.activePrimitive = 'sphere';
        this.isReady = false;

        this._bindUI();
        this._loadThreeStack()
            .then(() => this._initScene())
            .then(() => {
                this.isReady = true;
                this._setPrimitive(this.activePrimitive);
                this._setPreviewHint('Drag to orbit. Scroll to zoom.');
                this.refreshPreview();
            })
            .catch((error) => {
                this._setStatus(`Preview unavailable: ${error.message}`);
                this._setPreviewHint(`3D preview failed to load: ${error.message}`);
                this.app.ui.logToConsole(`3D Vector: ${error.message}`, 'error');
            });
    }

    _bindUI() {
        this.previewHost = document.getElementById('v3d-preview');
        this.statusEl = document.getElementById('v3d-status');
        this.modelNameEl = document.getElementById('v3d-model-name');
        this.vectorNameEl = document.getElementById('v3d-vector-name');
        this.outputNameEl = document.getElementById('v3d-output-name');
        this.previewHintEl = document.getElementById('v3d-preview-hint');
        this.selectedSurfaceEl = document.getElementById('v3d-selected-surface');
        this.qualityEl = document.getElementById('sel-v3d-quality');
        this.previewDetailEl = document.getElementById('sel-v3d-preview-detail');
        this.file3dInput = document.getElementById('input-v3d-model');
        this.fileSvgInput = document.getElementById('input-v3d-svg');
        this.selectedSurfaceTarget = 'wrap';
        this.selectedSurfaceLabel = 'Wrapped surface';
        this.availableSurfaceTargets = [{ value: 'wrap', label: 'Wrapped surface' }];
        this.selectedImportedFaces = [];

        const ids = [
            'sel-v3d-primitive',
            'sel-v3d-mode',
            'input-v3d-camera-angle',
            'input-v3d-art-offset-x',
            'input-v3d-art-offset-y',
            'input-v3d-art-scale',
            'input-v3d-art-rotation',
            'input-v3d-obj-rot-x',
            'input-v3d-obj-rot-y',
            'input-v3d-obj-rot-z',
            'input-v3d-obj-scale',
            'input-v3d-plane-pos',
            'input-v3d-plane-rot-x',
            'input-v3d-plane-rot-y',
            'input-v3d-plane-rot-z'
        ];

        ids.forEach((id) => {
            const element = document.getElementById(id);
            if (!element) return;
            const output = document.querySelector(`[data-v3d-value="${id}"]`);
            const syncValue = () => {
                if (output) output.textContent = element.value;
                if (id === 'input-v3d-camera-angle') this._applyCameraAngle(false);
                this.refreshPreview();
            };
            element.addEventListener('input', syncValue);
            element.addEventListener('change', syncValue);
            if (output) output.textContent = element.value;
        });

        document.getElementById('sel-v3d-primitive')?.addEventListener('change', (event) => {
            this.activePrimitive = event.target.value || 'sphere';
            this._updateFaceTargetOptions();
            this._setPrimitive(this.activePrimitive);
            this._setModelName(this.activePrimitive);
            this.refreshPreview();
        });
        this.qualityEl?.addEventListener('change', () => this._applyRenderQuality());
        this.previewDetailEl?.addEventListener('change', () => this.refreshPreview());

        document.getElementById('chk-v3d-plane')?.addEventListener('change', () => {
            this._syncPlaneControls();
            this.refreshPreview();
        });
        document.getElementById('chk-v3d-include-shape-line')?.addEventListener('change', () => this.refreshPreview(true));
        this._syncPlaneControls();

        document.getElementById('btn-v3d-import-model')?.addEventListener('click', () => this.file3dInput?.click());
        document.getElementById('btn-v3d-import-svg')?.addEventListener('click', () => this.fileSvgInput?.click());
        document.getElementById('btn-v3d-from-canvas')?.addEventListener('click', () => this.importFromCanvasSelection());
        document.getElementById('btn-v3d-generate')?.addEventListener('click', () => this.refreshPreview(true));
        document.getElementById('btn-v3d-add')?.addEventListener('click', () => this.addFlattenedToCanvas());
        document.getElementById('btn-v3d-export')?.addEventListener('click', () => this.exportFlattenedSvg());
        document.getElementById('btn-v3d-reset-view')?.addEventListener('click', () => this.resetView());
        document.getElementById('btn-v3d-set-front')?.addEventListener('click', () => this.setCurrentViewAsFront());
        document.getElementById('btn-v3d-reset-object')?.addEventListener('click', () => this.resetObjectSettings());
        document.getElementById('btn-v3d-reset-plane')?.addEventListener('click', () => this.resetPlaneSettings());

        this.fileSvgInput?.addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            await this.importSvgFile(file);
            event.target.value = '';
        });

        this.file3dInput?.addEventListener('change', async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            await this.importModelFile(file);
            event.target.value = '';
        });

        this._updateFaceTargetOptions();
    }

    async importSvgFile(file) {
        try {
            this._setStatus(`Loading vector: ${file.name}`);
            const text = await file.text();
            const polylines = this.engine.parseSvgPolylines(text, 5);
            if (!polylines.length) throw new Error('No linework found in SVG.');
            this._ingestArtwork(polylines, file.name);
        } catch (error) {
            this._setStatus(`Vector import failed: ${error.message}`);
            this.app.ui.logToConsole(`3D Vector: ${error.message}`, 'error');
        }
    }

    importFromCanvasSelection() {
        try {
            const polylines = this.engine.getSelectedCanvasPolylines();
            if (!polylines.length) throw new Error('Select linework on the canvas first.');
            this._ingestArtwork(polylines, 'Canvas selection');
        } catch (error) {
            this._setStatus(error.message);
            this.app.ui.logToConsole(`3D Vector: ${error.message}`, 'error');
        }
    }

    _ingestArtwork(polylines, label) {
        const normalized = this._prepareArtworkPolylines(polylines);
        if (!normalized.length) {
            this._setStatus('No usable linework found.');
            return;
        }

        if (this._shouldAssignArtworkToImportedFaces()) {
            this._replaceAssignmentsForImportedFaces(this.selectedImportedFaces);
            this.surfaceAssignments.push({
                id: `v3d_assign_${Date.now()}_${this.surfaceAssignments.length}`,
                label,
                pathCount: polylines.length,
                normalizedArtwork: normalized,
                importedFaces: this.selectedImportedFaces.map((entry) => ({ ...entry }))
            });
            const faceCount = this.selectedImportedFaces.length;
            this.artworkPolylines = [];
            this.normalizedArtwork = [];
            this._setVectorName(`${label} assigned`, polylines.length);
            this._setStatus(`Assigned ${polylines.length} path${polylines.length === 1 ? '' : 's'} to ${faceCount} face${faceCount === 1 ? '' : 's'}.`);
            this.refreshPreview(true);
            return;
        }

        this.artworkPolylines = polylines;
        this.normalizedArtwork = normalized;
        this._setVectorName(label, polylines.length);
        this.refreshPreview(true);
    }

    async importModelFile(file) {
        if (!this.isReady) return;
        this.app.ui?.showLoading?.(`Importing ${file.name}...`);
        try {
            this._setStatus(`Loading model: ${file.name}`);
            this.app.ui?.updateLoading?.(5, 'Reading model file...');
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            const fileData = await this._readModelFileWithProgress(file, ext);
            this.app.ui?.updateLoading?.(65, 'Parsing 3D geometry...');
            const model = await this._parseModelData(fileData, ext);
            this.app.ui?.updateLoading?.(82, 'Normalizing scale...');
            this._applySurfaceObject(model);
            this._setModelName(file.name);
            this._updateFaceTargetOptions(true);
            this.app.ui?.updateLoading?.(92, 'Fitting camera to object...');
            this.fitCameraToSurface();
            this.app.ui?.updateLoading?.(98, 'Refreshing preview...');
            this.refreshPreview(true);
            this.app.ui?.updateLoading?.(100, '3D model imported.');
        } catch (error) {
            this._setStatus(`Model import failed: ${error.message}`);
            this.app.ui.logToConsole(`3D Vector: ${error.message}`, 'error');
        } finally {
            window.setTimeout(() => this.app.ui?.hideLoading?.(), 180);
        }
    }

    refreshPreview(forceStatus = false) {
        if (!this.isReady || !this.surfaceMesh || !this.camera || !this.renderer) return;

        this._applyNumericTransforms();
        this._updatePlane();
        this._rebuildWrappedLines();

        const artworkJobs = this._getArtworkJobs();
        if (!artworkJobs.length) {
            this.flattenedPaths = [];
            this._setOutputName('No output yet');
            if (forceStatus) this._setStatus('Import an SVG or pull selected canvas vectors to start.');
            this._renderScene();
            return;
        }

        const mode = document.getElementById('sel-v3d-mode')?.value || 'visible';
        const activePen = this.app.ui?.activeVisualizerPen || 1;
        const isCubeWrap = (this.surfaceMesh?.userData?.surfaceType === 'cube')
            && ((this.selectedSurfaceTarget || 'wrap') === 'wrap')
            && !this.helperPlaneMesh?.visible;
        this.flattenedPaths = [];
        let totalSourcePaths = 0;
        artworkJobs.forEach((job) => {
            const result = this._runWithImportedFaceSelection(job.importedFaces, () => this.engine.buildWrappedResult({
                THREE: this.THREE,
                camera: this.camera,
                surfaceMesh: this.surfaceMesh,
                planeMesh: this.helperPlaneMesh?.visible ? this.helperPlaneMesh : null,
                artworkPolylines: job.normalizedArtwork,
                mapper: (point) => this._mapArtworkPoint(point),
                mapperPolyline: (polyline) => this._mapArtworkPolyline(polyline),
                visibilityEvaluator: (worldPoint, targets) => this._isWrappedPointVisible(worldPoint, targets),
                projectPoint: (worldPoint) => this._projectCameraPoint(worldPoint),
                includeHidden: mode === 'seethrough',
                bedWidth: this.app.settings?.bedWidth || this.app.canvas?.bedWidth || 432,
                bedHeight: this.app.settings?.bedHeight || this.app.canvas?.bedHeight || 297,
                activePen,
                enableBridging: false,
                splitOnFaceChange: isCubeWrap,
                useViewportFrame: true,
                viewportAspect: this.camera?.aspect || 1
            }));
            totalSourcePaths += job.normalizedArtwork.length;
            this.flattenedPaths.push(...result.projectedPaths);
        });

        if (this._shouldIncludeShapeLine()) {
            this.flattenedPaths = this.flattenedPaths.concat(this._buildShapeOutlinePaths(activePen));
        }
        this._setOutputName(`${this.flattenedPaths.length} path${this.flattenedPaths.length === 1 ? '' : 's'}`);
        if (forceStatus || this.flattenedPaths.length) {
            this._setStatus(`Wrapped ${totalSourcePaths} source path${totalSourcePaths === 1 ? '' : 's'} into ${this.flattenedPaths.length} flattened path${this.flattenedPaths.length === 1 ? '' : 's'}.`);
        }
        this._renderScene();
    }

    addFlattenedToCanvas() {
        if (!this.flattenedPaths.length) {
            this._setStatus('Generate flattened output first.');
            return;
        }

        const groupId = `v3d_${Date.now()}`;
        const created = this.flattenedPaths.map((path) => ({
            type: 'polyline',
            pen: path.pen || (this.app.ui?.activeVisualizerPen || 1),
            groupId,
            points: (path.points || []).map(point => ({ x: point.x, y: point.y }))
        }));

        this.app.canvas.paths.push(...created);
        this.app.canvas.selectedPaths = created.map((_, index) => this.app.canvas.paths.length - created.length + index);
        this.app.canvas.saveUndoState();
        this.app.canvas.draw();
        this.app.ui.logToConsole(`3D Vector: Sent ${created.length} flattened path${created.length === 1 ? '' : 's'} to the canvas/visualiser.`);
        this._setStatus(`Sent ${created.length} path${created.length === 1 ? '' : 's'} to the main canvas/visualiser.`);
    }

    exportFlattenedSvg() {
        if (!this.flattenedPaths.length) {
            this._setStatus('Generate flattened output first.');
            return;
        }
        const ok = this.engine.downloadSvg(this.flattenedPaths, `3d_vector_${Date.now()}.svg`);
        if (ok) {
            this.app.ui.logToConsole('3D Vector: Flattened SVG exported.');
            this._setStatus('Flattened SVG exported.');
        }
    }

    resetView() {
        if (!this.camera || !this.controls) return;
        this.controls.target.set(0, 0, 0);
        this._applyCameraAngle(true);
        this._renderScene();
        this.refreshPreview();
    }

    fitCameraToSurface() {
        if (!this.THREE || !this.surfaceMesh || !this.camera || !this.controls) return;

        const THREE = this.THREE;
        this.surfaceMesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.surfaceMesh);
        if (box.isEmpty()) {
            this.resetView();
            return;
        }

        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const maxDim = Math.max(size.x || 1, size.y || 1, size.z || 1);
        this.controls.target.copy(center);
        this._applyCameraAngle(true, center, maxDim);
        this._renderScene();
    }

    resetObjectSettings() {
        this._setInputValue('input-v3d-obj-rot-x', 0);
        this._setInputValue('input-v3d-obj-rot-y', 0);
        this._setInputValue('input-v3d-obj-rot-z', 0);
        this._setInputValue('input-v3d-obj-scale', 1);
        this.refreshPreview(true);
    }

    resetPlaneSettings() {
        const planeToggle = document.getElementById('chk-v3d-plane');
        if (planeToggle) planeToggle.checked = false;
        this._setInputValue('input-v3d-plane-pos', 0);
        this._setInputValue('input-v3d-plane-rot-x', 0);
        this._setInputValue('input-v3d-plane-rot-y', 0);
        this._setInputValue('input-v3d-plane-rot-z', 0);
        this._syncPlaneControls();
        this.refreshPreview(true);
    }

    async _loadThreeStack() {
        const version = '0.160.0';
        const base = `https://cdn.jsdelivr.net/npm/three@${version}`;
        const [threeModule, orbitModule, objModule, stlModule, threeMfModule, gltfModule] = await Promise.all([
            import(`${base}/build/three.module.js`),
            import(`${base}/examples/jsm/controls/OrbitControls.js`),
            import(`${base}/examples/jsm/loaders/OBJLoader.js`),
            import(`${base}/examples/jsm/loaders/STLLoader.js`),
            import(`${base}/examples/jsm/loaders/3MFLoader.js`),
            import(`${base}/examples/jsm/loaders/GLTFLoader.js`)
        ]);

        this.THREE = threeModule;
        this.OrbitControls = orbitModule.OrbitControls;
        this.OBJLoader = objModule.OBJLoader;
        this.STLLoader = stlModule.STLLoader;
        this.ThreeMFLoader = threeMfModule.ThreeMFLoader;
        this.GLTFLoader = gltfModule.GLTFLoader;
    }

    async _initScene() {
        const THREE = this.THREE;
        if (!this.previewHost) throw new Error('3D preview host not found.');

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f172a);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        this.camera.position.set(0, 0.25, 4.2);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(1);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.previewHost.innerHTML = '';
        this.previewHost.appendChild(this.renderer.domElement);

        this.controls = new this.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.12;
        this.controls.target.set(0, 0, 0);
        this.controls.update();
        this.controls.addEventListener('start', () => {
            this.lastInteractionAt = performance.now();
            this._startInteractionRenderLoop();
        });
        this.controls.addEventListener('change', () => {
            this.lastInteractionAt = performance.now();
            this._startInteractionRenderLoop();
            this._renderScene();
        });
        this.controls.addEventListener('end', () => this._schedulePreviewRefresh());
        this._bindSurfacePicking();

        const ambient = new THREE.AmbientLight(0xffffff, 1.15);
        const key = new THREE.DirectionalLight(0xffffff, 1.7);
        key.position.set(2.5, 2.2, 4.0);
        const rim = new THREE.DirectionalLight(0x7dd3fc, 0.6);
        rim.position.set(-3.0, -1.2, 2.0);
        this.scene.add(ambient, key, rim);

        const grid = new THREE.GridHelper(4, 8, 0x334155, 0x1e293b);
        grid.rotation.x = Math.PI / 2;
        grid.position.z = -1.05;
        this.scene.add(grid);

        const axes = new THREE.AxesHelper(1.35);
        axes.material.transparent = true;
        axes.material.opacity = 0.65;
        this.axesHelper = axes;
        this.scene.add(axes);

        this.surfaceRoot = new THREE.Group();
        this.scene.add(this.surfaceRoot);
        this.surfaceHighlightGroup = new THREE.Group();
        this.surfaceRoot.add(this.surfaceHighlightGroup);

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this._resizeRenderer());
            this.resizeObserver.observe(this.previewHost);
        }
        window.addEventListener('resize', () => this._resizeRenderer());
        this._resizeRenderer();
        this._applyRenderQuality();
        this._renderScene();
    }

    _bindSurfacePicking() {
        if (!this.renderer?.domElement) return;
        let down = null;

        this.renderer.domElement.addEventListener('pointerdown', (event) => {
            down = { x: event.clientX, y: event.clientY };
        });

        this.renderer.domElement.addEventListener('pointerup', (event) => {
            if (!down) return;
            const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
            down = null;
            if (moved > 6) return;
            this._pickSurfaceAtClientPoint(event.clientX, event.clientY, event.shiftKey || event.ctrlKey || event.metaKey);
        });
    }

    _resizeRenderer() {
        if (!this.previewHost || !this.renderer || !this.camera) return;
        const width = Math.max(100, this.previewHost.clientWidth || 100);
        const height = Math.max(100, this.previewHost.clientHeight || 100);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this._renderScene();
    }

    _renderScene() {
        if (!this.renderer || !this.scene || !this.camera) return;
        this.renderer.render(this.scene, this.camera);
    }

    _startInteractionRenderLoop() {
        if (this.interactionRenderRaf) return;
        const loop = () => {
            this.interactionRenderRaf = 0;
            if (!this.controls || !this.renderer) return;
            this.controls.update();
            this._renderScene();

            const elapsed = performance.now() - this.lastInteractionAt;
            if (elapsed < 180) {
                this.interactionRenderRaf = window.requestAnimationFrame(loop);
            } else {
                this._schedulePreviewRefresh();
            }
        };
        this.interactionRenderRaf = window.requestAnimationFrame(loop);
    }

    _schedulePreviewRefresh() {
        clearTimeout(this.previewRefreshTimer);
        this.previewRefreshTimer = setTimeout(() => {
            this.refreshPreview(false);
        }, 90);
    }

    _applyRenderQuality() {
        if (!this.renderer) return;
        const quality = this.qualityEl?.value || 'standard';
        const dpr = window.devicePixelRatio || 1;
        const pixelRatio = quality === 'eco'
            ? 0.85
            : Math.min(dpr, 1.5);
        this.renderer.setPixelRatio(pixelRatio);
        this.renderer.setClearColor(0x0f172a, 1);
        if (this.axesHelper) this.axesHelper.visible = quality !== 'eco';
        this._resizeRenderer();
        this._renderScene();
    }

    _pickSurfaceAtClientPoint(clientX, clientY, additiveSelection = false) {
        if (!this.THREE || !this.camera || !this.renderer || !this.surfaceMesh) return;
        const surfaceType = this.surfaceMesh?.userData?.surfaceType || this.activePrimitive || 'sphere';

        const rect = this.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) return;

        const x = ((clientX - rect.left) / rect.width) * 2 - 1;
        const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
        const raycaster = new this.THREE.Raycaster();
        raycaster.setFromCamera(new this.THREE.Vector2(x, y), this.camera);

        const hits = raycaster.intersectObject(this.surfaceMesh, true);
        const firstSurfaceHit = hits.find((hit) => hit?.object?.isMesh);
        if (!firstSurfaceHit) return;

        if (surfaceType === 'imported') {
            this._toggleImportedFaceSelection(firstSurfaceHit, additiveSelection);
            return;
        }

        const target = this._deriveSurfaceTargetFromHit(firstSurfaceHit);
        if (!target) return;

        const currentTarget = this.selectedSurfaceTarget || 'wrap';
        const isToggleBackToWrap = currentTarget === target.value
            && target.value !== 'wrap'
            && this.availableSurfaceTargets.some(option => option.value === 'wrap');

        if (isToggleBackToWrap) {
            this.selectedSurfaceTarget = 'wrap';
            this.selectedSurfaceLabel = (this.availableSurfaceTargets.find(option => option.value === 'wrap') || { label: 'Wrapped surface' }).label;
            this._updateSelectedSurfaceReadout();
            this._updateSurfaceHighlight();
            this._setStatus('Selected surface: Wrapped surface');
            this.refreshPreview();
            return;
        }

        this.selectedSurfaceTarget = target.value;
        this.selectedSurfaceLabel = target.label;
        this._updateSelectedSurfaceReadout();
        this._updateSurfaceHighlight();
        this._setStatus(`Selected surface: ${target.label}`);
        this.refreshPreview();
    }

    _toggleImportedFaceSelection(hit, additiveSelection = false) {
        const selection = this._normalizeImportedFaceSelection(hit);
        if (!selection) return;

        const existingIndex = this.selectedImportedFaces.findIndex((entry) => entry.key === selection.key);
        if (!additiveSelection) {
            this.selectedImportedFaces = existingIndex >= 0 && this.selectedImportedFaces.length === 1
                ? []
                : [selection];
        } else if (existingIndex >= 0) {
            this.selectedImportedFaces.splice(existingIndex, 1);
        } else {
            this.selectedImportedFaces.push(selection);
        }

        this._updateSelectedSurfaceReadout();
        this._updateSurfaceHighlight();
        const count = this.selectedImportedFaces.length;
        this._setStatus(
            count
                ? `Selected ${count} imported face${count === 1 ? '' : 's'} for vector placement.`
                : 'Selected surface: Wrapped surface only'
        );
        this.refreshPreview();
    }

    _normalizeImportedFaceSelection(hit) {
        const object = hit?.object;
        const geometry = object?.geometry;
        const faceIndex = Number.isInteger(hit?.faceIndex) ? hit.faceIndex : null;
        if (!object?.isMesh || !geometry || faceIndex == null) return null;
        return {
            key: `${object.uuid}:${faceIndex}`,
            objectUuid: object.uuid,
            faceIndex
        };
    }

    _deriveSurfaceTargetFromHit(hit) {
        const surfaceType = this.surfaceMesh?.userData?.surfaceType || this.activePrimitive || 'sphere';
        const normal = hit.face?.normal?.clone?.();
        const object = hit.object;
        if (!normal || !object) {
            return this.availableSurfaceTargets[0] || { value: 'wrap', label: 'Wrapped surface' };
        }

        const worldNormal = normal.transformDirection(object.matrixWorld).normalize();
        const localNormal = worldNormal.clone();
        if (this.surfaceRoot) {
            const inverseQuat = this.surfaceRoot.getWorldQuaternion(new this.THREE.Quaternion()).invert();
            localNormal.applyQuaternion(inverseQuat).normalize();
        }

        const absX = Math.abs(localNormal.x);
        const absY = Math.abs(localNormal.y);
        const absZ = Math.abs(localNormal.z);

        if (surfaceType === 'cube') {
            if (absZ >= absX && absZ >= absY) {
                return localNormal.z >= 0
                    ? { value: 'front', label: 'Front face' }
                    : { value: 'back', label: 'Back face' };
            }
            if (absX >= absY) {
                return localNormal.x >= 0
                    ? { value: 'right', label: 'Right face' }
                    : { value: 'left', label: 'Left face' };
            }
            return localNormal.y >= 0
                ? { value: 'top', label: 'Top face' }
                : { value: 'bottom', label: 'Bottom face' };
        }

        if (surfaceType === 'plane') return { value: 'front', label: 'Front face only' };
        if (surfaceType === 'cylinder') {
            if (absY > Math.max(absX, absZ) * 1.2) {
                return localNormal.y >= 0
                    ? { value: 'top', label: 'Top cap' }
                    : { value: 'bottom', label: 'Bottom cap' };
            }
            return { value: 'wrap', label: 'Wrapped surface' };
        }
        if (surfaceType === 'cone') {
            return localNormal.y < -0.7
                ? { value: 'base', label: 'Base face' }
                : { value: 'wrap', label: 'Wrapped surface' };
        }
        if (surfaceType === 'hemisphere') {
            return localNormal.y > 0.7
                ? { value: 'base', label: 'Base face' }
                : { value: 'wrap', label: 'Curved shell' };
        }

        return { value: 'wrap', label: 'Wrapped surface' };
    }

    _setPrimitive(name) {
        if (!this.THREE || !this.surfaceRoot) return;
        const THREE = this.THREE;
        let geometry = null;
        const baseMaterial = new THREE.MeshStandardMaterial({
            color: 0xcbd5e1,
            transparent: true,
            opacity: 0.7,
            roughness: 0.52,
            metalness: 0.08,
            emissive: 0x1e293b,
            emissiveIntensity: 0.2,
            side: THREE.DoubleSide
        });

        switch (name) {
            case 'sphere':
                geometry = new THREE.SphereGeometry(0.9, 48, 32);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(0.7, 0.7, 1.8, 48, 1, false);
                break;
            case 'cone':
                geometry = new THREE.ConeGeometry(0.9, 1.8, 48, 1, true);
                break;
            case 'cube':
                geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
                break;
            case 'plane':
                geometry = new THREE.PlaneGeometry(1.8, 1.8);
                break;
            case 'hemisphere':
                geometry = new THREE.SphereGeometry(0.9, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5);
                geometry.rotateX(Math.PI / 2);
                break;
            default:
                geometry = new THREE.SphereGeometry(0.9, 48, 32);
                break;
        }

        const mesh = new THREE.Mesh(geometry, baseMaterial);
        mesh.userData.surfaceType = name;
        this._applySurfaceObject(mesh);
        this._applyCameraAngle(true);
        this._updateFaceTargetOptions();
        this._setModelName(name);
    }

    _applySurfaceObject(object3d) {
        if (!this.surfaceRoot) return;
        this.selectedImportedFaces = [];
        this.surfaceAssignments = [];
        if (this.surfaceMesh) {
            this.surfaceRoot.remove(this.surfaceMesh);
            this.surfaceMesh.traverse?.((child) => {
                child.geometry?.dispose?.();
                if (Array.isArray(child.material)) child.material.forEach(mat => mat?.dispose?.());
                else child.material?.dispose?.();
            });
        }

        this.surfaceMesh = this._normalizeObject(object3d);
        this.surfaceRoot.add(this.surfaceMesh);
        this._applyNumericTransforms();
        this._updatePlane();
        this._updateSurfaceHighlight();
        this._renderScene();
    }

    _normalizeObject(object3d) {
        const THREE = this.THREE;
        object3d.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(object3d);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        const maxDim = Math.max(size.x || 1, size.y || 1, size.z || 1);
        const scale = 1.8 / maxDim;

        const wrapper = new THREE.Group();
        object3d.position.sub(center);
        object3d.scale.multiplyScalar(scale);

        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
        object3d.traverse((child) => {
            if (child.isMesh) {
                child.material = new THREE.MeshStandardMaterial({
                    color: 0xcbd5e1,
                    transparent: true,
                    opacity: 0.7,
                    roughness: 0.52,
                    metalness: 0.08,
                    emissive: 0x1e293b,
                    emissiveIntensity: 0.2,
                    side: THREE.DoubleSide
                });
                child.add(new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry, 25), edgeMaterial.clone()));
            }
        });

        wrapper.add(object3d);
        wrapper.userData.surfaceType = object3d.userData?.surfaceType || 'imported';
        return wrapper;
    }

    _applyNumericTransforms() {
        if (!this.surfaceRoot) return;
        const degToRad = (value) => (Number(value) || 0) * Math.PI / 180;
        const scale = Math.max(0.1, Number(document.getElementById('input-v3d-obj-scale')?.value) || 1);
        this.surfaceRoot.rotation.set(
            degToRad(document.getElementById('input-v3d-obj-rot-x')?.value),
            degToRad(document.getElementById('input-v3d-obj-rot-y')?.value),
            degToRad(document.getElementById('input-v3d-obj-rot-z')?.value)
        );
        this.surfaceRoot.scale.setScalar(scale);
        this.surfaceRoot.updateMatrixWorld(true);
        this._updateSurfaceHighlight();
    }

    _updatePlane() {
        if (!this.THREE || !this.surfaceRoot) return;
        const THREE = this.THREE;
        const enabled = !!document.getElementById('chk-v3d-plane')?.checked;
        if (!this.helperPlaneMesh) {
            const geometry = new THREE.PlaneGeometry(3.4, 3.4);
            const material = new THREE.MeshStandardMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.12,
                side: THREE.DoubleSide
            });
            this.helperPlaneMesh = new THREE.Mesh(geometry, material);
            const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({
                color: 0x38bdf8,
                transparent: true,
                opacity: 0.35
            }));
            this.helperPlaneMesh.add(wire);
            this.surfaceRoot.add(this.helperPlaneMesh);
        }

        this.helperPlaneMesh.visible = enabled;
        if (!enabled) return;

        const degToRad = (value) => (Number(value) || 0) * Math.PI / 180;
        const planeOffsetMm = Number(document.getElementById('input-v3d-plane-pos')?.value) || 0;
        const sceneUnitsPerMm = 1 / 50;
        this.helperPlaneMesh.position.set(0, 0, planeOffsetMm * sceneUnitsPerMm);
        this.helperPlaneMesh.rotation.set(
            degToRad(document.getElementById('input-v3d-plane-rot-x')?.value),
            degToRad(document.getElementById('input-v3d-plane-rot-y')?.value),
            degToRad(document.getElementById('input-v3d-plane-rot-z')?.value)
        );
        this.helperPlaneMesh.updateMatrixWorld(true);
    }

    _mapArtworkPoint(point) {
        const surfaceType = this.surfaceMesh?.userData?.surfaceType || 'imported';
        const transformed = this._applyArtworkTransform(point);
        const planeEnabled = !!this.helperPlaneMesh?.visible;
        const faceTarget = this.selectedSurfaceTarget || 'wrap';

        if (faceTarget !== 'wrap') {
            return this._mapFlatFacePoint(surfaceType, faceTarget, transformed, this.THREE);
        }

        const warpedPoint = transformed;

        if (planeEnabled) {
            return this._projectToSurfaceByRay(warpedPoint, true);
        }

        let worldPoint = null;
        if (surfaceType === 'imported') {
            worldPoint = this._projectToSurfaceByRay(warpedPoint, true);
        } else {
            worldPoint = this._mapPrimitivePoint(surfaceType, warpedPoint);
            if (!worldPoint) worldPoint = this._projectToSurfaceByRay(warpedPoint, false);
        }
        return worldPoint;
    }

    _getArtworkJobs() {
        const jobs = (this.surfaceAssignments || []).map((assignment) => ({
            normalizedArtwork: assignment.normalizedArtwork || [],
            importedFaces: assignment.importedFaces || null
        }));

        if (this.normalizedArtwork.length) {
            jobs.push({
                normalizedArtwork: this.normalizedArtwork,
                importedFaces: this._shouldAssignArtworkToImportedFaces()
                    ? this.selectedImportedFaces.map((entry) => ({ ...entry }))
                    : null
            });
        }

        return jobs.filter((job) => Array.isArray(job.normalizedArtwork) && job.normalizedArtwork.length);
    }

    _runWithImportedFaceSelection(importedFaces, work) {
        const previous = this.activeImportedFaceSelection;
        this.activeImportedFaceSelection = Array.isArray(importedFaces) && importedFaces.length
            ? importedFaces.map((entry) => ({ ...entry }))
            : null;
        try {
            return work();
        } finally {
            this.activeImportedFaceSelection = previous;
        }
    }

    _hasImportedFaceSelection() {
        return (this.surfaceMesh?.userData?.surfaceType || 'imported') === 'imported'
            && Array.isArray(this._getEffectiveImportedFaceSelection())
            && this._getEffectiveImportedFaceSelection().length > 0;
    }

    _getEffectiveImportedFaceSelection() {
        return this.activeImportedFaceSelection || this.selectedImportedFaces;
    }

    _shouldAssignArtworkToImportedFaces() {
        return (this.surfaceMesh?.userData?.surfaceType || 'imported') === 'imported'
            && Array.isArray(this.selectedImportedFaces)
            && this.selectedImportedFaces.length > 0;
    }

    _replaceAssignmentsForImportedFaces(faces) {
        const keys = new Set((faces || []).map((entry) => entry.key));
        if (!keys.size) return;
        this.surfaceAssignments = (this.surfaceAssignments || []).filter((assignment) => {
            const assignmentKeys = (assignment.importedFaces || []).map((entry) => entry.key);
            return !assignmentKeys.some((key) => keys.has(key));
        });
    }

    _getProjectionMode() {
        const value = Number(document.getElementById('input-v3d-camera-angle')?.value) || 50;
        return value <= 50 ? 'perspective' : 'straight';
    }

    _applyPerspectiveWrapWarp(surfaceType, point, planeEnabled = false) {
        return point;
    }

    _applyArtworkTransform(point) {
        const angle = ((Number(document.getElementById('input-v3d-art-rotation')?.value) || 0) * Math.PI) / 180;
        const scale = Number(document.getElementById('input-v3d-art-scale')?.value) || 1;
        const tx = (Number(document.getElementById('input-v3d-art-offset-x')?.value) || 0) / 100;
        const ty = (Number(document.getElementById('input-v3d-art-offset-y')?.value) || 0) / 100;
        const x = point.x * scale;
        const y = point.y * scale;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
            x: x * cos - y * sin + tx,
            y: x * sin + y * cos + ty
        };
    }

    _prepareArtworkPolylines(polylines) {
        const bounds = this.engine.getBounds(polylines);
        if (!bounds) return [];

        const width = Math.max(1e-6, bounds.maxX - bounds.minX);
        const height = Math.max(1e-6, bounds.maxY - bounds.minY);
        const cx = (bounds.minX + bounds.maxX) * 0.5;
        const cy = (bounds.minY + bounds.maxY) * 0.5;

        const fitted = polylines.map((polyline) => polyline.map((point) => ({
            x: (point.x - cx) / width,
            y: (point.y - cy) / height
        })));

        return this.engine.resamplePolylines(fitted, 0.0035);
    }

    _mapArtworkPolyline(polyline) {
        const surfaceType = this.surfaceMesh?.userData?.surfaceType || 'imported';
        const faceTarget = this.selectedSurfaceTarget || 'wrap';
        const planeEnabled = !!this.helperPlaneMesh?.visible;
        if (surfaceType === 'cube' && faceTarget === 'wrap' && !planeEnabled) {
            const transformed = (polyline || []).map(point => this._applyArtworkTransform(point));
            return this._mapCubeWrappedPolyline(transformed);
        }
        return (polyline || []).map(point => this._mapArtworkPoint(point)).filter(Boolean);
    }

    _mapCubeWrappedPolyline(transformedPolyline) {
        const mapped = [];
        const epsilonX = 1e-4;

        for (let i = 0; i < transformedPolyline.length; i++) {
            const current = transformedPolyline[i];
            if (!current) continue;

            if (!mapped.length) {
                const firstPoint = this._mapPrimitivePoint('cube', current);
                if (firstPoint) mapped.push(firstPoint);
            }

            if (i === transformedPolyline.length - 1) break;

            const next = transformedPolyline[i + 1];
            if (!next) continue;
            const crossings = this._getCubeWrapSeamCrossings(current, next);
            crossings.forEach((crossing) => {
                const bias = Math.sign(next.x - current.x) || 1;
                const before = this._mapPrimitivePoint('cube', {
                    x: crossing.x - bias * epsilonX,
                    y: crossing.y
                });
                const after = this._mapPrimitivePoint('cube', {
                    x: crossing.x + bias * epsilonX,
                    y: crossing.y
                });
                if (before) mapped.push(before);
                if (after) mapped.push(after);
            });

            const nextPoint = this._mapPrimitivePoint('cube', next);
            if (nextPoint) mapped.push(nextPoint);
        }

        return mapped;
    }

    _getCubeWrapSeamCrossings(a, b) {
        if (!a || !b) return [];
        const bandA = (a.x + 0.5) * 4;
        const bandB = (b.x + 0.5) * 4;
        const delta = bandB - bandA;
        if (Math.abs(delta) < 1e-9) return [];

        const minBand = Math.min(bandA, bandB);
        const maxBand = Math.max(bandA, bandB);
        const crossings = [];

        for (let seam = Math.floor(minBand) + 1; seam < maxBand; seam++) {
            const t = (seam - bandA) / delta;
            if (t <= 1e-6 || t >= 1 - 1e-6) continue;
            crossings.push({
                t,
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t
            });
        }

        crossings.sort((left, right) => left.t - right.t);
        return crossings;
    }

    _mapPrimitivePoint(surfaceType, point) {
        const THREE = this.THREE;
        if (!THREE || !this.surfaceRoot) return null;

        const faceTarget = this.selectedSurfaceTarget || 'wrap';
        if (faceTarget !== 'wrap') {
            const flatPoint = this._mapFlatFacePoint(surfaceType, faceTarget, point, THREE);
            if (flatPoint) return flatPoint;
        }

        const u = point.x;
        const v = point.y;
        let localPoint = null;
        let localNormal = null;

        switch (surfaceType) {
            case 'sphere': {
                const lon = u * Math.PI * 2;
                const lat = v * Math.PI;
                const r = 0.9;
                localPoint = new THREE.Vector3(
                    Math.sin(lon) * Math.cos(lat) * r,
                    Math.sin(lat) * r,
                    Math.cos(lon) * Math.cos(lat) * r
                );
                localNormal = localPoint.clone().normalize();
                break;
            }
            case 'hemisphere': {
                const lon = u * Math.PI * 2;
                const lat = Math.max(-Math.PI * 0.25, Math.min(Math.PI * 0.25, v * (Math.PI * 0.5)));
                const r = 0.9;
                localPoint = new THREE.Vector3(
                    Math.sin(lon) * Math.cos(lat) * r,
                    Math.cos(lon) * Math.cos(lat) * r,
                    Math.abs(Math.sin(lat)) * r
                );
                localNormal = localPoint.clone().normalize();
                break;
            }
            case 'cylinder': {
                const theta = u * Math.PI * 2;
                localPoint = new THREE.Vector3(Math.sin(theta) * 0.7, v * 1.8, Math.cos(theta) * 0.7);
                localNormal = new THREE.Vector3(localPoint.x, 0, localPoint.z).normalize();
                break;
            }
            case 'cone': {
                const theta = u * Math.PI * 2;
                const y = v * 1.8;
                const t = Math.max(0, Math.min(1, (0.9 - y) / 1.8));
                const radius = 0.9 * t;
                localPoint = new THREE.Vector3(Math.sin(theta) * radius, y, Math.cos(theta) * radius);
                localNormal = new THREE.Vector3(localPoint.x, 0.5, localPoint.z).normalize();
                break;
            }
            case 'cube': {
                const half = 0.75;
                const side = half * 2;
                const wrapped = ((((u + 0.5) % 1) + 1) % 1) * 4;
                const face = Math.floor(wrapped) % 4;
                const s = wrapped - Math.floor(wrapped);
                const y = -v * side;

                if (face === 0) {
                    localPoint = new THREE.Vector3(-half + s * side, y, half);
                    localNormal = new THREE.Vector3(0, 0, 1);
                } else if (face === 1) {
                    localPoint = new THREE.Vector3(half, y, half - s * side);
                    localNormal = new THREE.Vector3(1, 0, 0);
                } else if (face === 2) {
                    localPoint = new THREE.Vector3(half - s * side, y, -half);
                    localNormal = new THREE.Vector3(0, 0, -1);
                } else {
                    localPoint = new THREE.Vector3(-half, y, -half + s * side);
                    localNormal = new THREE.Vector3(-1, 0, 0);
                }
                localPoint.userData = { face, wrapped };
                break;
            }
            case 'plane':
                localPoint = new THREE.Vector3(u * 1.8, v * 1.8, 0);
                localNormal = new THREE.Vector3(0, 0, 1);
                break;
            default:
                return this._projectToSurfaceByRay(point, false);
        }

        return this._localSurfacePointToWorld(localPoint, localNormal);
    }

    _mapFlatFacePoint(surfaceType, faceTarget, point, THREE) {
        const local = new THREE.Vector3();
        let localNormal = null;
        switch (surfaceType) {
            case 'plane':
                local.set(point.x * 1.8, point.y * 1.8, 0);
                localNormal = new THREE.Vector3(0, 0, 1);
                break;
            case 'cube': {
                const half = 0.75;
                if (faceTarget === 'front') {
                    local.set(point.x * 1.5, point.y * 1.5, half);
                    localNormal = new THREE.Vector3(0, 0, 1);
                } else if (faceTarget === 'back') {
                    local.set(-point.x * 1.5, point.y * 1.5, -half);
                    localNormal = new THREE.Vector3(0, 0, -1);
                } else if (faceTarget === 'left') {
                    local.set(-half, point.y * 1.5, point.x * 1.5);
                    localNormal = new THREE.Vector3(-1, 0, 0);
                } else if (faceTarget === 'right') {
                    local.set(half, point.y * 1.5, -point.x * 1.5);
                    localNormal = new THREE.Vector3(1, 0, 0);
                } else if (faceTarget === 'top') {
                    local.set(point.x * 1.5, half, -point.y * 1.5);
                    localNormal = new THREE.Vector3(0, 1, 0);
                } else if (faceTarget === 'bottom') {
                    local.set(point.x * 1.5, -half, point.y * 1.5);
                    localNormal = new THREE.Vector3(0, -1, 0);
                }
                else return null;
                break;
            }
            case 'cylinder': {
                const r = 0.7;
                if (faceTarget === 'top') {
                    local.set(point.x * r, 0.9, -point.y * r);
                    localNormal = new THREE.Vector3(0, 1, 0);
                } else if (faceTarget === 'bottom') {
                    local.set(point.x * r, -0.9, point.y * r);
                    localNormal = new THREE.Vector3(0, -1, 0);
                }
                else return null;
                break;
            }
            case 'cone': {
                const r = 0.9;
                if (faceTarget === 'base') {
                    local.set(point.x * r, -0.9, point.y * r);
                    localNormal = new THREE.Vector3(0, -1, 0);
                }
                else return null;
                break;
            }
            case 'hemisphere': {
                const r = 0.9;
                if (faceTarget === 'base') {
                    local.set(point.x * r, 0, point.y * r);
                    localNormal = new THREE.Vector3(0, 1, 0);
                }
                else return null;
                break;
            }
            default:
                return null;
        }
        return this._localSurfacePointToWorld(local, localNormal);
    }

    _localSurfacePointToWorld(localPoint, localNormal = null) {
        if (!localPoint) return null;
        const worldPoint = this.surfaceRoot.localToWorld(localPoint.clone());
        if (!localNormal || !this.THREE) return worldPoint;

        const worldNormal = localNormal.clone()
            .transformDirection(this.surfaceRoot.matrixWorld)
            .normalize();
        worldPoint.add(worldNormal.clone().multiplyScalar(0.012));

        const face = localPoint.userData?.face;
        const wrapped = localPoint.userData?.wrapped;
        if (face != null) worldPoint._v3dFace = face;
        if (wrapped != null) worldPoint._v3dWrapped = wrapped;
        worldPoint._v3dNormal = worldNormal.clone();
        return worldPoint;
    }

    _projectToSurfaceByRay(point, includePlane) {
        const THREE = this.THREE;
        if (!THREE || !this.surfaceMesh || !this.surfaceRoot) return null;

        const bounds = new THREE.Box3().setFromObject(this.surfaceMesh);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        bounds.getSize(size);
        bounds.getCenter(center);

        const localWidth = Math.max(1.2, size.x * 1.1);
        const localHeight = Math.max(1.2, size.y * 1.1);
        const localDepth = Math.max(1.2, size.z * 1.1);

        const localOrigin = new THREE.Vector3(
            center.x + point.x * localWidth,
            center.y + point.y * localHeight,
            center.z + localDepth * 2.2
        );
        const localTarget = new THREE.Vector3(localOrigin.x, localOrigin.y, center.z - localDepth * 2.2);
        const worldOrigin = this.surfaceRoot.localToWorld(localOrigin.clone());
        const worldTarget = this.surfaceRoot.localToWorld(localTarget.clone());
        const direction = worldTarget.sub(worldOrigin).normalize();

        const raycaster = new THREE.Raycaster(worldOrigin, direction, 0.0001, localDepth * 6);
        const targets = [this.surfaceMesh];
        if (includePlane && this.helperPlaneMesh?.visible) targets.push(this.helperPlaneMesh);
        const hits = raycaster.intersectObjects(targets, true);
        if (!hits.length) return null;

        let hit = null;
        for (const candidate of hits) {
            if (!candidate?.object?.isMesh) continue;
            if (this._hasImportedFaceSelection() && !this._isImportedFaceHitSelected(candidate)) continue;
            const isPlaneHit = !!(this.helperPlaneMesh && (candidate.object === this.helperPlaneMesh || this.helperPlaneMesh.children.includes(candidate.object)));
            if (!includePlane || !this.helperPlaneMesh?.visible || isPlaneHit || !this._isBehindActivePlane(candidate.point)) {
                hit = candidate;
                break;
            }
        }
        if (!hit) return null;

        const hitPoint = hit.point.clone();
        const isPlaneHit = !!(this.helperPlaneMesh && (hit.object === this.helperPlaneMesh || this.helperPlaneMesh.children.includes(hit.object)));
        hitPoint._v3dSurface = isPlaneHit ? 'plane' : 'object';
        const normal = hit.face?.normal?.clone?.();
        if (normal && hit.object) {
            const worldNormal = normal.transformDirection(hit.object.matrixWorld).normalize();
            hitPoint._v3dNormal = worldNormal.clone();
            if (isPlaneHit && this.camera) {
                const toCamera = this.camera.position.clone().sub(hitPoint).normalize();
                hitPoint.add(toCamera.multiplyScalar(0.008));
            } else {
                hitPoint.add(worldNormal.clone().multiplyScalar(0.01));
            }
        }
        return hitPoint;
    }

    _isImportedFaceHitSelected(hit) {
        if (!this._hasImportedFaceSelection()) return true;
        const activeSelection = this._getEffectiveImportedFaceSelection();
        const faceIndex = Number.isInteger(hit?.faceIndex) ? hit.faceIndex : null;
        const objectUuid = hit?.object?.uuid;
        if (faceIndex == null || !objectUuid) return false;
        return activeSelection.some((entry) => entry.objectUuid === objectUuid && entry.faceIndex === faceIndex);
    }

    _projectToPlaneCandidate(point) {
        if (!this.THREE || !this.helperPlaneMesh || !this.helperPlaneMesh.visible || !this.surfaceRoot) return null;
        const THREE = this.THREE;
        const localOrigin = new THREE.Vector3(point.x * 2.2, point.y * 2.2, 3.5);
        const localTarget = new THREE.Vector3(localOrigin.x, localOrigin.y, -3.5);
        const worldOrigin = this.surfaceRoot.localToWorld(localOrigin.clone());
        const worldTarget = this.surfaceRoot.localToWorld(localTarget.clone());
        const direction = worldTarget.sub(worldOrigin).normalize();
        const raycaster = new THREE.Raycaster(worldOrigin, direction, 0.0001, 20);
        const hits = raycaster.intersectObject(this.helperPlaneMesh, true);
        if (!hits.length) return null;
        const pointHit = hits[0].point.clone();
        pointHit._v3dSurface = 'plane';
        const planeNormal = new this.THREE.Vector3(0, 0, 1)
            .applyQuaternion(this.helperPlaneMesh.getWorldQuaternion(new this.THREE.Quaternion()))
            .normalize();
        pointHit.add(planeNormal.clone().multiplyScalar(0.01));
        pointHit._v3dNormal = planeNormal.clone();
        return pointHit;
    }

    _projectCameraPoint(worldPoint) {
        if (!this.camera || !worldPoint) return null;
        const projected = worldPoint.clone().project(this.camera);
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;
        return {
            x: (projected.x + 1) * 0.5,
            y: 1 - ((projected.y + 1) * 0.5)
        };
    }

    _projectWrappedPoint(worldPoint) {
        if (!worldPoint || !this.camera) return null;
        if (this._getProjectionMode() === 'perspective') {
            return this._projectPerspectivePoint(worldPoint);
        }
        return this._projectOrthographicPoint(worldPoint);
    }

    _projectOrthographicPoint(worldPoint) {
        if (!this.camera || !worldPoint) return null;
        const viewPoint = worldPoint.clone().applyMatrix4(this.camera.matrixWorldInverse);
        if (!Number.isFinite(viewPoint.x) || !Number.isFinite(viewPoint.y)) return null;
        return {
            x: viewPoint.x,
            y: -viewPoint.y
        };
    }

    _projectPerspectivePoint(worldPoint) {
        if (!this.camera || !this.surfaceRoot || !worldPoint) return null;
        const viewPoint = worldPoint.clone().applyMatrix4(this.camera.matrixWorldInverse);
        const centerWorld = this.surfaceRoot.getWorldPosition(new this.THREE.Vector3());
        const centerView = centerWorld.applyMatrix4(this.camera.matrixWorldInverse);
        const depthStats = this._getSurfaceViewDepthStats();
        const depth = -viewPoint.z;
        const centerDepth = -centerView.z;
        const frontDepth = depthStats?.frontDepth ?? centerDepth;
        const backDepth = depthStats?.backDepth ?? centerDepth;
        const depthRange = Math.max(1e-4, backDepth - frontDepth);
        const frontness = Math.max(0, Math.min(1, (backDepth - depth) / depthRange));

        const isPlanePoint = worldPoint._v3dSurface === 'plane';
        const strength = isPlanePoint
            ? 1
            : (this.helperPlaneMesh?.visible ? 0.95 : 0.55);
        const scale = 1 + (frontness * strength);

        return {
            x: viewPoint.x * scale,
            y: -viewPoint.y * scale
        };
    }

    _applyCameraAngle(resetDirection = false, forcedCenter = null, forcedMaxDim = null) {
        if (!this.THREE || !this.camera || !this.controls || !this.surfaceMesh) return;

        const THREE = this.THREE;
        this.surfaceMesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.surfaceMesh);
        if (box.isEmpty()) return;

        const center = forcedCenter || box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = forcedMaxDim || Math.max(size.x || 1, size.y || 1, size.z || 1);
        const lensValue = Math.max(1, Math.min(100, Number(document.getElementById('input-v3d-camera-angle')?.value) || 50));
        const lensT = (lensValue - 1) / 99;
        const distanceFactor = 0.55 + lensT * 2.7;
        const framingFactor = maxDim * 0.9;
        const distance = Math.max(1.2, framingFactor * distanceFactor);
        const fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(framingFactor / distance)), 18, 110);

        let direction = this.camera.position.clone().sub(this.controls.target);
        if (resetDirection || direction.lengthSq() < 1e-6) {
            direction = new THREE.Vector3(0.35, 0.18, 1);
        }
        direction.normalize();

        this.controls.target.copy(center);
        this.camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
        this.camera.fov = fov;
        this.camera.near = Math.max(0.01, distance / 100);
        this.camera.far = Math.max(50, distance * 12);
        this.camera.updateProjectionMatrix();
        this.controls.update();
    }

    setCurrentViewAsFront() {
        if (!this.surfaceMesh || !this.surfaceRoot || !this.camera || !this.controls || !this.THREE) return;

        const THREE = this.THREE;
        const cameraDirWorld = this.controls.target.clone().sub(this.camera.position).normalize();
        const rootRotation = new THREE.Matrix4().extractRotation(this.surfaceRoot.matrixWorld);
        const localViewDir = cameraDirWorld.clone().transformDirection(rootRotation.invert());
        const alignToFront = new THREE.Quaternion().setFromUnitVectors(
            localViewDir.normalize(),
            new THREE.Vector3(0, 0, -1)
        );

        this.surfaceMesh.quaternion.premultiply(alignToFront);
        this.surfaceMesh.updateMatrixWorld(true);

        this._setInputValue('input-v3d-obj-rot-x', 0);
        this._setInputValue('input-v3d-obj-rot-y', 0);
        this._setInputValue('input-v3d-obj-rot-z', 0);
        this.surfaceRoot.rotation.set(0, 0, 0);
        this.surfaceRoot.updateMatrixWorld(true);

        this.fitCameraToSurface();
        this._setStatus('Current view baked in as the new front.');
        this.refreshPreview(true);
    }

    _getSurfaceViewDepthStats() {
        if (!this.THREE || !this.camera || !this.surfaceMesh) return null;

        const box = new this.THREE.Box3().setFromObject(this.surfaceMesh);
        if (box.isEmpty()) return null;

        const corners = [
            new this.THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new this.THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new this.THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new this.THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new this.THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new this.THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new this.THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new this.THREE.Vector3(box.max.x, box.max.y, box.max.z)
        ];

        let frontDepth = Infinity;
        let backDepth = -Infinity;

        corners.forEach((corner) => {
            const viewCorner = corner.clone().applyMatrix4(this.camera.matrixWorldInverse);
            const depth = -viewCorner.z;
            if (!Number.isFinite(depth)) return;
            frontDepth = Math.min(frontDepth, depth);
            backDepth = Math.max(backDepth, depth);
        });

        if (!Number.isFinite(frontDepth) || !Number.isFinite(backDepth)) return null;
        return { frontDepth, backDepth };
    }

    _isBehindActivePlane(worldPoint) {
        if (!this.THREE || !this.helperPlaneMesh || !this.helperPlaneMesh.visible || !this.camera || !worldPoint) {
            return false;
        }

        const planePosition = new this.THREE.Vector3();
        const planeQuaternion = new this.THREE.Quaternion();
        this.helperPlaneMesh.getWorldPosition(planePosition);
        this.helperPlaneMesh.getWorldQuaternion(planeQuaternion);

        const planeNormal = new this.THREE.Vector3(0, 0, 1).applyQuaternion(planeQuaternion).normalize();
        const cameraVector = this.camera.position.clone().sub(planePosition);

        if (planeNormal.dot(cameraVector) < 0) {
            planeNormal.multiplyScalar(-1);
        }

        const signedDistance = worldPoint.clone().sub(planePosition).dot(planeNormal);
        return signedDistance < -1e-4;
    }

    _rebuildWrappedLines() {
        if (!this.THREE || !this.surfaceRoot) return;
        if (this.wrappedLineGroup) {
            this.surfaceRoot.remove(this.wrappedLineGroup);
            this.wrappedLineGroup.traverse((child) => {
                child.geometry?.dispose?.();
                if (Array.isArray(child.material)) child.material.forEach(mat => mat?.dispose?.());
                else child.material?.dispose?.();
            });
        }

        this.wrappedLineGroup = new this.THREE.Group();
        this.surfaceRoot.add(this.wrappedLineGroup);

        if (!this.normalizedArtwork.length) return;

        const mode = document.getElementById('sel-v3d-mode')?.value || 'visible';
        const previewTargets = [this.surfaceMesh];
        if (this.helperPlaneMesh?.visible) previewTargets.push(this.helperPlaneMesh);
        const isCubeWrap = (this.surfaceMesh?.userData?.surfaceType === 'cube')
            && ((this.selectedSurfaceTarget || 'wrap') === 'wrap');

        this._getArtworkJobs().forEach((job) => {
            this._runWithImportedFaceSelection(job.importedFaces, () => {
                const forcePreviewVisible = Array.isArray(job.importedFaces) && job.importedFaces.length > 0;
                this._getPreviewArtworkPolylines(job.normalizedArtwork, job.importedFaces).forEach(polyline => {
                    const mappedPoints = this._mapArtworkPolyline(polyline);
                    if (mappedPoints.length < 2) return;

                    const segmentPoints = [];

                    for (let i = 1; i < mappedPoints.length; i++) {
                        const a = mappedPoints[i - 1];
                        const b = mappedPoints[i];
                        const visibleA = forcePreviewVisible || mode === 'seethrough' || this._isWrappedPointVisible(a, previewTargets);
                        const visibleB = forcePreviewVisible || mode === 'seethrough' || this._isWrappedPointVisible(b, previewTargets);
                        if (!visibleA || !visibleB) continue;

                        const faceA = a?._v3dFace ?? null;
                        const faceB = b?._v3dFace ?? null;
                        if (isCubeWrap && faceA !== null && faceB !== null && faceA !== faceB) continue;

                        segmentPoints.push(this._offsetPreviewPoint(a), this._offsetPreviewPoint(b));
                    }

                    this._commitWrappedPreviewSegments(segmentPoints, mode);
                });
            });
        });
    }

    _getPreviewArtworkPolylines(sourcePolylines = this.normalizedArtwork, importedFaces = null) {
        if (Array.isArray(importedFaces) && importedFaces.length) {
            return sourcePolylines;
        }

        const stride = this._getPreviewPolylineStride();
        if (stride <= 1) return sourcePolylines;

        return (sourcePolylines || []).map((polyline) => {
            if (!Array.isArray(polyline) || polyline.length <= 2) return polyline;
            const reduced = [polyline[0]];
            for (let i = stride; i < polyline.length - 1; i += stride) {
                reduced.push(polyline[i]);
            }
            reduced.push(polyline[polyline.length - 1]);
            return reduced;
        }).filter(polyline => polyline.length >= 2);
    }

    _getPreviewPolylineStride() {
        const detail = this.previewDetailEl?.value || 'medium';
        if (detail === 'full') return 1;
        if (detail === 'low') return 6;
        return 3;
    }

    _commitWrappedPreviewSegments(segmentPoints, mode) {
        if (!Array.isArray(segmentPoints) || segmentPoints.length < 2) return;
        const geometry = new this.THREE.BufferGeometry().setFromPoints(segmentPoints);
        const material = new this.THREE.LineBasicMaterial({
            color: mode === 'seethrough' ? 0xf59e0b : 0x38bdf8,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false
        });
        const line = new this.THREE.LineSegments(geometry, material);
        line.renderOrder = 20;
        this.wrappedLineGroup.add(line);
    }

    _shouldIncludeShapeLine() {
        return !!document.getElementById('chk-v3d-include-shape-line')?.checked;
    }

    _buildShapeOutlinePaths(activePen) {
        const projectedLines = this._buildProjectedShapeLinePolylines();
        if (!projectedLines.length) return [];

        return this.engine._fitProjectedPolylines(
            projectedLines,
            this.app.settings?.bedWidth || this.app.canvas?.bedWidth || 432,
            this.app.settings?.bedHeight || this.app.canvas?.bedHeight || 297,
            activePen,
            true,
            this.camera?.aspect || 1
        ).map(path => ({
            ...path,
            isShapeOutline: true
        }));
    }

    _buildProjectedShapeLinePolylines() {
        if (!this.THREE || !this.surfaceMesh || !this.camera) return [];

        const THREE = this.THREE;
        const mode = document.getElementById('sel-v3d-mode')?.value || 'visible';
        const previewTargets = [this.surfaceMesh];
        if (this.helperPlaneMesh?.visible) previewTargets.push(this.helperPlaneMesh);
        const projectedLines = [];
        const pointA = new THREE.Vector3();
        const pointB = new THREE.Vector3();
        const midpoint = new THREE.Vector3();
        const surfaceType = this.surfaceMesh?.userData?.surfaceType || 'imported';

        this.surfaceMesh.updateMatrixWorld(true);
        this.surfaceMesh.traverse((child) => {
            if (!child?.isMesh || !child.geometry?.attributes?.position) return;
            const lineGeometry = surfaceType === 'imported'
                ? new THREE.WireframeGeometry(child.geometry)
                : new THREE.EdgesGeometry(child.geometry, 25);
            const positions = lineGeometry.attributes?.position;
            const count = positions?.count || 0;
            if (!count) {
                lineGeometry.dispose?.();
                return;
            }

            for (let i = 0; i < count - 1; i += 2) {
                pointA.fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld);
                pointB.fromBufferAttribute(positions, i + 1).applyMatrix4(child.matrixWorld);
                midpoint.copy(pointA).add(pointB).multiplyScalar(0.5);

                if (mode !== 'seethrough' && !this._isWrappedPointVisible(midpoint, previewTargets)) {
                    continue;
                }

                const projectedA = this._projectCameraPoint(pointA);
                const projectedB = this._projectCameraPoint(pointB);
                if (projectedA && projectedB) {
                    projectedLines.push([projectedA, projectedB]);
                }
            }

            lineGeometry.dispose?.();
        });

        return projectedLines;
    }

    _offsetPreviewPoint(point) {
        if (point?._v3dSurface === 'plane' && this.camera) {
            const toCamera = this.camera.position.clone().sub(point).normalize().multiplyScalar(0.008);
            return point.clone().add(toCamera);
        }
        if (point?._v3dSurface === 'object' && (this.activeImportedFaceSelection?.length || this.selectedImportedFaces?.length) && this.camera) {
            const toCamera = this.camera.position.clone().sub(point).normalize().multiplyScalar(0.014);
            return point.clone().add(toCamera);
        }
        if (point?._v3dNormal) {
            return point.clone().add(point._v3dNormal.clone().multiplyScalar(0.01));
        }
        if (!this.camera) return point.clone();
        const offset = this.camera.position.clone().sub(point).normalize().multiplyScalar(0.004);
        return point.clone().add(offset);
    }

    _isWrappedPointVisible(worldPoint, targets) {
        if (!worldPoint) return false;
        if (this.helperPlaneMesh?.visible && !worldPoint._v3dSurface?.startsWith?.('plane') && this._isBehindActivePlane(worldPoint)) {
            return false;
        }
        if (worldPoint._v3dSurface === 'plane') {
            return this._isPlanePointVisible(worldPoint, targets);
        }
        if (worldPoint._v3dNormal && this.camera) {
            const toCamera = this.camera.position.clone().sub(worldPoint).normalize();
            return worldPoint._v3dNormal.dot(toCamera) > 0.05;
        }
        return this.engine._isPointVisible(this.camera, worldPoint, targets, this.THREE);
    }

    _isPlanePointVisible(worldPoint, targets) {
        if (!this.THREE || !this.camera || !worldPoint) return false;

        const origin = this.camera.position.clone();
        const direction = worldPoint.clone().sub(origin);
        const distanceToPoint = direction.length();
        if (distanceToPoint <= 1e-5) return true;

        const raycaster = new this.THREE.Raycaster(origin, direction.normalize(), 0.0001, distanceToPoint + 0.02);
        const hits = raycaster.intersectObjects(targets || [], true);
        if (!hits.length) return true;

        const planeObjects = new Set([
            this.helperPlaneMesh,
            ...(this.helperPlaneMesh?.children || [])
        ].filter(Boolean));
        const tolerance = 0.035;

        for (const hit of hits) {
            if (!hit?.object?.isMesh) continue;
            const isPlaneHit = planeObjects.has(hit.object);
            if (isPlaneHit) continue;
            if (hit.distance < distanceToPoint - tolerance) return false;
            if (Math.abs(hit.distance - distanceToPoint) <= tolerance) return true;
        }

        return true;
    }

    async _parseModelData(fileData, ext) {
        if (ext === 'obj') {
            return new this.OBJLoader().parse(fileData);
        }

        if (ext === 'stl') {
            const geometry = new this.STLLoader().parse(fileData);
            geometry.computeBoundingBox?.();
            geometry.computeVertexNormals?.();
            return new this.THREE.Mesh(geometry, new this.THREE.MeshStandardMaterial());
        }

        if (ext === '3mf') {
            return new this.ThreeMFLoader().parse(fileData);
        }

        if (ext === 'glb' || ext === 'gltf') {
            return await new Promise((resolve, reject) => {
                new this.GLTFLoader().parse(fileData, '', (gltf) => resolve(gltf.scene || gltf.scenes?.[0]), reject);
            });
        }

        throw new Error(`Unsupported model type: .${ext}`);
    }

    _readModelFileWithProgress(file, ext) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onprogress = (event) => {
                if (!event.lengthComputable) return;
                const pct = 5 + Math.round((event.loaded / event.total) * 50);
                this.app.ui?.updateLoading?.(pct, `Reading model file... ${Math.round((event.loaded / event.total) * 100)}%`);
            };
            reader.onerror = () => reject(new Error('Failed to read model file.'));
            reader.onload = () => resolve(reader.result);

            if (ext === 'obj') reader.readAsText(file);
            else reader.readAsArrayBuffer(file);
        });
    }

    _syncPlaneControls() {
        const enabled = !!document.getElementById('chk-v3d-plane')?.checked;
        document.querySelectorAll('[data-v3d-plane-control]').forEach((element) => {
            element.disabled = !enabled;
        });
    }

    _setStatus(text) {
        if (this.statusEl) this.statusEl.textContent = text;
    }

    _setModelName(name) {
        if (this.modelNameEl) this.modelNameEl.textContent = name || 'None';
    }

    _setVectorName(name, count) {
        if (this.vectorNameEl) this.vectorNameEl.textContent = count ? `${name} (${count})` : (name || 'None');
    }

    _setOutputName(name) {
        if (this.outputNameEl) this.outputNameEl.textContent = name || 'None';
    }

    _setPreviewHint(text) {
        if (this.previewHintEl) this.previewHintEl.textContent = text || '';
    }

    _setInputValue(id, value) {
        const input = document.getElementById(id);
        if (!input) return;
        input.value = value;
        const output = document.querySelector(`[data-v3d-value="${id}"]`);
        if (output) output.textContent = String(value);
    }

    _updateFaceTargetOptions(forceImported = false) {
        const surfaceType = forceImported ? 'imported' : (this.surfaceMesh?.userData?.surfaceType || this.activePrimitive || 'sphere');
        const options = this._getFaceTargetOptions(surfaceType);
        const current = this.selectedSurfaceTarget;
        this.availableSurfaceTargets = options;
        const hasCurrent = options.some(option => option.value === current);
        this.selectedSurfaceTarget = hasCurrent ? current : options[0].value;
        this.selectedSurfaceLabel = (options.find(option => option.value === this.selectedSurfaceTarget) || options[0]).label;
        if (surfaceType !== 'imported') this.selectedImportedFaces = [];
        this._updateSelectedSurfaceReadout();
        this._updateSurfaceHighlight();
    }

    _getFaceTargetOptions(surfaceType) {
        if (surfaceType === 'imported') {
            return [
                { value: 'wrap', label: 'Wrapped surface only' }
            ];
        }

        switch (surfaceType) {
            case 'cube':
                return [
                    { value: 'wrap', label: 'Wrapped surface' },
                    { value: 'front', label: 'Front face' },
                    { value: 'back', label: 'Back face' },
                    { value: 'left', label: 'Left face' },
                    { value: 'right', label: 'Right face' },
                    { value: 'top', label: 'Top face' },
                    { value: 'bottom', label: 'Bottom face' }
                ];
            case 'plane':
                return [
                    { value: 'front', label: 'Front face only' }
                ];
            case 'cylinder':
                return [
                    { value: 'wrap', label: 'Wrapped surface' },
                    { value: 'top', label: 'Top cap' },
                    { value: 'bottom', label: 'Bottom cap' }
                ];
            case 'cone':
                return [
                    { value: 'wrap', label: 'Wrapped surface' },
                    { value: 'base', label: 'Base face' }
                ];
            case 'hemisphere':
                return [
                    { value: 'wrap', label: 'Curved shell' },
                    { value: 'base', label: 'Base face' }
                ];
            default:
                return [
                    { value: 'wrap', label: 'Wrapped surface' }
                ];
        }
    }

    _updateSelectedSurfaceReadout() {
        if (!this.selectedSurfaceEl) return;
        if (this._hasImportedFaceSelection()) {
            const count = this.selectedImportedFaces.length;
            this.selectedSurfaceEl.textContent = `${count} face${count === 1 ? '' : 's'} selected`;
            return;
        }
        this.selectedSurfaceEl.textContent = this.selectedSurfaceLabel || 'Wrapped surface';
    }

    _updateSurfaceHighlight() {
        if (!this.THREE || !this.surfaceHighlightGroup) return;

        while (this.surfaceHighlightGroup.children.length) {
            const child = this.surfaceHighlightGroup.children.pop();
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) child.material.forEach(mat => mat?.dispose?.());
            else child.material?.dispose?.();
        }

        const surfaceType = this.surfaceMesh?.userData?.surfaceType || this.activePrimitive || 'sphere';
        const target = this.selectedSurfaceTarget || 'wrap';
        if (surfaceType === 'imported') {
            const highlight = this._buildImportedFaceHighlight();
            if (highlight) this.surfaceHighlightGroup.add(highlight);
            return;
        }
        if (target === 'wrap') return;

        const highlight = this._buildSurfaceHighlight(surfaceType, target);
        if (highlight) this.surfaceHighlightGroup.add(highlight);
    }

    _buildImportedFaceHighlight() {
        if (!this.THREE || !this._hasImportedFaceSelection()) return null;

        const THREE = this.THREE;
        const fillMaterial = new THREE.MeshBasicMaterial({
            color: 0x7dd3fc,
            transparent: true,
            opacity: 0.18,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x7dd3fc,
            transparent: true,
            opacity: 0.95
        });
        const group = new THREE.Group();

        this.selectedImportedFaces.forEach((entry) => {
            const mesh = this.surfaceMesh.getObjectByProperty('uuid', entry.objectUuid);
            const geometry = mesh?.geometry;
            if (!mesh?.isMesh || !geometry?.attributes?.position) return;

            const positions = geometry.attributes.position;
            const index = geometry.index;
            const vertexIndices = index
                ? [index.getX(entry.faceIndex * 3), index.getX(entry.faceIndex * 3 + 1), index.getX(entry.faceIndex * 3 + 2)]
                : [entry.faceIndex * 3, entry.faceIndex * 3 + 1, entry.faceIndex * 3 + 2];
            if (vertexIndices.some((value) => value == null || value >= positions.count)) return;

            const vertices = vertexIndices.map((vertexIndex) => {
                const point = new THREE.Vector3().fromBufferAttribute(positions, vertexIndex);
                return mesh.localToWorld(point);
            });

            const triangleGeometry = new THREE.BufferGeometry().setFromPoints(vertices);
            triangleGeometry.setIndex([0, 1, 2]);
            const triangleMesh = new THREE.Mesh(triangleGeometry, fillMaterial.clone());
            group.add(triangleMesh);

            const lineGeometry = new THREE.BufferGeometry().setFromPoints([
                vertices[0], vertices[1],
                vertices[1], vertices[2],
                vertices[2], vertices[0]
            ]);
            group.add(new THREE.LineSegments(lineGeometry, lineMaterial.clone()));
        });

        return group.children.length ? group : null;
    }

    _buildSurfaceHighlight(surfaceType, target) {
        const THREE = this.THREE;
        if (!THREE) return null;

        const fillMaterial = new THREE.MeshBasicMaterial({
            color: 0x7dd3fc,
            transparent: true,
            opacity: 0.16,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const lineMaterial = new THREE.LineBasicMaterial({
            color: 0x7dd3fc,
            transparent: true,
            opacity: 0.95
        });
        const group = new THREE.Group();

        const addFace = (geometry, position, rotation, normal) => {
            const mesh = new THREE.Mesh(geometry, fillMaterial.clone());
            if (position) mesh.position.copy(position);
            if (rotation) mesh.rotation.set(rotation.x, rotation.y, rotation.z);
            if (normal) mesh.position.add(normal.clone().multiplyScalar(0.022));
            group.add(mesh);

            const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lineMaterial.clone());
            if (position) outline.position.copy(position);
            if (rotation) outline.rotation.set(rotation.x, rotation.y, rotation.z);
            if (normal) outline.position.add(normal.clone().multiplyScalar(0.024));
            group.add(outline);
        };

        if (surfaceType === 'cube') {
            const half = 0.75;
            const geom = new THREE.PlaneGeometry(1.5, 1.5);
            if (target === 'front') addFace(geom, new THREE.Vector3(0, 0, half), new THREE.Euler(0, 0, 0), new THREE.Vector3(0, 0, 1));
            else if (target === 'back') addFace(geom, new THREE.Vector3(0, 0, -half), new THREE.Euler(0, Math.PI, 0), new THREE.Vector3(0, 0, -1));
            else if (target === 'left') addFace(geom, new THREE.Vector3(-half, 0, 0), new THREE.Euler(0, -Math.PI / 2, 0), new THREE.Vector3(-1, 0, 0));
            else if (target === 'right') addFace(geom, new THREE.Vector3(half, 0, 0), new THREE.Euler(0, Math.PI / 2, 0), new THREE.Vector3(1, 0, 0));
            else if (target === 'top') addFace(geom, new THREE.Vector3(0, half, 0), new THREE.Euler(-Math.PI / 2, 0, 0), new THREE.Vector3(0, 1, 0));
            else if (target === 'bottom') addFace(geom, new THREE.Vector3(0, -half, 0), new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Vector3(0, -1, 0));
            else return null;
            return group;
        }

        if (surfaceType === 'plane' && target === 'front') {
            addFace(new THREE.PlaneGeometry(1.8, 1.8), new THREE.Vector3(0, 0, 0), new THREE.Euler(0, 0, 0), new THREE.Vector3(0, 0, 1));
            return group;
        }

        if (surfaceType === 'cylinder') {
            const disk = new THREE.CircleGeometry(0.7, 48);
            if (target === 'top') addFace(disk, new THREE.Vector3(0, 0.9, 0), new THREE.Euler(-Math.PI / 2, 0, 0), new THREE.Vector3(0, 1, 0));
            else if (target === 'bottom') addFace(disk, new THREE.Vector3(0, -0.9, 0), new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Vector3(0, -1, 0));
            else return null;
            return group;
        }

        if (surfaceType === 'cone' && target === 'base') {
            addFace(new THREE.CircleGeometry(0.9, 48), new THREE.Vector3(0, -0.9, 0), new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Vector3(0, -1, 0));
            return group;
        }

        if (surfaceType === 'hemisphere' && target === 'base') {
            addFace(new THREE.CircleGeometry(0.9, 48), new THREE.Vector3(0, 0, 0), new THREE.Euler(-Math.PI / 2, 0, 0), new THREE.Vector3(0, 1, 0));
            return group;
        }

        return null;
    }
}

if (typeof module !== 'undefined') module.exports = Vector3DPanel;
else window.Vector3DPanel = Vector3DPanel;
