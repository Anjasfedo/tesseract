// Client-only PDF helpers built on pdf.js (mozilla.github.io/pdf.js).
// Never imported on the server for side effects — call `ensurePdfWorker()`
// from an event handler / useEffect only.

import type { PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjsLib from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

export function ensurePdfWorker() {
	if (typeof window === "undefined") return;
	if (!workerConfigured) {
		pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
		workerConfigured = true;
	}
}

export type LoadedPdf = {
	pdf: PDFDocumentProxy;
	destroy: () => Promise<void>;
};

export async function loadPdfDocument(data: ArrayBuffer): Promise<LoadedPdf> {
	ensurePdfWorker();
	const task = pdfjsLib.getDocument({
		data: data as unknown as Uint8Array,
		useSystemFonts: true,
		// Render via canvas, no external fetch of cmaps needed for OCR.
	});
	const pdf = await task.promise;
	return { pdf, destroy: () => task.destroy() };
}

/** Fast path: does this PDF page already contain selectable text? */
export async function getEmbeddedPageText(
	pdf: PDFDocumentProxy,
	pageNumber: number,
): Promise<string> {
	const page = await pdf.getPage(pageNumber);
	const content = await page.getTextContent();
	const str = content.items
		.map((it) => ("str" in it ? (it.str as string) : ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return str;
}

/**
 * Render a PDF page to canvas at a given scale.
 * scale 2.0 ≈ 144 DPI, 3.0 ≈ 216 DPI. 2.0 is the speed/accuracy sweet spot.
 */
export async function renderPageToCanvas(
	pdf: PDFDocumentProxy,
	pageNumber: number,
	scale = 2.0,
	maxDim = 4000,
): Promise<HTMLCanvasElement> {
	const page = await pdf.getPage(pageNumber);
	let viewport = page.getViewport({ scale });
	// Guard against OOM on huge pages (posters / A0 scans).
	const largest = Math.max(viewport.width, viewport.height);
	if (largest > maxDim) {
		const down = maxDim / largest;
		viewport = page.getViewport({ scale: scale * down });
	}
	const canvas = document.createElement("canvas");
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	const ctx = canvas.getContext("2d", { alpha: false });
	if (!ctx) throw new Error("Canvas 2D not supported in this browser");
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	// pdf.js v4+ requires `canvas`; `canvasContext` is optional.
	await page.render({ canvas, canvasContext: ctx, viewport }).promise;
	return canvas;
}

/** Downscaled JPEG preview so the UI stays snappy with 20+ pages. */
export function canvasToPreviewUrl(
	canvas: HTMLCanvasElement,
	maxSide = 480,
): string {
	const ratio = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
	if (ratio >= 1) return canvas.toDataURL("image/jpeg", 0.7);
	const small = document.createElement("canvas");
	small.width = Math.floor(canvas.width * ratio);
	small.height = Math.floor(canvas.height * ratio);
	const ctx = small.getContext("2d");
	if (!ctx) return canvas.toDataURL("image/jpeg", 0.7);
	ctx.drawImage(canvas, 0, 0, small.width, small.height);
	return small.toDataURL("image/jpeg", 0.7);
}

/** Parse "1-3,5" style page ranges into 1-based page numbers. */
export function parsePageRange(input: string, totalPages: number): number[] {
	const raw = input.trim().toLowerCase();
	if (raw === "" || raw === "all") {
		return Array.from({ length: totalPages }, (_, i) => i + 1);
	}
	const out = new Set<number>();
	for (const part of raw.split(",")) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [a, b] = p.split("-").map((s) => Number.parseInt(s.trim(), 10));
			if (Number.isNaN(a) || Number.isNaN(b)) continue;
			const lo = Math.max(1, Math.min(a, b));
			const hi = Math.min(totalPages, Math.max(a, b));
			for (let i = lo; i <= hi; i++) out.add(i);
		} else {
			const n = Number.parseInt(p, 10);
			if (!Number.isNaN(n) && n >= 1 && n <= totalPages) out.add(n);
		}
	}
	return [...out].sort((x, y) => x - y);
}
