import * as THREE from 'three';

/**
 * OperatorAvatar — procedural field-operator avatar (clean-shaven, white hard
 * hat with green band, safety glasses, hi-vis vest, gloves, boots).
 *
 * Shared by the static GuideAvatar and by remote players in Multiplayer.js, so
 * both look the same and neither depends on loading a GLTF.
 *
 * Structure (this is what fixes the old remote avatar, whose parts were placed
 * with fixed WORLD offsets that didn't rotate with the person):
 *   root                (identity; add this to the scene)
 *   ├─ body             yaw-only rotation, feet at the floor, scaled to height
 *   │    torso, vest, belt, legs, boots, shoulders…  (all in body-local space)
 *   ├─ head             follows the headset's full pose (position + rotation)
 *   │    skull, face, glasses, helmet…               (all in head-local space)
 *   └─ arms/hands       two-bone IK from the shoulder to the controller
 *
 * Convention: the avatar's FRONT is -Z (same as a WebXR camera), so a head
 * quaternion taken straight from a headset needs no correction.
 *
 * Needs lights to look good: call ensureAvatarLights(scene) once.
 */

const UP = new THREE.Vector3(0, 1, 0);
export const REST_EYE_HEIGHT = 1.62; // head-center height of the model at scale 1

const SHOULDER_X = 0.19;
const SHOULDER_Y = 1.4;
const UPPER_LEN = 0.29;
const FORE_LEN = 0.27;

const SKIN_TONES = [0xf0c8a4, 0xd9a47f, 0xb67a56, 0x8d5a3b, 0x6a4330];

/** One-time hemisphere + sun for Lambert materials. Harmless to the splat shaders. */
export function ensureAvatarLights(scene) {
    if (scene.userData._avatarLights) return;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x58626e, 2.0);
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(2.5, 5, 3.5);
    hemi.name = 'AvatarHemiLight';
    sun.name = 'AvatarSunLight';
    scene.add(hemi, sun);
    scene.userData._avatarLights = true;
}

const _matCache = new Map();
function mat(color, extra = {}) {
    const key = `${color}|${JSON.stringify(extra)}`;
    let m = _matCache.get(key);
    if (!m) {
        m = new THREE.MeshLambertMaterial({ color, ...extra });
        _matCache.set(key, m);
    }
    return m;
}

const M = {
    shirt: () => mat(0x24405f),
    vest: () => mat(0xff6f1d),
    reflect: () => mat(0xe6ebef, { emissive: 0x5b6168 }),
    pants: () => mat(0x1d2a3a),
    boot: () => mat(0x1b1a19),
    sole: () => mat(0x3d3c3b),
    helmet: () => mat(0xf6f6f1),
    green: () => mat(0x1fb36b, { emissive: 0x0b3a24 }),
    glove: () => mat(0x30343a),
    dark: () => mat(0x15171a),
    eyeWhite: () => mat(0xf4f4f4),
    pupil: () => mat(0x14100d),
    brow: () => mat(0x2a1c14),
    mouth: () => mat(0x8a3a35),
    lens: () => mat(0xbfe3ff, { transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    badge: () => mat(0xf3f3f3)
};

function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const shortestAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class OperatorAvatar {
    /**
     * @param {object} opts
     * @param {string} [opts.name]  floating name tag (omit for none)
     * @param {number} [opts.skin]  skin color; default derived from the name
     */
    constructor(opts = {}) {
        this.root = new THREE.Group();
        this.root.name = 'OperatorAvatar';
        this.body = new THREE.Group();
        this.head = new THREE.Group();
        this.root.add(this.body, this.head);

        this._name = '';
        this._label = null;
        this._yaw = 0;
        this._yawInit = false;
        this._k = 1;

        const tone = opts.skin ?? SKIN_TONES[hashString(opts.name || 'guide') % SKIN_TONES.length];
        this._skin = mat(tone);
        this._skinDark = mat(new THREE.Color(tone).multiplyScalar(0.82).getHex());

        // temps
        this._v1 = new THREE.Vector3();
        this._v2 = new THREE.Vector3();
        this._v3 = new THREE.Vector3();
        this._v4 = new THREE.Vector3();
        this._pole = new THREE.Vector3();
        this._q = new THREE.Quaternion();

        this._buildBody();
        this._buildHead();
        this._buildArms();
        if (opts.name) this.setName(opts.name);
    }

    // ------------------------------------------------------------------
    // construction
    // ------------------------------------------------------------------
    _add(parent, geometry, material, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) {
        const m = new THREE.Mesh(geometry, material);
        m.position.set(x, y, z);
        m.scale.set(sx, sy, sz);
        parent.add(m);
        return m;
    }

    _buildBody() {
        const b = this.body;

        for (const s of [-1, 1]) {
            // boot: box + rounded toe + sole
            this._add(b, new THREE.BoxGeometry(0.105, 0.115, 0.27), M.boot(), s * 0.09, 0.075, -0.03);
            this._add(b, new THREE.SphereGeometry(0.0525, 14, 10), M.boot(), s * 0.09, 0.065, -0.165, 1, 0.95, 1.05);
            this._add(b, new THREE.BoxGeometry(0.112, 0.03, 0.3), M.sole(), s * 0.09, 0.015, -0.045);
            // trouser leg, tapered
            this._add(b, new THREE.CylinderGeometry(0.088, 0.066, 0.88, 16), M.pants(), s * 0.09, 0.56, 0);
            // reflective shin band
            this._add(b, new THREE.CylinderGeometry(0.0735, 0.0735, 0.032, 16), M.reflect(), s * 0.09, 0.3, 0);
        }

        // pelvis + belt
        this._add(b, new THREE.CylinderGeometry(0.172, 0.168, 0.2, 20), M.pants(), 0, 0.97, 0, 1, 1, 0.8);
        this._add(b, new THREE.CylinderGeometry(0.178, 0.178, 0.05, 22), M.dark(), 0, 1.045, 0, 1, 1, 0.82);
        this._add(b, new THREE.BoxGeometry(0.05, 0.036, 0.014), M.reflect(), 0, 1.045, -0.148);
        // radio on the right hip + antenna
        this._add(b, new THREE.BoxGeometry(0.046, 0.105, 0.036), M.dark(), 0.205, 0.99, -0.02);
        this._add(b, new THREE.CylinderGeometry(0.004, 0.004, 0.11, 6), M.dark(), 0.217, 1.095, -0.02);

        // work shirt + hi-vis vest
        this._add(b, new THREE.CapsuleGeometry(0.15, 0.18, 6, 16), M.shirt(), 0, 1.24, 0, 1.12, 1, 0.86);
        this._add(b, new THREE.CapsuleGeometry(0.157, 0.17, 6, 18), M.vest(), 0, 1.23, 0, 1.12, 1, 0.88);

        // reflective bands around the vest (radius follows the capsule's rounded ends)
        for (const y of [1.11, 1.3]) {
            const dy = Math.max(0, Math.abs(y - 1.23) - 0.085);
            const r = Math.sqrt(Math.max(0.157 * 0.157 - dy * dy, 0.0004)) + 0.004;
            const t = this._add(b, new THREE.TorusGeometry(r, 0.0105, 6, 36), M.reflect(), 0, y, 0, 1.12, 0.88, 1);
            t.rotation.x = Math.PI / 2;
            t.scale.set(1.12, 0.88, 1); // after rotation: x,y are the ring plane → ellipse; z is tube thickness
        }
        // vertical braces front and back
        for (const z of [-0.129, 0.129]) {
            for (const s of [-1, 1]) {
                const brace = this._add(b, new THREE.BoxGeometry(0.04, 0.34, 0.012), M.reflect(), s * 0.075, 1.29, z);
                brace.rotation.z = s * -0.06;
            }
        }
        // ID badge + logo patch
        this._add(b, new THREE.BoxGeometry(0.05, 0.034, 0.008), M.badge(), 0.09, 1.2, -0.1235);
        this._add(b, new THREE.BoxGeometry(0.044, 0.044, 0.008), M.green(), -0.09, 1.2, -0.1235);

        // shoulders and neck
        for (const s of [-1, 1]) this._add(b, new THREE.SphereGeometry(0.062, 16, 12), M.shirt(), s * SHOULDER_X, SHOULDER_Y, 0, 1, 0.9, 1);
        this._add(b, new THREE.CylinderGeometry(0.052, 0.058, 0.09, 14), this._skin, 0, 1.5, 0);
        this._add(b, new THREE.CylinderGeometry(0.066, 0.074, 0.03, 16), M.shirt(), 0, 1.475, 0); // collar
    }

    _buildHead() {
        const h = this.head;

        // skull + jaw, ears, nose
        this._add(h, new THREE.SphereGeometry(0.105, 28, 20), this._skin, 0, 0, 0, 0.92, 1.07, 0.98);
        this._add(h, new THREE.SphereGeometry(0.082, 22, 16), this._skin, 0, -0.045, -0.014, 0.95, 0.9, 0.95);
        for (const s of [-1, 1]) this._add(h, new THREE.SphereGeometry(0.022, 10, 8), this._skinDark, s * 0.097, -0.005, 0.005, 0.5, 1, 0.8);
        this._add(h, new THREE.SphereGeometry(0.016, 12, 10), this._skinDark, 0, -0.012, -0.099, 0.9, 1.25, 1.15);

        // eyes, brows, mouth (no beard)
        for (const s of [-1, 1]) {
            this._add(h, new THREE.SphereGeometry(0.0165, 12, 10), M.eyeWhite(), s * 0.036, 0.012, -0.0925, 1, 1, 0.55);
            this._add(h, new THREE.SphereGeometry(0.0095, 10, 8), M.pupil(), s * 0.036, 0.012, -0.1018, 1, 1, 0.5);
            const brow = this._add(h, new THREE.BoxGeometry(0.04, 0.008, 0.01), M.brow(), s * 0.037, 0.044, -0.093);
            brow.rotation.z = s * 0.1;
        }
        this._add(h, new THREE.BoxGeometry(0.042, 0.006, 0.007), M.mouth(), 0, -0.052, -0.0925);

        // safety glasses: curved clear lens + dark rims, wrapping the face
        const arc = (height, material, y) => {
            const g = new THREE.CylinderGeometry(0.108, 0.108, height, 22, 1, true, Math.PI - 1.15, 2.3);
            return this._add(h, g, material, 0, y, 0);
        };
        arc(0.04, M.lens(), 0.012);
        arc(0.006, M.dark(), 0.033);
        arc(0.006, M.dark(), -0.009);

        // hard hat: dome, rim, front peak, ridge, green band, logo
        this._add(h, new THREE.SphereGeometry(0.13, 30, 18, 0, Math.PI * 2, 0, Math.PI * 0.418), M.helmet(), 0, 0.03, 0, 1, 0.9, 1.05);
        this._add(h, new THREE.CylinderGeometry(0.1265, 0.134, 0.014, 30), M.helmet(), 0, 0.058, 0, 1, 1, 1.05);
        this._add(h, new THREE.CylinderGeometry(0.108, 0.13, 0.012, 24, 1, false, Math.PI / 2, Math.PI), M.helmet(), 0, 0.057, -0.034, 1, 1, 1.05);
        this._add(h, new THREE.BoxGeometry(0.03, 0.016, 0.2), M.helmet(), 0, 0.139, 0);
        const band = this._add(h, new THREE.TorusGeometry(0.1155, 0.0065, 8, 36), M.green(), 0, 0.083, 0, 1, 1.05, 1);
        band.rotation.x = Math.PI / 2;
        const logo = this._add(h, new THREE.BoxGeometry(0.05, 0.034, 0.006), M.green(), 0, 0.105, -0.1175);
        logo.rotation.x = 0.55;
    }

    _buildArms() {
        this.arms = {};
        for (const side of ['L', 'R']) {
            const upper = this._add(this.root, new THREE.CylinderGeometry(0.046, 0.04, 1, 12), M.shirt());
            const fore = this._add(this.root, new THREE.CylinderGeometry(0.04, 0.034, 1, 12), M.shirt());
            const elbow = this._add(this.root, new THREE.SphereGeometry(0.043, 12, 10), M.shirt());

            const hand = new THREE.Group();
            this._add(hand, new THREE.SphereGeometry(0.045, 14, 10), M.glove(), 0, 0, 0, 0.95, 0.6, 1.15);
            const fingers = this._add(hand, new THREE.CapsuleGeometry(0.021, 0.05, 4, 8), M.glove(), 0, 0, -0.072, 1.9, 1, 1);
            fingers.rotation.x = Math.PI / 2;
            const thumb = this._add(hand, new THREE.CapsuleGeometry(0.013, 0.03, 4, 8), M.glove(), side === 'L' ? 0.04 : -0.04, 0.006, -0.04);
            thumb.rotation.x = Math.PI / 2;
            this._add(hand, new THREE.CylinderGeometry(0.036, 0.036, 0.04, 12), M.reflect(), 0, 0, 0.055, 1, 1, 1).rotation.x = Math.PI / 2; // cuff
            this.root.add(hand);

            this.arms[side] = { upper, fore, elbow, hand };
        }
    }

    // ------------------------------------------------------------------
    // public API
    // ------------------------------------------------------------------
    setName(name) {
        name = String(name || '').trim();
        if (name === this._name) return;
        this._name = name;

        if (this._label) {
            this.root.remove(this._label);
            this._label.material.map?.dispose();
            this._label.material.dispose();
            this._label = null;
        }
        if (!name) return;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 46px Arial';
        const textW = Math.min(ctx.measureText(name).width, 560);
        canvas.width = Math.round(textW + 96);
        canvas.height = 96;
        const c = canvas.getContext('2d');
        c.beginPath();
        c.moveTo(48, 4);
        c.arcTo(canvas.width - 4, 4, canvas.width - 4, 92, 44);
        c.arcTo(canvas.width - 4, 92, 4, 92, 44);
        c.arcTo(4, 92, 4, 4, 44);
        c.arcTo(4, 4, canvas.width - 4, 4, 44);
        c.closePath();
        c.fillStyle = 'rgba(8, 14, 18, 0.84)';
        c.fill();
        c.lineWidth = 5;
        c.strokeStyle = 'rgba(92, 255, 176, 0.95)';
        c.stroke();
        c.beginPath();
        c.arc(42, 48, 10, 0, Math.PI * 2);
        c.fillStyle = '#5cffb0';
        c.fill();
        c.font = 'bold 46px Arial';
        c.fillStyle = '#ffffff';
        c.textBaseline = 'middle';
        c.fillText(name, 66, 51, 560);

        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
        sprite.scale.set(canvas.width / 1000, 0.096, 1);
        sprite.renderOrder = 1003;
        this._label = sprite;
        this.root.add(sprite);
    }

    /** Body point in world space (e.g. for the guide to aim a waving hand). */
    bodyPoint(x, y, z, out = new THREE.Vector3()) {
        return this.body.localToWorld(out.set(x, y, z));
    }

    get bodyYaw() {
        return this._yaw;
    }

    /**
     * pose (all WORLD space):
     *   head:  { p:[x,y,z], q:[x,y,z,w] }           required
     *   handL / handR: { p, q } | null              optional (relaxed if absent)
     *   floorY: number                              optional (default: head − eye height)
     */
    applyPose(pose) {
        const hp = pose?.head?.p;
        if (!hp) return;
        const hq = pose.head.q || [0, 0, 0, 1];

        this.head.position.set(hp[0], hp[1], hp[2]);
        this.head.quaternion.set(hq[0], hq[1], hq[2], hq[3]);

        // body follows the head's yaw, smoothed so it doesn't jitter
        const q = this.head.quaternion;
        const headYaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        if (!this._yawInit) {
            this._yaw = headYaw;
            this._yawInit = true;
        } else {
            this._yaw += shortestAngle(headYaw - this._yaw) * 0.18;
        }

        const floorY = Number.isFinite(pose.floorY) ? pose.floorY : hp[1] - REST_EYE_HEIGHT;
        const k = clamp((hp[1] - floorY) / REST_EYE_HEIGHT, 0.55, 1.25);
        this._k = k;

        this.body.position.set(hp[0], floorY, hp[2]);
        this.body.rotation.set(0, this._yaw, 0);
        this.body.scale.setScalar(k);
        this.root.updateMatrixWorld(true);

        this._solveArm('L', pose.handL, -1, k);
        this._solveArm('R', pose.handR, 1, k);

        if (this._label) {
            this._label.position.set(hp[0], hp[1] + 0.33, hp[2]);
        }
    }

    // ------------------------------------------------------------------
    // arms: two-bone IK (shoulder → elbow → hand)
    // ------------------------------------------------------------------
    _solveArm(side, hand, s, k) {
        const arm = this.arms[side];
        const shoulder = this.bodyPoint(s * SHOULDER_X, SHOULDER_Y, 0, this._v1);
        const target = this._v2;

        if (hand?.p) target.set(hand.p[0], hand.p[1], hand.p[2]);
        else this.bodyPoint(s * 0.27, 0.8, -0.04, target); // hanging at the side

        const L1 = UPPER_LEN * k;
        const L2 = FORE_LEN * k;
        const d = this._v3.copy(target).sub(shoulder);
        const dist = d.length();
        const dir = dist > 1e-5 ? d.multiplyScalar(1 / dist) : d.set(0, -1, 0);

        const c = clamp(dist, Math.abs(L1 - L2) + 0.03, (L1 + L2) * 0.995);
        const a = (L1 * L1 - L2 * L2 + c * c) / (2 * c);
        const hgt = Math.sqrt(Math.max(L1 * L1 - a * a, 0));

        // elbow bends down and slightly back/out
        this._pole.set(s * 0.45, -1, 0.55).transformDirection(this.body.matrixWorld);
        this._pole.addScaledVector(dir, -this._pole.dot(dir));
        if (this._pole.lengthSq() < 1e-6) this._pole.set(s, 0, 0).transformDirection(this.body.matrixWorld);
        this._pole.normalize();

        const elbow = this._v4.copy(shoulder).addScaledVector(dir, a).addScaledVector(this._pole, hgt);

        this._limb(arm.upper, shoulder, elbow, k);
        this._limb(arm.fore, elbow, target, k);
        arm.elbow.position.copy(elbow);
        arm.elbow.scale.setScalar(k);

        arm.hand.position.copy(target);
        if (hand?.q) arm.hand.quaternion.set(hand.q[0], hand.q[1], hand.q[2], hand.q[3]);
        else arm.hand.quaternion.setFromEuler(new THREE.Euler(0.3, this._yaw, 0));
        arm.hand.scale.setScalar(k);
    }

    _limb(mesh, a, b, k) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const len = Math.max(Math.hypot(dx, dy, dz), 0.001);
        mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        this._q.setFromUnitVectors(UP, this._v3.set(dx / len, dy / len, dz / len));
        mesh.quaternion.copy(this._q);
        mesh.scale.set(k, len, k);
    }

    dispose() {
        if (this._label) {
            this._label.material.map?.dispose();
            this._label.material.dispose();
        }
    }
}
