import * as THREE from 'three';

/**
 * MultiplayerSession
 *
 * Connects to the XR relay server, renders a simple head+hands avatar for
 * every other connected player, and syncs EHS tags (create/list) so both
 * headsets see the same markers.
 *
 * Usage:
 *   const mp = new MultiplayerSession(scene, {
 *       serverUrl: 'wss://your-server.onrender.com',
 *       room: 'edificio-baron',
 *   });
 *   mp.connect();
 *   // every frame:
 *   mp.update(camera, controllerL, controllerR);
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
        this.tags = new Map(); // id -> THREE.Mesh marker

        this._ws = null;
        this._peers = new Map(); // id -> { group, head, handL, handR, targetPose }
        this._lastSend = 0;

        this._handGeometry = new THREE.CapsuleGeometry(0.03, 0.08, 4, 8);
        this._headGeometry = new THREE.SphereGeometry(0.11, 12, 8);
        this._peerMaterial = new THREE.MeshStandardMaterial({ color: 0x3388ff });

        this._tmpPos = new THREE.Vector3();
        this._tmpQuat = new THREE.Quaternion();
    }

    connect() {
        if (!this.serverUrl) {
            console.error('[Multiplayer] no serverUrl configured — set it once the server is deployed.');
            return;
        }
        this._ws = new WebSocket(this.serverUrl);
        this._ws.addEventListener('open', () => {
            this._ws.send(JSON.stringify({ type: 'join', room: this.room }));
        });
        this._ws.addEventListener('message', (event) => this._onMessage(JSON.parse(event.data)));
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
        const head = new THREE.Mesh(this._headGeometry, this._peerMaterial);
        const handL = new THREE.Mesh(this._handGeometry, this._peerMaterial);
        const handR = new THREE.Mesh(this._handGeometry, this._peerMaterial);
        group.add(head, handL, handR);
        this.scene.add(group);
        this._peers.set(id, { group, head, handL, handR, targetPose: null });
    }

    _removePeer(id) {
        const peer = this._peers.get(id);
        if (!peer) return;
        this.scene.remove(peer.group);
        this._peers.delete(id);
    }

    /**
     * Call every frame. Applies the latest received poses to remote avatars
     * and (throttled) sends this player's own pose to the server.
     */
    update(camera, controllerL, controllerR) {
        for (const peer of this._peers.values()) {
            const p = peer.targetPose;
            if (!p) continue;
            peer.head.position.fromArray(p.head.p);
            peer.head.quaternion.fromArray(p.head.q);
            peer.handL.position.fromArray(p.handL.p);
            peer.handL.quaternion.fromArray(p.handL.q);
            peer.handR.position.fromArray(p.handR.p);
            peer.handR.quaternion.fromArray(p.handR.q);
        }

        const now = performance.now();
        if (now - this._lastSend < 1000 / this.sendRateHz) return;
        this._lastSend = now;
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

        const pack = (obj) => {
            obj.getWorldPosition(this._tmpPos);
            obj.getWorldQuaternion(this._tmpQuat);
            return { p: this._tmpPos.toArray(), q: this._tmpQuat.toArray() };
        };

        this._ws.send(
            JSON.stringify({
                type: 'pose',
                pose: { head: pack(camera), handL: pack(controllerL), handR: pack(controllerR) }
            })
        );
    }

    async _loadExistingTags() {
        try {
            const res = await fetch(`${this._httpUrl()}/tags?room=${encodeURIComponent(this.room)}`);
            const tags = await res.json();
            for (const tag of tags) this._addTagMarker(tag);
        } catch (e) {
            console.warn('[Multiplayer] failed to load tags', e);
        }
    }

    async createTag(position, note) {
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
            return await res.json();
        } catch (e) {
            console.warn('[Multiplayer] failed to create tag', e);
        }
    }

    _httpUrl() {
        return this.serverUrl.replace(/^ws/, 'http');
    }

    _addTagMarker(tag) {
        if (this.tags.has(tag.id)) return;
        const marker = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.06),
            new THREE.MeshBasicMaterial({ color: 0xffaa00 })
        );
        marker.position.set(tag.x, tag.y, tag.z);
        marker.userData.tag = tag;
        this.scene.add(marker);
        this.tags.set(tag.id, marker);
    }
}

export { MultiplayerSession };
