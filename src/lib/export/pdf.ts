import { renderScore } from '$lib/render/render.js';
import type { Score } from '$lib/score/types.js';
import { safeFilename } from './download.js';

/**
 * Score → PDF, in the browser.
 *
 * The engraver already produces SVG, and svg2pdf draws SVG into a jsPDF
 * document as real vectors — so the PDF is the same notation the user has been
 * looking at, selectable and scalable rather than a screenshot. Nothing is
 * rasterised and nothing touches the server.
 *
 * The rendering is done into a detached element sized to the paper rather than
 * to the editor viewport. Exporting whatever happened to be on screen would
 * make the page breaks depend on the window width, which is not a property
 * anyone wants in a printed part.
 */

/** Millimetres, portrait. */
const PAPER = {
	a4: { width: 210, height: 297 },
	letter: { width: 215.9, height: 279.4 }
} as const;

export type PaperSize = keyof typeof PAPER;

export interface PdfOptions {
	paper?: PaperSize;
	/** Margin in millimetres. */
	margin?: number;
	/** Printed above the first system. Defaults to the score's own title. */
	title?: string;
	composer?: string;
	/** Ink colour. Black by default — a themed score is for the screen, not
	 *  for paper, and a dark theme would otherwise print as a solid block. */
	color?: string;
}

/** Millimetres to CSS pixels at 96dpi, which is what the engraver lays out in. */
const MM_TO_PX = 96 / 25.4;

export async function scoreToPdf(score: Score, opts: PdfOptions = {}): Promise<Blob> {
	// Dynamic, and only here: jsPDF and svg2pdf together are a large chunk that
	// nobody needs until they actually export.
	const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);

	const paper = PAPER[opts.paper ?? 'a4'];
	const margin = opts.margin ?? 15;
	const contentMm = { width: paper.width - margin * 2, height: paper.height - margin * 2 };
	const ink = opts.color ?? '#000000';
	const contentPx = {
		width: Math.round(contentMm.width * MM_TO_PX),
		height: Math.round(contentMm.height * MM_TO_PX)
	};

	const host = document.createElement('div');
	// Off-screen rather than hidden: the engraver measures text, and
	// display:none gives every element zero width.
	host.style.cssText = `position:absolute;left:-10000px;top:0;width:${contentPx.width}px;`;
	document.body.append(host);

	try {
		renderScore(host, score, {
			width: contentPx.width,
			pageHeight: contentPx.height,
			// Everything prints in one ink. On screen the diff and selection
			// colours carry meaning; on paper they would just be a score with
			// mysteriously coloured notes in it.
			colors: {
				notation: ink,
				paper: '#ffffff',
				accent: ink,
				diffAdd: ink,
				diffChange: ink,
				dim: ink
			}
		});

		const svgs = [...host.querySelectorAll('svg')];
		if (svgs.length === 0) throw new Error('There is nothing to export yet.');

		const doc = new jsPDF({
			orientation: 'portrait',
			unit: 'mm',
			format: [paper.width, paper.height],
			compress: true
		});

		for (const [index, svg] of svgs.entries()) {
			if (index > 0) doc.addPage([paper.width, paper.height], 'portrait');

			const isFirst = index === 0;
			const headerMm = isFirst ? writeHeader(doc, score, opts, paper, margin) : 0;

			await svg2pdf(svg, doc, {
				x: margin,
				y: margin + headerMm,
				width: contentMm.width,
				height: Math.min(
					contentMm.height - headerMm,
					(svg.viewBox?.baseVal?.height || contentPx.height) / MM_TO_PX
				)
			});

			// Page numbers only once there is more than one page — a single
			// sheet numbered "1" looks like a fragment of something longer.
			if (svgs.length > 1) {
				doc.setFontSize(9);
				doc.setTextColor(120);
				doc.text(String(index + 1), paper.width / 2, paper.height - margin / 2, {
					align: 'center'
				});
			}
		}

		return doc.output('blob');
	} finally {
		host.remove();
	}
}

/** Title and composer above the first system. Returns the height it used, in mm. */
function writeHeader(
	doc: import('jspdf').jsPDF,
	score: Score,
	opts: PdfOptions,
	paper: { width: number },
	margin: number
): number {
	const title = opts.title ?? score.title;
	const composer = opts.composer ?? score.composer;
	if (!title && !composer) return 0;

	let used = 0;
	if (title) {
		doc.setFontSize(18);
		doc.setTextColor(0);
		doc.text(title, paper.width / 2, margin + 6, { align: 'center' });
		used += 10;
	}
	if (composer) {
		doc.setFontSize(11);
		doc.setTextColor(80);
		doc.text(composer, paper.width - margin, margin + used + 3, { align: 'right' });
		used += 7;
	}
	return used + 4;
}

export function pdfFilename(score: Score): string {
	return safeFilename(score.title, 'pdf');
}
