export function hasWebGpu(): boolean {
  if (typeof navigator === "undefined") return false;
  return "gpu" in navigator && (navigator as Navigator & { gpu?: unknown }).gpu != null;
}
