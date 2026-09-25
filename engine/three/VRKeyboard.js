import * as THREE from 'three';

const ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
const CANVAS_W = 600;
const CANVAS_H = 300;

/**
 * VRKeyboard — a flat panel you point at with a controller and "click" keys
 * on with a trigger/select event. Minimal on purpose: short EHS notes only,
 * no shift/symbols/autocomplete.
 */
class VRKeyboard {
    constructor(options = {}) {
        this.width = options.width ?? 0.6;
        this.height = options.height ?? 0.3;
        this.onSubmit = options.onSubmit || (() => {});
        this.onChange = options.onChange || (() => {});
        this.text = '';

        this._canvas = document.createElement('canvas');
        this._canvas.width = CANVAS_W;
        this._canvas.height = CANVAS_H;
        this._ctx = this._canvas.getContext('2d');
        this._texture = new THREE.CanvasTexture(this._canvas);

        this._keys = [];
        this._layoutKeys();
        this._draw();

        this.mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(this.width, this.height),
            new THREE.MeshBasicMaterial({ map: this._texture, transparent: true })
        );
        this.mesh.visible = false;
    }

    _layoutKeys() {
        const textRowH = 40; // top strip shows the text being typed
        const keyRows = 5; // 4 letter/number rows + 1 action row
        const rowH = (CANVAS_H - textRowH) / keyRows;

        ROWS.forEach((row, r) => {
            const keyW = CANVAS_W / row.length;
            for (let c = 0; c < row.length; c++) {
                this._keys.push({
                    x0: c * keyW,
                    x1: (c + 1) * keyW,
                    y0: textRowH + r * rowH,
                    y1: textRowH + (r + 1) * rowH,
                    char: row[c],
                    label: row[c]
                });
            }
        });

        const y0 = textRowH + 4 * rowH;
        const y1 = textRowH + 5 * rowH;
        this._keys.push({ x0: 0, x1: 300, y0, y1, char: ' ', label: 'ESPACIO' });
        this._keys.push({ x0: 300, x1: 450, y0, y1, char: '\b', label: 'BORRAR' });
        this._keys.push({ x0: 450, x1: 600, y0, y1, char: '\n', label: 'OK' });
    }

    _draw() {
        const ctx = this._ctx;
        ctx.fillStyle = '#141414';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        // Text preview strip
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, CANVAS_W, 40);
        ctx.fillStyle = '#fff';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.text || '(nota vacía)', 10, 20);

        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        for (const key of this._keys) {
            ctx.strokeStyle = '#555';
            ctx.strokeRect(key.x0 + 2, key.y0 + 2, key.x1 - key.x0 - 4, key.y1 - key.y0 - 4);
            ctx.fillStyle = '#eee';
            ctx.fillText(key.label, (key.x0 + key.x1) / 2, (key.y0 + key.y1) / 2);
        }
        this._texture.needsUpdate = true;
    }

    open(position, quaternion) {
        this.text = '';
        this.mesh.position.copy(position);
        this.mesh.quaternion.copy(quaternion);
        this.mesh.visible = true;
        this._draw();
    }

    close() {
        this.mesh.visible = false;
    }

    get isOpen() {
        return this.mesh.visible;
    }

    /** uv: THREE.Vector2 in [0,1], from a raycaster intersection with this.mesh */
    handleSelect(uv) {
        if (!this.mesh.visible) return;
        const px = uv.x * CANVAS_W;
        const py = (1 - uv.y) * CANVAS_H; // canvas Y is flipped vs UV
        const key = this._keys.find((k) => px >= k.x0 && px < k.x1 && py >= k.y0 && py < k.y1);
        if (!key) return;

        if (key.char === '\n') {
            const submitted = this.text;
            this.close();
            this.onSubmit(submitted);
        } else if (key.char === '\b') {
            this.text = this.text.slice(0, -1);
            this._draw();
            this.onChange(this.text);
        } else {
            this.text += key.char;
            this._draw();
            this.onChange(this.text);
        }
    }
}

export { VRKeyboard };
