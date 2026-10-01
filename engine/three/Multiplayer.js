import * as THREE from 'three';
import { GLTFLoader } from './jsm/loaders/GLTFLoader.js';

/**
 * MultiplayerSession
 *
 * Multiplayer pose + EHS tags.
 * Remote users are rendered with the Chilquinta operator GLB.
 *
 * Important pose rule:
 * Controller groups are children of XRLocomotion.cameraRig, so their
 * getWorldPosition()/getWorldQuaternion() already contain locomotion.
 * We therefore DO NOT multiply the rig a second time here.
 */
class MultiplayerSession {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.serverUrl = options.serverUrl;
        this.room = options.room || 'default';
        this.sendRateHz = options.sendRateHz ?? 15;
        this.onTagCreated = options.onTagCreated || (() => {});
        this.playerName = options.playerName || 'Anónimo';
        this.playerId = null;
        this.tags = new Map();
        this.maxTags = options.maxTags ?? 25;
        this.avatarUrl = options.avatarUrl || './assets/avatars/Chilquinta_Operador_VR.glb';

        this._ws = null;
        this._peers = new Map();
        this._lastSend = 0;

        // Avatar / pose temporaries.
        this._tmpPos = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpQuat2 = new THREE.Quaternion();
        this._tmpEuler = new THREE.Euler();
        this._tmpForward = new THREE.Vector3();
        this._tmpShoulder = new THREE.Vector3();
        this._tmpHand = new THREE.Vector3();
        this._tmpMid = new THREE.Vector3();
        this._tmpDir = new THREE.Vector3();
        this._tmpInvRoot = new THREE.Matrix4();
        this._tmpWorld = new THREE.Matrix4();
        this._tmpArmQuat = new THREE.Quaternion();

        this._avatarTemplate = null;
        this._avatarLoadPromise = this._loadAvatar();

        // Model proportions of the generated GLB.
        this._avatarHeadY = 1.70;
        this._armBaseLength = 0.63;
        this._shoulderY = 1.23;
        this._shoulderX = 0.34;
    }

    async _loadAvatar() {
        try {
            const loader = new GLTFLoader();
            const gltf = await loader.loadAsync(this.avatarUrl);
            this._avatarTemplate = gltf.scene;
            this._avatarTemplate.traverse((obj) => {
                if (obj.isMesh) {
                    obj.frustumCulled = true;
                }
            });

            // A peer may have arrived while the GLB was loading.
            for (const peer of this._peers.values()) {
                this._installAvatar(peer);
            }

            console.log('[Multiplayer] Chilquinta operator GLB loaded.');
        } catch (error) {
            console.error('[Multiplayer] avatar GLB failed to load:', error);
        }
    }

    connect() {
        if (!this.serverUrl) {
            console.error('[Multiplayer] no serverUrl configured.');
            return;
        }

        this._ws = new WebSocket(this.serverUrl);

        this._ws.addEventListener('open', () => {
            this._ws.send(JSON.stringify({ type: 'join', room: this.room }));
        });

        this._ws.addEventListener('message', (event) => {
            try {
                this._onMessage(JSON.parse(event.data));
            } catch (e) {
                console.warn('[Multiplayer] invalid server message', e);
            }
        });

        this._ws.addEventListener('close', () => {
            console.warn('[Multiplayer] disconnected, retrying in 3s');
            setTimeout(() => this.connect(), 3000);
        });

        this._ws.addEventListener('error', (e) => {
            console.error('[Multiplayer] socket error', e);
        });
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'joined':
                this.playerId = msg.id;
                this._loadExistingTags();
                break;

            case 'peer-joined':
                this._ensurePeer(msg.id);
                break;

            case 'peer-left':
                this._removePeer(msg.id);
                break;

            case 'pose':
                // Never render our own network echo as a remote avatar.
                if (msg.id === this.playerId) break;
                this._ensurePeer(msg.id);
                this._peers.get(msg.id).targetPose = msg.pose;
                break;

            case 'tag-created':
                this._addTagMarker(msg.tag);
                this.onTagCreated(msg.tag);
                break;
        }
    }

    _ensurePeer(id) {
        if (this._peers.has(id)) return this._peers.get(id);

        const group = new THREE.Group();
        group.name = `RemotePlayer_${id}`;
        group.matrixAutoUpdate = true;
        this.scene.add(group);

        const peer = {
            id,
            group,
            avatar: null,
            parts: {},
            targetPose: null,
            smoothPose: null
        };

        this._peers.set(id, peer);

        if (this._avatarTemplate) {
            this._installAvatar(peer);
        }

        return peer;
    }

    _installAvatar(peer) {
        if (!this._avatarTemplate || !peer || peer.avatar) return;

        const avatar = this._avatarTemplate.clone(true);
        avatar.name = 'ChilquintaOperatorAvatar';
        avatar.traverse((obj) => {
            if (obj.isMesh) {
                obj.frustumCulled = true;
                obj.castShadow = false;
                obj.receiveShadow = false;
            }
        });

        peer.group.add(avatar);
        peer.avatar = avatar;

        const find = (name) => avatar.getObjectByName(name);
        peer.parts = {
            head: find('Head'),
            helmet: find('Casco'),
            visor: find('Insignia_Casco'),
            armL: find('Brazo_Izquierdo'),
            armR: find('Brazo_Derecho'),
            handL: find('Mano_Izquierda'),
            handR: find('Mano_Derecha'),
            armBandL: find('Banda_Reflectante_Brazo_I'),
            armBandR: find('Banda_Reflectante_Brazo_D'),
            torso: find('Torso')
        };

        // Make the reflective arm bands children of their corresponding arms.
        // Object3D.attach() preserves their current world transform.
        if (peer.parts.armL && peer.parts.armBandL && peer.parts.armBandL.parent !== peer.parts.armL) {
            peer.parts.armL.attach(peer.parts.armBandL);
        }
        if (peer.parts.armR && peer.parts.armBandR && peer.parts.armBandR.parent !== peer.parts.armR) {
            peer.parts.armR.attach(peer.parts.armBandR);
        }

        // Keep the avatar at its native generated scale.
        avatar.scale.setScalar(1);
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    /**
     * Convert a world-space pose to a stable avatar pose.
     * The body follows head yaw; head pitch/roll and both hands remain tracked.
     */
    _updateAvatar(peer, pose) {
        if (!peer.avatar || !pose?.head?.p) return;

        const headPos = this._tmpPos.fromArray(pose.head.p);
        const headQuat = this._tmpQuat.fromArray(pose.head.q);

        // Extract yaw only for the body, preventing the whole body from leaning
        // when the Quest user looks up/down.
        this._tmpForward.set(0, 0, -1).applyQuaternion(headQuat);
        this._tmpForward.y = 0;
        if (this._tmpForward.lengthSq() < 1e-8) this._tmpForward.set(0, 0, -1);
        this._tmpForward.normalize();
        const yaw = Math.atan2(this._tmpForward.x, -this._tmpForward.z);
        peer.group.rotation.set(0, yaw, 0);

        // The generated model's head center is at Y=1.70 m.
        peer.group.position.set(
            headPos.x,
            headPos.y - this._avatarHeadY,
            headPos.z
        );
        peer.group.updateMatrixWorld(true);

        this._tmpQuat2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
        const localHeadQuat = this._tmpQuat2.clone().multiply(headQuat);

        if (peer.parts.head) {
            peer.parts.head.quaternion.copy(localHeadQuat);
        }
        if (peer.parts.helmet) {
            // Helmet remains attached to the head's yaw/pitch/roll.
            peer.parts.helmet.quaternion.copy(localHeadQuat);
        }
        if (peer.parts.visor) {
            peer.parts.visor.quaternion.copy(localHeadQuat);
        }

        // Hands and arms.
        this._updateHandAndArm(peer, pose.handL, false);
        this._updateHandAndArm(peer, pose.handR, true);
    }

    _updateHandAndArm(peer, handPose, rightSide) {
        if (!handPose?.p) return;

        const hand = rightSide ? peer.parts.handR : peer.parts.handL;
        const arm = rightSide ? peer.parts.armR : peer.parts.armL;
        if (!hand || !arm) return;

        const handWorld = this._tmpHand.fromArray(handPose.p);
        const handLocal = this._tmpPos.copy(handWorld);
        peer.group.worldToLocal(handLocal);
        hand.position.copy(handLocal);

        // Apply controller orientation in avatar-local space.
        const handWorldQuat = this._tmpQuat.fromArray(handPose.q);
        const rootWorldQuat = peer.group.getWorldQuaternion(this._tmpQuat2);
        const rootInv = this._tmpQuat2.clone().invert();
        hand.quaternion.copy(rootInv).multiply(handWorldQuat);

        // Shoulder is expressed in avatar-local coordinates.
        const shoulder = this._tmpShoulder.set(
            rightSide ? this._shoulderX : -this._shoulderX,
            this._shoulderY,
            0
        );
        const shoulderWorld = this._tmpMid.copy(shoulder);
        peer.group.localToWorld(shoulderWorld);

        const direction = this._tmpDir.copy(handWorld).sub(shoulderWorld);
        const length = Math.max(0.08, direction.length());
        direction.normalize();

        const midpointWorld = this._tmpMid.copy(shoulderWorld).add(handWorld).multiplyScalar(0.5);
        const midpointLocal = this._tmpPos.copy(midpointWorld);
        peer.group.worldToLocal(midpointLocal);
        arm.position.copy(midpointLocal);

        // Arm geometry is aligned to local +Y and has ~0.63 m native length.
        arm.scale.set(1, length / this._armBaseLength, 1);

        this._tmpArmQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        arm.quaternion.copy(rootInv).multiply(this._tmpArmQuat);
    }

    update(camera, controllerL, controllerR) {
        // Render all remote avatars from their latest network pose.
        for (const peer of this._peers.values()) {
            const p = peer.targetPose;
            if (!p) continue;

            if (peer.avatar) {
                this._updateAvatar(peer, p);
            }
        }

        const now = performance.now();
        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;

        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (!camera || !controllerL || !controllerR) return;

        // IMPORTANT: controller groups are now children of cameraRig.
        // getWorldPosition/getWorldQuaternion therefore already include locomotion.
        const pack = (obj) => {
            obj.updateMatrixWorld(true);
            obj.getWorldPosition(this._tmpPos);
            obj.getWorldQuaternion(this._tmpQuat);
            return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
        };

        this._ws.send(JSON.stringify({
            type: 'pose',
            pose: {
                head: pack(camera),
                handL: pack(controllerL),
                handR: pack(controllerR)
            }
        }));
    }

    async _loadExistingTags() {
        try {
            const res = await fetch(`${this._httpUrl()}/tags?room=${encodeURIComponent(this.room)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const tags = await res.json();
            const visibleTags = tags.slice(-this.maxTags);
            for (const tag of visibleTags) this._addTagMarker(tag);
            console.log(`[Tags] loaded ${this.tags.size}/${this.maxTags}`);
        } catch (e) {
            console.warn('[Multiplayer] failed to load tags', e);
        }
    }

    getTagCount() {
        return this.tags.size;
    }

    canCreateTag() {
        return this.tags.size < this.maxTags;
    }

    async createTag(position, note) {
        if (!this.canCreateTag()) {
            console.warn(`[Tags] maximum of ${this.maxTags} tags reached.`);
            return { ok: false, limitReached: true };
        }

        try {
            const res = await fetch(`${this._httpUrl()}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    room: this.room,
                    x: position.x,
                    y: position.y,
                    z: position.z,
                    note,
                    author: this.playerName
                })
            });

            let data = null;
            try { data = await res.json(); } catch (_) { data = null; }

            if (!res.ok) {
                if (res.status === 409 && data?.limitReached) {
                    console.warn('[Tags] server says the 25-tag limit was reached.');
                    return { ok: false, limitReached: true };
                }
                throw new Error(`HTTP ${res.status}`);
            }

            if (data?.id) this._addTagMarker(data);
            return { ok: true, tag: data };
        } catch (e) {
            console.warn('[Multiplayer] failed to create tag', e);
            return { ok: false, error: e };
        }
    }

    _httpUrl() {
        return this.serverUrl.replace(/^ws/, 'http');
    }

    _wrapText(text, maxChars = 28, maxLines = 3) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        const lines = [];
        let current = '';
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length <= maxChars) current = candidate;
            else {
                if (current) lines.push(current);
                current = word.slice(0, maxChars);
                if (lines.length >= maxLines - 1) break;
            }
        }
        if (current && lines.length < maxLines) lines.push(current);
        if (!lines.length) lines.push('Sin texto');
        if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
            lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
        }
        return lines;
    }

    _createTagLabel(tag) {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 300;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(10, 15, 20, 0.88)';
        ctx.beginPath();
        ctx.roundRect(10, 10, canvas.width - 20, canvas.height - 20, 24);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 190, 0, 0.95)';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.font = 'bold 28px Arial';
        ctx.fillStyle = '#ffcc33';
        ctx.fillText('TAG', 32, 52);
        ctx.font = 'bold 34px Arial';
        ctx.fillStyle = '#ffffff';
        const lines = this._wrapText(tag.note, 28, 3);
        lines.forEach((line, i) => ctx.fillText(line, 32, 98 + i * 48));
        ctx.font = '22px Arial';
        ctx.fillStyle = '#d8d8d8';
        const shortId = String(tag.id || '').slice(0, 6);
        ctx.fillText(`${tag.author || 'Anónimo'}  •  ${shortId}`, 32, 258);

        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(0.55, 0.258, 1);
        sprite.renderOrder = 1001;
        sprite.position.set(0, 0.16, 0);
        sprite.userData.tagLabel = true;
        return sprite;
    }

    _addTagMarker(tag) {
        if (!tag || !tag.id) return;
        if (this.tags.has(tag.id)) return;
        if (this.tags.size >= this.maxTags) {
            console.warn(`[Tags] local limit ${this.maxTags} reached; ignoring additional tag.`);
            return;
        }

        const group = new THREE.Group();
        group.position.set(Number(tag.x), Number(tag.y), Number(tag.z));
        group.userData.tag = tag;

        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.055, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false, depthWrite: false })
        );
        marker.renderOrder = 1000;

        const stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false })
        );
        stem.position.y = 0.06;
        stem.renderOrder = 1000;

        const label = this._createTagLabel(tag);
        group.add(marker, stem, label);
        this.scene.add(group);
        this.tags.set(tag.id, group);
    }
}

export { MultiplayerSession };
