// Client-only Tesseract.js wrapper (naptha/tesseract.js v6+).
// One shared worker is reused across pages for speed — models are
// downloaded once from CDN then cached by the browser. Image pixels
// never leave the device.

import { createWorker, type Worker } from "tesseract.js";

export type OcrProgress = {
	status: string;
	progress: number;
};

let cachedWorker: Worker | null = null;
let cachedLang = "";

export async function getOcrWorker(
	lang: string,
	onProgress?: (p: OcrProgress) => void,
): Promise<Worker> {
	if (cachedWorker && cachedLang === lang) return cachedWorker;
	// Language changed (or first run) — drop the old worker.
	if (cachedWorker) {
		try {
			await cachedWorker.terminate();
		} catch {
			// ignore teardown errors
		}
		cachedWorker = null;
	}
	cachedWorker = await createWorker(lang, 1, {
		logger: (m: { status: string; progress: number }) => {
			onProgress?.({ status: m.status, progress: m.progress ?? 0 });
		},
	});
	cachedLang = lang;
	return cachedWorker;
}

export async function terminateOcrWorker() {
	if (cachedWorker) {
		try {
			await cachedWorker.terminate();
		} catch {
			// ignore
		}
		cachedWorker = null;
		cachedLang = "";
	}
}

export type OcrResult = {
	text: string;
	confidence: number;
};

/**
 * Run OCR on a canvas / image / blob / data URL / object URL.
 * Returns trimmed text + mean confidence (0-100).
 */
export async function recognizeImage(
	image: HTMLCanvasElement | HTMLImageElement | string | Blob,
	lang: string,
	onProgress?: (p: OcrProgress) => void,
): Promise<OcrResult> {
	const worker = await getOcrWorker(lang, onProgress);
	const { data } = await worker.recognize(
		image as unknown as string,
		{},
		{ text: true },
	);
	return {
		text: (data.text ?? "").trim(),
		confidence: Math.round(data.confidence ?? 0),
	};
}

/** Commonly useful Tesseract language codes. */
export const OCR_LANGUAGES = [
	{ code: "eng", label: "English" },
	{ code: "ind", label: "Indonesian" },
	{ code: "eng+ind", label: "English + Indonesian" },
	{ code: "chi_sim+eng", label: "Chinese (Simplified) + English" },
	{ code: "jpn", label: "Japanese" },
	{ code: "ara", label: "Arabic" },
	{ code: "fra", label: "French" },
	{ code: "deu", label: "German" },
	{ code: "spa", label: "Spanish" },
] as const;
