/**
 * Blob download of a text file — the one place the anchor-click mechanics
 * live (CSV export, backup export, everything else that writes a file).
 *
 * Kept separate from the exporters so they can reuse the mechanics without
 * pulling in the processed-row / backup types.
 *
 * Returns the filename used, so callers/tests can assert on it.
 */
export function downloadTextFile(filename: string, text: string, mime: string): string {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return filename;
}
