import * as THREE from 'three';

/**
 * MultiplayerSession
 *
 * Syncs avatars and EHS tags through the Render WebSocket/HTTP server.
 * Tags are rendered as a marker plus a floating text box inside the model.
 * Maximum number of tags visible/creatable per room: 25.
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
        this.tags = new Map(); // id -> Group
        this.maxTags = options.maxTags ?? 25;

        this._ws = null;
        this._peers = new Map();
        this._lastSend = 0;

        // Lightweight operator avatar: helmet, visor, torso, arms and controllers.
        // All geometry is local and tiny; only poses are synchronized over the network.
        this._headGeometry = new THREE.SphereGeometry(0.105, 20, 14);
        this._helmetGeometry = new THREE.SphereGeometry(0.125, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62);
        this._visorGeometry = new THREE.SphereGeometry(0.108, 20, 10, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.30);
        this._torsoGeometry = new THREE.CapsuleGeometry(0.11, 0.24, 6, 10);
        this._armGeometry = new THREE.CapsuleGeometry(0.022, 0.16, 4, 8);
        this._handGeometry = new THREE.SphereGeometry(0.045, 12, 8);
        this._peerBodyMaterial = new THREE.MeshBasicMaterial({ color: 0x3388ff, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false });
        this._peerHelmetMaterial = new THREE.MeshBasicMaterial({ color: 0xffc400, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
        this._peerVisorMaterial = new THREE.MeshBasicMaterial({ color: 0x101820, transparent: true, opacity: 0.92, depthTest: false, depthWrite: false });
        this._peerAccentMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
        this._tmpPos = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpVec = new THREE.Vector3();
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
        if (this._peers.has(id)) return;

        const group = new THREE.Group();
        group.renderOrder = 2000;

        const head = new THREE.Mesh(this._headGeometry, this._peerBodyMaterial);
        const helmet = new THREE.Mesh(this._helmetGeometry, this._peerHelmetMaterial);
        const visor = new THREE.Mesh(this._visorGeometry, this._peerVisorMaterial);
        const torso = new THREE.Mesh(this._torsoGeometry, this._peerBodyMaterial);
        const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.055, 0.10), this._peerAccentMaterial);
        const handL = new THREE.Mesh(this._handGeometry, this._peerAccentMaterial);
        const handR = new THREE.Mesh(this._handGeometry, this._peerAccentMaterial);
        const armL = new THREE.Mesh(this._armGeometry, this._peerBodyMaterial);
        const armR = new THREE.Mesh(this._armGeometry, this._peerBodyMaterial);

        group.add(head, helmet, visor, torso, shoulder, armL, armR, handL, handR);
        this.scene.add(group);
        this._peers.set(id, { group, head, helmet, visor, torso, shoulder, armL, armR, handL, handR, targetPose: null });
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    update(camera, controllerL, controllerR, locomotionRig = null) {
        for (const peer of this._peers.values()) {
            const p = peer.targetPose;
            if (!p) continue;
            peer.head.position.fromArray(p.head.p);
            peer.head.quaternion.fromArray(p.head.q);

            peer.helmet.position.copy(peer.head.position);
            peer.helmet.position.y += 0.025;
            peer.helmet.quaternion.copy(peer.head.quaternion);

            peer.visor.position.copy(peer.head.position);
            peer.visor.quaternion.copy(peer.head.quaternion);
            peer.visor.translateZ(-0.065);

            peer.torso.position.copy(peer.head.position);
            peer.torso.position.y -= 0.23;
            peer.torso.quaternion.copy(peer.head.quaternion);

            peer.shoulder.position.copy(peer.head.position);
            peer.shoulder.position.y -= 0.10;
            peer.shoulder.quaternion.copy(peer.head.quaternion);

            peer.handL.position.fromArray(p.handL.p);
            peer.handL.quaternion.fromArray(p.handL.q);
            peer.handR.position.fromArray(p.handR.p);
            peer.handR.quaternion.fromArray(p.handR.q);

            const orientArm = (arm, shoulderPos, handPos) => {
                const midpoint = this._tmpPos.copy(shoulderPos).add(handPos).multiplyScalar(0.5);
                const direction = this._tmpVec.copy(handPos).sub(shoulderPos);
                const length = direction.length();
                arm.position.copy(midpoint);
                arm.scale.set(1, Math.max(0.25, length / 0.22), 1);
                if (length > 0.001) {
                    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
                }
            };

            const leftShoulder = peer.head.position.clone();
            leftShoulder.x -= 0.13;
            leftShoulder.y -= 0.10;
            const rightShoulder = peer.head.position.clone();
            rightShoulder.x += 0.13;
            rightShoulder.y -= 0.10;

            orientArm(peer.armL, leftShoulder, peer.handL.position);
            orientArm(peer.armR, rightShoulder, peer.handR.position);
        }

        const now = performance.now();
        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;

        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (!camera || !controllerL || !controllerR) return;

        const pack = (obj, applyRig = false) => {
            if (applyRig && locomotionRig) {
                locomotionRig.updateMatrixWorld(true);
                obj.updateMatrixWorld(true);
                const worldMatrix = new THREE.Matrix4().copy(locomotionRig.matrixWorld).multiply(obj.matrixWorld);
                this._tmpPos.setFromMatrixPosition(worldMatrix);
                this._tmpQuat.setFromRotationMatrix(worldMatrix);
                return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
            }
            obj.getWorldPosition(this._tmpPos);
            obj.getWorldQuaternion(this._tmpQuat);
            return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
        };

        this._ws.send(JSON.stringify({
            type: 'pose',
            pose: {
                head: pack(camera, false),
                handL: pack(controllerL, true),
                handR: pack(controllerR, true)
            }
        }));
    }

    async _loadExistingTags() {
        try {
            const res = await fetch(`${this._httpUrl()}/tags?room=${encodeURIComponent(this.room)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const tags = await res.json();

            // Keep the most recent maxTags if a room somehow contains more.
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
            try {
                data = await res.json();
            } catch (_) {
                data = null;
            }

            if (!res.ok) {
                if (res.status === 409 && data?.limitReached) {
                    console.warn('[Tags] server says the 25-tag limit was reached.');
                    return { ok: false, limitReached: true };
                }
                throw new Error(`HTTP ${res.status}`);
            }

            // Important: the HTTP POST response is also added locally.
            // This makes the first tag appear immediately even if the WebSocket
            // broadcast is delayed. _addTagMarker prevents duplicates by id.
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
            if (candidate.length <= maxChars) {
                current = candidate;
            } else {
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
        canvas.width = 760;
        canvas.height = 360;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Background box
        ctx.fillStyle = 'rgba(10, 15, 20, 0.88)';
        ctx.beginPath();
        ctx.roundRect(12, 12, canvas.width - 24, canvas.height - 24, 28);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 190, 0, 0.95)';
        ctx.lineWidth = 6;
        ctx.stroke();

        // Title
        ctx.font = 'bold 42px Arial';
        ctx.fillStyle = '#ffcc33';
        ctx.fillText('TAG', 38, 62);

        // Main note
        ctx.font = 'bold 34px Arial';
        ctx.fillStyle = '#ffffff';
        const lines = this._wrapText(tag.note, 28, 3);
        lines.forEach((line, i) => {
            ctx.fillText(line, 38, 122 + i * 58);
        });

        // Author / number
        ctx.font = '26px Arial';
        ctx.fillStyle = '#d8d8d8';
        const shortId = String(tag.id || '').slice(0, 6);
        ctx.fillText(`${tag.author || 'Anónimo'}  •  ${shortId}`, 38, 316);

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
        sprite.scale.set(0.75, 0.355, 1);
        sprite.renderOrder = 1001;
        sprite.position.set(0, 0.21, 0);
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
            new THREE.MeshBasicMaterial({
                color: 0xffaa00,
                depthTest: false,
                depthWrite: false
            })
        );
        marker.renderOrder = 1000;

        const stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.008, 0.008, 0.12, 8),
            new THREE.MeshBasicMaterial({
                color: 0xffcc33,
                depthTest: false,
                depthWrite: false
            })
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
