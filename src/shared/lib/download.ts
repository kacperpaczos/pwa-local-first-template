/** Browser-only: triggers a file download for in-memory content via a blob URL. */
export function triggerDownload(content: BlobPart, filename: string, mimeType: string): void {
  if (typeof document === "undefined") {
    throw new Error("triggerDownload requires a browser environment");
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
