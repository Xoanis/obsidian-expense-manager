import { getPluginLogger } from '../utils/plugin-debug-log';

export interface DocumentExtractionRequest {
	bytes: ArrayBuffer;
	fileName: string;
	mimeType?: string;
}

export interface ExtractedDocumentPage {
	pageNumber: number;
	text: string;
}

export interface DocumentExtractionResult {
	status: 'success' | 'partial' | 'failed';
	text: string;
	pages: ExtractedDocumentPage[];
	warnings: string[];
	provider: 'pdfjs';
}

export interface DocumentExtractionService {
	extractPdf(request: DocumentExtractionRequest): Promise<DocumentExtractionResult>;
}

const MINIMUM_USABLE_TEXT_LENGTH = 32;

function normalizeExtractionWhitespace(value: string): string {
	return value
		.replace(/\s+/g, ' ')
		.replace(/[^\S\r\n]+/g, ' ')
		.trim();
}

function looksGarbledExtractionText(value: string): boolean {
	const compact = value.replace(/\s+/g, '');
	if (!compact) {
		return false;
	}

	const replacementCount = (compact.match(/\uFFFD/g) ?? []).length;
	const readableCount = (compact.match(/[A-Za-zА-Яа-яЁё0-9.,:;()%+\-_/[\]]/g) ?? []).length;
	const ratio = readableCount / compact.length;
	return replacementCount > 0 || ratio < 0.45;
}

function looksLikePdfSyntaxDump(value: string): boolean {
	const normalized = normalizeExtractionWhitespace(value);
	if (!normalized) {
		return false;
	}

	const syntaxMarkers = [
		'%PDF-',
		' obj ',
		'endobj',
		'stream',
		'endstream',
		'/Type',
		'/Subtype',
		'/XObject',
		'/Filter',
		'/FlateDecode',
		'/Length',
		'/Width',
		'/Height',
		'/ColorSpace',
	];
	const markerHits = syntaxMarkers.reduce((count, marker) => count + (normalized.includes(marker) ? 1 : 0), 0);
	return markerHits >= 5;
}

export function isUsableDocumentExtractionResult(result: DocumentExtractionResult): boolean {
	const normalized = normalizeExtractionWhitespace(result.text);
	if (!normalized || normalized.length < MINIMUM_USABLE_TEXT_LENGTH) {
		return false;
	}

	if (!/[A-Za-zА-Яа-яЁё0-9]/.test(normalized)) {
		return false;
	}

	if (looksLikePdfSyntaxDump(normalized)) {
		return false;
	}

	return result.status === 'success' || !looksGarbledExtractionText(normalized);
}

function cloneArrayBuffer(buffer: ArrayBuffer): ArrayBuffer {
	return Uint8Array.from(new Uint8Array(buffer)).buffer;
}

let pdfJsModulePromise: Promise<any> | null = null;
let pdfJsWorkerModulePromise: Promise<unknown> | null = null;

async function withPdfJsBrowserLikeGlobals<T>(factory: () => Promise<T>): Promise<T> {
	const globalObject = globalThis as typeof globalThis & { process?: unknown };
	const originalProcessDescriptor = Object.getOwnPropertyDescriptor(globalObject, 'process') ?? null;
	try {
		if (originalProcessDescriptor) {
			try {
				Object.defineProperty(globalObject, 'process', {
					configurable: true,
					writable: true,
					value: undefined,
				});
			} catch (_error) {
				(globalObject as any).process = undefined;
			}
		}

		return await factory();
	} finally {
		if (originalProcessDescriptor) {
			Object.defineProperty(globalObject, 'process', originalProcessDescriptor);
		}
	}
}

async function ensurePdfJsWorkerModule(): Promise<void> {
	if (!pdfJsWorkerModulePromise) {
		pdfJsWorkerModulePromise = withPdfJsBrowserLikeGlobals(() => import('pdfjs-dist/legacy/build/pdf.worker.mjs'));
	}

	await pdfJsWorkerModulePromise;
}

async function loadPdfJsModule(): Promise<any> {
	if (!pdfJsModulePromise) {
		pdfJsModulePromise = withPdfJsBrowserLikeGlobals(async () => {
			await ensurePdfJsWorkerModule();
			return import('pdfjs-dist/legacy/build/pdf.mjs');
		});
	}

	return pdfJsModulePromise;
}

export class PdfJsDocumentExtractionService implements DocumentExtractionService {
	async extractPdf(request: DocumentExtractionRequest): Promise<DocumentExtractionResult> {
		let loadingTask: { promise: Promise<any>; destroy?: () => Promise<void> | void } | null = null;

		try {
			const pdfjsLib = await loadPdfJsModule();
			const stableBytes = cloneArrayBuffer(request.bytes);
			const task = (pdfjsLib as any).getDocument({
				data: new Uint8Array(stableBytes),
				disableWorker: true,
				disableStream: true,
				disableAutoFetch: true,
				stopAtErrors: false,
				isEvalSupported: false,
				useWorkerFetch: false,
				useSystemFonts: true,
			});
			loadingTask = task;

			const document = await task.promise;
			const pages: ExtractedDocumentPage[] = [];
			for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
				const page = await document.getPage(pageNumber);
				try {
					const textContent = await page.getTextContent();
					const parts: string[] = [];
					for (const item of textContent.items ?? []) {
						const rawText = typeof item?.str === 'string' ? item.str : '';
						const text = normalizeExtractionWhitespace(rawText);
						if (!text) {
							continue;
						}

						parts.push(text);
						if (item?.hasEOL) {
							parts.push('\n');
						}
					}

					const pageText = normalizeExtractionWhitespace(parts.join(' '));
					if (pageText) {
						pages.push({
							pageNumber,
							text: pageText,
						});
					}
				} finally {
					page.cleanup?.();
				}
			}

			const text = normalizeExtractionWhitespace(pages.map((page) => page.text).join('\n\n'));
			if (!text) {
				return {
					status: 'failed',
					text: '',
					pages: [],
					warnings: [
						'pdf.js did not return any extractable text from the PDF.',
						'Only text-based PDFs are supported right now.',
						'This PDF appears image-based, scanned, encrypted, or otherwise missing a usable text layer.',
					],
					provider: 'pdfjs',
				};
			}

			if (looksLikePdfSyntaxDump(text)) {
				return {
					status: 'failed',
					text,
					pages,
					warnings: [
						'pdf.js returned PDF syntax instead of readable document text.',
						'Only text-based PDFs are supported right now.',
						'This PDF appears image-based, scanned, or otherwise lacks a usable text layer for this iteration.',
					],
					provider: 'pdfjs',
				};
			}

			const warnings: string[] = [];
			if (looksGarbledExtractionText(text)) {
				warnings.push('pdf.js extracted text looks partially garbled or low-confidence.');
			}

			return {
				status: warnings.length > 0 ? 'partial' : 'success',
				text,
				pages,
				warnings,
				provider: 'pdfjs',
			};
		} catch (error) {
			return {
				status: 'failed',
				text: '',
				pages: [],
				warnings: [
					`pdf.js extraction failed: ${error instanceof Error ? error.message : String(error)}`,
				],
				provider: 'pdfjs',
			};
		} finally {
			try {
				await loadingTask?.destroy?.();
			} catch (error) {
				getPluginLogger().debug('PdfJsDocumentExtractionService: failed to destroy loading task', error);
			}
		}
	}
}

export function createDefaultDocumentExtractionService(): DocumentExtractionService {
	return new PdfJsDocumentExtractionService();
}
