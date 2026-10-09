import * as THREE from 'three';
import { OperatorAvatar, ensureAvatarLights, REST_EYE_HEIGHT } from './OperatorAvatar.js';

/**
 * GuideAvatar — a static Chilquinta operator that greets the user, looks at
 * them as they move around, and carries a floating instructions sign.
 *
 * Built on the shared OperatorAvatar (same model remote players use), so both
 * look identical and the guide's feet always sit exactly on `position.y`
 * (use setFloorY() once the real floor height has been measured).
 *
 * Behaviour:
 *  - the head turns smoothly toward the user; the body follows a moment later;
 *  - waves for the first few seconds, and again whenever the user comes back
 *    from far away (> 7 m) to close by (< 3.5 m);
 *  - gentle idle sway so it doesn't look frozen. Feet never move.
 */
class GuideAvatar {
    constructor(scene, options = {}) {
        ensureAvatarLights(scene);
        this.scene = scene;
        this.position = (options.position || new THREE.Vector3(0, 0, -2.5)).clone();

        this.group = new THREE.Group();
        this.group.name = 'GuideAvatar';
        scene.add(this.group);

        this.avatar = new OperatorAvatar({ name: '' });
        this.group.add(this.avatar.root); // root stays at identity → world coordinates

        this._buildPanel(options.title || 'Bienvenido', options.lines || []);
        this._placePanel();

        // initial gaze: toward the world origin (where the user spawns)
        this._helper = new THREE.Object3D();
        this._headQuat = new THREE.Quaternion();
        this._targetQuat = new THREE.Quaternion();
        this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
        this._camPos = new THREE.Vector3();
        this._headPos = new THREE.Vector3();
        this._mirror = new THREE.Vector3();
        this._hand = new THREE.Vector3();
        this._handQuat = new THREE.Quaternion();
        this._lookInit = false;

        this._t0 = performance.now();
        this._lastTime = this._t0;
        this._waveUntil = this._t0 + 9000;
        this._wasFar = false;
        this._pending = { head: { p: [0, 0, 0], q: [0, 0, 0, 1] }, handL: null, handR: null, floorY: 0 };
    }

    _buildPanel(title, lines) {
        const canvas = document.createElement('canvas');
        canvas.width = 820;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');

        const r = 28;
        ctx.beginPath();
        ctx.moveTo(12 + r, 12);
        ctx.arcTo(canvas.width - 12, 12, canvas.width - 12, canvas.height - 12, r);
        ctx.arcTo(canvas.width - 12, canvas.height - 12, 12, canvas.height - 12, r);
        ctx.arcTo(12, canvas.height - 12, 12, 12, r);
        ctx.arcTo(12, 12, canvas.width - 12, 12, r);
        ctx.closePath();
        ctx.fillStyle = 'rgba(10, 15, 20, 0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 255, 150, 0.9)';
        ctx.lineWidth = 6;
        ctx.stroke();

        ctx.font = 'bold 48px Arial';
        ctx.fillStyle = '#5cffb0';
        ctx.fillText(title, 40, 78, canvas.width - 80);

        ctx.font = '29px Arial';
        ctx.fillStyle = '#ffffff';
        lines.forEach((line, i) => ctx.fillText(line, 40, 146 + i * 50, canvas.width - 80));

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        this._panel = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
        );
        this._panel.scale.set(1.5, 0.878, 1);
        this._panel.renderOrder = 1002;
        this.group.add(this._panel);
    }

    _placePanel() {
        // bottom edge of the sign clears the top of the hard hat (~1.77 m)
        this._panel.position.set(this.position.x, this.position.y + 2.45, this.position.z);
    }

    /** Anchor the feet to a measured floor height (world Y). */
    setFloorY(y) {
        this.position.y = y;
        this._placePanel();
    }

    setVisible(v) {
        this.group.visible = !!v;
    }

    /** Wave for `seconds` seconds. */
    wave(seconds = 6) {
        this._waveUntil = performance.now() + seconds * 1000;
    }

    update(time, camera) {
        if (!this.group.visible || !camera) return;
        const now = performance.now();
        const dt = Math.min(0.1, (now - this._lastTime) / 1000);
        this._lastTime = now;
        const t = (now - this._t0) / 1000;

        camera.getWorldPosition(this._camPos);
        const px = this.position.x;
        const pz = this.position.z;

        // proximity-triggered greeting
        const dist = Math.hypot(this._camPos.x - px, this._camPos.z - pz);
        if (dist > 7) this._wasFar = true;
        if (dist < 3.5 && this._wasFar) {
            this._wasFar = false;
            this.wave(6);
        }

        // head position with a tiny idle sway
        this._headPos.set(px, this.position.y + REST_EYE_HEIGHT + Math.sin(t * 1.6) * 0.003, pz);

        // gaze: a plain Object3D's lookAt points its +Z at the target, and this
        // avatar's front is -Z, so look at the point mirrored through the head.
        this._mirror.copy(this._headPos).multiplyScalar(2).sub(this._camPos);
        this._helper.position.copy(this._headPos);
        this._helper.lookAt(this._mirror);
        this._euler.setFromQuaternion(this._helper.quaternion, 'YXZ');
        this._euler.x = THREE.MathUtils.clamp(this._euler.x, -0.35, 0.35); // limit pitch
        this._euler.z = 0;
        this._targetQuat.setFromEuler(this._euler);

        if (!this._lookInit) {
            this._headQuat.copy(this._targetQuat);
            this._lookInit = true;
        } else {
            this._headQuat.slerp(this._targetQuat, 1 - Math.exp(-dt * 5));
        }

        // waving right hand (palm forward, fingers up), otherwise relaxed
        let handR = null;
        if (now < this._waveUntil) {
            const w = Math.sin(t * 7.5);
            this.avatar.bodyPoint(0.3 + 0.09 * w, 1.7, -0.14, this._hand);
            this._handQuat.setFromEuler(new THREE.Euler(Math.PI / 2, this.avatar.bodyYaw, w * 0.35, 'YXZ'));
            handR = { p: this._hand.toArray(), q: this._handQuat.toArray() };
        }

        const pose = this._pending;
        pose.head.p = this._headPos.toArray();
        pose.head.q = this._headQuat.toArray();
        pose.handR = handR;
        pose.floorY = this.position.y;
        this.avatar.applyPose(pose);
    }
}

export { GuideAvatar };
