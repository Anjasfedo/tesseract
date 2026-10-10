import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadJsonFile, downloadTextFile, formatBytes } from "../lib/export";
import { OCR_LANGUAGES, recognizeImage, terminateOcrWorker } from "../lib/ocr";
import {
	canvasToPreviewUrl,
	ensurePdfWorker,
	getEmbeddedPageText,
	loadPdfDocument,
	parsePageRange,
	renderPageToCanvas,
} from "../lib/pdf";

export const Route = createFileRoute("/")({
	component: Home,
	// Fully client-side: never SSR this page (workers / canvas need `window`).
	ssr: false,
});

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp,image/bmp";
const MAX_FILE_MB = 50;
const MAX_PAGES_PER_PDF = 30;

type PageJob = {
	id: string;
	fileName: string;
	kind: "image" | "pdf";
	pageNumber: number;
	totalPages: number;
	previewUrl?: string;
	status: "queued" | "rendering" | "ocr" | "done" | "error" | "cancelled";
	detail: string;
	progress: number;
	text: string;
	confidence: number;
	usedEmbeddedText?: boolean;
};

type InputFile = {
	file: File;
	id: string;
	pdfPages?: number;
	previewUrl?: string;
	error?: string;
};

function loadImageFile(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(`Cannot decode image ${file.name}`));
		};
		img.src = url;
	});
}

function imageToCanvas(
	img: HTMLImageElement,
	maxDim = 4000,
): HTMLCanvasElement {
	const ratio = Math.min(
		1,
		maxDim / Math.max(img.naturalWidth, img.naturalHeight),
	);
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.floor(img.naturalWidth * ratio));
	canvas.height = Math.max(1, Math.floor(img.naturalHeight * ratio));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D not supported");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas;
}

function Home() {
	const [isClient, setIsClient] = useState(false);
	const [inputs, setInputs] = useState<InputFile[]>([]);
	const [jobs, setJobs] = useState<PageJob[]>([]);
	const [lang, setLang] = useState<string>("eng");
	const [scale, setScale] = useState<number>(2);
	const [pageRange, setPageRange] = useState("all");
	const [useEmbedded, setUseEmbedded] = useState(true);
	const [isRunning, setIsRunning] = useState(false);
	const [isDragging, setIsDragging] = useState(false);
	const [engineNote, setEngineNote] = useState("");
	const cancelRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setIsClient(true);
		ensurePdfWorker();
		return () => {
			void terminateOcrWorker();
		};
	}, []);

	const patchJob = useCallback((id: string, patch: Partial<PageJob>) => {
		setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
	}, []);

	const addFiles = useCallback(async (list: FileList | File[]) => {
		const arr = Array.from(list);
		const next: InputFile[] = [];
		for (const file of arr) {
			if (file.size > MAX_FILE_MB * 1024 * 1024) {
				next.push({
					file,
					id: `${file.name}-${file.size}-${Date.now()}`,
					error: `Over ${MAX_FILE_MB}MB limit`,
				});
				continue;
			}
			const entry: InputFile = {
				file,
				id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
			};
			if (file.type === "application/pdf") {
				try {
					ensurePdfWorker();
					const buf = await file.arrayBuffer();
					const loaded = await loadPdfDocument(buf.slice(0));
					entry.pdfPages = loaded.pdf.numPages;
					await loaded.destroy();
					if (loaded.pdf.numPages > MAX_PAGES_PER_PDF) {
						entry.error = `Has ${loaded.pdf.numPages} pages — only first ${MAX_PAGES_PER_PDF} will be OCR'd (set a range like 1-${MAX_PAGES_PER_PDF}).`;
					}
				} catch (e) {
					entry.error =
						e instanceof Error ? e.message : "Cannot read PDF (encrypted?)";
				}
			} else if (file.type.startsWith("image/")) {
				entry.previewUrl = URL.createObjectURL(file);
			} else {
				entry.error = `Unsupported type: ${file.type || file.name}`;
			}
			next.push(entry);
		}
		setInputs((prev) => [...prev, ...next]);
	}, []);

	// Paste support
	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			const files = Array.from(e.clipboardData?.files ?? []).filter(
				(f) => f.type === "application/pdf" || f.type.startsWith("image/"),
			);
			if (files.length > 0) void addFiles(files);
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [addFiles]);

	const removeInput = (id: string) => {
		setInputs((prev) => {
			const found = prev.find((i) => i.id === id);
			if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
			return prev.filter((i) => i.id !== id);
		});
	};

	const clearAll = () => {
		cancelRef.current = true;
		void terminateOcrWorker();
		setInputs((prev) => {
			for (const i of prev) if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
			return [];
		});
		setJobs([]);
		setIsRunning(false);
		setEngineNote("");
	};

	const runOcr = async () => {
		const valid = inputs.filter((i) => !i.error);
		if (valid.length === 0 || isRunning) return;
		cancelRef.current = false;
		setIsRunning(true);
		setJobs([]);
		setEngineNote(
			"Starting… (first run downloads the OCR model ~10MB, then it is cached)",
		);

		const allJobs: PageJob[] = [];
		try {
			// Build job skeleton first so UI shows the queue immediately.
			for (const input of valid) {
				if (input.file.type === "application/pdf") {
					const total = input.pdfPages ?? 1;
					const pages = parsePageRange(pageRange, total).slice(
						0,
						MAX_PAGES_PER_PDF,
					);
					const list = pages.length > 0 ? pages : [1];
					for (const p of list) {
						allJobs.push({
							id: `${input.id}-p${p}`,
							fileName: input.file.name,
							kind: "pdf",
							pageNumber: p,
							totalPages: total,
							status: "queued",
							detail: "Waiting…",
							progress: 0,
							text: "",
							confidence: 0,
						});
					}
				} else {
					allJobs.push({
						id: input.id,
						fileName: input.file.name,
						kind: "image",
						pageNumber: 1,
						totalPages: 1,
						previewUrl: input.previewUrl,
						status: "queued",
						detail: "Waiting…",
						progress: 0,
						text: "",
						confidence: 0,
					});
				}
			}
			setJobs(allJobs);

			for (const job of allJobs) {
				if (cancelRef.current) {
					patchJob(job.id, { status: "cancelled", detail: "Cancelled" });
					continue;
				}
				const input = valid.find((v) =>
					job.kind === "image" ? v.id === job.id : v.file.name === job.fileName,
				);
				if (!input) continue;

				try {
					if (job.kind === "image") {
						patchJob(job.id, {
							status: "ocr",
							detail: "Reading image…",
							progress: 0.05,
						});
						setEngineNote(`OCR: ${job.fileName}`);
						const img = await loadImageFile(input.file);
						const canvas = imageToCanvas(img);
						if (!job.previewUrl) {
							patchJob(job.id, { previewUrl: canvasToPreviewUrl(canvas) });
						}
						const res = await recognizeImage(canvas, lang, (p) => {
							patchJob(job.id, {
								detail: p.status,
								progress: 0.05 + p.progress * 0.9,
							});
						});
						patchJob(job.id, {
							status: "done",
							detail: res.text ? "Done" : "Done — no text found",
							progress: 1,
							text: res.text,
							confidence: res.confidence,
						});
					} else {
						// PDF page
						patchJob(job.id, {
							status: "rendering",
							detail: `Rendering page ${job.pageNumber}…`,
							progress: 0.05,
						});
						setEngineNote(
							`PDF ${job.fileName} — page ${job.pageNumber}/${job.totalPages}`,
						);
						const buf = await input.file.arrayBuffer();
						const loaded = await loadPdfDocument(buf.slice(0));
						const pdf = loaded.pdf;
						try {
							if (cancelRef.current) throw new Error("cancelled");
							let embedded = "";
							try {
								embedded = await getEmbeddedPageText(pdf, job.pageNumber);
							} catch {
								embedded = "";
							}
							const canvas = await renderPageToCanvas(
								pdf,
								job.pageNumber,
								scale,
							);
							patchJob(job.id, {
								previewUrl: canvasToPreviewUrl(canvas),
								detail:
									embedded.length > 20
										? "Page has selectable text"
										: "Scanned page — running OCR…",
								progress: 0.15,
							});

							if (useEmbedded && embedded.length > 20) {
								patchJob(job.id, {
									status: "done",
									detail: "Used embedded PDF text (no OCR needed)",
									progress: 1,
									text: embedded,
									confidence: 100,
									usedEmbeddedText: true,
								});
							} else {
								patchJob(job.id, {
									status: "ocr",
									detail: "Recognizing…",
									progress: 0.15,
								});
								const res = await recognizeImage(canvas, lang, (p) => {
									patchJob(job.id, {
										detail: p.status,
										progress: 0.15 + p.progress * 0.8,
									});
								});
								patchJob(job.id, {
									status: "done",
									detail: res.text ? "Done" : "Done — no text found",
									progress: 1,
									text: res.text,
									confidence: res.confidence,
								});
							}
						} finally {
							await loaded.destroy();
						}
					}
				} catch (e) {
					if (cancelRef.current) {
						patchJob(job.id, {
							status: "cancelled",
							detail: "Cancelled",
							progress: 0,
						});
					} else {
						patchJob(job.id, {
							status: "error",
							detail: e instanceof Error ? e.message : "Failed",
							progress: 0,
						});
					}
				}
			}
			setEngineNote(
				cancelRef.current
					? "Cancelled."
					: "Finished. All processing stayed on your device.",
			);
		} finally {
			setIsRunning(false);
		}
	};

	const doneJobs = jobs.filter((j) => j.status === "done");
	const combinedText = doneJobs
		.map((j) =>
			j.kind === "pdf"
				? `===== ${j.fileName} — page ${j.pageNumber}/${j.totalPages} =====\n${j.text}`
				: `===== ${j.fileName} =====\n${j.text}`,
		)
		.join("\n\n");
	const overall =
		jobs.length === 0
			? 0
			: jobs.reduce((s, j) => s + j.progress, 0) / jobs.length;

	if (!isClient) {
		return (
			<div className="p-8 text-sm text-neutral-500">Loading OCR workspace…</div>
		);
	}

	return (
		<div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
			<div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
				<header className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
							Local OCR{" "}
							<span className="text-emerald-600">· 100% client-side</span>
						</h1>
						<p className="mt-1 max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
							Drop a PDF or image — PDFs are rasterized with pdf.js, then read
							with Tesseract.js. Files never leave your device. You can also
							paste from clipboard.
						</p>
					</div>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={runOcr}
							disabled={
								isRunning || inputs.filter((i) => !i.error).length === 0
							}
							className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow disabled:cursor-not-allowed disabled:opacity-40 hover:bg-emerald-500"
						>
							{isRunning ? "Running…" : "Start OCR"}
						</button>
						<button
							type="button"
							onClick={() => {
								cancelRef.current = true;
								void terminateOcrWorker();
								setIsRunning(false);
								setEngineNote("Cancelled.");
							}}
							disabled={!isRunning}
							className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={clearAll}
							className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-900"
						>
							Clear
						</button>
					</div>
				</header>

				{/* Settings */}
				<section className="mt-6 grid gap-3 rounded-2xl border border-neutral-200 bg-white p-4 sm:grid-cols-4 dark:border-neutral-800 dark:bg-neutral-900">
					<label className="flex flex-col gap-1 text-xs font-medium">
						Language
						<select
							value={lang}
							onChange={(e) => setLang(e.target.value)}
							disabled={isRunning}
							className="rounded-lg border border-neutral-300 bg-transparent px-2 py-2 text-sm dark:border-neutral-700"
						>
							{OCR_LANGUAGES.map((l) => (
								<option key={l.code} value={l.code}>
									{l.label} ({l.code})
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						PDF render scale (~DPI)
						<select
							value={scale}
							onChange={(e) => setScale(Number(e.target.value))}
							disabled={isRunning}
							className="rounded-lg border border-neutral-300 bg-transparent px-2 py-2 text-sm dark:border-neutral-700"
						>
							<option value={1.5}>1.5x — fast</option>
							<option value={2}>2.0x — balanced</option>
							<option value={3}>3.0x — accurate, slow</option>
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs font-medium">
						PDF pages{" "}
						<span className="font-normal text-neutral-500">
							e.g. all, 1-3, 1-3,5
						</span>
						<input
							value={pageRange}
							onChange={(e) => setPageRange(e.target.value)}
							disabled={isRunning}
							placeholder="all"
							className="rounded-lg border border-neutral-300 bg-transparent px-2 py-2 text-sm dark:border-neutral-700"
						/>
					</label>
					<label className="flex items-center gap-2 text-xs font-medium">
						<input
							type="checkbox"
							checked={useEmbedded}
							onChange={(e) => setUseEmbedded(e.target.checked)}
							disabled={isRunning}
							className="h-4 w-4 accent-emerald-600"
						/>
						<span>
							Use embedded PDF text when available
							<span className="block font-normal text-neutral-500">
								100x faster for digital PDFs
							</span>
						</span>
					</label>
				</section>

				{/* Dropzone */}
				{/* biome-ignore lint/a11y/useSemanticElements: dropzone needs div semantics with drag events */}
				<div
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ")
							fileInputRef.current?.click();
					}}
					onDragOver={(e) => {
						e.preventDefault();
						setIsDragging(true);
					}}
					onDragLeave={() => setIsDragging(false)}
					onDrop={(e) => {
						e.preventDefault();
						setIsDragging(false);
						if (e.dataTransfer.files.length > 0)
							void addFiles(e.dataTransfer.files);
					}}
					onClick={() => fileInputRef.current?.click()}
					className={`mt-4 cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition ${
						isDragging
							? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950"
							: "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
					}`}
				>
					<input
						ref={fileInputRef}
						type="file"
						accept={ACCEPT}
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files) void addFiles(e.target.files);
							e.target.value = "";
						}}
					/>
					<p className="text-sm font-semibold">
						Drop PDF / PNG / JPG / WebP / BMP here, or click to browse
					</p>
					<p className="mt-1 text-xs text-neutral-500">
						PDF, PNG, JPG, WebP, BMP · max {MAX_FILE_MB}MB each · max{" "}
						{MAX_PAGES_PER_PDF} pages/PDF per run
					</p>
				</div>

				{/* Input files */}
				{inputs.length > 0 && (
					<section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
						<h2 className="text-sm font-semibold">Files ({inputs.length})</h2>
						<ul className="mt-2 space-y-2">
							{inputs.map((i) => (
								<li
									key={i.id}
									className="flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800"
								>
									<div className="min-w-0">
										<p className="truncate font-medium">{i.file.name}</p>
										<p className="text-xs text-neutral-500">
											{formatBytes(i.file.size)} · {i.file.type || "unknown"}
											{typeof i.pdfPages === "number"
												? ` · ${i.pdfPages} pages`
												: ""}
											{i.error ? ` · ⚠ ${i.error}` : ""}
										</p>
									</div>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											removeInput(i.id);
										}}
										className="shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-600 hover:bg-neutral-200 dark:hover:bg-neutral-700"
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					</section>
				)}

				{/* Progress */}
				{(isRunning || jobs.length > 0) && (
					<section className="mt-4 rounded-2xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
						<div className="flex items-center justify-between gap-3">
							<h2 className="text-sm font-semibold">
								Results ({doneJobs.length}/{jobs.length} done)
							</h2>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() =>
										combinedText &&
										downloadTextFile("ocr-result.txt", combinedText)
									}
									disabled={!combinedText}
									className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-black"
								>
									Download .txt
								</button>
								<button
									type="button"
									onClick={() =>
										downloadJsonFile(
											"ocr-result.json",
											doneJobs.map((j) => ({
												file: j.fileName,
												page: j.pageNumber,
												confidence: j.confidence,
												embedded: j.usedEmbeddedText ?? false,
												text: j.text,
											})),
										)
									}
									disabled={!combinedText}
									className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-600"
								>
									Download .json
								</button>
								<button
									type="button"
									onClick={() =>
										combinedText && navigator.clipboard.writeText(combinedText)
									}
									disabled={!combinedText}
									className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-neutral-600"
								>
									Copy all
								</button>
							</div>
						</div>
						{engineNote && (
							<p className="mt-1 text-xs text-neutral-500">{engineNote}</p>
						)}
						<div className="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
							<div
								className="h-full bg-emerald-500 transition-all"
								style={{ width: `${Math.round(overall * 100)}%` }}
							/>
						</div>

						<ul className="mt-3 space-y-3">
							{jobs.map((j) => (
								<li
									key={j.id}
									className="grid gap-3 rounded-xl border border-neutral-200 p-3 sm:grid-cols-[160px_1fr] dark:border-neutral-700"
								>
									<div>
										{j.previewUrl ? (
											<img
												src={j.previewUrl}
												alt={`${j.fileName} p${j.pageNumber}`}
												className="max-h-48 w-full rounded-lg border border-neutral-200 object-contain bg-white dark:border-neutral-700"
											/>
										) : (
											<div className="flex h-24 items-center justify-center rounded-lg bg-neutral-100 text-xs text-neutral-500 dark:bg-neutral-800">
												no preview yet
											</div>
										)}
										<p
											className="mt-1 truncate text-xs font-medium"
											title={j.fileName}
										>
											{j.fileName}
											{j.kind === "pdf"
												? ` · p${j.pageNumber}/${j.totalPages}`
												: ""}
										</p>
										<p className="text-xs text-neutral-500">
											{j.status} · {Math.round(j.progress * 100)}%
											{j.status === "done" && j.confidence > 0
												? ` · conf ${j.confidence}%`
												: ""}
										</p>
										<p
											className="truncate text-xs text-neutral-500"
											title={j.detail}
										>
											{j.detail}
										</p>
										{j.status !== "done" &&
											j.status !== "error" &&
											j.status !== "cancelled" && (
												<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
													<div
														className="h-full bg-emerald-500"
														style={{ width: `${j.progress * 100}%` }}
													/>
												</div>
											)}
									</div>
									<div>
										{j.status === "done" ? (
											<textarea
												readOnly
												value={j.text || "(no text detected)"}
												rows={8}
												className="w-full rounded-lg border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs whitespace-pre-wrap dark:border-neutral-700 dark:bg-neutral-950"
											/>
										) : j.status === "error" ? (
											<p className="text-xs text-red-600">Error: {j.detail}</p>
										) : (
											<p className="text-xs text-neutral-500">
												Waiting for result…
											</p>
										)}
									</div>
								</li>
							))}
						</ul>

						{combinedText && (
							<details className="mt-3">
								<summary className="cursor-pointer text-sm font-semibold">
									Combined text preview
								</summary>
								<textarea
									readOnly
									value={combinedText}
									rows={10}
									className="mt-2 w-full rounded-lg border border-neutral-200 bg-neutral-50 p-2 font-mono text-xs whitespace-pre-wrap dark:border-neutral-700 dark:bg-neutral-950"
								/>
							</details>
						)}
					</section>
				)}

				<footer className="mt-8 text-center text-xs text-neutral-500">
					Private by design — OCR runs in WebAssembly workers on your device.
					First run fetches the language model (~10MB) from CDN and caches it.
				</footer>
			</div>
		</div>
	);
}
