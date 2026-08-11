/**
 * Browser download helper, shared by every exporter.
 *
 * Exports are deliberately client-side: the droplet has no business rendering
 * audio or PDFs, and a download that never touches the server is also one that
 * needs no temp files, no cleanup job and no upload limit.
 */

export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.append(a);
	a.click();
	a.remove();
	// Revoking immediately can cancel the download in some browsers; one turn of
	// the event loop is enough for the click to have been consumed.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filesystem-safe name derived from the score title. */
export function safeFilename(title: string, extension: string): string {
	const base =
		title
			.trim()
			.replace(/[^\w\s.-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/^[.-]+|[.-]+$/g, '')
			.slice(0, 80) || 'untitled';
	return `${base}.${extension}`;
}
