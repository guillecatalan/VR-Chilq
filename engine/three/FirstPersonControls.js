import { EventDispatcher, Vector3, Quaternion } from 'three';

const _mouseMoveChange = { type: 'movechange' };
const _mouseMoveEnd = { type: 'moveend' };
const _target = new Vector3();

const controlKeys = ['Shift', 'a', 'A', 's', 'S', 'd', 'D', 'w', 'W', 'q', 'Q', 'e', 'E'];

export class FirstPersonControls extends EventDispatcher {
    constructor(camera, container) {
        super();
        this._camera = camera;
        this._container = container;

        this.enabled = false;
        this.movementSpeed = 1.0;

        // Vertical axis (yaw axis): follow camera.up so Y-up / Z-up scenes both work
        this._configUp = camera.up.clone().normalize();

        const forwardDir = new Vector3();
        camera.getWorldDirection(forwardDir);
        this._target = camera.position.clone().add(forwardDir);

        this._keys = {};
        this._mouseMovingLeft = false; // Left mouse button pressed and moving
        this._mouseMovingRight = false; // Right mouse button pressed and moving

        this._wheelDelta = 0.0; // Wheel delta
        this._panDeltaY = 0.0; // Vertical pan delta
        this._panDeltaX = 0; // Horizontal pan delta
        this._rotateDelta = 0.0; // Rotation delta
        this._pitchDelta = 0.0; // Pitch delta
        this._dampingFactor = 0.15;
        this._moveDelta = new Vector3(0, 0, 0); // Movement delta

        this._panSpeed = 2.5;
        this._rotateSpeed = 2.5 / 4;
        this._pitchSpeed = 2.5 / 4;
        this._shiftCoeff = 3;

        this._moving = false;
        this._targetDirty = false;
        this._lastClientX = undefined;
        this._lastClientY = undefined;
        this._deltaTimeArr = [];

        this._container.addEventListener('pointerdown', this._onMouseDownFunc);
        this._container.addEventListener('pointerup', this._onMouseUpFunc);
        this._container.addEventListener('pointercancel', this._onMouseUpFunc);
        this._container.addEventListener('pointerout', this._onMouseUpFunc);
        this._container.addEventListener('pointermove', this._onMouseMoveFunc, false);
        this._container.addEventListener('wheel', this._onMouseWheelFunc, { passive: false });
        window.addEventListener('keydown', this._onKeyDownFunc);
        window.addEventListener('keyup', this._onKeyUpFunc);
        window.addEventListener('keypress', this._onKeyPressFunc);
        window.addEventListener('blur', this._onBlurFunc);
    }

    _onMouseDownFunc = (evt) => {
        this._onMouseDown(evt);
    };

    _onMouseUpFunc = (evt) => {
        this._onMouseUp(evt);
    };

    _onMouseMoveFunc = (evt) => {
        this._onMouseMove(evt);
    };

    _onMouseWheelFunc = (evt) => {
        this._onMouseWheel(evt);
    };

    _onKeyDownFunc = (evt) => {
        this._onKeyDown(evt);
    };

    _onKeyUpFunc = (evt) => {
        this._onKeyUp(evt);
    };

    _onKeyPressFunc = (evt) => {
        this._onKeyPress(evt);
    };

    _onBlurFunc = () => {
        this._clearInput();
    };

    get _moveFactory() {
        return 1 / window.innerHeight;
    }

    get _inNonLimited() {
        return this._moving || this._mouseMovingLeft;
    }

    lookAt(x, y, z) {
        if (x.isVector3) {
            _target.copy(x);
        } else {
            _target.set(x, y, z);
        }
        this._camera.lookAt(_target);
        this._updateTarget();
        return this;
    }

    _updateTarget() {
        const direction = new Vector3();
        this._camera.getWorldDirection(direction);
        this._target.copy(this._camera.position).add(direction);
        this._targetDirty = false;
    }

    _setTarget(pos) {
        this._target.copy(pos);
        this._targetDirty = true;
    }

    _clearInput() {
        this._mouseMovingLeft = false;
        this._mouseMovingRight = false;
        Object.keys(this._keys).forEach((key) => {
            this._keys[key] = false;
        });
        this._wheelDelta = 0.0;
        this._panDeltaY = 0;
        this._panDeltaX = 0;
        this._rotateDelta = 0;
        this._pitchDelta = 0;
        this._moveDelta.set(0, 0, 0);
    }

    _onKeyDown(evt) {
        if (!this.enabled) return;
        // Ctrl/Meta combos are reserved for shortcuts and do not trigger movement
        if (evt.ctrlKey || evt.metaKey) {
            return;
        }
        if (controlKeys.includes(evt.key)) {
            evt.preventDefault();
        }
        if (evt.repeat) {
            return;
        }
        this._keys[evt.key.toLowerCase()] = true;
    }

    _onKeyPress(evt) {
        if (controlKeys.includes(evt.key)) {
            evt.preventDefault();
        }
    }

    _onKeyUp(evt) {
        this._keys[evt.key.toLowerCase()] = false;
    }

    _onMouseDown(evt) {
        if (!this.enabled || !(evt.target instanceof HTMLCanvasElement)) {
            return;
        }

        evt.stopPropagation();
        if (evt.button == 0) {
            // left
            this._mouseMovingLeft = true;
            this._rotateDelta = 0;
            this._pitchDelta = 0;
        } else if (evt.button == 2) {
            // right
            this._mouseMovingRight = true;
            this._panDeltaY = 0.0;
            this._panDeltaX = 0;
        }
    }

    _onMouseUp(evt) {
        evt.stopPropagation();
        if (this._mouseMovingLeft || this._mouseMovingRight) {
            this.dispatchEvent({ ..._mouseMoveEnd, payload: {} });
        }
        this._mouseMovingLeft = false;
        this._mouseMovingRight = false;
        this._lastClientX = undefined;
        this._lastClientY = undefined;
    }

    _onMouseMove(evt) {
        if (!this.enabled) return;
        evt.stopPropagation();

        this._onMouseMoveDefault(evt);

        if (this._mouseMovingLeft || this._mouseMovingRight) {
            this.dispatchEvent(_mouseMoveChange);
        }
    }

    _onMouseMoveDefault(evt) {
        if (this._mouseMovingLeft) {
            const deltaX = evt.movementX * this._moveFactory * -1;
            const deltaY = evt.movementY * this._moveFactory;

            if (this._lastClientX === undefined) {
                this._lastClientX = evt.clientX;
            }
            if (this._lastClientY === undefined) {
                this._lastClientY = evt.clientY;
            }

            this._rotateDelta += deltaX;
            this._pitchDelta += deltaY;

            this._lastClientX = evt.clientX;
            this._lastClientY = evt.clientY;
        } else if (this._mouseMovingRight) {
            this._panDeltaY += (evt.movementY / 20.0) * -1;
            this._panDeltaX += (evt.movementX / 20.0) * -1;
        }
    }

    _onMouseWheel(evt) {
        if (!this.enabled) return;
        evt.stopPropagation();

        if (evt.deltaY > 0) {
            this._wheelDelta -= 2;
        } else {
            this._wheelDelta += 2;
        }
    }

    _calMoveDelta(deltaTime) {
        const camera = this._camera;
        const moveDir = new Vector3(0, 0, 0);

        let speed = this.movementSpeed * 1.2;
        if (this._keys['shift']) {
            speed *= this._shiftCoeff;
        }

        if (this._keys['w'] || this._keys['s'] || this._keys['arrowup'] || this._keys['arrowdown']) {
            const forwardMoveDir = new Vector3();
            camera.getWorldDirection(forwardMoveDir); // Get the unit vector of the camera facing direction

            // Scale the movement direction; speed is the movement speed, deltaTime is the time delta
            forwardMoveDir.multiplyScalar(speed * deltaTime);

            // Adjust direction based on the 's' key or vertical mouse movement
            if (this._keys['s'] || this._keys['arrowdown']) {
                forwardMoveDir.multiplyScalar(-1); // Move backward
            }

            // Accumulate into the total movement direction vector
            moveDir.add(forwardMoveDir);
        }

        const forward = new Vector3();
        camera.getWorldDirection(forward);
        const up = new Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
        const right = forward.clone().cross(up);

        if (this._keys['a'] || this._keys['d'] || this._keys['arrowleft'] || this._keys['arrowright']) {
            right.multiplyScalar(speed * deltaTime);

            if (this._keys['a'] || this._keys['arrowleft']) {
                right.multiplyScalar(-1.0);
            }
            moveDir.add(right);
        } else if (this._mouseMovingRight) {
            const scalar = this._panDeltaX * this._panSpeed * 20 * deltaTime;
            moveDir.add(right.multiplyScalar(scalar));
            this._panDeltaX = 0;
        }

        this._moveDelta.add(moveDir);
    }

    _calMoveWheel(deltaTime) {
        const delta = Math.abs(this._wheelDelta);
        if (delta < 0.00001) return;

        let speed = this._panSpeed;
        if (this._keys['shift']) {
            speed *= 5;
        }

        let t = Math.pow(0.95, delta * deltaTime) * speed * 0.2;
        if (this._wheelDelta < 0) t *= -1;

        const forwardMoveDir = new Vector3();
        this._camera.getWorldDirection(forwardMoveDir);
        forwardMoveDir.multiplyScalar(t);
        this._moveDelta.add(forwardMoveDir);

        this._wheelDelta = 0;
    }

    _calCameraHeight(deltaTime) {
        let speed = this._panSpeed;
        if (this._keys['shift']) {
            speed *= this._shiftCoeff;
        }

        const moveDir = this._configUp.clone();

        if (this._keys['q']) {
            moveDir.multiplyScalar(speed * deltaTime * -1);
        } else if (this._keys['e']) {
            moveDir.multiplyScalar(speed * deltaTime);
        } else {
            moveDir.multiplyScalar(this._panDeltaY * 20 * speed * deltaTime * -1);
        }

        this._moveDelta.add(moveDir);

        this._panDeltaY = 0.0;
    }

    _updateOnce(deltaTime, steps) {
        this._calMoveDelta(deltaTime);
        this._calMoveWheel(deltaTime);
        this._calCameraHeight(deltaTime);

        this._moving = this._moveDelta.length() > 0.0;

        if (this._moving) {
            this._move();
        }

        if (this._mouseMovingLeft) {
            this._pitchWithNonLimited(steps);
        }

        this._moveDelta.set(0, 0, 0);
    }

    update(inputDeltaTime) {
        if (!this.enabled || inputDeltaTime === undefined) return;
        this._deltaTimeArr.push(inputDeltaTime);

        if (this._deltaTimeArr.length >= 10) {
            this._deltaTimeArr.shift();
        }

        const deltaTime = this._deltaTimeArr.reduce((acc, curr) => acc + curr, 0) / this._deltaTimeArr.length;

        this._updateOnce(deltaTime, 1);

        // Modify target to avoid position jump
        if (this._inNonLimited) {
            this._updateTarget();
        }

        if (this._targetDirty) {
            if (!this._inNonLimited) {
                this._camera.lookAt(this._target.x, this._target.y, this._target.z);
                this._updateTarget();
            }
            this._targetDirty = false;
        }

        this._rotateDelta *= 1 - this._dampingFactor;
        this._pitchDelta *= 1 - this._dampingFactor;
    }

    _move() {
        this._camera.position.add(this._moveDelta);
        this._updateTarget();
    }

    _pitchWithNonLimited(steps) {
        const pitchRad = (this._pitchDelta / steps) * this._pitchSpeed;
        const thetaRad = (this._rotateDelta / steps) * this._rotateSpeed;
        // Pitch: around the camera local X axis (right direction), independent of coordinate system
        const pitchQuat = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -pitchRad);
        // Yaw: around the world vertical axis _configUp ((0,1,0) for Y-up, (0,0,1) for Z-up), avoids horizon roll
        const thetaQuat = new Quaternion().setFromAxisAngle(this._configUp, thetaRad);
        this._camera.quaternion.premultiply(thetaQuat);
        this._camera.quaternion.multiply(pitchQuat);
        this._updateTarget();
    }
}
