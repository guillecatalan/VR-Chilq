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
 *       fixedHeight: true,     // Lock Y-axis for thumbstick movement (horizontal only)
 *       triggerFly: true,      // quest/pico: left trigger = move where you look (free 3D, ignores fixedHeight)
 *       triggerFlySpeed: null, // Optional separate speed for trigger-fly (defaults to moveSpeed)
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
        this.triggerFly = options.triggerFly ?? true;
        this.triggerFlySpeed = options.triggerFlySpeed ?? null;

        // Camera Rig
        this.cameraRig = new THREE.Group();
        this.cameraRig.add(camera);
        scene.add(this.cameraRig);

        // Internal state
        this._prevTime = performance.now();
        this._snapReady = true; // Prevent snap turn from firing continuously
        this._selecting = false;
        this._leftTriggerPressed = false;
        this._rightTriggerPressed = false;
        this._teleportTarget = null;
        this._raycaster = new THREE.Raycaster();
        this._tempMatrix = new THREE.Matrix4();
        this._direction = new THREE.Vector3();
        this._worldQuat = new THREE.Quaternion(); // world-space head orientation (see note below)

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

        // Track which physical hand (left/right) each controller index belongs to.
        // The Quest/Pico runtime doesn't guarantee controller0 = left hand, so we
        // read it from the XRInputSource once it connects.
        const onConnected = (controller) => (event) => {
            controller.userData.handedness = event.data.handedness;
        };
        controller0.addEventListener('connected', onConnected(controller0));
        controller1.addEventListener('connected', onConnected(controller1));

        const onSelectStart = (controller) => () => {
            if (controller.userData.handedness === 'left') {
                this._leftTriggerPressed = true;
            } else if (controller.userData.handedness === 'right') {
                this._rightTriggerPressed = true;
            }
            // Preserve original single-controller behavior (avp/generic gaze-move & teleport)
            if (controller === controller0) {
                this._selecting = true;
            }
        };

        const onSelectEnd = (controller) => () => {
            if (controller.userData.handedness === 'left') {
                this._leftTriggerPressed = false;
            } else if (controller.userData.handedness === 'right') {
                this._rightTriggerPressed = false;
            }
            if (controller === controller0) {
                this._selecting = false;
                if (this.teleport && this._teleportTarget) {
                    this.teleportTo(this._teleportTarget);
                    this._teleportTarget = null;
                }
            }
        };

        controller0.addEventListener('selectstart', onSelectStart(controller0));
        controller0.addEventListener('selectend', onSelectEnd(controller0));
        controller1.addEventListener('selectstart', onSelectStart(controller1));
        controller1.addEventListener('selectend', onSelectEnd(controller1));

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
                    // IMPORTANT: use the WORLD orientation, not camera.quaternion.
                    // camera.quaternion is the head's rotation relative to the rig,
                    // so after a snap-turn rotates the rig, camera.quaternion no
                    // longer matches the real-world facing direction — that's what
                    // was making "forward" flip to "backward" after turning around.
                    this.camera.getWorldQuaternion(this._worldQuat);
                    this._direction.set(x, 0, z);
                    this._direction.applyQuaternion(this._worldQuat);
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

        // Left trigger: fly toward where you're looking (full 3D, ignores fixedHeight).
        // This is what makes it feel like "true" VR movement instead of being stuck on a plane.
        this._updateTriggerGazeMove(delta);
    }

    /**
     * Quest/Pico/AVP: hold the LEFT trigger to move freely along the exact
     * direction the headset is facing, including up/down — unlike the
     * thumbstick move, this is never flattened by fixedHeight.
     */
    _updateTriggerGazeMove(delta) {
        if (!this.triggerFly || !this._leftTriggerPressed) return;

        const speed = this.triggerFlySpeed ?? this.moveSpeed;

        // getWorldDirection reads matrixWorld directly, which already includes
        // the rig's rotation — unlike camera.quaternion, it stays correct after
        // snap turns.
        this.camera.getWorldDirection(this._direction);
        this.cameraRig.position.addScaledVector(this._direction, speed * delta);
    }

    /**
     * AVP (non-teleport): Pinch select to move along gaze direction
     */
    _updateGazeMove(delta) {
        if (!this._selecting) return;

        this.camera.getWorldDirection(this._direction);
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
