import * as THREE from 'three';
import { OperatorAvatar, ensureAvatarLights } from './OperatorAvatar.js';

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
                for (const p of msg.peers || []) this._setPeerName(p.id, p.name);
                break;
            case 'peer-joined':
                this._ensurePeer(msg.id);
                if (msg.name) this._setPeerName(msg.id, msg.name);
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
        ensureAvatarLights(this.scene);

        // Shared OperatorAvatar (same model as the guide): body/head hierarchy,
        // two-bone arm IK, legs down to the floor, floating name tag.
        const avatar = new OperatorAvatar({ name: this._peerNames.get(id) || '' });
        this.scene.add(avatar.root);
        this._peers.set(id, { avatar, group: avatar.root, targetPose: null });
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        peer.avatar.dispose();
        this._peers.delete(id);
    }

    _setPeerName(id, name) {
        if (!name) return;
        this._peerNames.set(id, name);
        this._peers.get(id)?.avatar.setName(name);
    }

    _applyPose(peer, pose) {
        if (!pose?.head?.p) return;
        peer.avatar.applyPose(pose);
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

        const pose = { head: null, handL: null, handR: null, floorY: locomotionRig ? locomotionRig.position.y : 0 };
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

    isConnected() {
        return !!this._ws && this._ws.readyState === WebSocket.OPEN;
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
