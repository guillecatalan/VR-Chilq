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
        this.tags = new Map();
        this.maxTags = options.maxTags ?? 25;

        this._ws = null;
        this._peers = new Map();
        this._peerNames = new Map(); // id -> name, populated by 'peers'/'peer-joined'
        this._lastSend = 0;
        this._refSpace = null;

        // Procedural technical-operator avatar. This is intentionally independent
        // of GLTF loading so one missing asset can NEVER make multiplayer disappear.
        this._skin = new THREE.MeshBasicMaterial({ color: 0x8a543c });
        this._shirt = new THREE.MeshBasicMaterial({ color: 0xb51f24 });
        this._reflective = new THREE.MeshBasicMaterial({ color: 0xf1f1e8 });
        this._pants = new THREE.MeshBasicMaterial({ color: 0x101826 });
        this._boots = new THREE.MeshBasicMaterial({ color: 0x202020 });
        this._helmet = new THREE.MeshBasicMaterial({ color: 0xf4f4ef });
        this._glove = new THREE.MeshBasicMaterial({ color: 0xd8d2bd });
        this._black = new THREE.MeshBasicMaterial({ color: 0x101010 });

        this._tmpPos = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
        this._tmpMatrix = new THREE.Matrix4();
        this._tmpMatrix2 = new THREE.Matrix4();
        this._tmpDir = new THREE.Vector3();
        this._tmpMid = new THREE.Vector3();
        this._tmpUp = new THREE.Vector3(0, 1, 0);
    }

    connect() {
        if (!this.serverUrl) {
            console.error('[Multiplayer] no serverUrl configured.');
            return;
        }
        try { if (this._ws) this._ws.close(); } catch (_) {}
        this._ws = new WebSocket(this.serverUrl);
        this._ws.addEventListener('open', () => {
            console.log('[Multiplayer] connected:', this.room);
            this._ws.send(JSON.stringify({ type: 'join', room: this.room, name: this.playerName }));
        });
        this._ws.addEventListener('message', (event) => {
            try { this._onMessage(JSON.parse(event.data)); }
            catch (e) { console.warn('[Multiplayer] invalid server message', e); }
        });
        this._ws.addEventListener('close', () => {
            console.warn('[Multiplayer] disconnected, retrying in 3s');
            setTimeout(() => this.connect(), 3000);
        });
        this._ws.addEventListener('error', (e) => console.error('[Multiplayer] socket error', e));
    }

    _onMessage(msg) {
        switch (msg.type) {
            case 'joined':
                this.playerId = msg.id;
                console.log('[Multiplayer] joined as', msg.id);
                this._loadExistingTags();
                break;
            case 'peers':
                // Sent once, right after 'joined': who's already in the room.
                for (const p of msg.peers || []) this._peerNames.set(p.id, p.name);
                break;
            case 'peer-joined':
                this._ensurePeer(msg.id);
                if (msg.name) this._peerNames.set(msg.id, msg.name);
                break;
            case 'peer-left':
                this._removePeer(msg.id);
                this._peerNames.delete(msg.id);
                break;
            case 'pose':
                if (!msg.id || msg.id === this.playerId || !msg.pose?.head) break;
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
        group.name = `RemoteAvatar_${id}`;
        group.visible = true;

        // Technical operator avatar: clean-shaven, white helmet and red
        // high-visibility work shirt. The head quaternion follows the remote
        // headset, so the visor visibly indicates gaze direction.
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 18, 14), this._skin);
        head.scale.set(0.94, 1.05, 0.92);

        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.10, 12), this._skin);
        neck.position.y = -0.105;

        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.145, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), this._helmet);
        helmet.position.y = 0.055;
        helmet.scale.set(1.10, 0.72, 1.02);
        const helmetRim = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.17, 0.025, 18), this._helmet);
        helmetRim.position.y = 0.005;
        helmetRim.scale.z = 0.82;

        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.030, 0.020), this._black);
        visor.position.set(0, 0.045, -0.115);
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.045, 8), this._skin);
        nose.position.set(0, -0.005, -0.116);
        nose.rotation.x = -Math.PI / 2;

        const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.30, 6, 10), this._shirt);
        torso.scale.set(1.02, 1.0, 0.78);
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.045, 0.20), this._black);
        collar.position.set(0, -0.025, -0.115);
        const chestPanel = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.11, 0.018), this._black);
        chestPanel.position.set(-0.055, -0.08, -0.125);
        const belt = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.055, 0.16), this._black);
        belt.position.y = -0.245;
        const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.040, 0.025), this._reflective);
        buckle.position.set(0, -0.245, -0.085);

        const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.30, 5, 8), this._pants);
        const legR = legL.clone();
        const bootL = new THREE.Mesh(new THREE.CapsuleGeometry(0.060, 0.10, 5, 8), this._boots);
        const bootR = bootL.clone();

        const armGeo = new THREE.CapsuleGeometry(0.028, 0.18, 5, 8);
        const handGeo = new THREE.SphereGeometry(0.045, 12, 8);
        const armL = new THREE.Mesh(armGeo, this._shirt);
        const armR = new THREE.Mesh(armGeo, this._shirt);
        const handL = new THREE.Mesh(handGeo, this._glove);
        const handR = new THREE.Mesh(handGeo, this._glove);

        // Reflective bands on torso.
        const band1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.045, 0.24), this._reflective);
        band1.position.y = -0.06;
        const band2 = band1.clone();
        band2.position.y = 0.02;

        group.add(head, neck, helmet, helmetRim, visor, nose, torso, collar, chestPanel,
                  belt, buckle, legL, legR, bootL, bootR, armL, armR, handL, handR, band1, band2);
        this.scene.add(group);

        this._peers.set(id, {
            group, head, neck, helmet, helmetRim, visor, nose, torso, collar, chestPanel,
            belt, buckle, legL, legR, bootL, bootR, armL, armR, handL, handR, band1, band2,
            targetPose: null,
            lastPoseTime: performance.now()
        });
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    _applyPose(peer, pose) {
        if (!pose?.head?.p) return;

        const hp = new THREE.Vector3().fromArray(pose.head.p);
        const hq = new THREE.Quaternion().fromArray(pose.head.q || [0, 0, 0, 1]);
        peer.head.position.copy(hp);
        peer.head.quaternion.copy(hq);
        peer.neck.position.set(hp.x, hp.y - 0.105, hp.z);
        peer.neck.quaternion.copy(hq);

        // Head-relative body. We intentionally keep the body upright while the
        // head follows headset pitch/roll, avoiding a human avatar tipping over.
        peer.torso.position.copy(hp).add(new THREE.Vector3(0, -0.31, 0));
        peer.torso.quaternion.setFromEuler(new THREE.Euler(0, hq.y ? 0 : 0, 0));
        const yaw = Math.atan2(2 * (hq.w * hq.y + hq.x * hq.z), 1 - 2 * (hq.y * hq.y + hq.z * hq.z));
        peer.torso.rotation.set(0, yaw, 0);
        peer.belt.position.set(hp.x, hp.y - 0.48, hp.z);
        peer.belt.rotation.y = yaw;
        peer.collar.position.set(hp.x, hp.y - 0.335, hp.z - 0.105);
        peer.collar.rotation.y = yaw;
        peer.chestPanel.position.set(hp.x - 0.055, hp.y - 0.39, hp.z - 0.125);
        peer.chestPanel.rotation.y = yaw;
        peer.buckle.position.set(hp.x, hp.y - 0.48, hp.z - 0.085);
        peer.buckle.rotation.y = yaw;
        peer.legL.position.set(hp.x - 0.075, hp.y - 0.72, hp.z);
        peer.legR.position.set(hp.x + 0.075, hp.y - 0.72, hp.z);
        peer.bootL.position.set(hp.x - 0.075, hp.y - 0.91, hp.z - 0.025);
        peer.bootR.position.set(hp.x + 0.075, hp.y - 0.91, hp.z - 0.025);

        peer.helmet.position.set(hp.x, hp.y + 0.055, hp.z);
        peer.helmet.quaternion.copy(hq);
        peer.helmetRim.position.set(hp.x, hp.y + 0.005, hp.z);
        peer.helmetRim.quaternion.copy(hq);
        peer.visor.position.set(hp.x, hp.y + 0.045, hp.z - 0.115);
        peer.visor.quaternion.copy(hq);
        peer.nose.position.set(hp.x, hp.y - 0.005, hp.z - 0.116);
        peer.nose.quaternion.copy(hq);

        const shoulderL = new THREE.Vector3(hp.x - 0.15, hp.y - 0.20, hp.z);
        const shoulderR = new THREE.Vector3(hp.x + 0.15, hp.y - 0.20, hp.z);

        if (pose.handL?.p) {
            const lp = new THREE.Vector3().fromArray(pose.handL.p);
            peer.handL.position.copy(lp);
            peer.handL.quaternion.fromArray(pose.handL.q || [0,0,0,1]);
            this._orientLimb(peer.armL, shoulderL, lp);
        }
        if (pose.handR?.p) {
            const rp = new THREE.Vector3().fromArray(pose.handR.p);
            peer.handR.position.copy(rp);
            peer.handR.quaternion.fromArray(pose.handR.q || [0,0,0,1]);
            this._orientLimb(peer.armR, shoulderR, rp);
        }

        // Reflective bands follow torso yaw.
        peer.band1.position.copy(peer.torso.position);
        peer.band1.position.y += 0.07;
        peer.band1.rotation.y = yaw;
        peer.band2.position.copy(peer.torso.position);
        peer.band2.position.y += 0.14;
        peer.band2.rotation.y = yaw;
    }

    _orientLimb(mesh, a, b) {
        this._tmpMid.copy(a).add(b).multiplyScalar(0.5);
        this._tmpDir.copy(b).sub(a);
        const len = this._tmpDir.length();
        mesh.position.copy(this._tmpMid);
        mesh.scale.set(1, Math.max(0.15, len / 0.23), 1);
        if (len > 0.001) mesh.quaternion.setFromUnitVectors(this._tmpUp, this._tmpDir.normalize());
    }

    _readGripPose(frame, source, refSpace, rig) {
        if (!frame || !source || !refSpace) return null;
        const space = source.gripSpace || source.targetRaySpace;
        if (!space) return null;
        const pose = frame.getPose(space, refSpace);
        if (!pose) return null;

        // WebXR gives controller pose in XR reference space. Locomotion is an
        // application-level offset, so compose it exactly once.
        this._tmpMatrix.fromArray(pose.transform.matrix);
        if (rig) {
            rig.updateMatrixWorld(true);
            this._tmpMatrix2.copy(rig.matrixWorld).multiply(this._tmpMatrix);
        } else {
            this._tmpMatrix2.copy(this._tmpMatrix);
        }
        this._tmpPos.setFromMatrixPosition(this._tmpMatrix2);
        this._tmpQuat.setFromRotationMatrix(this._tmpMatrix2);
        return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
    }

    update(camera, controllerL, controllerR, locomotionRig = null, renderer = null, frame = null) {
        for (const peer of this._peers.values()) {
            if (peer.targetPose) this._applyPose(peer, peer.targetPose);
        }

        const now = performance.now();
        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !camera) return;

        const pose = { head: null, handL: null, handR: null };
        camera.getWorldPosition(this._tmpPos);
        camera.getWorldQuaternion(this._tmpQuat);
        pose.head = { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };

        // Preferred path: use WebXR gripSpace directly. This avoids relying on
        // controller Group parenting and fixes the common "hand stays at origin"
        // bug after locomotion.
        if (renderer?.xr?.isPresenting && frame) {
            const ref = renderer.xr.getReferenceSpace();
            const session = renderer.xr.getSession();
            if (ref && session) {
                for (const source of session.inputSources) {
                    if (source.handedness !== 'left' && source.handedness !== 'right') continue;
                    const hp = this._readGripPose(frame, source, ref, locomotionRig);
                    if (source.handedness === 'left') pose.handL = hp;
                    else pose.handR = hp;
                }
            }
        }

        // Fallback for non-XR/testing and older browsers.
        const packController = (obj) => {
            if (!obj) return null;
            obj.updateMatrixWorld(true);
            obj.getWorldPosition(this._tmpPos);
            obj.getWorldQuaternion(this._tmpQuat);
            return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
        };
        if (!pose.handL) pose.handL = packController(controllerL);
        if (!pose.handR) pose.handR = packController(controllerR);
        // Head pose is always sufficient to keep the remote avatar alive.
        // A temporarily missing controller must not suppress the whole packet.
        this._ws.send(JSON.stringify({ type: 'pose', pose }));
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

    /** Array of {id, x, y, z, note, author, created_at}, newest first. */
    getTagsArray() {
        return Array.from(this.tags.values())
            .map((group) => group.userData.tag)
            .filter(Boolean)
            .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
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

    /** Real player names for the "Usuarios" panel, sourced from the server. */
    getPeerLabels() {
        return Array.from(this._peerNames.values());
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

        // Author / user name FIRST. The name is deliberately placed at the top
        // so the tag identifies who created it before showing the note.
        ctx.font = 'bold 38px Arial';
        ctx.fillStyle = '#ffcc33';
        const author = String(tag.author || 'Anónimo');
        ctx.fillText(author.slice(0, 30), 38, 62);

        // Main note
        ctx.font = 'bold 32px Arial';
        ctx.fillStyle = '#ffffff';
        const lines = this._wrapText(tag.note, 30, 3);
        lines.forEach((line, i) => {
            ctx.fillText(line, 38, 122 + i * 55);
        });

        // Tag id / type at the bottom
        ctx.font = '24px Arial';
        ctx.fillStyle = '#d8d8d8';
        const shortId = String(tag.id || '').slice(0, 6);
        ctx.fillText(`TAG  •  ${shortId}`, 38, 316);

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
