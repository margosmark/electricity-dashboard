/**
 * Blob download of a text file. Kept separate from the CSV exporter so the
 * backup drawer can reuse the same anchor-click mechanics without pulling in
 * the processed-row types.
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
