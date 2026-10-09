import * as THREE from 'three';

/**
 * VRMenu v2 — editor-style floating panel (sidebar tabs + content area).
 *
 * Why it looks the way it does:
 *  - Immersive-vr sessions have no DOM overlay, so everything the user sees
 *    and clicks has to live on a 3D surface: a canvas texture on a plane.
 *  - Aiming at a panel with no visible pointer is nearly impossible, so each
 *    controller gets a laser + a cursor dot on the panel, and the button under
 *    the pointer lights up (hover). If the laser shows up but nothing lights up,
 *    the ray is missing the panel; if it lights up but clicks do nothing, the
 *    trigger isn't being read. Either way the problem is visible, not silent.
 *  - Clicks are accepted from the per-frame trigger poll (update(triggers)) AND
 *    from the WebXR select event (clickFrom(id)); a 250 ms debounce makes the
 *    two paths safe to combine.
 *  - Mouse works too (pointRay('mouse', …)) so the menu can be tested on a PC.
 *
 * No special glyphs (✕ ← ▶ …) are used: every icon is drawn with canvas paths,
 * so nothing depends on which fonts the headset browser has.
 */

const W = 900;
const H = 710;

const COL = {
    bg: 'rgba(7, 12, 17, 0.96)',
    accent: '#5cffb0',
    accentDim: 'rgba(92, 255, 176, 0.28)',
    text: '#f2f6f4',
    dim: '#93a3a1',
    tab: '#0f2227',
    tabActive: '#16453a',
    tabHover: '#1b6a52',
    card: '#0e1c22',
    row: '#0e1c22',
    rowHover: '#14303a',
    btn: '#17614c',
    btnHover: '#22906f',
    danger: '#a73226',
    dangerHover: '#dd4636'
};

const TABS = [
    { id: 'home', label: 'INICIO', icon: 'home', title: 'Inicio' },
    { id: 'explore', label: 'EXPLORAR', icon: 'explore', title: 'Explorar' },
    { id: 'tags', label: 'TAGS', icon: 'tags', title: 'Centro de Tags' },
    { id: 'users', label: 'USUARIOS', icon: 'users', title: 'Usuarios' },
    { id: 'help', label: 'AYUDA', icon: 'help', title: 'Ayuda' },
    { id: 'settings', label: 'CONFIGURACIÓN', icon: 'settings', title: 'Configuración' }
];

// Layout constants (canvas pixels)
const SIDE_X = 28;
const SIDE_W = 270;
const CONTENT_X = 322;
const CONTENT_W = W - CONTENT_X - 28; // 550
const CONTENT_Y = 136;

const TAGS_PER_PAGE = 5;

class VRMenu {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.onAction = options.onAction || (() => {});
        this.onHaptic = options.onHaptic || (() => {});
        this.maxTags = options.maxTags ?? 25;
        this.visible = false;
        this.view = 'home';

        this.worldWidth = options.worldWidth ?? 0.8;
        this.worldHeight = (this.worldWidth * H) / W;

        this._canvas = document.createElement('canvas');
        this._canvas.width = W;
        this._canvas.height = H;
        this._ctx = this._canvas.getContext('2d');
        this._texture = new THREE.CanvasTexture(this._canvas);
        this._texture.colorSpace = THREE.SRGBColorSpace;
        this._texture.anisotropy = 4;

        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(this.worldWidth, this.worldHeight),
            new THREE.MeshBasicMaterial({
                map: this._texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthTest: false,
                depthWrite: false,
                toneMapped: false
            })
        );
        this.mesh.name = 'VRMenu';
        this.mesh.renderOrder = 2000;
        this.mesh.visible = false;
        scene.add(this.mesh);

        // data pushed in by the app
        this._tagsData = [];
        this._usersData = [];
        this._tagsPage = 0;
        this._selfName = '';
        this._online = 1;
        this._connected = false;
        this._settings = { speed: 'Normal', turn: 'Snap', guide: 'Visible' };

        // interaction state
        this._zones = [];
        this._hoverIndex = -1;
        this._pointers = new Map(); // id -> pointer state
        this._raycaster = new THREE.Raycaster();
        this._o = new THREE.Vector3();
        this._d = new THREE.Vector3();
        this._n = new THREE.Vector3();

        this._helper = new THREE.Object3D();
        this._lastFwd = new THREE.Vector3(0, 0, -1);
        this._camPos = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._pos = new THREE.Vector3();

        this._draw();
    }

    // ------------------------------------------------------------------
    // data from the app
    // ------------------------------------------------------------------
    setTagsData(tags) {
        this._tagsData = tags || [];
        const pages = Math.max(1, Math.ceil(this._tagsData.length / TAGS_PER_PAGE));
        this._tagsPage = Math.min(this._tagsPage, pages - 1);
        this._redrawIf('tags', 'home', 'explore');
    }

    setUsersData(users) {
        this._usersData = users || [];
        this._redrawIf('users', 'home');
    }

    setSelfName(name) {
        this._selfName = name || '';
        this._redrawIf('home', 'users');
    }

    setConnection(connected, online) {
        this._connected = !!connected;
        if (Number.isFinite(online)) this._online = online;
        this._redrawIf('home');
    }

    setSettings(settings) {
        this._settings = { ...this._settings, ...settings };
        this._redrawIf('settings');
    }

    _redrawIf(...views) {
        if (this.visible && views.includes(this.view)) this._draw();
    }

    // ------------------------------------------------------------------
    // open / close / placement
    // ------------------------------------------------------------------
    open(position, quaternion) {
        this.mesh.position.copy(position);
        this.mesh.quaternion.copy(quaternion);
        this.mesh.visible = true;
        this.visible = true;
        this.view = 'home';
        this._tagsPage = 0;
        this._hoverIndex = -1;
        this._draw();
        this._syncPointerVisibility();
    }

    close() {
        this.mesh.visible = false;
        this.visible = false;
        this._hoverIndex = -1;
        this._syncPointerVisibility();
    }

    /**
     * Put the panel in front of the user's HEAD at a comfortable distance,
     * upright and facing them. (Object3D.lookAt on a plain Object3D points its
     * +Z — the plane's front face — at the target, so no extra rotation.)
     */
    placeInFrontOf(camera, distance = 0.9) {
        camera.updateWorldMatrix(true, false);
        camera.getWorldPosition(this._camPos);
        camera.getWorldDirection(this._fwd);
        this._fwd.y = 0;
        if (this._fwd.lengthSq() < 1e-3) this._fwd.copy(this._lastFwd);
        else this._fwd.normalize();
        this._lastFwd.copy(this._fwd);

        this._pos.copy(this._camPos).addScaledVector(this._fwd, distance);
        this._pos.y = this._camPos.y - 0.05;

        this._helper.position.copy(this._pos);
        this._helper.lookAt(this._camPos.x, this._pos.y, this._camPos.z);
        this.open(this._pos, this._helper.quaternion);
    }

    toggle(camera) {
        if (this.visible) this.close();
        else this.placeInFrontOf(camera);
    }

    // ------------------------------------------------------------------
    // pointers (controllers and mouse)
    // ------------------------------------------------------------------
    /**
     * Register a pointer. With a controller object, a laser is attached to it and
     * update() drives the ray from it. With controller = null (mouse), feed rays
     * yourself through pointRay().
     */
    registerPointer(id, controller = null) {
        const old = this._pointers.get(id);
        if (old) {
            if (old.laser && old.controller) old.controller.remove(old.laser);
            this.scene.remove(old.dot);
        }

        let laser = null;
        if (controller) {
            const geo = new THREE.CylinderGeometry(0.0035, 0.0035, 1, 8, 1, true);
            geo.rotateX(-Math.PI / 2); // axis Y -> -Z
            geo.translate(0, 0, -0.5); // spans z = 0 .. -1
            laser = new THREE.Mesh(
                geo,
                new THREE.MeshBasicMaterial({
                    color: 0x5cffb0,
                    transparent: true,
                    opacity: 0.9,
                    depthTest: false,
                    depthWrite: false
                })
            );
            laser.renderOrder = 2001;
            laser.frustumCulled = false;
            laser.visible = this.visible;
            controller.add(laser);
        }

        const dot = new THREE.Group();
        const core = new THREE.Mesh(
            new THREE.CircleGeometry(0.0085, 24),
            new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
        );
        const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.012, 0.0165, 28),
            new THREE.MeshBasicMaterial({ color: 0x5cffb0, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
        );
        core.renderOrder = 2003;
        ring.renderOrder = 2002;
        dot.add(ring, core);
        dot.visible = false;
        this.scene.add(dot);

        this._pointers.set(id, {
            id,
            controller,
            laser,
            dot,
            prevPressed: false,
            hit: null,
            zone: -1,
            lastActivate: -Infinity // never debounce the very first click
        });
    }

    _syncPointerVisibility() {
        for (const p of this._pointers.values()) {
            if (p.laser) p.laser.visible = this.visible;
            if (!this.visible) p.dot.visible = false;
        }
    }

    /** Per frame: drive controller pointers. triggers = { left: bool, right: bool } */
    update(triggers = {}) {
        if (!this.visible) return;
        this.mesh.updateWorldMatrix(true, false);

        for (const p of this._pointers.values()) {
            if (!p.controller) continue;
            p.controller.updateWorldMatrix(true, false);
            this._o.setFromMatrixPosition(p.controller.matrixWorld);
            this._d.set(0, 0, -1).transformDirection(p.controller.matrixWorld);
            this._processRay(p, this._o, this._d, !!triggers[p.id]);
        }
        this._refreshHover();
    }

    /** Feed an arbitrary world ray (used for the mouse). */
    pointRay(id, origin, direction, pressed = false) {
        if (!this.visible) return;
        const p = this._pointers.get(id);
        if (!p) return;
        this.mesh.updateWorldMatrix(true, false);
        this._processRay(p, origin, direction, pressed);
        this._refreshHover();
    }

    _processRay(p, origin, dir, pressed) {
        this._raycaster.set(origin, dir);
        const hit = this._raycaster.intersectObject(this.mesh, false)[0];
        p.hit = hit && hit.uv ? hit : null;
        p.zone = p.hit ? this._zoneIndexAt(p.hit.uv) : -1;

        if (p.laser) {
            const len = p.hit ? p.hit.distance : 1.4;
            p.laser.scale.z = Math.max(0.05, len);
            p.laser.material.color.set(p.zone >= 0 ? 0xffffff : 0x5cffb0);
        }

        if (p.hit) {
            // sit the cursor on the side of the panel the pointer is on
            this.mesh.getWorldDirection(this._n);
            const side = this._n.dot(dir) > 0 ? -1 : 1;
            p.dot.position.copy(p.hit.point).addScaledVector(this._n, side * 0.004);
            p.dot.quaternion.copy(this.mesh.quaternion);
            p.dot.visible = true;
        } else {
            p.dot.visible = false;
        }

        if (pressed && !p.prevPressed) this._activate(p);
        p.prevPressed = pressed;
    }

    _refreshHover() {
        let idx = -1;
        for (const p of this._pointers.values()) {
            if (p.zone >= 0) idx = p.zone;
        }
        if (idx !== this._hoverIndex) {
            this._hoverIndex = idx;
            if (idx >= 0) {
                for (const p of this._pointers.values()) {
                    if (p.zone === idx) this.onHaptic(p.id, 0.15, 12);
                }
            }
            this._draw();
        }
    }

    /** Click from a WebXR select event, using the pointer's latest ray result. */
    clickFrom(id) {
        if (!this.visible) return false;
        const p = this._pointers.get(id);
        if (p) this._activate(p);
        return true; // the menu swallows trigger presses while open
    }

    _zoneIndexAt(uv) {
        const px = uv.x * W;
        const py = (1 - uv.y) * H;
        return this._zones.findIndex((z) => px >= z.x0 && px < z.x1 && py >= z.y0 && py < z.y1);
    }

    _activate(p) {
        const now = performance.now();
        if (now - p.lastActivate < 250) return false;
        const zone = p.zone >= 0 ? this._zones[p.zone] : null;
        if (!zone) return false;
        p.lastActivate = now;
        this.onHaptic(p.id, 0.7, 40);
        this._runZone(zone);
        return true;
    }

    _runZone(zone) {
        switch (zone.action) {
            case 'tab':
                this.view = zone.payload;
                this._hoverIndex = -1;
                this._tagsPage = 0;
                this._draw();
                break;
            case 'close':
                this.close();
                break;
            case 'noop':
                break;
            case 'page': {
                const pages = Math.max(1, Math.ceil(this._tagsData.length / TAGS_PER_PAGE));
                this._tagsPage = Math.min(pages - 1, Math.max(0, this._tagsPage + zone.payload));
                this._hoverIndex = -1;
                this._draw();
                break;
            }
            default:
                this.onAction(zone.action, zone.payload);
        }
    }

    // ------------------------------------------------------------------
    // drawing
    // ------------------------------------------------------------------
    _draw() {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, W, H);
        this._zones = [];

        // window
        this._rr(0, 0, W, H, 34);
        ctx.fillStyle = COL.bg;
        ctx.fill();
        ctx.lineWidth = 5;
        ctx.strokeStyle = COL.accent;
        ctx.stroke();

        // title bar
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = COL.accent;
        ctx.font = 'bold 40px Arial';
        ctx.fillText('VR-Chilq', 40, 62);
        ctx.fillStyle = COL.dim;
        ctx.font = '21px Arial';
        const tab = TABS.find((t) => t.id === this.view) || TABS[0];
        ctx.fillText(tab.title, 42, 96);

        ctx.strokeStyle = COL.accentDim;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(32, 114);
        ctx.lineTo(W - 32, 114);
        ctx.stroke();

        this._button({ x: W - 96, y: 22, w: 62, h: 62, icon: 'close', action: 'close', style: 'danger', r: 31 });

        // sidebar tabs
        TABS.forEach((t, i) => {
            this._button({
                x: SIDE_X,
                y: CONTENT_Y + i * 85,
                w: SIDE_W,
                h: 76,
                label: t.label,
                icon: t.icon,
                action: 'tab',
                payload: t.id,
                style: 'tab',
                active: t.id === this.view
            });
        });

        const body = {
            home: this._drawHome,
            explore: this._drawExplore,
            tags: this._drawTags,
            users: this._drawUsers,
            help: this._drawHelp,
            settings: this._drawSettings
        }[this.view];
        (body || this._drawHome).call(this);

        // footer
        ctx.fillStyle = COL.dim;
        ctx.font = '18px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('Apuntá con el control y apretá el gatillo para elegir', 40, H - 20);

        this._texture.needsUpdate = true;
    }

    _drawHome() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        let y = CONTENT_Y;

        ctx.fillStyle = COL.text;
        ctx.font = 'bold 34px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(this._selfName ? `Hola, ${this._fit(this._selfName, CONTENT_W - 90, 'bold 34px Arial')}` : 'Hola', x, y + 34);
        ctx.fillStyle = COL.dim;
        ctx.font = '21px Arial';
        ctx.fillText('Gemelo digital · Observaciones EHS', x, y + 66);

        y += 92;
        const cw = 170;
        const gap = (CONTENT_W - cw * 3) / 2;
        const cards = [
            { k: 'TAGS', v: `${this._tagsData.length}/${this.maxTags}`, c: COL.accent },
            { k: 'EN LÍNEA', v: String(this._online), c: COL.accent },
            { k: 'SERVIDOR', v: this._connected ? 'Conectado' : 'Sin conexión', c: this._connected ? COL.accent : '#ff8a7a', small: true }
        ];
        cards.forEach((c, i) => {
            const cx = x + i * (cw + gap);
            this._rr(cx, y, cw, 118, 16);
            ctx.fillStyle = COL.card;
            ctx.fill();
            ctx.strokeStyle = COL.accentDim;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = COL.dim;
            ctx.font = 'bold 17px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(c.k, cx + cw / 2, y + 34);
            ctx.fillStyle = c.c;
            ctx.font = c.small ? 'bold 24px Arial' : 'bold 46px Arial';
            ctx.fillText(c.v, cx + cw / 2, y + (c.small ? 84 : 90));
        });

        y += 140;
        this._rr(x, y, CONTENT_W, 150, 16);
        ctx.fillStyle = COL.card;
        ctx.fill();
        ctx.strokeStyle = COL.accentDim;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.accent;
        ctx.font = 'bold 22px Arial';
        ctx.fillText('Cómo dejar una observación', x + 22, y + 38);
        ctx.fillStyle = COL.text;
        ctx.font = '21px Arial';
        ctx.fillText('1. Apuntá al lugar con el control.', x + 22, y + 74);
        ctx.fillText('2. Apretá la empuñadura (grip).', x + 22, y + 104);
        ctx.fillText('3. Escribí la nota con el teclado del Quest.', x + 22, y + 134);
    }

    _drawExplore() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        let y = CONTENT_Y;

        ctx.textAlign = 'left';
        ctx.fillStyle = COL.dim;
        ctx.font = '21px Arial';
        ctx.fillText('Atajos para moverte por la instalación', x, y + 24);

        y += 48;
        this._button({ x, y, w: CONTENT_W, h: 84, label: 'Volver al punto de inicio', icon: 'home', action: 'goto-spawn', style: 'bar' });
        y += 98;
        this._button({ x, y, w: CONTENT_W, h: 84, label: 'Ir al avatar guía', icon: 'users', action: 'goto-guide', style: 'bar' });
        y += 98;
        const last = this._tagsData[0];
        this._button({
            x, y, w: CONTENT_W, h: 84,
            label: last ? 'Ir al último tag' : 'Ir al último tag (no hay)',
            icon: 'tags',
            action: last ? 'goto-tag' : 'noop',
            payload: last ? last.id : null,
            style: 'bar',
            disabled: !last
        });
        y += 104;
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.dim;
        ctx.font = '19px Arial';
        ctx.fillText('Gatillo izq.: volar · Joystick izq.: moverte · Der.: girar', x, y + 12);
    }

    _drawTags() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        let y = CONTENT_Y;
        const pages = Math.max(1, Math.ceil(this._tagsData.length / TAGS_PER_PAGE));

        ctx.textAlign = 'left';
        ctx.fillStyle = COL.text;
        ctx.font = 'bold 24px Arial';
        ctx.fillText(`${this._tagsData.length} de ${this.maxTags} observaciones`, x, y + 24);

        y += 42;
        if (!this._tagsData.length) {
            ctx.fillStyle = COL.dim;
            ctx.font = '22px Arial';
            ctx.fillText('Todavía no hay tags en esta sala.', x, y + 50);
            ctx.font = '20px Arial';
            ctx.fillText('Apuntá y apretá la empuñadura para crear uno.', x, y + 86);
            return;
        }

        const rowH = 76;
        const start = this._tagsPage * TAGS_PER_PAGE;
        this._tagsData.slice(start, start + TAGS_PER_PAGE).forEach((tag, i) => {
            const ry = y + i * (rowH + 4);
            this._rr(x, ry, CONTENT_W, rowH, 14);
            ctx.fillStyle = COL.row;
            ctx.fill();
            ctx.strokeStyle = COL.accentDim;
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.textAlign = 'left';
            ctx.fillStyle = COL.text;
            ctx.font = 'bold 22px Arial';
            ctx.fillText(this._fit(tag.author || 'Anónimo', 250, 'bold 22px Arial'), x + 18, ry + 29);
            ctx.fillStyle = COL.dim;
            ctx.font = '17px Arial';
            ctx.fillText(this._fmtDate(tag.created_at), x + 280, ry + 29);
            ctx.fillStyle = '#c6d2d0';
            ctx.font = '20px Arial';
            ctx.fillText(this._fit(tag.note || '', CONTENT_W - 150, '20px Arial'), x + 18, ry + 59);

            this._button({ x: x + CONTENT_W - 96, y: ry + 12, w: 80, h: 52, label: 'Ir', action: 'goto-tag', payload: tag.id, style: 'small' });
        });

        // pager
        const py = CONTENT_Y + 42 + TAGS_PER_PAGE * (rowH + 4) + 6;
        this._button({ x, y: py, w: 76, h: 48, icon: 'prev', action: 'page', payload: -1, style: 'small', disabled: this._tagsPage === 0 });
        ctx.fillStyle = COL.text;
        ctx.font = '21px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`Página ${this._tagsPage + 1} de ${pages}`, x + CONTENT_W / 2, py + 32);
        this._button({ x: x + CONTENT_W - 76, y: py, w: 76, h: 48, icon: 'next', action: 'page', payload: 1, style: 'small', disabled: this._tagsPage >= pages - 1 });
    }

    _drawUsers() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        const y = CONTENT_Y;

        ctx.textAlign = 'left';
        ctx.fillStyle = COL.text;
        ctx.font = 'bold 24px Arial';
        ctx.fillText(`${this._usersData.length + 1} en línea`, x, y + 24);

        const rows = [{ name: `${this._selfName || 'Vos'} (vos)`, self: true }, ...this._usersData.map((n) => ({ name: n }))];
        rows.slice(0, 6).forEach((u, i) => {
            const ry = y + 42 + i * 66;
            this._rr(x, ry, CONTENT_W, 58, 14);
            ctx.fillStyle = COL.row;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + 30, ry + 29, 9, 0, Math.PI * 2);
            ctx.fillStyle = COL.accent;
            ctx.fill();
            ctx.fillStyle = u.self ? COL.accent : COL.text;
            ctx.font = 'bold 24px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(this._fit(u.name, CONTENT_W - 90, 'bold 24px Arial'), x + 56, ry + 38);
        });

        if (!this._usersData.length) {
            ctx.fillStyle = COL.dim;
            ctx.font = '20px Arial';
            ctx.textAlign = 'left';
            ctx.fillText('Estás solo en la sala (modo demostración).', x, y + 42 + 66 + 30);
        }
    }

    _drawHelp() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        const items = [
            ['Gatillo izquierdo', 'Volar hacia donde mirás'],
            ['Joystick izquierdo', 'Moverte'],
            ['Joystick derecho', 'Girar'],
            ['Empuñadura (grip)', 'Crear un tag EHS donde apuntás'],
            ['Botón A / X', 'Abrir y cerrar este menú'],
            ['Gatillo con menú abierto', 'Elegir una opción']
        ];
        items.forEach(([k, v], i) => {
            const y = CONTENT_Y + i * 68;
            ctx.textAlign = 'left';
            ctx.fillStyle = COL.accent;
            ctx.font = 'bold 22px Arial';
            ctx.fillText(k, x, y + 24);
            ctx.fillStyle = COL.text;
            ctx.font = '21px Arial';
            ctx.fillText(v, x, y + 52);
        });
        ctx.fillStyle = COL.dim;
        ctx.font = '17px Arial';
        ctx.fillText('Informe e impresión/PDF: tags-dashboard.html en un navegador.', x, CONTENT_Y + 6 * 68 + 14);
    }

    _drawSettings() {
        const ctx = this._ctx;
        const x = CONTENT_X;
        const y = CONTENT_Y;
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.dim;
        ctx.font = '21px Arial';
        ctx.fillText('Tocá una opción para cambiarla', x, y + 24);

        const rows = [
            ['Velocidad de vuelo', this._settings.speed, 'speed'],
            ['Giro del joystick', this._settings.turn, 'turn'],
            ['Avatar guía', this._settings.guide, 'guide']
        ];
        rows.forEach(([label, value, key], i) => {
            this._button({
                x, y: y + 48 + i * 98, w: CONTENT_W, h: 84,
                label, value,
                action: 'setting', payload: key,
                style: 'bar'
            });
        });
    }

    // ------------------------------------------------------------------
    // widgets
    // ------------------------------------------------------------------
    /** Rounded-rect path without relying on ctx.roundRect support. */
    _rr(x, y, w, h, r) {
        const ctx = this._ctx;
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    _fit(text, maxW, font) {
        const ctx = this._ctx;
        ctx.save();
        ctx.font = font;
        const s0 = String(text);
        if (ctx.measureText(s0).width <= maxW) {
            ctx.restore();
            return s0;
        }
        let s = s0;
        while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
        ctx.restore();
        return s + '…';
    }

    _fmtDate(ms) {
        if (!ms) return '';
        const d = new Date(Number(ms));
        if (Number.isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    /**
     * o: {x,y,w,h,label?,value?,icon?,action,payload?,style,active?,disabled?,r?}
     * styles: tab | bar | small | danger
     */
    _button(o) {
        const ctx = this._ctx;
        const idx = this._zones.length;
        const hover = idx === this._hoverIndex && !o.disabled;

        let fill;
        let stroke = COL.accentDim;
        let ink = COL.text;
        let strokeW = 2;
        switch (o.style) {
            case 'tab':
                fill = hover ? COL.tabHover : o.active ? COL.tabActive : COL.tab;
                stroke = o.active || hover ? COL.accent : COL.accentDim;
                ink = o.active || hover ? '#ffffff' : '#bfe9d9';
                break;
            case 'danger':
                fill = hover ? COL.dangerHover : COL.danger;
                stroke = '#ffb3a8';
                ink = '#ffffff';
                break;
            case 'small':
                fill = hover ? COL.btnHover : COL.btn;
                stroke = hover ? '#ffffff' : COL.accent;
                ink = '#ffffff';
                break;
            default: // bar
                fill = hover ? COL.rowHover : COL.row;
                stroke = hover ? COL.accent : COL.accentDim;
        }
        if (hover) strokeW = 4;
        if (o.disabled) {
            fill = '#101619';
            stroke = 'rgba(255,255,255,0.12)';
            ink = '#55615f';
            strokeW = 1.5;
        }

        this._rr(o.x, o.y, o.w, o.h, o.r ?? 16);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = stroke;
        ctx.stroke();

        if (o.style === 'tab' && o.active) {
            this._rr(o.x + 6, o.y + 14, 6, o.h - 28, 3);
            ctx.fillStyle = COL.accent;
            ctx.fill();
        }

        if (o.icon) {
            const iconOnly = !o.label;
            const iconSize = iconOnly ? Math.min(o.w, o.h) * 0.46 : o.style === 'tab' ? 36 : 44;
            const ix = iconOnly ? o.x + o.w / 2 : o.x + (o.style === 'tab' ? 42 : 44);
            this._icon(o.icon, ix, o.y + o.h / 2, iconSize, ink);
        }

        if (o.label) {
            ctx.fillStyle = ink;
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'left';
            const font = o.style === 'tab' ? 'bold 20px Arial' : 'bold 26px Arial';
            ctx.font = font;
            let tx = o.x + (o.icon ? (o.style === 'tab' ? 72 : 84) : 24);
            if (o.style === 'small') {
                ctx.textAlign = 'center';
                tx = o.x + o.w / 2;
            }
            const maxW = o.style === 'small' ? o.w - 12 : o.x + o.w - tx - (o.value ? 190 : 14);
            ctx.fillText(this._fit(o.label, maxW, font), tx, o.y + o.h / 2 + 1);
            if (o.value) {
                ctx.textAlign = 'right';
                ctx.fillStyle = COL.accent;
                ctx.font = 'bold 26px Arial';
                ctx.fillText(o.value, o.x + o.w - 24, o.y + o.h / 2 + 1);
            }
            ctx.textBaseline = 'alphabetic';
            ctx.textAlign = 'left';
        }

        this._zones.push({
            x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h,
            action: o.disabled ? 'noop' : o.action,
            payload: o.payload,
            label: o.label || o.icon || ''
        });
    }

    /** Vector icons in a [-1,1] box, scaled to `size` px, centered on (cx, cy). */
    _icon(kind, cx, cy, size, color) {
        const ctx = this._ctx;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(size / 2, size / 2);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 0.14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const line = (...pts) => {
            ctx.beginPath();
            ctx.moveTo(pts[0], pts[1]);
            for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
            ctx.stroke();
        };

        switch (kind) {
            case 'home':
                line(-0.95, -0.05, 0, -0.9, 0.95, -0.05);
                line(-0.68, -0.2, -0.68, 0.85, 0.68, 0.85, 0.68, -0.2);
                line(-0.2, 0.85, -0.2, 0.3, 0.2, 0.3, 0.2, 0.85);
                break;
            case 'explore':
                ctx.beginPath();
                ctx.arc(0, 0, 0.88, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(0.42, -0.42);
                ctx.lineTo(0.13, 0.13);
                ctx.lineTo(-0.42, 0.42);
                ctx.lineTo(-0.13, -0.13);
                ctx.closePath();
                ctx.fill();
                break;
            case 'tags':
                ctx.beginPath();
                ctx.moveTo(0.9, -0.62);
                ctx.lineTo(0.9, 0.62);
                ctx.lineTo(-0.35, 0.62);
                ctx.lineTo(-0.95, 0);
                ctx.lineTo(-0.35, -0.62);
                ctx.closePath();
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(-0.33, 0, 0.14, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'users':
                ctx.beginPath();
                ctx.arc(-0.3, -0.38, 0.27, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(-0.3, 0.92, 0.6, Math.PI, 0);
                ctx.fill();
                ctx.globalAlpha = 0.65;
                ctx.beginPath();
                ctx.arc(0.5, -0.22, 0.22, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.arc(0.5, 0.82, 0.46, Math.PI, 0);
                ctx.fill();
                break;
            case 'help':
                ctx.beginPath();
                ctx.arc(0, 0, 0.88, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(0, -0.2, 0.3, Math.PI * 1.1, Math.PI * 2.35);
                ctx.stroke();
                line(0.06, 0.08, 0, 0.22, 0, 0.3);
                ctx.beginPath();
                ctx.arc(0, 0.58, 0.085, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'settings': {
                ctx.beginPath();
                const teeth = 8;
                for (let i = 0; i < teeth; i++) {
                    const a = (i / teeth) * Math.PI * 2;
                    const w = 0.16;
                    const pts = [
                        [a - w - 0.07, 0.68],
                        [a - w, 0.95],
                        [a + w, 0.95],
                        [a + w + 0.07, 0.68]
                    ];
                    pts.forEach(([ang, r], j) => {
                        const px = Math.cos(ang) * r;
                        const py = Math.sin(ang) * r;
                        if (i === 0 && j === 0) ctx.moveTo(px, py);
                        else ctx.lineTo(px, py);
                    });
                }
                ctx.closePath();
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(0, 0, 0.3, 0, Math.PI * 2);
                ctx.stroke();
                break;
            }
            case 'close':
                ctx.lineWidth = 0.2;
                line(-0.62, -0.62, 0.62, 0.62);
                line(0.62, -0.62, -0.62, 0.62);
                break;
            case 'prev':
                ctx.lineWidth = 0.2;
                line(0.35, -0.7, -0.35, 0, 0.35, 0.7);
                break;
            case 'next':
                ctx.lineWidth = 0.2;
                line(-0.35, -0.7, 0.35, 0, -0.35, 0.7);
                break;
            default:
                break;
        }
        ctx.restore();
    }
}

export { VRMenu };
