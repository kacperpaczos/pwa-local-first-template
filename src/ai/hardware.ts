import {
  AI_TIER_MODELS,
  getPersistedAiTier,
  resolveActiveAiTier,
  setPersistedAiTier,
  type AiTier,
} from "./config";

/** Snapshot of browser / GPU capabilities used for tier gating. */
export type HardwareProfile = {
  /** `navigator.deviceMemory` (GiB), Chrome-only; null if unavailable. */
  deviceMemory: number | null;
  /** `adapter.limits.maxBufferSize` when a GPU adapter is available. */
  maxBufferSize: number | null;
  /** `adapter.limits.maxStorageBufferBindingSize` when available. */
  maxStorageBufferBindingSize: number | null;
  /** Coarse mobile UA heuristic. */
  isMobile: boolean;
  /** Free bytes from `navigator.storage.estimate()`, or null. */
  storageFreeBytes: number | null;
  /** GPU vendor string when `adapter.info` is present. */
  gpuVendor: string | null;
  /** GPU architecture string when `adapter.info` is present. */
  gpuArchitecture: string | null;
};

/** ~1 GiB — enough headroom for 8B q4 shard buffers on typical dGPU / Apple Silicon. */
const MAX_TIER_MIN_BUFFER = 1 * 1024 * 1024 * 1024;
/** Prefer MAX only when RAM probe says ≥ 8 GiB (or probe missing). */
const MAX_TIER_MIN_DEVICE_MEMORY_GIB = 8;
/** STD needs at least ~4 GiB when the probe is present; else fall to DEV. */
const STD_TIER_MIN_DEVICE_MEMORY_GIB = 4;
/** Free storage must cover model × margin before recommending that tier. */
const STORAGE_MARGIN = 1.3;

function detectMobileUa(ua: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
}

/**
 * Probe WebGPU + device memory + storage. Safe in Node/Vitest (returns nulls).
 */
export async function detectHardware(): Promise<HardwareProfile> {
  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & {
          deviceMemory?: number;
          gpu?: {
            requestAdapter?: () => Promise<{
              limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
              info?: { vendor?: string; architecture?: string };
              requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string }>;
            } | null>;
          };
          storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> };
          userAgent?: string;
        })
      : undefined;

  const deviceMemory =
    typeof nav?.deviceMemory === "number" && Number.isFinite(nav.deviceMemory)
      ? nav.deviceMemory
      : null;

  const isMobile = detectMobileUa(nav?.userAgent ?? "");

  let maxBufferSize: number | null = null;
  let maxStorageBufferBindingSize: number | null = null;
  let gpuVendor: string | null = null;
  let gpuArchitecture: string | null = null;

  try {
    const adapter = await nav?.gpu?.requestAdapter?.();
    if (adapter?.limits) {
      maxBufferSize =
        typeof adapter.limits.maxBufferSize === "number" ? adapter.limits.maxBufferSize : null;
      maxStorageBufferBindingSize =
        typeof adapter.limits.maxStorageBufferBindingSize === "number"
          ? adapter.limits.maxStorageBufferBindingSize
          : null;
    }
    const info =
      adapter?.info ??
      (typeof adapter?.requestAdapterInfo === "function"
        ? await adapter.requestAdapterInfo().catch(() => null)
        : null);
    if (info) {
      gpuVendor = info.vendor ?? null;
      gpuArchitecture = info.architecture ?? null;
    }
  } catch {
    /* no adapter / denied */
  }

  let storageFreeBytes: number | null = null;
  try {
    const estimate = await nav?.storage?.estimate?.();
    if (estimate && typeof estimate.quota === "number") {
      storageFreeBytes = estimate.quota - (estimate.usage ?? 0);
    }
  } catch {
    /* storage estimate unavailable */
  }

  return {
    deviceMemory,
    maxBufferSize,
    maxStorageBufferBindingSize,
    isMobile,
    storageFreeBytes,
    gpuVendor,
    gpuArchitecture,
  };
}

function storageOkFor(tier: AiTier, freeBytes: number | null): boolean {
  if (freeBytes == null) return true;
  return freeBytes >= AI_TIER_MODELS[tier].approxBytes * STORAGE_MARGIN;
}

/**
 * Heuristic tier pick:
 * - MAX: !mobile ∧ buffer ≥ 1 GiB ∧ (deviceMemory ≥ 8 or unknown) ∧ storage for 8B
 * - DEV: very low RAM when probed, or tiny buffer
 * - else STD
 */
export function recommendTier(profile: HardwareProfile): AiTier {
  const { deviceMemory, maxBufferSize, isMobile, storageFreeBytes } = profile;

  const tinyBuffer = maxBufferSize != null && maxBufferSize < 256 * 1024 * 1024;
  const lowRam =
    deviceMemory != null && deviceMemory > 0 && deviceMemory < STD_TIER_MIN_DEVICE_MEMORY_GIB;

  if (tinyBuffer || lowRam) {
    return "dev";
  }

  const ramOkForMax =
    deviceMemory == null || deviceMemory >= MAX_TIER_MIN_DEVICE_MEMORY_GIB;
  const bufferOkForMax = maxBufferSize != null && maxBufferSize >= MAX_TIER_MIN_BUFFER;
  const storageOkForMax = storageOkFor("max", storageFreeBytes);

  if (!isMobile && ramOkForMax && bufferOkForMax && storageOkForMax) {
    return "max";
  }

  return "std";
}

/** Recommended + optional forced override (persisted when `remember` is true). */
export function resolveAiTier(
  profile: HardwareProfile,
  options?: { forced?: AiTier | null; remember?: boolean },
): { recommended: AiTier; active: AiTier } {
  const recommended = recommendTier(profile);
  const forced = options?.forced !== undefined ? options.forced : getPersistedAiTier();
  if (options?.remember && options.forced !== undefined) {
    setPersistedAiTier(options.forced);
  }
  return {
    recommended,
    active: resolveActiveAiTier(recommended, forced),
  };
}
