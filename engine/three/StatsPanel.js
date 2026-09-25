/**
 * StatsPanel — FPS / frame-time / GPU stats overlay for Three.js scenes.
 *
 * Features:
 *   - HTML overlay panel (top-left corner, visible outside VR)
 *   - In-headset 3D HUD (floating canvas panel, visible inside VR)
 *   - FPS, frame time, min/max/avg, 1% low
 *   - XR status
 *
 * Usage:
 *   import { StatsPanel } from './engine/three/StatsPanel.js';
 *
 *   const stats = new StatsPanel(THREE, renderer, { xrHud: true });
 *   scene.add(stats.xrHudObject);          // only if xrHud: true
 *
 *   // inside render loop:
 *   stats.update();
 */

// ─── FPS Counter ────────────────────────────────────────────────────────────

class FPSCounter {
    #frames = 0;
    #lastTime = 0;
    #fps = 0;
    #frameTime = 0;
    #history = [];
    #historyMax = 600; // ~10s at 60fps
    #minFps = Infinity;
    #maxFps = 0;
    #sumFps = 0;
    #sumCount = 0;

    update(now) {
        this.#frames++;
        const elapsed = now - this.#lastTime;
        if (elapsed >= 1000) {
            this.#fps = Math.round((this.#frames * 1000) / elapsed);
            this.#frameTime = +(elapsed / this.#frames).toFixed(1);
            this.#frames = 0;
            this.#lastTime = now;
            if (this.#fps > 0) {
                this.#history.push(this.#fps);
                if (this.#history.length > this.#historyMax) this.#history.shift();
                this.#minFps = Math.min(this.#minFps, this.#fps);
                this.#maxFps = Math.max(this.#maxFps, this.#fps);
                this.#sumFps += this.#fps;
                this.#sumCount++;
            }
        }
    }

    get fps() {
        return this.#fps;
    }
    get frameTime() {
        return this.#frameTime;
    }
    get minFps() {
        return this.#minFps === Infinity ? 0 : this.#minFps;
    }
    get maxFps() {
        return this.#maxFps;
    }
    get avgFps() {
        return this.#sumCount > 0 ? Math.round(this.#sumFps / this.#sumCount) : 0;
    }
    /** Average of the lowest 1% of FPS samples */
    get onePercentLow() {
        if (this.#history.length < 10) return 0;
        const sorted = [...this.#history].sort((a, b) => a - b);
        const count = Math.max(1, Math.ceil(sorted.length * 0.01));
        let sum = 0;
        for (let i = 0; i < count; i++) sum += sorted[i];
        return Math.round(sum / count);
    }

    reset() {
        this.#frames = 0;
        this.#lastTime = performance.now();
        this.#fps = 0;
        this.#frameTime = 0;
        this.#history = [];
        this.#minFps = Infinity;
        this.#maxFps = 0;
        this.#sumFps = 0;
        this.#sumCount = 0;
    }
}

// ─── XR HUD (in-headset floating panel) ─────────────────────────────────────

class XRStatsHUD {
    #mesh;
    #canvas;
    #ctx;
    #texture;
    #lib;
    #width = 512;
    #height = 320;

    constructor(lib) {
        this.#lib = lib;
        this.#canvas = document.createElement('canvas');
        this.#canvas.width = this.#width;
        this.#canvas.height = this.#height;
        this.#ctx = this.#canvas.getContext('2d');

        this.#texture = new lib.CanvasTexture(this.#canvas);
        this.#texture.minFilter = lib.LinearFilter;

        const geometry = new lib.PlaneGeometry(0.5, 0.32);
        const material = new lib.MeshBasicMaterial({
            map: this.#texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: lib.DoubleSide
        });
        this.#mesh = new lib.Mesh(geometry, material);
        this.#mesh.renderOrder = 9999;
        this.#mesh.frustumCulled = false;
    }

    get object() {
        return this.#mesh;
    }

    update(stats) {
        const ctx = this.#ctx;
        const w = this.#width;
        const h = this.#height;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 16);
        ctx.fill();

        const fps = stats.fps;
        const fpsColor = fps >= 60 ? '#4caf50' : fps >= 30 ? '#ff9800' : '#f44336';

        ctx.font = 'bold 44px monospace';
        ctx.fillStyle = fpsColor;
        ctx.fillText(`${fps} FPS`, 20, 50);

        ctx.font = '22px monospace';
        ctx.fillStyle = '#ccc';
        const lines = [
            `Frame: ${stats.frameTime} ms`,
            `Min: ${stats.minFps}  Max: ${stats.maxFps}  Avg: ${stats.avgFps}`
            // `1% Low: ${stats.onePercentLow}`
        ];
        lines.forEach((line, i) => {
            if (line) ctx.fillText(line, 20, 90 + i * 38);
        });

        this.#texture.needsUpdate = true;
    }

    followCamera(camera) {
        const offset = new this.#lib.Vector3(-0.3, -0.2, -0.8);
        offset.applyQuaternion(camera.quaternion);
        this.#mesh.position.copy(camera.position).add(offset);
        this.#mesh.quaternion.copy(camera.quaternion);
    }

    dispose() {
        this.#texture.dispose();
        this.#mesh.geometry.dispose();
        this.#mesh.material.dispose();
    }
}

// ─── HTML Overlay ───────────────────────────────────────────────────────────

const PANEL_HTML = `
<div id="__stats-panel" style="
    position:fixed; top:10px; left:10px; color:#fff;
    background:rgba(0,0,0,0.8); padding:12px 16px; border-radius:6px;
    font-family:monospace; font-size:13px; z-index:999;
    min-width:220px; line-height:1.6; pointer-events:none;">
    <div><span style="color:#999">FPS: </span><span id="__sp-fps" style="font-size:22px;font-weight:bold;color:#4caf50">--</span></div>
    <div><span style="color:#999">Frame: </span><span id="__sp-ft">--</span><span style="color:#999"> ms</span></div>
    <div><span style="color:#999">Min: </span><span id="__sp-min">--</span>
         <span style="color:#999"> Max: </span><span id="__sp-max">--</span>
         <span style="color:#999"> Avg: </span><span id="__sp-avg">--</span></div>
    <div style="display:none"><span style="color:#999">1% Low: </span><span id="__sp-1low">--</span></div>
    <div><span style="color:#999">XR: </span><span id="__sp-xr">--</span></div>
</div>`;

// ─── StatsPanel (main class) ────────────────────────────────────────────────

export class StatsPanel {
    #lib;
    #renderer;
    #fpsCounter;
    #xrHud = null;
    #domTimer = 0;
    #els = {};
    #isVR;

    /**
     * @param {typeof import('three')} lib  — THREE namespace
     * @param {import('three').WebGLRenderer} renderer
     * @param {{ xrHud?: boolean }} [options]
     */
    constructor(lib, renderer, options = {}) {
        this.#lib = lib;
        this.#renderer = renderer;
        this.#fpsCounter = new FPSCounter();
        this.#isVR = !!renderer.xr?.enabled;

        // Inject HTML overlay
        const wrapper = document.createElement('div');
        wrapper.innerHTML = PANEL_HTML;
        document.body.appendChild(wrapper);

        // Cache DOM elements
        for (const id of ['fps', 'ft', 'min', 'max', 'avg', '1low', 'xr']) {
            this.#els[id] = document.getElementById(`__sp-${id}`);
        }

        // XR HUD
        if (options.xrHud) {
            this.#xrHud = new XRStatsHUD(lib);
        }

        // Reset stats when entering/leaving XR to avoid stale data
        const xr = renderer.xr;
        if (xr) {
            const self = this;
            xr.addEventListener('sessionstart', () => {
                self.#fpsCounter.reset();
            });
            xr.addEventListener('sessionend', () => {
                self.#fpsCounter.reset();
            });
        }
    }

    /** The 3D mesh to add to the scene (null if xrHud not enabled) */
    get xrHudObject() {
        return this.#xrHud?.object ?? null;
    }

    /**
     * Call once per frame inside the render loop.
     */
    update() {
        const now = performance.now();
        this.#fpsCounter.update(now);

        // ── HTML overlay (~4 Hz) ──
        if (now - this.#domTimer > 250) {
            this.#domTimer = now;
            const fc = this.#fpsCounter;
            const fps = fc.fps;
            const el = this.#els;

            el['fps'].textContent = fps;
            el['fps'].style.color = fps >= 60 ? '#4caf50' : fps >= 30 ? '#ff9800' : '#f44336';
            el['ft'].textContent = fc.frameTime;
            el['min'].textContent = fc.minFps;
            el['max'].textContent = fc.maxFps;
            el['avg'].textContent = fc.avgFps;
            el['1low'].textContent = fc.onePercentLow;

            el['xr'].textContent = this.#renderer.xr?.isPresenting ? 'Presenting' : this.#isVR ? 'Ready' : 'N/A';
        }

        // ── XR HUD ──
        if (this.#xrHud && this.#renderer.xr?.isPresenting) {
            const xrCamera = this.#renderer.xr.getCamera();
            this.#xrHud.followCamera(xrCamera);
            const fc = this.#fpsCounter;
            this.#xrHud.update({
                fps: fc.fps,
                frameTime: fc.frameTime,
                minFps: fc.minFps,
                maxFps: fc.maxFps,
                avgFps: fc.avgFps,
                onePercentLow: fc.onePercentLow
            });
        }
    }

    dispose() {
        const panel = document.getElementById('__stats-panel');
        if (panel) panel.parentElement?.remove();
        this.#xrHud?.dispose();
    }
}
