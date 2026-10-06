import * as THREE from 'three';

/**
 * GuideAvatar — a static, non-interactive figure placed near the spawn
 * point, plus a floating welcome/instructions panel above it.
 *
 * Two jobs:
 *  1. Scale/orientation reference when there's no second player connected
 *     (same reason real estate photos include a person for scale).
 *  2. A readable, persistent "how to use this" sign for first-time users —
 *     no dismiss timer, no state machine, just a landmark that's always
 *     there, so it can never fail silently the way a timed popup could.
 *
 * Built from primitives (same approach as the remote-player avatar in
 * Multiplayer.js) — no GLTF dependency, so a missing asset can never make
 * it disappear. MeshBasicMaterial throughout, matching Multiplayer.js,
 * since this scene may have no lights configured.
 */
class GuideAvatar {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.position = options.position || new THREE.Vector3(0, 0, -2.5);
        this.facing = options.facing ?? Math.PI; // faces back toward spawn by default

        this._skin = new THREE.MeshBasicMaterial({ color: 0x8a543c });
        this._shirt = new THREE.MeshBasicMaterial({ color: 0xb51f24 }); // high-vis red, matches the remote operator avatar
        this._pants = new THREE.MeshBasicMaterial({ color: 0x101826 });
        this._helmet = new THREE.MeshBasicMaterial({ color: 0xf4f4ef });
        this._reflective = new THREE.MeshBasicMaterial({ color: 0xf1f1e8 });

        this.group = new THREE.Group();
        this.group.name = 'GuideAvatar';
        this._buildBody();
        this._buildPanel(options.title || 'Bienvenido', options.lines || []);

        this.group.position.copy(this.position);
        this.group.rotation.y = this.facing;
        this.scene.add(this.group);

        this._t0 = performance.now();
        this._baseY = this.position.y;
        this._lookQuat = new THREE.Quaternion();
        this._lookMatrix = new THREE.Matrix4();
        this._flatTarget = new THREE.Vector3();
        this._up = new THREE.Vector3(0, 1, 0);
    }

    _buildBody() {
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 14), this._skin);
        head.position.y = 1.58;

        const helmet = new THREE.Mesh(
            new THREE.SphereGeometry(0.145, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
            this._helmet
        );
        helmet.position.y = 1.65;
        helmet.scale.set(1.1, 0.72, 1.02);

        const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 6, 10), this._shirt);
        torso.position.y = 1.17;

        const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.55, 5, 8), this._pants);
        legL.position.set(-0.09, 0.55, 0);
        const legR = legL.clone();
        legR.position.x = 0.09;

        const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.40, 5, 8), this._shirt);
        armL.position.set(-0.24, 1.17, 0);
        const armR = armL.clone();
        armR.position.x = 0.24;

        const band1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.28), this._reflective);
        band1.position.set(0, 1.08, 0);
        const band2 = band1.clone();
        band2.position.y = 1.20;

        this.group.add(head, helmet, torso, legL, legR, armL, armR, band1, band2);
    }

    _buildPanel(title, lines) {
        const canvas = document.createElement('canvas');
        canvas.width = 820;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'rgba(10, 15, 20, 0.88)';
        ctx.beginPath();
        ctx.roundRect(12, 12, canvas.width - 24, canvas.height - 24, 28);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 255, 150, 0.9)';
        ctx.lineWidth = 6;
        ctx.stroke();

        ctx.font = 'bold 46px Arial';
        ctx.fillStyle = '#5cffb0';
        ctx.fillText(title, 40, 72);

        ctx.font = '28px Arial';
        ctx.fillStyle = '#ffffff';
        lines.forEach((line, i) => {
            ctx.fillText(line, 40, 136 + i * 46);
        });

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(1.5, 0.878, 1);
        sprite.position.set(0, 2.25, 0);
        sprite.renderOrder = 1002;

        this.group.add(sprite);
    }

    /**
     * Call every frame — a subtle idle bob, purely cosmetic, plus a yaw-only
     * billboard so the avatar always faces the camera (never tips/leans,
     * since it only rotates around the vertical axis).
     */
    update(time, camera) {
        const t = (time - this._t0) / 1000;
        this.group.position.y = this._baseY + Math.sin(t * 1.2) * 0.015;

        if (camera) {
            camera.getWorldPosition(this._flatTarget);
            this._flatTarget.y = this.group.position.y; // ignore camera height — yaw only
            this._lookMatrix.lookAt(this._flatTarget, this.group.position, this._up);
            this._lookQuat.setFromRotationMatrix(this._lookMatrix);
            this.group.quaternion.slerp(this._lookQuat, 0.08); // smooth turn, not instant snap
        }
    }
}

export { GuideAvatar };
