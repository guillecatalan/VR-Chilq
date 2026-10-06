import * as THREE from 'three';

/**
 * VRMenu — a single floating canvas-texture panel that switches between
 * views depending on which button was clicked. Same pattern used elsewhere
 * in this project for in-world UI (canvas texture + manual hit-zones read
 * back from a raycaster UV hit) — no DOM overlay, because DOM overlay isn't
 * available in immersive-vr sessions (only immersive-ar), so anything the
 * user needs to see/click while in VR has to live on a 3D surface.
 */
class VRMenu {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.onAction = options.onAction || (() => {}); // (action, payload) => void
        this.visible = false;
        this.view = 'home';

        this.width = 620;
        this.height = 760;
        this.worldWidth = options.worldWidth ?? 0.56;
        this.worldHeight = this.worldWidth * (this.height / this.width);

        this._canvas = document.createElement('canvas');
        this._canvas.width = this.width;
        this._canvas.height = this.height;
        this._ctx = this._canvas.getContext('2d');
        this._texture = new THREE.CanvasTexture(this._canvas);

        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(this.worldWidth, this.worldHeight),
            new THREE.MeshBasicMaterial({
                map: this._texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false
            })
        );
        this.mesh.renderOrder = 2000;
        this.mesh.visible = false;
        scene.add(this.mesh);

        this._hitZones = [];
        this._tagsData = [];
        this._usersData = [];
        this._infoLine = '';

        this._draw();
    }

    setTagsData(tags) {
        this._tagsData = tags || [];
        if (this.view === 'tags') this._draw();
    }

    setUsersData(users) {
        this._usersData = users || [];
        if (this.view === 'users') this._draw();
    }

    setInfoLine(text) {
        this._infoLine = text || '';
        if (this.view === 'home') this._draw();
    }

    open(position, quaternion) {
        this.mesh.position.copy(position);
        this.mesh.quaternion.copy(quaternion);
        this.mesh.visible = true;
        this.visible = true;
        this.view = 'home';
        this._draw();
    }

    close() {
        this.mesh.visible = false;
        this.visible = false;
    }

    toggle(position, quaternion) {
        if (this.visible) this.close();
        else this.open(position, quaternion);
    }

    /** uv: THREE.Vector2 in [0,1], from a raycaster hit against this.mesh */
    handleSelect(uv) {
        if (!this.visible) return null;
        const px = uv.x * this.width;
        const py = (1 - uv.y) * this.height;
        const zone = this._hitZones.find((z) => px >= z.x0 && px < z.x1 && py >= z.y0 && py < z.y1);
        if (!zone) return null;

        if (zone.action === 'nav') {
            this.view = zone.payload;
            this._draw();
            return null;
        }
        if (zone.action === 'close') {
            this.close();
            return null;
        }
        // Anything else is the app's responsibility (e.g. teleporting to a tag).
        this.onAction(zone.action, zone.payload);
        return { action: zone.action, payload: zone.payload };
    }

    // ---------- drawing ----------

    _draw() {
        const ctx = this._ctx;
        const W = this.width;
        const H = this.height;
        ctx.clearRect(0, 0, W, H);
        this._hitZones = [];

        ctx.fillStyle = 'rgba(8, 12, 16, 0.92)';
        ctx.beginPath();
        ctx.roundRect(0, 0, W, H, 24);
        ctx.fill();
        ctx.strokeStyle = 'rgba(92, 255, 176, 0.9)';
        ctx.lineWidth = 5;
        ctx.stroke();

        ctx.fillStyle = '#5cffb0';
        ctx.font = 'bold 32px Arial';
        ctx.fillText('VR-Chilq', 28, 50);
        ctx.font = '17px Arial';
        ctx.fillStyle = '#aab0bb';
        ctx.fillText(this._viewTitle(), 28, 76);

        this._button(W - 60, 18, 40, 40, '✕', 'close', null, '#c0392b');

        const body = { home: this._drawHome, tags: this._drawTags, users: this._drawUsers, help: this._drawHelp, settings: this._drawSettings, explore: this._drawExplore };
        (body[this.view] || this._drawHome).call(this);

        this._texture.needsUpdate = true;
    }

    _viewTitle() {
        return {
            home: 'Menú principal',
            explore: 'Explorar',
            tags: `Centro de Tags (${this._tagsData.length}/25)`,
            users: 'Usuarios conectados',
            help: 'Ayuda',
            settings: 'Configuración'
        }[this.view] || '';
    }

    _drawHome() {
        const items = [
            ['INICIO', 'nav', 'home'],
            ['EXPLORAR', 'nav', 'explore'],
            ['TAGS', 'nav', 'tags'],
            ['USUARIOS', 'nav', 'users'],
            ['AYUDA', 'nav', 'help'],
            ['CONFIGURACIÓN', 'nav', 'settings']
        ];
        const top = 112;
        const h = 82;
        const gap = 14;
        items.forEach(([label, action, payload], i) => {
            this._button(28, top + i * (h + gap), this.width - 56, h, label, action, payload);
        });
        if (this._infoLine) {
            this._ctx.font = '14px Arial';
            this._ctx.fillStyle = '#8a8';
            this._ctx.fillText(this._infoLine, 28, this.height - 24);
        }
    }

    _drawExplore() {
        const lines = [
            'Recorré la instalación libremente.',
            '',
            'Gatillo izquierdo: volar hacia donde mirás',
            'Joystick izquierdo: moverte',
            'Joystick derecho: girar'
        ];
        lines.forEach((l, i) => this._text(l, 28, 130 + i * 34));
        this._backButton();
    }

    _drawTags() {
        const top = 110;
        if (!this._tagsData.length) {
            this._text('Todavía no hay tags en esta sala.', 28, top + 24);
        } else {
            this._tagsData.slice(0, 9).forEach((tag, i) => {
                const y = top + i * 62;
                const ctx = this._ctx;
                ctx.font = 'bold 18px Arial';
                ctx.fillStyle = '#fff';
                ctx.fillText(String(tag.author || 'Anónimo').slice(0, 16), 28, y + 20);
                ctx.font = '13px Arial';
                ctx.fillStyle = '#bbb';
                ctx.fillText(String(tag.note || '').slice(0, 42), 28, y + 40);
                this._button(this.width - 108, y, 80, 44, 'Ir', 'goto-tag', tag.id, '#2c6e49');
            });
        }
        this._backButton();
    }

    _drawUsers() {
        const top = 120;
        if (!this._usersData.length) {
            this._text('Sos el único conectado ahora mismo.', 28, top);
            this._text('(Modo demostración)', 28, top + 30);
        } else {
            this._usersData.forEach((name, i) => this._text(`• ${name}`, 28, top + i * 36));
        }
        this._backButton();
    }

    _drawHelp() {
        const lines = [
            'Gatillo izquierdo: volar hacia donde mirás',
            'Joystick izquierdo: moverte',
            'Joystick derecho: girar',
            'Empuñadura (grip): crear un tag EHS',
            'Botón A / X: abrir o cerrar este menú',
            '',
            'Informe completo e impresión/PDF:',
            'ver tags-dashboard.html en un navegador.'
        ];
        lines.forEach((l, i) => this._text(l, 28, 124 + i * 32));
        this._backButton();
    }

    _drawSettings() {
        this._text('(próximamente)', 28, 130);
        this._backButton();
    }

    _backButton() {
        this._button(28, this.height - 70, 150, 48, '← Volver', 'nav', 'home');
    }

    _button(x, y, w, h, label, action, payload, color = '#2c6e49') {
        const ctx = this._ctx;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 10);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 19px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + w / 2, y + h / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        this._hitZones.push({ x0: x, y0: y, x1: x + w, y1: y + h, action, payload });
    }

    _text(str, x, y) {
        this._ctx.font = '16px Arial';
        this._ctx.fillStyle = '#eee';
        this._ctx.fillText(str, x, y);
    }
}

export { VRMenu };
