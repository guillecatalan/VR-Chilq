import * as THREE from 'three';

/**
 * XR Locomotion Controller
 *
 * Multi-device VR locomotion solution:
 * - quest/pico: Thumbstick continuous movement + snap/smooth rotation
 * - avp: Pinch select gaze-direction movement / teleport
 * - generic: Select-hold gaze movement (universal fallback)
 *
 * Usage:
 *   const locomotion = new XRLocomotion(renderer, camera, scene, {
 *       device: 'quest',       // 'quest' | 'pico' | 'avp' | 'generic'
 *       moveSpeed: 3,          // Movement speed (m/s)
 *       rotateSpeed: 1.5,      // Rotation speed (smooth rotation only)
 *       snapAngle: 45,         // Snap turn angle (degrees)
 *       rotateMode: 'snap',    // 'snap' | 'smooth'
 *       deadzone: 0.15,        // Thumbstick deadzone
 *       teleport: false,       // AVP teleport mode
 *       fixedHeight: true,     // Lock Y-axis (horizontal movement only)
 *   });
 *
 *   // In the animation loop
 *   renderer.setAnimationLoop((time, frame) => {
 *       locomotion.update(time, frame);
 *       renderer.render(scene, camera);
 *   });
 */
class XRLocomotion {
    constructor(renderer, camera, scene, options = {}) {
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;

        // Configuration
        this.device = options.device || 'generic';
        this.moveSpeed = options.moveSpeed ?? 3;
        this.rotateSpeed = options.rotateSpeed ?? 1.5;
        this.snapAngle = options.snapAngle ?? 45;
        this.rotateMode = options.rotateMode || 'snap';
        this.deadzone = options.deadzone ?? 0.15;
        this.teleport = options.teleport ?? false;
        this.fixedHeight = options.fixedHeight ?? true;

        // Camera Rig
        this.cameraRig = new THREE.Group();
        this.cameraRig.add(camera);
        scene.add(this.cameraRig);

        // Internal state
        this._prevTime = performance.now();
        this._snapReady = true; // Prevent snap turn from firing continuously
        this._selecting = false;
        this._teleportTarget = null;
        this._raycaster = new THREE.Raycaster();
        this._tempMatrix = new THREE.Matrix4();
        this._direction = new THREE.Vector3();

        // Teleport marker
        this._marker = null;
        this._floorMeshes = [];

        // Controllers
        this._controllers = [];
        this._setupControllers();
    }

    // ─── Public API ─────────────────────────────────────────

    /**
     * Call every frame to process movement and rotation logic.
     */
    update(time, frame) {
        if (!this.renderer.xr.isPresenting) return;

        const now = performance.now();
        const delta = (now - this._prevTime) / 1000; // 秒
        this._prevTime = now;

        switch (this.device) {
            case 'quest':
            case 'pico':
                this._updateThumbstick(delta);
                break;
            case 'avp':
                if (this.teleport) {
                    this._updateTeleport();
                } else {
                    this._updateGazeMove(delta);
                }
                break;
            case 'generic':
            default:
                this._updateSelectMove(delta);
                break;
        }
    }

    /**
     * Set floor meshes for teleport raycasting (teleport mode only).
     */
    setFloorMeshes(meshes) {
        this._floorMeshes = Array.isArray(meshes) ? meshes : [meshes];
    }

    /**
     * Get the camera rig group for external position control.
     */
    getRig() {
        return this.cameraRig;
    }

    /**
     * Manually set rig position (teleport to coordinates).
     */
    teleportTo(position) {
        this.cameraRig.position.copy(position);
    }

    /**
     * Dispose: remove controllers and event listeners.
     */
    dispose() {
        for (const ctrl of this._controllers) {
            this.scene.remove(ctrl);
        }
        if (this._marker) {
            this.scene.remove(this._marker);
        }
    }

    // ─── Internal Methods ─────────────────────────────────────────

    _setupControllers() {
        const controller0 = this.renderer.xr.getController(0);
        const controller1 = this.renderer.xr.getController(1);

        controller0.addEventListener('selectstart', () => {
            this._selecting = true;
        });
        controller0.addEventListener('selectend', () => {
            this._selecting = false;
            if (this.teleport && this._teleportTarget) {
                this.teleportTo(this._teleportTarget);
                this._teleportTarget = null;
            }
        });

        this.scene.add(controller0);
        this.scene.add(controller1);
        this._controllers = [controller0, controller1];

        // Teleport marker for floor indication
        if (this.teleport || this.device === 'avp') {
            this._marker = new THREE.Mesh(
                new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
                new THREE.MeshBasicMaterial({ color: 0x00ff88, opacity: 0.7, transparent: true })
            );
            this._marker.visible = false;
            this.scene.add(this._marker);
        }
    }

    /**
     * Quest/Pico: Thumbstick continuous movement + snap/smooth rotation
     */
    _updateThumbstick(delta) {
        const session = this.renderer.xr.getSession();
        if (!session) return;

        for (const source of session.inputSources) {
            if (!source.gamepad) continue;

            const axes = source.gamepad.axes;
            // Typically: axes[2] = X (left/right), axes[3] = Y (forward/back)

            if (source.handedness === 'left') {
                // Left thumbstick: movement
                const x = Math.abs(axes[2]) > this.deadzone ? axes[2] : 0;
                const z = Math.abs(axes[3]) > this.deadzone ? axes[3] : 0;

                if (x !== 0 || z !== 0) {
                    this._direction.set(x, 0, z);
                    this._direction.applyQuaternion(this.camera.quaternion);
                    if (this.fixedHeight) this._direction.y = 0;
                    this._direction.normalize();
                    this.cameraRig.position.addScaledVector(this._direction, this.moveSpeed * delta);
                }
            }

            if (source.handedness === 'right') {
                // Right thumbstick: rotation
                const rotX = Math.abs(axes[2]) > this.deadzone ? axes[2] : 0;

                if (this.rotateMode === 'snap') {
                    if (Math.abs(rotX) > 0.7 && this._snapReady) {
                        const angle = -Math.sign(rotX) * THREE.MathUtils.degToRad(this.snapAngle);
                        this.cameraRig.rotateY(angle);
                        this._snapReady = false;
                    } else if (Math.abs(rotX) < 0.3) {
                        this._snapReady = true;
                    }
                } else {
                    // smooth rotation
                    if (rotX !== 0) {
                        this.cameraRig.rotateY(-rotX * this.rotateSpeed * delta);
                    }
                }
            }
        }
    }

    /**
     * AVP (non-teleport): Pinch select to move along gaze direction
     */
    _updateGazeMove(delta) {
        if (!this._selecting) return;

        this._direction.set(0, 0, -1);
        this._direction.applyQuaternion(this.camera.quaternion);
        if (this.fixedHeight) this._direction.y = 0;
        this._direction.normalize();
        this.cameraRig.position.addScaledVector(this._direction, this.moveSpeed * delta);
    }

    /**
     * AVP (teleport): Point at floor to teleport
     */
    _updateTeleport() {
        const controller = this._controllers[0];
        if (!controller) return;

        this._tempMatrix.identity().extractRotation(controller.matrixWorld);
        this._raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
        this._raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this._tempMatrix);

        const intersects = this._raycaster.intersectObjects(this._floorMeshes);

        if (intersects.length > 0 && this._selecting) {
            this._teleportTarget = intersects[0].point.clone();
            if (this._marker) {
                this._marker.position.copy(this._teleportTarget);
                this._marker.visible = true;
            }
        } else {
            this._teleportTarget = null;
            if (this._marker) this._marker.visible = false;
        }
    }

    /**
     * Generic: Select-hold to move along gaze direction
     */
    _updateSelectMove(delta) {
        this._updateGazeMove(delta);
    }
}

export { XRLocomotion };
