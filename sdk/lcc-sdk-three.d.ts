export declare type FailureFunc = () => void;

export declare interface IPoint2 {
    x: number;
    y: number;
}

export declare interface IPoint3 {
    x: number;
    y: number;
    z: number;
}

export declare interface LccBounds {
    min: IPoint3;
    max: IPoint3;
}

export declare interface LccClipBoxParams {
    scale: number[] | IPoint3;
    rotation: number[] | IPoint3;
    position: number[] | IPoint3;
    clipSide?: number;
}

export declare interface LccFileInfo {
    collision?: {
        url: string;
        header?: any;
    };
    data: {
        url: string;
        header?: any;
    };
    environment?: {
        url: string;
        header?: any;
    };
    index: {
        url: string;
        header?: any;
    };
    meta: {
        url: string;
        header?: any;
    };
    shcoef?: {
        url: string;
        header?: any;
    };
}

export declare interface LccIntersectsCapsuleParams {
    start: IPoint3;
    end: IPoint3;
    radius: number;
    noDelta?: boolean;
}

export declare interface LccIntersectsRayFromOriginParams {
    origin: IPoint3;
    direction: IPoint3;
    maxDistance: number;
}

export declare interface LccIntersectsRayParams {
    evt: IPoint2;
    maxDistance: number;
}

export declare interface LccIntersectsSphereParams {
    center: IPoint3;
    radius: number;
    noDelta?: boolean;
}

export declare interface LccMeta {
    fileType: string;
    dataType: string;
    [key: string]: unknown;
}

export declare interface LccObject {
    maxLoadSplatCount: number;
    checkFirstDataReady?: () => boolean;
    /** Register a callback for frame stable state changes; pass undefined to unregister. Optional implementation. */
    setFrameStableCallback?: (callback?: (stable: boolean) => void) => void;
    checkFrameStable?: () => boolean;
    clearRenderNextFrame: () => void;
    checkRenderNextFrame: () => boolean;
    getInstancedMesh: () => any;
    getEnvInstancedMesh: () => any;
    getMeta: () => LccMeta | undefined;
    getBounds: () => LccBounds | null;
    togglePointsDisplayMode: () => void;
    useEnvironment: (flag: boolean) => void;
    useShcoef: (flag: boolean, progressFunc: ProgressFunc) => void;
    hasShcoef: () => boolean;
    hasEnvironment: () => boolean;
    hasCollision: () => boolean;
    setLodAutoLevelUp: (flag: boolean) => void;
    setSmooth: (flag: boolean) => void;
    setSemantic: (flag: boolean) => void;
    setSemanticColor: (colors: number[][]) => void;
    resetSemanticColor: () => void;
    setVisible: (flag: boolean) => void;
    setPointsColor: (style: 'default' | 'rainbow') => void;
    setAlpha: (value: number) => void;
    setStartLod: (value: number) => void;
    setEndLod: (value: number) => void;
    setMaxDistance: (value: number) => void;
    setMaxSplats: (value: number) => void;
    setMaxNodeSplats: (value: number) => void;
    setClipBox: (param?: LccClipBoxParams) => void;
    setSelectBox: (param?: LccClipBoxParams) => void;
    setClipPlane: (normal: number[], constant: number) => void;
    getLodInfos: () => number[] | undefined;
    getCurrentConfig: () => any;
    updateCurrentConfig: (config: UserConfig) => void;
    raycast: (param: LccRaycastParams) => IPoint3 | null;
    raycastFromOrigin: (param: LccRaycastFromOriginParams) => IPoint3 | null;
    /**
     * @deprecated This interface is deprecated. Use `intersectsRayExt` instead.
     */
    intersectsRay?: (param: LccIntersectsRayParams) => IPoint3 | null;
    /**
     * @deprecated This interface is deprecated. Use `intersectsRayFromOriginExt` instead.
     */
    intersectsRayFromOrigin?: (param: LccIntersectsRayFromOriginParams) => IPoint3 | null;
    intersectsRayExt?: (param: LccIntersectsRayParams) => {
        point: IPoint3;
        normal: IPoint3;
    } | null;
    intersectsRayFromOriginExt?: (param: LccIntersectsRayFromOriginParams) => {
        point: IPoint3;
        normal: IPoint3;
    } | null;
    intersectsSphere?: (param: LccIntersectsSphereParams) => {
        hit: boolean;
        delta: IPoint3;
    };
    intersectsCapsule?: (param: LccIntersectsCapsuleParams) => {
        hit: boolean;
        delta: IPoint3;
    };
    /**
     * Start the reveal effect.
     * Optional implementation.
     *
     * @param {() => number} [clock] - Effect time source returning the current timestamp (ms).
     * Pass it to drive the effect timeline from an external clock (e.g. video recording);
     * omit to use the default wall clock. The clock is anchored at start and not changed while running.
     * @returns {boolean} `true` if the effect was started; `false` if the model
     * is not ready (mesh not built yet) or the renderer has been disposed.
     */
    startEffect?: (clock?: (() => number) | null) => boolean;
    /**
     * Stop the reveal effect and restore regular full rendering.
     * Optional implementation.
     */
    endEffect?: () => void;
    getCollisionGeometry?: () => {
        vertices: Float32Array;
        indices: Uint32Array;
        vertexCount: number;
        faceCount: number;
    }[];
}

export declare interface LccRaycastFromOriginParams {
    origin: IPoint3;
    direction: IPoint3;
    maxDistance: number;
    radius: number;
    opacityThreshold?: number;
}

export declare interface LccRaycastParams {
    evt: IPoint2;
    maxDistance: number;
    radius: number;
    opacityThreshold?: number;
}

/**
 * Three.js engine LCCRender. API is fully compatible with the legacy @xgrids/lcc-web-sdk.
 */
export declare const LCCRender: LCCRenderType;

/**
 * LCCRender instance type. Explicitly declares the public API contract to avoid
 * pulling internal types (EngineIntegration / LccParam / math) into the rolled-up d.ts
 * via the createLCCRender factory signature.
 */
export declare interface LCCRenderType {
    load: (param: LoadOptions, successFunc: SuccessFunc, progressFunc: ProgressFunc, failureFunc: FailureFunc, preProcessFunc?: PreProcessFunc) => LccObject;
    /** Update camera, currently only supports Three.js */
    setCamera(camera: any): void;
    /** Tick update */
    update: () => void;
    /** Unload model */
    unload: (lccobj: LccObject) => void;
    /** Release all SDK resources */
    dispose: () => void;
    /** Raycast */
    raycast: (param: LccRaycastParams) => IPoint3 | null;
    /** Raycast from origin */
    raycastFromOrigin: (param: LccRaycastFromOriginParams) => IPoint3 | null;
    /** Clear IndexedDB */
    clearIndexDB(): void;
    /** Get SDK version */
    getVersion(): string;
    /**
     * Enable/disable offscreen rendering （only threejs）
     * @param {boolean} flag - Whether to enable offscreen rendering
     */
    setOffscreenRender(flag: boolean): void;
    /**
     * Enable/disable depth writing （only threejs）
     * @param {boolean} flag - Whether to write depth
     */
    setWriteDepth(flag: boolean): void;
}

declare enum LoadingEffectCenterType {
    Camera = "camera",// Camera position
    SceneBox = "sceneBox",// Center of scene bounding box
    Custom = "custom"
}

declare enum LoadingEffectType {
    Ring = "ring",// Ring reveal (default effect)
    Wave = "wave"
}

export declare interface LoadOptions {
    camera: any;
    scene: any;
    renderLib: any; /** three or cesium */
    renderLibWebgpu?: any; /** three/webgpu */
    renderLibTSL?: any; /** three/tsl */
    renderer?: any; /** only for threejs */
    dataPath: string | LccFileInfo;
    canvas: HTMLCanvasElement;
    useEnv?: boolean;
    useIndexDB?: boolean;
    useLoadingEffect?: boolean;
    /**
     * Origin of the loading effect that controls where the reveal animation starts from.
     * - `'camera'`: start from the camera position (default).
     * - `'sceneBox'`: start from the center of the scene bounding box.
     * - `'custom'`: start from the point given in `loadingEffectCenter`.
     * Invalid or omitted values fall back to `'camera'`.
     */
    loadingEffectCenterType?: LoadingEffectCenterType;
    /**
     * Custom center point of the loading effect, in world coordinates.
     * Only used when `loadingEffectCenterType` is `'custom'`. Defaults to the origin (0, 0, 0) when omitted.
     */
    loadingEffectCenter?: IPoint3;
    /**
     * Style of the loading reveal animation (unified pipeline).
     * - `'ring'`: expanding ring reveal (default, existing behavior).
     * - `'wave'`: dual-wave radial reveal (dot wave + lift wave), ported from the PLY pipeline.
     * Only takes effect when `useLoadingEffect` is `true`. Invalid/omitted values fall back to `'ring'`.
     */
    loadingEffectType?: LoadingEffectType;
    /**
     * Total duration of the loading reveal animation in seconds (wave pipeline only).
     * Only takes effect when `useLoadingEffect` is `true` and `loadingEffectType` is `'wave'`.
     * Omitted or non-positive values fall back to the SDK default (4.5s).
     */
    loadingEffectDuration?: number;
    /**
     * Effective radius of the loading reveal animation, in world units (wave pipeline only).
     * Controls how far the wave travels within `loadingEffectDuration`, so callers can make the
     * wave sweep exactly the model inside the camera viewport instead of the whole scene
     * (avoids an overly fast wave on large scenes). Splats beyond this radius stay hidden during
     * the effect and appear once it ends.
     * Only takes effect when `useLoadingEffect` is `true` and `loadingEffectType` is `'wave'`.
     * Omitted or non-positive values fall back to a bounding-box-derived radius (covers the whole scene).
     */
    loadingEffectRadius?: number;
    gpuAcceleration?: boolean;
    pointsColor?: string;
    appKey?: string;
    modelMatrix?: any; /** cesium: Cesium.Matrix4   threejs: THREE.Matrix4 */
    /**
     * Enable precision measurement (anisotropic gaussian raycast) for pick/raycast.
     * Desktop defaults to `true`; mobile is force-disabled and ignores this option.
     * Applied at load time only; it cannot be changed dynamically at runtime.
     */
    usePrecisionRaycast?: boolean;
    maxHostCacheSize?: number;
    maxGpuCacheSize?: number;
    maxConcurrentDownloads?: number;
    workerPerFrameRequests?: number;
    /** only for threejs */
    /** Enable Perf mode */
    /** Enable compact work buffer (WebGPU unified pipeline only) */
    /** Whether to use EPSG projection */
    /** only for cesium */
    /** Whether the asset is lcc2 format */
    usePage?: boolean; /** only for threejs */
}

export declare type PreProcessFunc = (buffer: ArrayBuffer, filename: string) => Promise<{
    data: ArrayBuffer;
    rawData: ArrayBuffer;
}>;

export declare type ProgressFunc = (progress: number) => void;

/**
 * Scan angle estimation result.
 *
 * Principle: during 3DGS training, the shortest axis of each Gaussian ellipsoid
 * (the local axis of the smallest scale component) approximately points toward
 * the training camera's viewing direction. By analyzing the distribution of all
 * Gaussians' shortest-axis directions (rotated to world space via their quaternion),
 * the dominant scan angle of the capture trajectory can be inferred.
 */
export declare interface ScanAngleEstimation {
    /** Primary scan direction (normalized vector), i.e. the direction where normals cluster most densely. */
    primaryDirection: [number, number, number];
    /** Angle between the primary scan direction and the Y axis (vertical up), in degrees. 0° = nadir, 90° = horizontal, >90° = looking up. */
    elevationAngle: number;
    /** Median azimuth angle (angle between the XZ-plane projection and the +X axis), in degrees, range [-180, 180]. */
    azimuthAngle: number;
    /** Standard deviation of normal angles (degrees); smaller means the scan trajectory is closer to a single direction. */
    angularSpread: number;
    /** Inferred scan pattern. */
    scanPattern: 'nadir' | 'oblique' | 'horizontal' | 'mixed';
    /** Number of splats effectively analyzed. */
    sampleCount: number;
    /** Normal elevation histogram, one bin per 10° (0-10°, 10-20°, ... 170-180°); values are ratios in [0,1]. */
    elevationHistogram: number[];
}

export declare type SuccessFunc = (model: any) => void;

declare interface UserConfig {
    useSH?: boolean;
    useEnv?: boolean;
    pointsOnly?: boolean;
    pointsColor?: 'default' | 'rainbow';
    maxLoadSplatCount?: number;
    visible?: boolean;
}

export { }
