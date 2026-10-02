import * as THREE from 'three';

/**
 * XRLocomotion V10
 *
 * Designed around WebXR's actual reference-space model:
 * - Three.js XR camera remains owned by WebXR.
 * - cameraRig is the application locomotion offset.
 * - Controllers stay in Three.js XR reference space; they are NOT re-parented.
 * - Quest left trigger = free-flight forward in gaze direction.
 * - Left stick = free-flight using gaze direction (X/Y of stick).
 * - Right stick = snap/smooth yaw.
 *
 * This follows the same architectural idea documented by PlayCanvas: when XR
 * owns the camera transform, additional application movement belongs on a
 * parent rig/entity rather than overwriting the XR camera itself.
 */
class XRLocomotion {
    constructor(renderer, camera, scene, options = {}) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;

        this.device = options.device || 'quest';
        this.moveSpeed = options.moveSpeed ?? 2.5;
        this.flySpeed = options.flySpeed ?? 2.5;
        this.rotateSpeed = options.rotateSpeed ?? 1.5;
        this.snapAngle = options.snapAngle ?? 45;
        this.rotateMode = options.rotateMode || 'snap';
        this.deadzone = options.deadzone ?? 0.15;
        this.teleport = options.teleport ?? false;
        this.fixedHeight = options.fixedHeight ?? false;

        this.cameraRig = new THREE.Group();
        this.cameraRig.name = 'XR_CameraRig';
        this.cameraRig.add(camera);
        scene.add(this.cameraRig);

        this._prevTime = performance.now();
        this._snapReady = true;
        this._selecting = false;
        this._flyLeft = false;
        this._teleportTarget = null;
        this._controllers = [];

        this._direction = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3(0, 1, 0);
        this._tempMatrix = new THREE.Matrix4();
        this._raycaster = new THREE.Raycaster();
        this._floorMeshes = [];
        this._marker = null;

        this._setupControllers();
    }

    update(time, frame) {
        if (!this.renderer.xr.isPresenting) return;

        const now = performance.now();
        const delta = Math.min(0.05, Math.max(0, (now - this._prevTime) / 1000));
        this._prevTime = now;

        if (this.device === 'quest' || this.device === 'pico') {
            this._updateQuest(delta);
        } else {
            this._updateQuest(delta);
        }
    }

    getRig() {
        return this.cameraRig;
    }

    getControllers() {
        return this._controllers;
    }

    teleportTo(position) {
        this.cameraRig.position.copy(position);
    }

    setFloorMeshes(meshes) {
        this._floorMeshes = Array.isArray(meshes) ? meshes : [meshes];
    }

    dispose() {
        if (this._marker) this.scene.remove(this._marker);
    }

    _setupControllers() {
        const left = this.renderer.xr.getController(0);
        const right = this.renderer.xr.getController(1);
        this._controllers = [left, right];

        const setHandState = (source, pressed) => {
            if (!source || !source.data) return;
            if (source.data.handedness === 'left') this._flyLeft = pressed;
        };

        for (const controller of this._controllers) {
            controller.addEventListener('connected', (event) => {
                controller.userData.handedness = event.data?.handedness || '';
            });
            controller.addEventListener('selectstart', (event) => {
                setHandState(event, true);
                this._selecting = true;
            });
            controller.addEventListener('selectend', (event) => {
                setHandState(event, false);
                this._selecting = false;
            });
            // Controllers remain in the scene's XR reference space. Do not add
            // them under cameraRig; their XR matrices are owned by WebXR.
            if (!controller.parent) this.scene.add(controller);
        }
    }

    _updateQuest(delta) {
        const session = this.renderer.xr.getSession();
        if (!session) return;

        let leftX = 0;
        let leftY = 0;
        let rightX = 0;
        let leftTriggerPressed = this._flyLeft;

        for (const source of session.inputSources) {
            const gp = source.gamepad;
            if (!gp) continue;

            // WebXR standard gamepad mapping: the primary trigger is button 0.
            if (source.handedness === 'left') {
                if (gp.buttons?.[0]?.pressed) leftTriggerPressed = true;
                if (gp.axes?.length >= 4) {
                    leftX = Math.abs(gp.axes[2]) > this.deadzone ? gp.axes[2] : 0;
                    leftY = Math.abs(gp.axes[3]) > this.deadzone ? gp.axes[3] : 0;
                }
            } else if (source.handedness === 'right') {
                if (gp.axes?.length >= 4) {
                    rightX = Math.abs(gp.axes[2]) > this.deadzone ? gp.axes[2] : 0;
                }
            }
        }

        // Camera gaze direction in WORLD space. This is deliberately not
        // camera.quaternion alone: the rig's yaw must be included.
        this.camera.getWorldDirection(this._forward).normalize();
        this._right.crossVectors(this._forward, this._up).normalize();

        // Left thumbstick: free-flight in the direction of the user's gaze.
        // WebXR gamepad Y is positive when pushed backwards, hence -leftY.
        if (leftX !== 0 || leftY !== 0) {
            this._direction.set(0, 0, 0)
                .addScaledVector(this._right, leftX)
                .addScaledVector(this._forward, -leftY);
            if (this._direction.lengthSq() > 0.000001) {
                this._direction.normalize();
                this.cameraRig.position.addScaledVector(this._direction, this.moveSpeed * delta);
            }
        }

        // LEFT TRIGGER: fly continuously along the exact gaze vector.
        if (leftTriggerPressed) {
            this.cameraRig.position.addScaledVector(this._forward, this.flySpeed * delta);
        }

        // Right thumbstick: yaw only. Never modifies the XR camera itself.
        if (this.rotateMode === 'snap') {
            if (Math.abs(rightX) > 0.7 && this._snapReady) {
                this.cameraRig.rotateY(-Math.sign(rightX) * THREE.MathUtils.degToRad(this.snapAngle));
                this._snapReady = false;
            } else if (Math.abs(rightX) < 0.3) {
                this._snapReady = true;
            }
        } else if (rightX !== 0) {
            this.cameraRig.rotateY(-rightX * this.rotateSpeed * delta);
        }
    }

    // Kept for API compatibility with older builds.
    _updateThumbstick(delta) { this._updateQuest(delta); }
    _updateGazeMove(delta) { if (this._flyLeft) this._updateQuest(delta); }
    _updateSelectMove(delta) { if (this._flyLeft) this._updateQuest(delta); }
}

export { XRLocomotion };
