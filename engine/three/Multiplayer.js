import * as THREE from 'three';
import { GLTFLoader } from './jsm/loaders/GLTFLoader.js';

/**
 * MultiplayerSession
 *
 * WebSocket pose sync + EHS tags + lightweight Chilquinta operator avatar.
 * The avatar is local to each client; only head and controller poses are sent.
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

        this._handGeometry = new THREE.SphereGeometry(0.045, 12, 8);
        this._headGeometry = new THREE.SphereGeometry(0.11, 16, 10);
        this._peerMaterial = new THREE.MeshBasicMaterial({
            color: 0x3388ff,
            transparent: true,
            opacity: 0.92,
            depthTest: false,
            depthWrite: false
        });

        this._tmpPos = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpQuat2 = new THREE.Quaternion();
        this._tmpForward = new THREE.Vector3();
        this._tmpHand = new THREE.Vector3();
        this._tmpMid = new THREE.Vector3();
        this._tmpDir = new THREE.Vector3();
        this._tmpShoulder = new THREE.Vector3();
        this._tmpArmQuat = new THREE.Quaternion();

        this._avatarTemplate = null;
        this._avatarReady = false;
        this._avatarLoadPromise = this._loadAvatar();

        // Generated GLB dimensions.
        this._avatarHeadY = 1.70;
        this._shoulderY = 1.23;
        this._shoulderX = 0.34;
        this._armBaseLength = 0.63;
    }

    async _loadAvatar() {
        try {
            const loader = new GLTFLoader();
            const gltf = await loader.loadAsync(this.avatarUrl);
            this._avatarTemplate = gltf.scene;
            this._avatarTemplate.traverse((obj) => {
                if (obj.isMesh) {
                    obj.frustumCulled = true;
                    obj.castShadow = false;
                    obj.receiveShadow = false;
                }
            });
            this._avatarReady = true;
            console.log('[Multiplayer] Chilquinta GLB loaded.');

            // Peers can arrive before the GLB finishes loading.
            for (const peer of this._peers.values()) {
                this._installAvatar(peer);
            }
        } catch (error) {
            // Do not kill multiplayer if the GLB path is wrong or a browser
            // refuses the asset. A simple fallback avatar remains visible.
            console.error('[Multiplayer] GLB load failed; using fallback avatar:', error);
            this._avatarReady = false;
        }
    }

    connect() {
        if (!this.serverUrl) {
            console.error('[Multiplayer] no serverUrl configured.');
            return;
        }

        this._ws = new WebSocket(this.serverUrl);

        this._ws.addEventListener('open', () => {
            console.log(`[Multiplayer] connected -> ${this.serverUrl} / room=${this.room}`);
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
                console.log(`[Multiplayer] joined as ${this.playerId}`);
                this._loadExistingTags();
                break;
            case 'peer-joined':
                this._ensurePeer(msg.id);
                break;
            case 'peer-left':
                this._removePeer(msg.id);
                break;
            case 'pose':
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

    _makeFallbackPeer(group) {
        const head = new THREE.Mesh(this._headGeometry, this._peerMaterial);
        const handL = new THREE.Mesh(this._handGeometry, this._peerMaterial);
        const handR = new THREE.Mesh(this._handGeometry, this._peerMaterial);
        head.position.y = 1.7;
        group.add(head, handL, handR);
        return { head, handL, handR };
    }

    _ensurePeer(id) {
        if (this._peers.has(id)) return this._peers.get(id);

        const group = new THREE.Group();
        group.name = `RemotePlayer_${id}`;
        this.scene.add(group);

        const peer = {
            id,
            group,
            avatar: null,
            parts: {},
            fallback: null,
            targetPose: null
        };

        this._peers.set(id, peer);
        this._installAvatar(peer);
        return peer;
    }

    _installAvatar(peer) {
        if (!peer || peer.avatar || !this._avatarTemplate) return;

        const avatar = this._avatarTemplate.clone(true);
        avatar.name = 'ChilquintaOperatorAvatar';
        avatar.traverse((obj) => {
            if (obj.isMesh) obj.frustumCulled = true;
        });

        peer.group.add(avatar);
        peer.avatar = avatar;

        const find = (name) => avatar.getObjectByName(name);
        peer.parts = {
            head: find('Head'),
            helmet: find('Casco'),
            badge: find('Insignia_Casco'),
            armL: find('Brazo_Izquierdo'),
            armR: find('Brazo_Derecho'),
            handL: find('Mano_Izquierda'),
            handR: find('Mano_Derecha'),
            torso: find('Torso')
        };

        // The GLB is a static low-poly model. We replace the arm/hand transforms
        // at runtime so the remote avatar follows the VR controllers.
        avatar.scale.setScalar(1);

        if (peer.fallback) {
            peer.group.remove(peer.fallback.head, peer.fallback.handL, peer.fallback.handR);
            peer.fallback = null;
        }
    }

    _ensureFallback(peer) {
        if (peer.avatar || peer.fallback) return;
        peer.fallback = this._makeFallbackPeer(peer.group);
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    _updateAvatar(peer, pose) {
        if (!pose?.head?.p) return;
        if (!peer.avatar) this._ensureFallback(peer);

        if (!peer.avatar) return;

        const headPos = this._tmpPos.fromArray(pose.head.p);
        const headQuat = this._tmpQuat.fromArray(pose.head.q);

        this._tmpForward.set(0, 0, -1).applyQuaternion(headQuat);
        this._tmpForward.y = 0;
        if (this._tmpForward.lengthSq() < 1e-8) this._tmpForward.set(0, 0, -1);
        this._tmpForward.normalize();
        const yaw = Math.atan2(this._tmpForward.x, -this._tmpForward.z);

        peer.group.position.set(headPos.x, headPos.y - this._avatarHeadY, headPos.z);
        peer.group.rotation.set(0, yaw, 0);
        peer.group.updateMatrixWorld(true);

        const rootYawInv = this._tmpQuat2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
        const localHeadQuat = rootYawInv.clone().multiply(headQuat);

        if (peer.avatar) {
            if (peer.parts.head) peer.parts.head.quaternion.copy(localHeadQuat);
            if (peer.parts.helmet) peer.parts.helmet.quaternion.copy(localHeadQuat);
            if (peer.parts.badge) peer.parts.badge.quaternion.copy(localHeadQuat);

            this._updateHandAndArm(peer, pose.handL, false);
            this._updateHandAndArm(peer, pose.handR, true);
        } else if (peer.fallback) {
            peer.fallback.head.position.set(0, 1.7, 0);
            if (pose.handL?.p) peer.fallback.handL.position.fromArray(pose.handL.p);
            if (pose.handR?.p) peer.fallback.handR.position.fromArray(pose.handR.p);
        }
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

        const handWorldQuat = this._tmpQuat.fromArray(handPose.q);
        const rootWorldQuat = peer.group.getWorldQuaternion(this._tmpQuat2);
        hand.quaternion.copy(rootWorldQuat.clone().invert().multiply(handWorldQuat));

        const shoulderLocal = this._tmpShoulder.set(
            rightSide ? this._shoulderX : -this._shoulderX,
            this._shoulderY,
            0
        );
        const shoulderWorld = this._tmpMid.copy(shoulderLocal);
        peer.group.localToWorld(shoulderWorld);

        const direction = this._tmpDir.copy(handWorld).sub(shoulderWorld);
        const length = Math.max(0.08, direction.length());
        direction.normalize();

        const midpointWorld = this._tmpMid.copy(shoulderWorld).add(handWorld).multiplyScalar(0.5);
        const midpointLocal = this._tmpPos.copy(midpointWorld);
        peer.group.worldToLocal(midpointLocal);
        arm.position.copy(midpointLocal);
        arm.scale.set(1, length / this._armBaseLength, 1);

        this._tmpArmQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
        arm.quaternion.copy(rootWorldQuat.clone().invert().multiply(this._tmpArmQuat));
    }

    update(camera, controllerL, controllerR) {
        for (const peer of this._peers.values()) {
            if (peer.targetPose) this._updateAvatar(peer, peer.targetPose);
        }

        const now = performance.now();
        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;

        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (!camera || !controllerL || !controllerR) return;

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
            for (const tag of tags.slice(-this.maxTags)) this._addTagMarker(tag);
            console.log(`[Tags] loaded ${this.tags.size}/${this.maxTags}`);
        } catch (e) {
            console.warn('[Multiplayer] failed to load tags', e);
        }
    }

    getTagCount() { return this.tags.size; }
    canCreateTag() { return this.tags.size < this.maxTags; }

    async createTag(position, note) {
        if (!this.canCreateTag()) return { ok: false, limitReached: true };
        try {
            const res = await fetch(`${this._httpUrl()}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ room: this.room, x: position.x, y: position.y, z: position.z, note, author: this.playerName })
            });
            let data = null;
            try { data = await res.json(); } catch (_) {}
            if (!res.ok) {
                if (res.status === 409 && data?.limitReached) return { ok: false, limitReached: true };
                throw new Error(`HTTP ${res.status}`);
            }
            if (data?.id) this._addTagMarker(data);
            return { ok: true, tag: data };
        } catch (e) {
            console.warn('[Multiplayer] failed to create tag', e);
            return { ok: false, error: e };
        }
    }

    _httpUrl() { return this.serverUrl.replace(/^ws/, 'http'); }

    _wrapText(text, maxChars = 28, maxLines = 3) {
        const words = String(text || '').trim().split(/\s+/).filter(Boolean);
        const lines = [];
        let current = '';
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length <= maxChars) current = candidate;
            else { if (current) lines.push(current); current = word.slice(0, maxChars); if (lines.length >= maxLines - 1) break; }
        }
        if (current && lines.length < maxLines) lines.push(current);
        if (!lines.length) lines.push('Sin texto');
        if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(1, maxChars - 1)) + '…';
        return lines;
    }

    _createTagLabel(tag) {
        const canvas = document.createElement('canvas');
        canvas.width = 760; canvas.height = 360;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(10,15,20,0.88)';
        ctx.beginPath(); ctx.roundRect(12, 12, canvas.width - 24, canvas.height - 24, 28); ctx.fill();
        ctx.strokeStyle = 'rgba(255,190,0,0.95)'; ctx.lineWidth = 6; ctx.stroke();
        ctx.font = 'bold 42px Arial'; ctx.fillStyle = '#ffcc33'; ctx.fillText('TAG', 38, 62);
        ctx.font = 'bold 34px Arial'; ctx.fillStyle = '#ffffff';
        this._wrapText(tag.note, 28, 3).forEach((line, i) => ctx.fillText(line, 38, 122 + i * 58));
        ctx.font = '26px Arial'; ctx.fillStyle = '#d8d8d8';
        ctx.fillText(`${tag.author || 'Anónimo'} • ${String(tag.id || '').slice(0, 6)}`, 38, 316);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
        sprite.scale.set(0.75, 0.355, 1); sprite.renderOrder = 1001; sprite.position.set(0, 0.21, 0);
        return sprite;
    }

    _addTagMarker(tag) {
        if (!tag || !tag.id || this.tags.has(tag.id) || this.tags.size >= this.maxTags) return;
        const group = new THREE.Group();
        group.position.set(Number(tag.x), Number(tag.y), Number(tag.z));
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false, depthWrite: false }));
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8), new THREE.MeshBasicMaterial({ color: 0xffcc33, depthTest: false, depthWrite: false }));
        stem.position.y = 0.06;
        group.add(marker, stem, this._createTagLabel(tag));
        this.scene.add(group);
        this.tags.set(tag.id, group);
    }
}

export { MultiplayerSession };
