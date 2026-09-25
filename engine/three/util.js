import { WebGLRenderer } from './three.module.js';
import { WebGPURenderer } from 'three/webgpu';

/**
 * Create a renderer for the given canvas, preferring WebGPU with automatic
 * fallback to a classic WebGLRenderer.
 *
 * The fallback chain is:
 * 1. If the browser has no WebGPU support, use WebGLRenderer.
 * 2. If no GPU adapter can be acquired, use WebGLRenderer.
 * 3. If WebGPURenderer initializes but silently falls back to a WebGL backend
 *    (no GPUDevice), dispose it and use WebGLRenderer instead.
 * Otherwise the initialized WebGPURenderer is returned.
 *
 * @param {HTMLCanvasElement} canvas - The canvas to render into.
 * @param {boolean} [forceWebGL=false] - When true, skip WebGPU detection entirely and
 *   always create a classic WebGLRenderer. Useful for testing the WebGL path or
 *   working around WebGPU issues on specific devices.
 * @returns {Promise<WebGPURenderer | WebGLRenderer>} The created renderer.
 */
export async function createRenderer(canvas, forceWebGL = false) {
    // Force WebGL: skip WebGPU detection and return a WebGLRenderer directly.
    if (forceWebGL) {
        console.log('[UTIL] force webgl');
        return createWebGLRenderer(canvas);
    }

    // 1. Browser does not support WebGPU: fall back to WebGLRenderer.
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        console.log('[UTIL] navigator does not support WebGPU, falling back to WebGLRenderer');
        return createWebGLRenderer(canvas);
    }

    // 2. Try to create a WebGPURenderer.
    try {
        // Fetch the adapter first, then forward the adapter's maximum supported
        // limits to WebGPURenderer. three.js uses these requiredLimits when it
        // calls adapter.requestDevice internally.
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.warn('[UTIL] failed to get GPU adapter, falling back to WebGLRenderer');
            return createWebGLRenderer(canvas);
        }
        const requiredLimits = {
            maxBufferSize: adapter.limits.maxBufferSize,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxTextureDimension2D: adapter.limits.maxTextureDimension2D
        };

        const renderer = new WebGPURenderer({
            canvas: canvas,
            antialias: false,
            requiredLimits
        });

        await renderer.init();

        // If the WebGPU backend fails to initialize, init() silently falls back
        // to a WebGL backend. In that case isWebGPURenderer stays true but the
        // actual backend is WebGL, which cannot drive the Node render pipeline.
        // Only the WebGPU backend holds a GPUDevice, so use that to detect
        // whether the WebGPU backend is really in use.
        const hasDevice = !!renderer.backend?.device;
        if (!hasDevice) {
            console.warn('[UTIL] WebGPURenderer fell back to WebGL backend (no GPUDevice), using WebGLRenderer instead');
            renderer.dispose?.();
            return createWebGLRenderer(canvas);
        }

        console.log('[UTIL] using WebGPURenderer (WebGPUBackend)');
        return renderer;
    } catch (e) {
        console.warn('[UTIL] failed to create WebGPURenderer, falling back to WebGLRenderer:', e);
        return createWebGLRenderer(canvas);
    }
}

/**
 * Create a classic WebGLRenderer for the given canvas.
 *
 * @param {HTMLCanvasElement} canvas - The canvas to render into.
 * @returns {WebGLRenderer} The created WebGL renderer.
 */
function createWebGLRenderer(canvas) {
    const renderer = new WebGLRenderer({
        canvas: canvas,
        antialias: false
    });
    return renderer;
}

/**
 * Detect whether the current browser/device supports WebXR immersive VR sessions.
 *
 * Detection logic:
 * 1. Check if navigator.xr (WebXR API) is available; return false if not.
 * 2. Query navigator.xr.isSessionSupported('immersive-vr') to determine device support.
 * 3. Any exception (Permissions Policy block, unimplemented UA, etc.) silently returns false.
 *
 * @returns {Promise<boolean>} Resolves to true if immersive VR is supported, false otherwise.
 */
export async function checkVRSupport() {
    // WebXR API unavailable — VR not supported in this environment
    if (!navigator.xr) {
        return false;
    }

    try {
        // Query whether the device supports immersive-vr mode
        return await navigator.xr.isSessionSupported('immersive-vr');
    } catch (e) {
        // Query failed (e.g. blocked by Permissions Policy) — treat as unsupported
        return false;
    }
}
