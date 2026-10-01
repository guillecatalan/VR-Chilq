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

        // Lightweight technical operator avatar. The avatar is procedural so it
        // adds almost no loading cost to the LCC/Gaussian-Splat scene.
        this._headGeometry = new THREE.SphereGeometry(0.105, 20, 14);
        this._helmetGeometry = new THREE.SphereGeometry(0.125, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.64);
        this._visorGeometry = new THREE.SphereGeometry(0.109, 20, 10, 0, Math.PI * 2, Math.PI * 0.40, Math.PI * 0.28);
        this._neckGeometry = new THREE.CylinderGeometry(0.045, 0.05, 0.075, 12);
        this._torsoGeometry = new THREE.CapsuleGeometry(0.105, 0.22, 6, 10);
        this._pelvisGeometry = new THREE.BoxGeometry(0.17, 0.10, 0.10);
        this._shoulderGeometry = new THREE.SphereGeometry(0.048, 12, 8);
        this._armGeometry = new THREE.CapsuleGeometry(0.021, 0.14, 4, 8);
        this._handGeometry = new THREE.SphereGeometry(0.043, 12, 8);
        this._badgeGeometry = new THREE.BoxGeometry(0.065, 0.052, 0.012);

        this._tmpPos = new THREE.Vector3();
        this._tmpPos2 = new THREE.Vector3();
        this._tmpShoulderL = new THREE.Vector3();
        this._tmpShoulderR = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpQuat2 = new THREE.Quaternion();
        this._tmpVec = new THREE.Vector3();
        this._tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
        this._lastUpdateTime = performance.now();

        this._peerBodyMaterial = new THREE.MeshBasicMaterial({
            color: 0x3388ff,
            transparent: true,
            opacity: 0.88,
            depthTest: false,
            depthWrite: false
        });
        this._peerAccentMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
            depthWrite: false
        });
        this._peerVisorMaterial = new THREE.MeshBasicMaterial({
            color: 0x101820,
            transparent: true,
            opacity: 0.94,
            depthTest: false,
            depthWrite: false
        });
        this._peerHelmetMaterial = new THREE.MeshBasicMaterial({
            color: 0xffc400,
            transparent: true,
            opacity: 0.96,
            depthTest: false,
            depthWrite: false
        });

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

    _peerColor(id) {
        // Stable color per participant. This makes several operators easy to
        // distinguish without requiring textures or external assets.
        let hash = 0;
        for (let i = 0; i < String(id).length; i++) hash = ((hash << 5) - hash + String(id).charCodeAt(i)) | 0;
        const palette = [0x3388ff, 0x00c896, 0xff6b35, 0xb26cff, 0x2dd4ff, 0xff4d8d];
        return palette[Math.abs(hash) % palette.length];
    }

    _mesh(geometry, material, renderOrder = 900) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = renderOrder;
        return mesh;
    }

    _ensurePeer(id) {
        if (this._peers.has(id)) return;

        const group = new THREE.Group();
        group.renderOrder = 900;

        const color = this._peerColor(id);
        const bodyMaterial = this._peerBodyMaterial.clone();
        bodyMaterial.color.setHex(color);

        const head = this._mesh(this._headGeometry, bodyMaterial);
        const helmet = this._mesh(this._helmetGeometry, this._peerHelmetMaterial);
        const visor = this._mesh(this._visorGeometry, this._peerVisorMaterial);
        const neck = this._mesh(this._neckGeometry, bodyMaterial);
        const torso = this._mesh(this._torsoGeometry, bodyMaterial);
        const pelvis = this._mesh(this._pelvisGeometry, bodyMaterial);
        const shoulderL = this._mesh(this._shoulderGeometry, bodyMaterial);
        const shoulderR = this._mesh(this._shoulderGeometry, bodyMaterial);
        const upperArmL = this._mesh(this._armGeometry, bodyMaterial);
        const upperArmR = this._mesh(this._armGeometry, bodyMaterial);
        const forearmL = this._mesh(this._armGeometry, bodyMaterial);
        const forearmR = this._mesh(this._armGeometry, bodyMaterial);
        const handL = this._mesh(this._handGeometry, this._peerAccentMaterial);
        const handR = this._mesh(this._handGeometry, this._peerAccentMaterial);
        const badge = this._mesh(this._badgeGeometry, this._peerAccentMaterial, 901);

        group.add(
            torso, pelvis, neck,
            shoulderL, shoulderR,
            upperArmL, upperArmR, forearmL, forearmR,
            handL, handR,
            head, helmet, visor, badge
        );

        this.scene.add(group);

        this._peers.set(id, {
            group, head, helmet, visor, neck, torso, pelvis,
            shoulderL, shoulderR,
            upperArmL, upperArmR, forearmL, forearmR,
            handL, handR, badge,
            targetPose: null,
            initialized: false,
            headPos: new THREE.Vector3(),
            headQuat: new THREE.Quaternion(),
            handLPos: new THREE.Vector3(),
            handLQuat: new THREE.Quaternion(),
            handRPos: new THREE.Vector3(),
            handRQuat: new THREE.Quaternion(),
            bodyMaterial,
            color
        });
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    _orientSegment(mesh, a, b, thicknessScale = 1) {
        const midpoint = this._tmpPos.copy(a).add(b).multiplyScalar(0.5);
        const direction = this._tmpVec.copy(b).sub(a);
        const length = direction.length();

        mesh.position.copy(midpoint);
        mesh.scale.set(thicknessScale, Math.max(0.28, length / 0.18), thicknessScale);

        if (length > 0.001) {
            mesh.quaternion.setFromUnitVectors(this._tmpPos2.set(0, 1, 0), direction.normalize());
        }
    }

    _updateAvatar(peer) {
        const h = peer.headPos;
        const q = peer.headQuat;

        // Head + helmet + visor.
        peer.head.position.copy(h);
        peer.head.quaternion.copy(q);

        peer.helmet.position.copy(h).add(this._tmpPos2.set(0, 0.025, 0));
        peer.helmet.quaternion.copy(q);

        peer.visor.position.copy(h);
        peer.visor.quaternion.copy(q);
        peer.visor.translateZ(-0.065);

        // Keep the torso upright while the headset can pitch freely.
        this._tmpEuler.setFromQuaternion(q, 'YXZ');
        this._tmpEuler.x = 0;
        this._tmpEuler.z = 0;
        this._tmpQuat.setFromEuler(this._tmpEuler);

        peer.neck.position.copy(h).add(this._tmpPos2.set(0, -0.105, 0));
        peer.neck.quaternion.copy(this._tmpQuat);

        peer.torso.position.copy(h).add(this._tmpPos2.set(0, -0.235, 0));
        peer.torso.quaternion.copy(this._tmpQuat);

        peer.pelvis.position.copy(h).add(this._tmpPos2.set(0, -0.405, 0));
        peer.pelvis.quaternion.copy(this._tmpQuat);

        // Shoulders rotate with the operator's yaw.
        this._tmpShoulderL.set(-0.13, -0.135, 0).applyQuaternion(this._tmpQuat).add(h);
        this._tmpShoulderR.set(0.13, -0.135, 0).applyQuaternion(this._tmpQuat).add(h);
        peer.shoulderL.position.copy(this._tmpShoulderL);
        peer.shoulderR.position.copy(this._tmpShoulderR);

        // Estimate elbows from shoulder -> hand. The slight inward offset gives
        // the arms a natural bend instead of two perfectly straight sticks.
        const elbowL = this._tmpPos.copy(this._tmpShoulderL).lerp(peer.handLPos, 0.52);
        elbowL.x += 0.025;
        elbowL.y += 0.015;
        const elbowR = this._tmpPos2.copy(this._tmpShoulderR).lerp(peer.handRPos, 0.52);
        elbowR.x -= 0.025;
        elbowR.y += 0.015;

        this._orientSegment(peer.upperArmL, this._tmpShoulderL, elbowL, 1.0);
        this._orientSegment(peer.forearmL, elbowL, peer.handLPos, 0.92);
        this._orientSegment(peer.upperArmR, this._tmpShoulderR, elbowR, 1.0);
        this._orientSegment(peer.forearmR, elbowR, peer.handRPos, 0.92);

        peer.handL.position.copy(peer.handLPos);
        peer.handL.quaternion.copy(peer.handLQuat);
        peer.handR.position.copy(peer.handRPos);
        peer.handR.quaternion.copy(peer.handRQuat);

        // Small chest identifier, useful when several operators are present.
        peer.badge.position.copy(h).add(this._tmpPos2.set(0, -0.205, -0.108));
        peer.badge.quaternion.copy(this._tmpQuat);
    }

    update(camera, controllerL, controllerR, locomotionRig = null) {
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - this._lastUpdateTime) / 1000));
        this._lastUpdateTime = now;
        const smooth = 1 - Math.pow(0.0008, dt); // smooth but responsive

        for (const peer of this._peers.values()) {
            const p = peer.targetPose;
            if (!p || !p.head || !p.handL || !p.handR) continue;

            const targetHead = this._tmpPos.fromArray(p.head.p);
            const targetHeadQ = this._tmpQuat.fromArray(p.head.q);
            const targetHandL = this._tmpPos2.fromArray(p.handL.p);
            const targetHandLQ = this._tmpQuat2.fromArray(p.handL.q);
            const targetHandR = this._tmpVec.fromArray(p.handR.p);

            if (!peer.initialized) {
                peer.headPos.copy(targetHead);
                peer.headQuat.copy(targetHeadQ);
                peer.handLPos.copy(targetHandL);
                peer.handLQuat.copy(targetHandLQ);
                peer.handRPos.copy(targetHandR);
                peer.handRQuat.fromArray(p.handR.q);
                peer.initialized = true;
            } else {
                peer.headPos.lerp(targetHead, smooth);
                peer.headQuat.slerp(targetHeadQ, smooth);
                peer.handLPos.lerp(targetHandL, smooth);
                peer.handLQuat.slerp(targetHandLQ, smooth);
                peer.handRPos.lerp(targetHandR, smooth);
                this._tmpQuat2.fromArray(p.handR.q);
                peer.handRQuat.slerp(this._tmpQuat2, smooth);
            }

            this._updateAvatar(peer);
        }

        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;

        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (!camera || !controllerL || !controllerR) return;

        const pack = (obj, applyRig = false) => {
            if (applyRig && locomotionRig) {
                locomotionRig.updateMatrixWorld(true);
                obj.updateMatrixWorld(true);
                const worldMatrix = new THREE.Matrix4()
                    .copy(locomotionRig.matrixWorld)
                    .multiply(obj.matrixWorld);
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
                head: pack(camera),
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
