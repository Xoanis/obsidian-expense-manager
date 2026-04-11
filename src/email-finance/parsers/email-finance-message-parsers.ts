import type {
	FinanceReceiptProposalRequest,
	FinanceTextProposalRequest,
} from '../../services/finance-intake-service';
import type { FinanceMailMessage } from '../transport/finance-mail-provider';
import type {
	PlannedEmailFinanceReceiptUnit,
	PlannedEmailFinanceTextUnit,
	PlannedEmailFinanceUnit,
} from '../planning/email-finance-message-planner';
import { decodeCommonHtmlEntities, decodeEmailTransferText, toSearchablePlainText } from '../utils/email-content-normalizer';

export interface EmailFinanceParserResult {
	units: PlannedEmailFinanceUnit[];
	stop: boolean;
	parserId: string;
}

export interface EmailFinanceParserAttempt {
	parserId: string;
	matched: boolean;
	stop: boolean;
	reason: string;
	diagnostics?: Record<string, unknown>;
	units: PlannedEmailFinanceUnit[];
}

export interface EmailFinanceMessageParser {
	readonly id: string;
	parse(message: FinanceMailMessage): EmailFinanceParserAttempt;
}

export interface EmailFinanceMessageDebugSignals {
	senderDomain: string;
	subject: string;
	normalizedBodyLength: number;
	normalizedBodyPreview: string;
	linkCount: number;
	linkSamples: string[];
	imageSourceCount: number;
	imageSourceSamples: string[];
	dataUrlImageCount: number;
	dataUrlImageSamples: string[];
	qrUrlCandidateCount: number;
	qrUrlCandidateSamples: string[];
	fiscalFieldsFromBody: string | null;
	fiscalFieldsFromQrUrl: string | null;
	evidenceSummary: EmailFinanceEvidenceSummary;
}

type EmailFinanceEvidenceKind =
	| 'fiscal-qr-payload'
	| 'amount'
	| 'date-time'
	| 'merchant'
	| 'operation-type'
	| 'receipt-link'
	| 'image-source'
	| 'remote-artifact-link';

type EmailFinanceEvidenceConfidence = 'high' | 'medium' | 'low';

interface EmailFinanceEvidenceItem {
	kind: EmailFinanceEvidenceKind;
	value: string;
	sourceId: string;
	confidence: EmailFinanceEvidenceConfidence;
}

interface EmailFinanceResolvedEvidenceValue {
	value: string | null;
	candidates: string[];
	conflictingValues: string[];
}

interface EmailFinanceEvidenceCollection {
	items: EmailFinanceEvidenceItem[];
	resolved: {
		fiscalQrPayload: EmailFinanceResolvedEvidenceValue;
		amount: EmailFinanceResolvedEvidenceValue;
		dateTime: EmailFinanceResolvedEvidenceValue;
		merchant: EmailFinanceResolvedEvidenceValue;
		operationType: EmailFinanceResolvedEvidenceValue;
	};
}

interface EmailFinanceEvidenceSummary {
	totalEvidenceCount: number;
	fiscalQrCandidateCount: number;
	resolvedFiscalQrPayload: string | null;
	conflictingFiscalQrPayloads: string[];
	amountCandidates: string[];
	dateTimeCandidates: string[];
}

export class CompositeEmailFinanceMessageParser {
	constructor(private readonly parsers: EmailFinanceMessageParser[]) {}

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt[] {
		const results: EmailFinanceParserAttempt[] = [];
		for (const parser of this.parsers) {
			const attempt = parser.parse(message);
			results.push(attempt);
			if (attempt.matched && attempt.stop) {
				break;
			}
		}
		return results;
	}
}

function matchedParserAttempt(
	parserId: string,
	units: PlannedEmailFinanceUnit[],
	options?: {
		stop?: boolean;
		reason?: string;
		diagnostics?: Record<string, unknown>;
	},
): EmailFinanceParserAttempt {
	return {
		parserId,
		matched: true,
		stop: options?.stop ?? false,
		reason: options?.reason ?? 'parser matched',
		diagnostics: options?.diagnostics,
		units,
	};
}

function noMatchParserAttempt(
	parserId: string,
	reason: string,
	diagnostics?: Record<string, unknown>,
): EmailFinanceParserAttempt {
	return {
		parserId,
		matched: false,
		stop: false,
		reason,
		diagnostics,
		units: [],
	};
}

export function createDefaultEmailFinanceMessageParsers(): EmailFinanceMessageParser[] {
	return [
		new ResolvedReceiptEvidenceEmailParser(),
		new MagnitReceiptEmailParser(),
		new LentaReceiptEmailParser(),
		new FiscalReceiptFieldsEmailParser(),
		new YandexCheckReceiptEmailParser(),
		new OzonReceiptEmailParser(),
		new ReceiptLinkEmailParser(),
		new ReceiptSummaryEmailParser(),
	];
}

export function collectEmailFinanceMessageDebugSignals(message: FinanceMailMessage): EmailFinanceMessageDebugSignals {
	const normalizedBody = normalizeMessageText(message);
	const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
	const from = decodeEmailTransferText(message.from?.trim() ?? '');
	const senderDomain = extractSenderDomain(from);
	const links = extractMessageLinks(message, normalizedBody);
	const imageSources = extractMessageImageSources(message);
	const dataUrlImages = imageSources.filter((source) => /^data:image\//i.test(source));
	const qrUrlCandidates = collectQrUrlCandidates(links, imageSources);
	const fiscalFieldsFromBody = extractFiscalReceiptFields(normalizedBody);
	const fiscalFieldsFromQrUrl = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
	const evidence = collectEmailFinanceEvidence(message, normalizedBody, links, imageSources);
	return {
		senderDomain,
		subject,
		normalizedBodyLength: normalizedBody.length,
		normalizedBodyPreview: normalizedBody.slice(0, 1500),
		linkCount: links.length,
		linkSamples: sanitizeDebugSourceSamples(links),
		imageSourceCount: imageSources.length,
		imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
		dataUrlImageCount: dataUrlImages.length,
		dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
		qrUrlCandidateCount: qrUrlCandidates.length,
		qrUrlCandidateSamples: sanitizeDebugSourceSamples(qrUrlCandidates),
		fiscalFieldsFromBody: fiscalFieldsFromBody ? buildRawReceiptQrPayload(fiscalFieldsFromBody) : null,
		fiscalFieldsFromQrUrl: fiscalFieldsFromQrUrl ? buildRawReceiptQrPayload(fiscalFieldsFromQrUrl) : null,
		evidenceSummary: summarizeEmailFinanceEvidence(evidence),
	};
}

class MagnitReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'magnit-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const senderDomain = extractSenderDomain(from);
		const links = extractMessageLinks(message, normalizedBody);
		const receiptPdfLink = links.find((link) => /lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul/i.test(link)) ?? null;
		const looksLikeBySender = /ofd-magnit\.ru/i.test(senderDomain);
		const looksLikeByKeyword = /магнит/i.test(`${subject}\n${normalizedBody}`);
		const looksLikeMagnitReceipt = Boolean(receiptPdfLink)
			|| looksLikeBySender
			|| looksLikeByKeyword;
		if (!looksLikeMagnitReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Magnit receipt', {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				looksLikeBySender,
				looksLikeByKeyword,
			});
		}

		const linkFields = extractMagnitReceiptFields(message, normalizedBody, links);
		const amount = extractReceiptAmount(normalizedBody) ?? extractMagnitReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const operationType = extractReceiptOperationType(normalizedBody);
		if (!linkFields || !amount || !dateTime || !operationType) {
			return noMatchParserAttempt(this.id, 'Magnit receipt signals were found, but fiscal extraction is incomplete', {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				hasLinkFields: Boolean(linkFields),
				hasAmount: Boolean(amount),
				hasDateTime: Boolean(dateTime),
				hasOperationType: Boolean(operationType),
				amount,
				dateTime,
				operationType,
				linkFields,
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('magnit-fiscal-receipt-fields', {
				dateTime,
				amount,
				fn: linkFields.fn,
				i: linkFields.fd,
				fp: linkFields.fp,
				n: operationType,
			})], {
			stop: true,
			reason: 'Magnit receipt fiscal fields reconstructed from email content',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				hasMagnitPdfLink: Boolean(receiptPdfLink),
				amount,
				dateTime,
				operationType,
				linkFields,
			},
		});
	}
}

class LentaReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'lenta-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const senderDomain = extractSenderDomain(from);
		const links = extractMessageLinks(message, normalizedBody);
		const imageSources = extractMessageImageSources(message);
		const dataUrlImages = imageSources.filter((source) => /^data:image\//i.test(source));
		const qrUrlCandidates = [...links, ...imageSources];
		const hasLentaKeyword = /лента/i.test(`${subject}\n${normalizedBody}`);
		const hasLegacyLentaReceiptLink = links.some((link) => /online\.lenta\.com|RenderDoc|ofd\.ru\/b\//i.test(link));
		const hasTaxcomReceiptLink = links.some((link) => /receipt\.taxcom\.ru/i.test(link));
		const hasLentaReceiptRedirectLink = links.some((link) =>
			/check\.lenta\.com|eco-check\.ru|prod\.upmetric\.ru\/receiptview|upmetric\.lenta\.com/i.test(link),
		);
		const hasTaxcomQrImageLink = qrUrlCandidates.some((link) =>
			/receipt\.taxcom\.ru|api-lk-ofd\.taxcom\.ru\/images\/qr|resize\.yandex\.net\/mailservice/i.test(link),
		);
		const hasQrServerImageLink = qrUrlCandidates.some((link) => /api\.qrserver\.com\/v1\/create-qr-code/i.test(link));
		const looksLikeBySender = /(?:^|\.)ofd\.ru$/i.test(senderDomain)
			|| /(?:^|\.)taxcom\.ru$/i.test(senderDomain)
			|| /(?:^|\.)lenta\.com$/i.test(senderDomain);
		const looksLikeLentaReceipt = looksLikeBySender
			&& (
				hasLentaKeyword
				|| hasLegacyLentaReceiptLink
				|| hasTaxcomReceiptLink
				|| hasTaxcomQrImageLink
				|| hasLentaReceiptRedirectLink
				|| hasQrServerImageLink
			);
		if (!looksLikeLentaReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Lenta receipt', {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				looksLikeBySender,
			});
		}

		const receiptFields = extractLentaReceiptFields(message, normalizedBody, qrUrlCandidates);
		const inlineReceiptImageUnit = buildInlineDataUrlReceiptUnit(
			message,
			dataUrlImages,
			'lenta-inline-qr-image',
			'lenta-inline-qr',
		);
		if (!receiptFields && inlineReceiptImageUnit) {
			return matchedParserAttempt(this.id, [inlineReceiptImageUnit], {
				stop: true,
				reason: 'Lenta inline QR image extracted from email HTML',
				diagnostics: {
					senderDomain,
					linkCount: links.length,
					linkSamples: sanitizeDebugSourceSamples(links),
					imageSourceCount: imageSources.length,
					imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
					dataUrlImageCount: dataUrlImages.length,
					dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
					hasLentaKeyword,
					hasLegacyLentaReceiptLink,
					hasTaxcomReceiptLink,
					hasTaxcomQrImageLink,
					hasLentaReceiptRedirectLink,
					hasQrServerImageLink,
					inlineReceiptFileName: inlineReceiptImageUnit.request.fileName,
					inlineReceiptMimeType: inlineReceiptImageUnit.request.mimeType,
					inlineReceiptByteLength: inlineReceiptImageUnit.request.bytes.byteLength,
				},
			});
		}
		if (!receiptFields) {
			const qrFields = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
			return noMatchParserAttempt(this.id, 'Lenta receipt signals were found, but fiscal fields were not extracted', {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				amount: extractReceiptAmount(normalizedBody),
				dateTime: extractReceiptDateTime(normalizedBody),
				operationType: extractReceiptOperationType(normalizedBody),
				fiscalFieldsFromQrUrl: qrFields ? buildRawReceiptQrPayload(qrFields) : null,
				qrUrlCandidateCount: qrUrlCandidates.length,
				qrUrlCandidateSamples: sanitizeDebugSourceSamples(qrUrlCandidates),
				hasFn: Boolean(matchFirst(normalizedBody, FISCAL_FN_PATTERNS)),
				hasFd: Boolean(matchFirst(normalizedBody, FISCAL_FD_PATTERNS)),
				hasFp: Boolean(matchFirst(normalizedBody, FISCAL_FP_PATTERNS)),
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('lenta-fiscal-receipt-fields', receiptFields)], {
			stop: true,
			reason: 'Lenta receipt fiscal fields extracted from email body',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				linkSamples: sanitizeDebugSourceSamples(links),
				imageSourceCount: imageSources.length,
				imageSourceSamples: sanitizeDebugSourceSamples(imageSources),
				dataUrlImageCount: dataUrlImages.length,
				dataUrlImageSamples: sanitizeDebugSourceSamples(dataUrlImages),
				hasLentaKeyword,
				hasLegacyLentaReceiptLink,
				hasTaxcomReceiptLink,
				hasTaxcomQrImageLink,
				hasLentaReceiptRedirectLink,
				hasQrServerImageLink,
				receiptFields,
			},
		});
	}
}

class YandexCheckReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'yandex-check-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => /check\.yandex\.ru/i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeByKeyword = /яндекс/i.test(normalizedBody) && /кассовый чек|ссылка на ваш чек/i.test(normalizedBody);
		const looksLikeYandexReceipt = receiptLinks.length > 0
			|| /check\.yandex\.ru/i.test(senderDomain)
			|| looksLikeByKeyword;
		if (!looksLikeYandexReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like a Yandex receipt', {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				looksLikeByKeyword,
			});
		}

		const receiptFields = extractFiscalReceiptFields(normalizedBody);
		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const merchant = extractReceiptMerchant(normalizedBody, from);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const units: PlannedEmailFinanceUnit[] = [];

		if (receiptFields) {
			units.push({
				kind: 'text',
				label: 'yandex-fiscal-receipt-fields',
				request: {
					text: buildRawReceiptQrPayload(receiptFields),
					intent: 'neutral',
					source: 'email',
				},
			});
		}

		units.push({
			kind: 'text',
			label: 'yandex-check-receipt-summary',
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Vendor parser: Yandex receipt email',
					'- Receipt provider: check.yandex.ru',
					merchant ? `- Detected merchant: ${merchant}` : '',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					receiptFields?.fn ? `- Fiscal FN: ${receiptFields.fn}` : '',
					receiptFields?.i ? `- Fiscal FD number: ${receiptFields.i}` : '',
					receiptFields?.fp ? `- Fiscal sign: ${receiptFields.fp}` : '',
					receiptFields?.n ? `- Fiscal operation type: ${mapOperationTypeToSummary(receiptFields.n)}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		});

		return matchedParserAttempt(this.id, units, {
			stop: false,
			reason: receiptFields
				? 'Yandex receipt detected with fiscal fields and AI fallback summary'
				: 'Yandex receipt detected with AI fallback summary only',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				hasReceiptFields: Boolean(receiptFields),
				amount,
				dateTime,
				merchant,
			},
		});
	}
}

class OzonReceiptEmailParser implements EmailFinanceMessageParser {
	readonly id = 'ozon-receipt';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => /ozon\.ru\/my\/e-check\//i.test(link));
		const senderDomain = extractSenderDomain(from);
		const looksLikeByKeyword = /ozon/i.test(normalizedBody) && /чек|e-check|receipt/i.test(normalizedBody);
		const looksLikeOzonReceipt = receiptLinks.length > 0
			|| /(?:^|\.)ozon\.ru$/i.test(senderDomain)
			|| /sender\.ozon\.ru/i.test(senderDomain)
			|| looksLikeByKeyword;
		if (!looksLikeOzonReceipt) {
			return noMatchParserAttempt(this.id, 'message does not look like an Ozon receipt', {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				looksLikeByKeyword,
			});
		}

		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const remotePdfLink = receiptLinks.find((link) => /ozon\.ru\/my\/e-check\/download\//i.test(link)) ?? null;
		const units: PlannedEmailFinanceUnit[] = [{
			kind: 'text',
			label: 'ozon-receipt-summary',
			remoteArtifactUrl: remotePdfLink ?? undefined,
			remoteArtifactFileName: remotePdfLink ? buildRemotePdfFileName(remotePdfLink, 'ozon-e-check') : undefined,
			remoteArtifactMimeType: remotePdfLink ? 'application/pdf' : undefined,
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Vendor parser: Ozon receipt email',
					'- Receipt provider: Ozon',
					'- Merchant: Ozon',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					'Parser hint: Ozon often sends an email that points to an electronic receipt page. Treat receipt links and receipt excerpt as finance evidence even when the full fiscal fields are not visible in the email body.',
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		}];

		return matchedParserAttempt(this.id, units, {
			stop: false,
			reason: remotePdfLink
				? 'Ozon receipt detected with remote PDF link'
				: 'Ozon receipt detected with summary only',
			diagnostics: {
				senderDomain,
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				remotePdfLinkPresent: Boolean(remotePdfLink),
				amount,
				dateTime,
			},
		});
	}
}

class ResolvedReceiptEvidenceEmailParser implements EmailFinanceMessageParser {
	readonly id = 'resolved-receipt-evidence';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return noMatchParserAttempt(this.id, 'normalized message body is empty');
		}

		const evidence = collectEmailFinanceEvidence(message, normalizedBody);
		const resolvedFiscalQrPayload = evidence.resolved.fiscalQrPayload.value;
		if (!resolvedFiscalQrPayload) {
			return noMatchParserAttempt(this.id, 'generic evidence layer did not resolve a canonical fiscal qr payload', {
				evidenceSummary: summarizeEmailFinanceEvidence(evidence),
			});
		}

		const receiptFields = extractFiscalReceiptFields(resolvedFiscalQrPayload);
		if (!receiptFields) {
			return noMatchParserAttempt(this.id, 'resolved fiscal evidence could not be converted back into receipt fields', {
				resolvedFiscalQrPayload,
				evidenceSummary: summarizeEmailFinanceEvidence(evidence),
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('resolved-fiscal-evidence', receiptFields)], {
			stop: true,
			reason: 'generic evidence layer resolved a canonical fiscal receipt payload',
			diagnostics: {
				resolvedFiscalQrPayload,
				evidenceSummary: summarizeEmailFinanceEvidence(evidence),
			},
		});
	}
}

class ReceiptLinkEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-link';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, message.subject ?? ''));
		if (receiptLinks.length === 0) {
			return noMatchParserAttempt(this.id, 'no receipt-like links found', {
				linkCount: links.length,
				receiptLinkCount: 0,
			});
		}

		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);
		const unit: PlannedEmailFinanceTextUnit = {
			kind: 'text',
			label: 'receipt-link',
			request: {
				text: [
					message.subject?.trim() ? `Subject: ${message.subject.trim()}` : '',
					message.from?.trim() ? `From: ${message.from.trim()}` : '',
					'Receipt links:',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `\nReceipt-related body excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			} as FinanceTextProposalRequest,
		};

		return matchedParserAttempt(this.id, [unit], {
			stop: false,
			reason: 'receipt-like links found in email content',
			diagnostics: {
				linkCount: links.length,
				receiptLinkCount: receiptLinks.length,
				focusedExcerptLength: focusedExcerpt.length,
			},
		});
	}
}

class FiscalReceiptFieldsEmailParser implements EmailFinanceMessageParser {
	readonly id = 'fiscal-receipt-fields';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return noMatchParserAttempt(this.id, 'normalized message body is empty');
		}

		const receiptFields = extractFiscalReceiptFields(normalizedBody);
		if (!receiptFields) {
			return noMatchParserAttempt(this.id, 'did not find a full set of fiscal receipt fields', {
				amount: extractReceiptAmount(normalizedBody),
				dateTime: extractReceiptDateTime(normalizedBody),
				operationType: extractReceiptOperationType(normalizedBody),
			});
		}

		const qrPayload = buildRawReceiptQrPayload(receiptFields);
		if (!qrPayload) {
			return noMatchParserAttempt(this.id, 'fiscal fields were found but qr payload could not be built', {
				receiptFields,
			});
		}

		return matchedParserAttempt(this.id, [buildFiscalReceiptUnit('fiscal-receipt-fields', receiptFields)], {
			stop: true,
			reason: 'generic fiscal receipt fields were extracted from email text',
			diagnostics: {
				receiptFields,
				qrPayload,
			},
		});
	}
}

class ReceiptSummaryEmailParser implements EmailFinanceMessageParser {
	readonly id = 'receipt-summary';

	parse(message: FinanceMailMessage): EmailFinanceParserAttempt {
		const normalizedBody = normalizeMessageText(message);
		if (!normalizedBody) {
			return noMatchParserAttempt(this.id, 'normalized message body is empty');
		}

		const subject = decodeEmailTransferText(message.subject?.trim() ?? '');
		const from = decodeEmailTransferText(message.from?.trim() ?? '');
		const links = extractMessageLinks(message, normalizedBody);
		const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, subject));
		const amount = extractReceiptAmount(normalizedBody);
		const dateTime = extractReceiptDateTime(normalizedBody);
		const merchant = extractReceiptMerchant(normalizedBody, from);
		const operationType = extractReceiptOperationType(normalizedBody);
		const focusedExcerpt = buildReceiptFocusedExcerpt(normalizedBody, receiptLinks);

		if (!looksLikeReceiptLikeMessage(subject, normalizedBody, {
			receiptLinks,
			amount,
			dateTime,
			merchant,
			focusedExcerpt,
		})) {
			return noMatchParserAttempt(this.id, 'message does not have enough receipt-like signals for summary fallback', {
				receiptLinkCount: receiptLinks.length,
				amount,
				dateTime,
				merchant,
				operationType,
				focusedExcerptLength: focusedExcerpt.length,
			});
		}

		const unit: PlannedEmailFinanceTextUnit = {
			kind: 'text',
			label: 'receipt-summary',
			request: {
				text: [
					subject ? `Subject: ${subject}` : '',
					from ? `From: ${from}` : '',
					'Email parser summary:',
					amount ? `- Detected amount: ${amount}` : '',
					dateTime ? `- Detected date/time: ${dateTime}` : '',
					merchant ? `- Detected merchant: ${merchant}` : '',
					operationType ? `- Detected fiscal operation type: ${mapOperationTypeToSummary(operationType)}` : '',
					receiptLinks.length > 0 ? 'Receipt links:' : '',
					...receiptLinks.map((link) => `- ${link}`),
					focusedExcerpt ? `Focused receipt excerpt:\n${focusedExcerpt}` : '',
				].filter(Boolean).join('\n'),
				intent: 'neutral',
				source: 'email',
			},
		};

		return matchedParserAttempt(this.id, [unit], {
			stop: false,
			reason: 'receipt-like message summary prepared for downstream extraction',
			diagnostics: {
				receiptLinkCount: receiptLinks.length,
				amount,
				dateTime,
				merchant,
				operationType,
				focusedExcerptLength: focusedExcerpt.length,
			},
		});
	}
}

interface ExtractedFiscalReceiptFields {
	dateTime: string;
	amount: string;
	fn: string;
	i: string;
	fp: string;
	n: '1' | '2' | '3' | '4';
}

interface PartialExtractedFiscalReceiptFields {
	dateTime?: string;
	amount?: string;
	fn?: string;
	i?: string;
	fp?: string;
	n?: '1' | '2' | '3' | '4';
}

export function buildRawReceiptQrPayload(fields: ExtractedFiscalReceiptFields): string {
	return `t=${fields.dateTime}&s=${fields.amount}&fn=${fields.fn}&i=${fields.i}&fp=${fields.fp}&n=${fields.n}`;
}

const FISCAL_FN_PATTERNS = [
	/серийный номер фн\s*[:=]?\s*(\d{10,})/i,
	/(?:^|[^a-zа-яё0-9])фн\s*[:=]?\s*(\d{10,})/iu,
	/\bfn\s*[=:]\s*(\d{10,})/i,
];

const FISCAL_FD_PATTERNS = [
	/(?:^|[^a-zа-яё0-9])фд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/iu,
	/номер фд(?: в смене)?\s*[:=]?\s*#?\s*(\d{1,})/i,
	/фискальный документ\s*#?\s*(\d{1,})/i,
	/\b(?:fd|i)\s*[=:]\s*(\d{1,})/i,
];

const FISCAL_FP_PATTERNS = [
	/(?:^|[^a-zа-яё0-9])фпд\s*[:=]?\s*(\d{6,})/iu,
	/(?:^|[^a-zа-яё0-9])фп\s*[:=]?\s*(\d{6,})/iu,
	/фискальный признак\s*[:=]?\s*(\d{6,})/i,
	/\bfp\s*[=:]\s*(\d{6,})/i,
];

export function extractFiscalReceiptFields(value: string): ExtractedFiscalReceiptFields | null {
	if (!value || typeof value !== 'string') {
		return null;
	}

	const normalized = toSearchablePlainText(value)
		.replace(/&nbsp;/gi, ' ')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, '\'');
	if (!normalized) {
		return null;
	}

	const fn = matchFirst(normalized, [
		...FISCAL_FN_PATTERNS,
	]);
	const documentNumber = matchFirst(normalized, [
		...FISCAL_FD_PATTERNS,
	]);
	const fiscalSign = matchFirst(normalized, [
		...FISCAL_FP_PATTERNS,
	]);
	const amount = extractReceiptAmount(normalized);
	const dateTime = extractReceiptDateTime(value);
	const operationType = extractReceiptOperationType(normalized);

	if (!fn || !documentNumber || !fiscalSign || !amount || !dateTime || !operationType) {
		return null;
	}

	return {
		dateTime,
		amount,
		fn,
		i: documentNumber,
		fp: fiscalSign,
		n: operationType,
	};
}

function collectEmailFinanceEvidence(
	message: FinanceMailMessage,
	precomputedNormalizedBody?: string,
	precomputedLinks?: string[],
	precomputedImageSources?: string[],
): EmailFinanceEvidenceCollection {
	const normalizedBody = precomputedNormalizedBody ?? normalizeMessageText(message);
	const from = decodeEmailTransferText(message.from?.trim() ?? '');
	const links = precomputedLinks ?? extractMessageLinks(message, normalizedBody);
	const imageSources = precomputedImageSources ?? extractMessageImageSources(message);
	const qrUrlCandidates = collectQrUrlCandidates(links, imageSources);

	const items: EmailFinanceEvidenceItem[] = [];

	const fiscalFieldsFromBody = extractFiscalReceiptFields(normalizedBody);
	if (fiscalFieldsFromBody) {
		items.push({
			kind: 'fiscal-qr-payload',
			value: buildRawReceiptQrPayload(fiscalFieldsFromBody),
			sourceId: 'body-fiscal-fields',
			confidence: 'high',
		});
	}

	const fiscalFieldsFromQrUrl = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
	if (fiscalFieldsFromQrUrl) {
		items.push({
			kind: 'fiscal-qr-payload',
			value: buildRawReceiptQrPayload(fiscalFieldsFromQrUrl),
			sourceId: 'qr-url-fiscal-fields',
			confidence: 'high',
		});
	}

	const amount = extractReceiptAmount(normalizedBody);
	if (amount) {
		items.push({
			kind: 'amount',
			value: amount,
			sourceId: 'body-amount',
			confidence: 'medium',
		});
	}

	const walletJsonAmount = extractWalletMailRuTotalPrice(message);
	if (walletJsonAmount) {
		items.push({
			kind: 'amount',
			value: walletJsonAmount,
			sourceId: 'wallet-mail-ru-json',
			confidence: 'medium',
		});
	}

	const dateTime = extractReceiptDateTime(normalizedBody);
	if (dateTime) {
		items.push({
			kind: 'date-time',
			value: dateTime,
			sourceId: 'body-date-time',
			confidence: 'medium',
		});
	}

	const merchant = extractReceiptMerchant(normalizedBody, from);
	if (merchant) {
		items.push({
			kind: 'merchant',
			value: merchant,
			sourceId: 'body-merchant',
			confidence: 'medium',
		});
	}

	const operationType = extractReceiptOperationType(normalizedBody);
	if (operationType) {
		items.push({
			kind: 'operation-type',
			value: operationType,
			sourceId: 'body-operation-type',
			confidence: 'medium',
		});
	}

	if (!fiscalFieldsFromQrUrl && amount && dateTime && operationType) {
		const partialFiscalFieldsFromQrUrl = extractPartialFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
		if (partialFiscalFieldsFromQrUrl?.fn && partialFiscalFieldsFromQrUrl.i && partialFiscalFieldsFromQrUrl.fp) {
			const combinedFiscalFields = extractFiscalReceiptFields(
				buildRawReceiptQrPayload({
					dateTime,
					amount,
					fn: partialFiscalFieldsFromQrUrl.fn,
					i: partialFiscalFieldsFromQrUrl.i,
					fp: partialFiscalFieldsFromQrUrl.fp,
					n: operationType,
				}),
			);

			if (combinedFiscalFields) {
				items.push({
					kind: 'fiscal-qr-payload',
					value: buildRawReceiptQrPayload(combinedFiscalFields),
					sourceId: 'combined-link-and-body-fiscal-fields',
					confidence: 'high',
				});
			}
		}
	}

	const receiptLinks = links.filter((link) => looksLikeReceiptLink(link, normalizedBody, message.subject ?? ''));
	for (const link of receiptLinks.slice(0, 12)) {
		items.push({
			kind: /(?:\.pdf\b|format=pdf\b)/i.test(link) ? 'remote-artifact-link' : 'receipt-link',
			value: link,
			sourceId: 'receipt-link',
			confidence: 'low',
		});
	}

	for (const source of imageSources.slice(0, 12)) {
		items.push({
			kind: 'image-source',
			value: sanitizeDebugSource(source),
			sourceId: /^data:image\//i.test(source) ? 'inline-image-source' : 'html-image-source',
			confidence: /^data:image\//i.test(source) ? 'medium' : 'low',
		});
	}

	return {
		items,
		resolved: {
			fiscalQrPayload: resolveEvidenceValue(items, 'fiscal-qr-payload'),
			amount: resolveEvidenceValue(items, 'amount'),
			dateTime: resolveEvidenceValue(items, 'date-time'),
			merchant: resolveEvidenceValue(items, 'merchant'),
			operationType: resolveEvidenceValue(items, 'operation-type'),
		},
	};
}

function summarizeEmailFinanceEvidence(evidence: EmailFinanceEvidenceCollection): EmailFinanceEvidenceSummary {
	return {
		totalEvidenceCount: evidence.items.length,
		fiscalQrCandidateCount: evidence.resolved.fiscalQrPayload.candidates.length,
		resolvedFiscalQrPayload: evidence.resolved.fiscalQrPayload.value,
		conflictingFiscalQrPayloads: evidence.resolved.fiscalQrPayload.conflictingValues,
		amountCandidates: evidence.resolved.amount.candidates,
		dateTimeCandidates: evidence.resolved.dateTime.candidates,
	};
}

function resolveEvidenceValue(
	items: EmailFinanceEvidenceItem[],
	kind: EmailFinanceEvidenceKind,
): EmailFinanceResolvedEvidenceValue {
	const filtered = items.filter((item) => item.kind === kind && item.value.trim().length > 0);
	if (filtered.length === 0) {
		return {
			value: null,
			candidates: [],
			conflictingValues: [],
		};
	}

	const grouped = new Map<string, EmailFinanceEvidenceItem[]>();
	for (const item of filtered) {
		const existing = grouped.get(item.value) ?? [];
		existing.push(item);
		grouped.set(item.value, existing);
	}

	const ranked = Array.from(grouped.entries())
		.map(([value, groupedItems]) => ({
			value,
			groupedItems,
			maxConfidence: Math.max(...groupedItems.map((item) => evidenceConfidenceWeight(item.confidence))),
			supportCount: groupedItems.length,
		}))
		.sort((left, right) => {
			if (right.maxConfidence !== left.maxConfidence) {
				return right.maxConfidence - left.maxConfidence;
			}
			return right.supportCount - left.supportCount;
		});

	const winner = ranked[0];
	const conflictingValues = ranked
		.filter((candidate) => candidate.value !== winner.value && candidate.maxConfidence >= winner.maxConfidence)
		.map((candidate) => candidate.value);

	return {
		value: conflictingValues.length > 0 ? null : winner.value,
		candidates: ranked.map((candidate) => candidate.value),
		conflictingValues,
	};
}

function evidenceConfidenceWeight(value: EmailFinanceEvidenceConfidence): number {
	switch (value) {
		case 'high':
			return 3;
		case 'medium':
			return 2;
		case 'low':
		default:
			return 1;
	}
}

function extractWalletMailRuTotalPrice(message: FinanceMailMessage): string | null {
	const htmlParts = [
		message.htmlBody ?? '',
		message.htmlBodyPreview ?? '',
	];

	for (const html of htmlParts) {
		const decoded = decodeMessagePart(html);
		if (!decoded) {
			continue;
		}

		const matched = decoded.match(/"total"\s*:\s*\{[^}]*"price"\s*:\s*"([0-9]+(?:\.[0-9]{1,2})?)"/i)?.[1];
		if (!matched) {
			continue;
		}

		const parsed = Number(matched);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed.toFixed(2);
		}
	}

	return null;
}

function looksLikeReceiptLink(link: string, body: string, subject: string): boolean {
	const normalizedLink = link.toLowerCase();
	const normalizedContext = `${subject}\n${body}`.toLowerCase();
	const hasReceiptKeyword = /чек|кассов|квитан|receipt|e-check|echeck|order receipt/.test(normalizedContext);
	return (
		/check\.yandex\.ru/.test(normalizedLink)
		|| /ozon\.ru\/my\/e-check\//.test(normalizedLink)
		|| /\/(?:receipt|e-check|echeck|check|cheque)\b/.test(normalizedLink)
		|| (hasReceiptKeyword && /ofd|receipt|check|cheque|kkt|taxcom|platformaofd/.test(normalizedLink))
	);
}

function looksLikeReceiptLikeMessage(
	subject: string,
	body: string,
	signals: {
		receiptLinks: string[];
		amount: string | null;
		dateTime: string | null;
		merchant: string | null;
		focusedExcerpt: string;
	},
): boolean {
	const normalizedContext = `${subject}\n${body}`.toLowerCase();
	const hasReceiptKeyword = /чек|кассов|квитан|оплат|платеж|покупк|заказ|списани|receipt|payment|paid|order|invoice|total/.test(normalizedContext);
	const detectedSignalCount = [
		signals.receiptLinks.length > 0,
		Boolean(signals.amount),
		Boolean(signals.dateTime),
		Boolean(signals.merchant),
		signals.focusedExcerpt.trim().length > 80,
	].filter(Boolean).length;
	return hasReceiptKeyword && detectedSignalCount >= 2;
}

function buildReceiptFocusedExcerpt(value: string, links: string[]): string {
	const withoutHtml = toSearchablePlainText(value);
	if (!withoutHtml) {
		return '';
	}

	const interesting = withoutHtml
		.split(/(?<=[.!?])\s+/)
		.filter((chunk) => {
			const normalized = chunk.toLowerCase();
			return /чек|кассов|квитан|итого|сумм|оплат|товар|заказ|receipt|total|amount|order/.test(normalized)
				|| links.some((link) => normalized.includes(link.toLowerCase()));
		})
		.join('\n');

	const result = interesting || withoutHtml.slice(0, 1800);
	return result.slice(0, 1800);
}

function extractReceiptAmount(value: string): string | null {
	const searchable = toSearchablePlainText(value);
	const candidates = [
		/итого\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/итог\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сколько\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/безналичными\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сумма\s+расч[её]та\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сумма\s+заказа\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/сумма\s+оплат[ыы]\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
		/(?:сумма(?:\s+к\s+оплате)?|к\s+оплате|оплачено|total|amount)\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/i,
	];
	for (const pattern of candidates) {
		const matched = searchable.match(pattern)?.[1];
		if (!matched) {
			continue;
		}

		const normalized = matched.replace(/[\s\u00A0]+/g, '').replace(',', '.');
		const parsed = Number(normalized);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed.toFixed(2);
		}
	}

	const qrAmountMatch = searchable.match(/\bs\s*[=:]\s*([0-9]+(?:[.,][0-9]{1,2})?)\b/i)?.[1];
	if (qrAmountMatch && /\b(?:fn|fp|fd|i|n)\s*[=:]/i.test(searchable)) {
		const normalized = qrAmountMatch.replace(',', '.');
		const parsed = Number(normalized);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed.toFixed(2);
		}
	}

	return null;
}

function extractMagnitReceiptAmount(value: string): string | null {
	const searchable = toSearchablePlainText(value);

	const patterns = [
		/итого\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/giu,
		/безналичными\s*[:=]?\s*([0-9][0-9\s\u00A0]*(?:[.,][0-9]{1,2})?)/giu,
	];

	for (const pattern of patterns) {
		const matches = Array.from(searchable.matchAll(pattern));
		for (let index = matches.length - 1; index >= 0; index -= 1) {
			const matched = matches[index]?.[1];
			if (!matched) {
				continue;
			}

			const normalized = matched.replace(/[\s\u00A0]+/g, '').replace(',', '.');
			const parsed = Number(normalized);
			if (Number.isFinite(parsed) && parsed > 0) {
				return parsed.toFixed(2);
			}
		}
	}

	return null;
}

function extractReceiptDateTime(value: string): string | null {
	const rawValueDate = extractReceiptDateTimeFromRawValue(value);
	if (rawValueDate) {
		return rawValueDate;
	}

	const searchable = toSearchablePlainText(value);
	const explicitQrDate = searchable.match(/\bt\s*[=:]\s*(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(?:\d{2})?\b/i);
	if (explicitQrDate) {
		const [, year, month, day, hour, minute] = explicitQrDate;
		return buildReceiptDateTimeValue(year, month, day, hour, minute);
	}

	const russianDate = searchable.match(/(?:когда|дата(?:\s+операции|\s+покупки|\s+чека|\s+выдачи)?|время(?:\s+операции|\s+покупки)?)\s*[:=]?\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г\.?)?(?:[\s,]+(?:в)?\s*(\d{2}):(\d{2})(?::\d{2})?)?/i);
	if (russianDate) {
		const [, day, monthName, year, hour, minute] = russianDate;
		const month = mapRussianMonth(monthName);
		if (month && hour && minute) {
			return buildReceiptDateTimeValue(year, month, day, hour, minute);
		}
	}

	const issuedRussianDate = searchable.match(/(?:дата\s+выдачи|дата)\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*(?:г\.?)?\s*(?:[, ]+в)?\s*(\d{2}):(\d{2})(?::\d{2})?/i);
	if (issuedRussianDate) {
		const [, day, monthName, year, hour, minute] = issuedRussianDate;
		const month = mapRussianMonth(monthName);
		if (month) {
			return buildReceiptDateTimeValue(year, month, day, hour, minute);
		}
	}

	const splitLabeledDate = searchable.match(/дата(?:\s+операции|\s+покупки|\s+чека|\s+выдачи)?\s*[:=]?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s*(?:[,;|]|время(?:\s+операции|\s+покупки)?\s*[:=]?)\s*|\s+)(\d{2}):(\d{2})(?::\d{2})?/i);
	if (splitLabeledDate) {
		const [, day, month, year, hour, minute] = splitLabeledDate;
		return buildReceiptDateTimeValue(
			year.length === 2 ? normalizeTwoDigitYear(year) : year,
			pad2(month),
			pad2(day),
			hour,
			minute,
		);
	}

	const dottedDate = searchable.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s*(?:[,;|]|в|время)\s*|\s+)(\d{2}):(\d{2})(?::\d{2})?\b/i);
	if (dottedDate) {
		const [, day, month, year, hour, minute] = dottedDate;
		return buildReceiptDateTimeValue(year, pad2(month), pad2(day), hour, minute);
	}

	const shortDottedDate = searchable.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2})(?:\s*(?:[,;|]|в|время)\s*|\s+)(\d{2}):(\d{2})(?::\d{2})?\b/i);
	if (shortDottedDate) {
		const [, day, month, year, hour, minute] = shortDottedDate;
		return buildReceiptDateTimeValue(normalizeTwoDigitYear(year), pad2(month), pad2(day), hour, minute);
	}

	const isoLikeDate = searchable.match(/\b(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/i);
	if (isoLikeDate) {
		const [, year, month, day, hour, minute] = isoLikeDate;
		return buildReceiptDateTimeValue(year, month, day, hour, minute);
	}

	return null;
}

function extractReceiptDateTimeFromRawValue(value: string): string | null {
	if (!value || typeof value !== 'string') {
		return null;
	}

	const patterns = [
		/<time\b[^>]*datetime=["']([^"']+)["']/i,
		/\b(?:datetime|date-time|date_time|transaction(?:Date|Time)?|operation(?:Date|Time)?|payment(?:Date|Time)?|purchase(?:Date|Time)?|receipt(?:Date|Time)?|postedAt|createdAt|occurredAt)\b[\s"'=:>]+(\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)/i,
	];
	for (const pattern of patterns) {
		const matched = value.match(pattern)?.[1];
		if (!matched) {
			continue;
		}

		const normalized = normalizeIsoLikeReceiptDateTimeCandidate(matched);
		if (normalized) {
			return normalized;
		}
	}

	return null;
}

function normalizeIsoLikeReceiptDateTimeCandidate(value: string): string | null {
	const matched = value.match(/(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/i);
	if (!matched) {
		return null;
	}

	const [, year, month, day, hour, minute] = matched;
	return buildReceiptDateTimeValue(year, month, day, hour, minute);
}

function extractReceiptMerchant(value: string, from: string): string | null {
	const normalized = toSearchablePlainText(value);
	const candidates = [
		normalized.match(/кассовый чек\s*\/\s*(?:приход|расход)\s+(.+?)(?=\s+(?:когда|дата|время|сумма|сколько|товары|итого|безналичными|инн|адрес|место|налогообложение)\b|$)/i)?.[1],
		normalized.match(/(?:продавец|поставщик|merchant|seller|получатель)\s*[:=]?\s*(.+?)(?=\s+(?:инн|кпп|итого|сумма|дата|время|чек|квитанц)\b|$)/i)?.[1],
		normalized.match(/\b((?:ооо|оао|зао|пао|ao|llc|ип)\s+[«"']?[^«"']{2,80}?[»"']?)(?=\s+(?:инн|кпп|итого|сумма|дата|время|чек|квитанц)\b|$)/i)?.[1],
	];
	for (const candidate of candidates) {
		const cleaned = cleanupMerchant(candidate);
		if (cleaned) {
			return cleaned;
		}
	}

	if (from) {
		const emailMatch = from.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1];
		if (emailMatch) {
			const domain = emailMatch.split('@')[1] ?? '';
			const host = domain.split('.').slice(0, -1).join('.');
			const cleanedHost = host.replace(/[-_]+/g, ' ').trim();
			if (cleanedHost && !/noreply|no reply|support|mail|robot|notify/i.test(cleanedHost)) {
				return cleanedHost;
			}
		}
	}

	return null;
}

function extractReceiptOperationType(value: string): '1' | '2' | '3' | '4' | null {
	const searchable = toSearchablePlainText(value);
	const explicitOperationType = searchable.match(/\bn\s*[=:]\s*([1-4])\b/i)?.[1] as '1' | '2' | '3' | '4' | undefined;
	if (explicitOperationType) {
		return explicitOperationType;
	}

	if (/(^|[^a-zа-яё])возврат\s+прихода($|[^a-zа-яё])/iu.test(searchable)) {
		return '2';
	}

	if (/(^|[^a-zа-яё])возврат\s+расхода($|[^a-zа-яё])/iu.test(searchable)) {
		return '4';
	}

	if (/кассовый чек\s*\/\s*расход/i.test(searchable) || /(^|[^a-zа-яё])расход($|[^a-zа-яё])/iu.test(searchable)) {
		return '3';
	}

	if (/кассовый чек\s*\/\s*приход/i.test(searchable) || /(^|[^a-zа-яё])приход($|[^a-zа-яё])/iu.test(searchable)) {
		return '1';
	}
	return null;
}

function mapOperationTypeToSummary(value: '1' | '2' | '3' | '4'): string {
	switch (value) {
		case '1':
			return 'sale / incoming receipt';
		case '2':
			return 'sale return';
		case '3':
			return 'expense / outgoing receipt';
		case '4':
			return 'expense return';
		default:
			return value;
	}
}

function matchFirst(value: string, patterns: RegExp[]): string | null {
	for (const pattern of patterns) {
		const matched = value.match(pattern)?.[1]?.trim();
		if (matched) {
			return matched;
		}
	}
	return null;
}

function buildFiscalReceiptUnit(
	label: string,
	fields: ExtractedFiscalReceiptFields,
): PlannedEmailFinanceTextUnit {
	return {
		kind: 'text',
		label,
		request: ({
			text: buildRawReceiptQrPayload(fields),
			intent: 'neutral',
			source: 'email',
		} as FinanceTextProposalRequest),
	};
}

function buildInlineDataUrlReceiptUnit(
	message: FinanceMailMessage,
	dataUrlImages: string[],
	label: string,
	fileBaseName: string,
): PlannedEmailFinanceReceiptUnit | null {
	const bestDataUrlImage = pickBestInlineDataUrlImage(dataUrlImages);
	if (!bestDataUrlImage) {
		return null;
	}

	const parsed = parseImageDataUrl(bestDataUrlImage);
	if (!parsed) {
		return null;
	}

	return {
		kind: 'receipt',
		label,
		request: ({
			bytes: parsed.bytes,
			fileName: `${fileBaseName}.${parsed.extension}`,
			mimeType: parsed.mimeType,
			caption: buildInlineReceiptCaption(message, parsed.mimeType),
			intent: 'neutral',
			source: 'email',
		} as FinanceReceiptProposalRequest),
	};
}

function buildInlineReceiptCaption(message: FinanceMailMessage, mimeType: string): string {
	const subject = message.subject?.trim() ?? '';
	const from = message.from?.trim() ?? '';
	return [
		subject,
		from ? `From: ${from}` : '',
		`Inline receipt QR image extracted from email HTML (${mimeType})`,
	].filter(Boolean).join(' | ');
}

function pickBestInlineDataUrlImage(dataUrlImages: string[]): string | null {
	if (dataUrlImages.length === 0) {
		return null;
	}

	return dataUrlImages
		.slice()
		.sort((left, right) => estimateDataUrlPayloadLength(right) - estimateDataUrlPayloadLength(left))[0] ?? null;
}

function estimateDataUrlPayloadLength(dataUrl: string): number {
	return dataUrl.match(/base64,([\s\S]+)$/i)?.[1]?.length ?? 0;
}

function parseImageDataUrl(dataUrl: string): { mimeType: string; extension: string; bytes: ArrayBuffer } | null {
	const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
	if (!match) {
		return null;
	}

	const [, mimeType, base64Payload] = match;
	const cleanedBase64 = base64Payload.replace(/\s+/g, '');
	if (!cleanedBase64) {
		return null;
	}

	const binary = atob(cleanedBase64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return {
		mimeType: mimeType.toLowerCase(),
		extension: extensionFromMimeType(mimeType),
		bytes: bytes.buffer,
	};
}

function extensionFromMimeType(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case 'image/jpeg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		case 'image/gif':
			return 'gif';
		case 'image/bmp':
			return 'bmp';
		default:
			return 'png';
	}
}

function pad2(value: string): string {
	return value.padStart(2, '0');
}

function buildReceiptDateTimeValue(
	year: string,
	month: string,
	day: string,
	hour: string,
	minute: string,
): string | null {
	const parsed = new Date(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		0,
		0,
	);
	if (
		Number.isNaN(parsed.getTime())
		|| parsed.getFullYear() !== Number(year)
		|| parsed.getMonth() !== Number(month) - 1
		|| parsed.getDate() !== Number(day)
		|| parsed.getHours() !== Number(hour)
		|| parsed.getMinutes() !== Number(minute)
	) {
		return null;
	}

	return `${year}${month}${day}T${hour}${minute}`;
}

function normalizeTwoDigitYear(value: string): string {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return `20${value}`;
	}
	return parsed >= 70 ? `19${value}` : `20${value}`;
}

function cleanupMerchant(value: string | undefined): string | null {
	if (!value) {
		return null;
	}

	const cleaned = value
		.replace(/\s+/g, ' ')
		.replace(/^[\s"'«»]+|[\s"'«».,:;()\-]+$/g, '')
		.trim();
	if (!cleaned || cleaned.length < 2 || cleaned.length > 120) {
		return null;
	}

	if (/^(когда|дата|время|сумма|сколько|товары|итого|безналичными|инн|адрес|место)$/i.test(cleaned)) {
		return null;
	}

	return cleaned;
}

function extractSenderDomain(from: string): string {
	const emailMatch = from.match(/<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i)?.[1];
	return emailMatch?.split('@')[1]?.toLowerCase() ?? '';
}

function extractMagnitReceiptFieldsFromLink(link: string | null): { fn: string; fd: string; fp: string } | null {
	if (!link) {
		return null;
	}

	try {
		const url = new URL(link);
		const fn = url.searchParams.get('fn')?.trim() ?? '';
		const fd = url.searchParams.get('fd')?.trim() ?? '';
		const fp = (url.searchParams.get('fs') ?? url.searchParams.get('fp') ?? '').trim();
		if (!fn || !fd || !fp) {
			return null;
		}

		return { fn, fd, fp };
	} catch {
		return null;
	}
}

function extractMagnitReceiptFields(
	message: FinanceMailMessage,
	normalizedBody: string,
	links: string[],
): { fn: string; fd: string; fp: string } | null {
	const directLink = links.find((link) => /lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul/i.test(link)) ?? null;
	const fromLink = extractMagnitReceiptFieldsFromLink(directLink);
	if (fromLink) {
		return fromLink;
	}

	const rawCandidates = [
		normalizedBody,
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
	]
		.filter(Boolean)
		.map((value) => value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ''));

	for (const candidate of rawCandidates) {
		const magnitLinkMatch = candidate.match(/https?:\/\/lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul\?[^\s"'<>]+/i)?.[0]
			?? candidate.match(/lk\.ofd-magnit\.ru\/CheckWebApp\/pdf\.zul\?[^\s"'<>]+/i)?.[0];
		if (magnitLinkMatch) {
			const normalizedLink = normalizeExtractedLink(
				magnitLinkMatch.startsWith('http') ? magnitLinkMatch : `https://${magnitLinkMatch}`,
			);
			const extracted = extractMagnitReceiptFieldsFromLink(normalizedLink);
			if (extracted) {
				return extracted;
			}
		}

		const queryMatch = candidate.match(/(?:\?|&)fn=(\d{10,})(?:&|$).*?(?:\?|&)(?:fs|fp)=(\d{6,})(?:&|$).*?(?:\?|&)fd=(\d{1,})(?:&|$)/i)
			?? candidate.match(/(?:\?|&)fd=(\d{1,})(?:&|$).*?(?:\?|&)fn=(\d{10,})(?:&|$).*?(?:\?|&)(?:fs|fp)=(\d{6,})(?:&|$)/i);
		if (queryMatch) {
			if (queryMatch.length === 4) {
				const [, first, second, third] = queryMatch;
				if (candidate.includes(`fn=${first}`)) {
					return { fn: first, fp: second, fd: third };
				}
				return { fd: first, fn: second, fp: third };
			}
		}
	}

	return null;
}

function extractLentaReceiptFields(
	message: FinanceMailMessage,
	normalizedBody: string,
	qrUrlCandidates: string[],
): ExtractedFiscalReceiptFields | null {
	const fromQrUrl = extractFiscalReceiptFieldsFromQrUrlCandidates(qrUrlCandidates);
	if (fromQrUrl) {
		return fromQrUrl;
	}

	const rawCandidates = [
		normalizedBody,
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
	];
	for (const candidate of rawCandidates) {
		const extracted = extractFiscalReceiptFieldsFromQrUrlCandidates(extractCandidateLinks(candidate));
		if (extracted) {
			return extracted;
		}
	}

	return extractFiscalReceiptFields(normalizedBody);
}

function buildRemotePdfFileName(link: string, fallbackBaseName: string): string {
	try {
		const url = new URL(link);
		const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
		if (!lastSegment) {
			return `${fallbackBaseName}.pdf`;
		}
		return lastSegment.toLowerCase().endsWith('.pdf') ? lastSegment : `${lastSegment}.pdf`;
	} catch {
		return `${fallbackBaseName}.pdf`;
	}
}

function normalizeMessageText(message: FinanceMailMessage): string {
	return [
		decodeMessagePart(message.subject?.trim() ?? ''),
		decodeMessagePart(message.textBody?.trim() ?? ''),
		decodeMessagePart(message.htmlBody?.trim() ?? ''),
		decodeMessagePart(message.textBodyPreview?.trim() ?? ''),
		decodeMessagePart(message.htmlBodyPreview?.trim() ?? ''),
	].filter(Boolean).join('\n\n');
}

function decodeMessagePart(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		decodeEmailTransferText(value)
			.replace(/href\s*=\s*3D/gi, 'href=')
			.replace(/\s+3D(?=["'])/gi, '='),
	);
}

function extractMessageLinks(message: FinanceMailMessage, normalizedBody: string): string[] {
	const parts = [
		normalizedBody,
		decodeMessagePart(message.textBody ?? ''),
		decodeMessagePart(message.htmlBody ?? ''),
		decodeMessagePart(message.textBodyPreview ?? ''),
		decodeMessagePart(message.htmlBodyPreview ?? ''),
	];

	const links = new Set<string>();
	for (const part of parts) {
		for (const link of extractCandidateLinks(part)) {
			links.add(link);
		}
	}

	const htmlParts = [
		prepareHtmlForAttributeExtraction(message.htmlBody ?? ''),
		prepareHtmlForAttributeExtraction(message.htmlBodyPreview ?? ''),
	];
	for (const html of htmlParts) {
		for (const link of extractHtmlHrefLinks(html)) {
			links.add(link);
		}
	}

	return Array.from(links);
}

function extractMessageImageSources(message: FinanceMailMessage): string[] {
	const htmlParts = [
		prepareHtmlForAttributeExtraction(message.htmlBody ?? ''),
		prepareHtmlForAttributeExtraction(message.htmlBodyPreview ?? ''),
	];

	const imageSources = new Set<string>();
	for (const html of htmlParts) {
		for (const source of extractHtmlImageSourceLinks(html)) {
			imageSources.add(source);
		}
	}

	return Array.from(imageSources);
}

function extractCandidateLinks(value: string): string[] {
	const decoded = decodeMessagePart(value);
	const matches = decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedLink(match[0]))
			.filter((link): link is string => Boolean(link)),
	));
}

function extractHtmlHrefLinks(value: string): string[] {
	if (!value) {
		return [];
	}

	const matches = value.matchAll(/href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedLink(match[1] ?? match[2] ?? match[3] ?? ''))
			.filter((link): link is string => Boolean(link)),
	));
}

function extractHtmlImageSourceLinks(value: string): string[] {
	if (!value) {
		return [];
	}

	const matches = value.matchAll(/src\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
	return Array.from(new Set(
		Array.from(matches, (match) => normalizeExtractedSource(match[1] ?? match[2] ?? match[3] ?? ''))
			.filter((source): source is string => Boolean(source)),
	));
}

function normalizeExtractedLink(value: string): string | null {
	if (!value) {
		return null;
	}

	const normalized = decodeUrlLikeValue(value)
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.replace(/\s+/g, '')
		.replace(/[>"']+$/g, '')
		.trim();
	if (!/^https?:\/\//i.test(normalized)) {
		return null;
	}

	return normalized;
}

function normalizeExtractedSource(value: string): string | null {
	if (!value) {
		return null;
	}

	const normalized = decodeUrlLikeValue(value)
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.replace(/\s+/g, '')
		.replace(/[>"']+$/g, '')
		.trim();
	if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized)) {
		return normalized;
	}

	return null;
}

function sanitizeDebugSourceSamples(values: string[], maxItems = 5): string[] {
	return values.slice(0, maxItems).map((value) => sanitizeDebugSource(value));
}

function sanitizeDebugSource(value: string): string {
	if (!value) {
		return '';
	}
	if (!/^data:image\//i.test(value)) {
		return value;
	}

	const mimeType = value.match(/^data:(image\/[a-z0-9.+-]+);/i)?.[1] ?? 'image/unknown';
	const base64Length = value.match(/base64,([\s\S]+)$/i)?.[1]?.length ?? 0;
	return `data:${mimeType};base64,<omitted;length=${base64Length}>`;
}

function collectQrUrlCandidates(links: string[], imageSources: string[]): string[] {
	return [...links, ...imageSources].filter((candidate) => looksLikeQrUrlCandidate(candidate));
}

function looksLikeQrUrlCandidate(value: string): boolean {
	const normalized = normalizeExtractedSource(value) ?? normalizeExtractedLink(value);
	if (!normalized) {
		return false;
	}

	if (/api-lk-ofd\.taxcom\.ru\/images\/qr|resize\.yandex\.net\/mailservice|check\.yandex\.ru|receipt\.taxcom\.ru|lk\.ofd-magnit\.ru|api\.qrserver\.com\/v1\/create-qr-code|check\.lenta\.com|eco-check\.ru|prod\.upmetric\.ru\/receiptview|upmetric\.lenta\.com/i.test(normalized)) {
		return true;
	}

	if (/[?&](?:t|s|fn|fp|i|n)=/i.test(normalized)) {
		return true;
	}

	if (/[?&](?:q|data|code)=/i.test(normalized) && /(?:t%3[dD]|s%3[dD]|fn%3[dD]|fp%3[dD]|i%3[dD]|n%3[dD]|t=|s=|fn=|fp=|i=|n=)/i.test(normalized)) {
		return true;
	}

	if (/\/(?:fn|fd|fp|fs|i|qrcode)\//i.test(normalized) || /\/CashReceipt\/View\//i.test(normalized)) {
		return true;
	}

	return false;
}

function prepareHtmlForAttributeExtraction(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		value
			.replace(/\r\n/g, '\n')
			.replace(/=\n/g, '')
			.replace(/href\s*=\s*3D/gi, 'href=')
			.replace(/src\s*=\s*3D/gi, 'src=')
			.replace(/\s+3D(?=["'])/gi, '='),
	);
}

function decodeUrlLikeValue(value: string): string {
	if (!value) {
		return '';
	}

	return decodeCommonHtmlEntities(
		value
			.replace(/\r\n/g, '\n')
			.replace(/=\n/g, '')
			.replace(/=3D/gi, '=')
			.replace(/=26/gi, '&')
			.replace(/=3A/gi, ':')
			.replace(/=2F/gi, '/')
			.replace(/=3F/gi, '?')
			.replace(/=25/gi, '%')
			.replace(/=23/gi, '#')
			.replace(/=2B/gi, '+'),
	);
}

function extractFiscalReceiptFieldsFromQrUrlCandidates(values: string[]): ExtractedFiscalReceiptFields | null {
	for (const value of values) {
		const extracted = extractFiscalReceiptFieldsFromQrUrlCandidate(value);
		if (extracted) {
			return extracted;
		}
	}
	return null;
}

function extractFiscalReceiptFieldsFromQrUrlCandidate(value: string): ExtractedFiscalReceiptFields | null {
	const normalized = normalizeExtractedLink(value);
	if (!normalized) {
		return null;
	}

	const repairedNormalized = repairCorruptedQrUrlCandidate(normalized);
	const candidates = new Set<string>([repairedNormalized]);
	try {
		const url = new URL(repairedNormalized);
		const nestedUrl = url.searchParams.get('url');
		if (nestedUrl) {
			candidates.add(decodeRepeatedUrlComponent(nestedUrl));
		}
	} catch {
		// ignore malformed nested URLs and continue with the raw candidate
	}

	for (const candidate of candidates) {
		const extracted = extractFiscalReceiptFieldsFromResolvedQrUrl(candidate);
		if (extracted) {
			return extracted;
		}
	}

	return null;
}

function extractPartialFiscalReceiptFieldsFromQrUrlCandidates(values: string[]): PartialExtractedFiscalReceiptFields | null {
	for (const value of values) {
		const extracted = extractPartialFiscalReceiptFieldsFromQrUrlCandidate(value);
		if (extracted?.fn && extracted.i && extracted.fp) {
			return extracted;
		}
	}

	return null;
}

function extractPartialFiscalReceiptFieldsFromQrUrlCandidate(value: string): PartialExtractedFiscalReceiptFields | null {
	const normalized = normalizeExtractedLink(value);
	if (!normalized) {
		return null;
	}

	const repairedNormalized = repairCorruptedQrUrlCandidate(normalized);

	try {
		const url = new URL(repairedNormalized);
		return extractPartialFiscalReceiptFieldsFromResolvedQrUrl(url);
	} catch {
		return null;
	}
}

function extractFiscalReceiptFieldsFromResolvedQrUrl(value: string): ExtractedFiscalReceiptFields | null {
	try {
		const url = new URL(repairCorruptedQrUrlCandidate(value));
		const directParams = extractFiscalReceiptFieldsFromDirectUrlParams(url);
		if (directParams) {
			return directParams;
		}

		const payload = url.searchParams.get('code') ?? url.searchParams.get('data') ?? url.searchParams.get('q');
		if (!payload) {
			return null;
		}

		const decodedPayload = decodeRepeatedUrlComponent(payload);
		for (const candidate of buildQrPayloadCandidates(decodedPayload)) {
			const extracted = extractFiscalReceiptFields(candidate);
			if (extracted) {
				return extracted;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function extractPartialFiscalReceiptFieldsFromResolvedQrUrl(url: URL): PartialExtractedFiscalReceiptFields | null {
	const directParams = extractPartialFiscalReceiptFieldsFromDirectUrlParams(url);
	if (directParams?.fn && directParams.i && directParams.fp) {
		return directParams;
	}

	const pathFields = extractPartialFiscalReceiptFieldsFromUrlPath(url);
	if (pathFields?.fn && pathFields.i && pathFields.fp) {
		return pathFields;
	}

	const payload = url.searchParams.get('code') ?? url.searchParams.get('data') ?? url.searchParams.get('q');
	if (!payload) {
		return directParams ?? pathFields ?? null;
	}

	const decodedPayload = decodeRepeatedUrlComponent(payload);
	for (const candidate of buildQrPayloadCandidates(decodedPayload)) {
		const extracted = extractFiscalReceiptFields(candidate);
		if (extracted) {
			return extracted;
		}
	}

	return directParams ?? pathFields ?? null;
}

function extractFiscalReceiptFieldsFromDirectUrlParams(url: URL): ExtractedFiscalReceiptFields | null {
	const partial = extractPartialFiscalReceiptFieldsFromDirectUrlParams(url);
	const t = partial?.dateTime?.trim() ?? '';
	const s = partial?.amount?.trim() ?? '';
	const fn = partial?.fn?.trim() ?? '';
	const i = partial?.i?.trim() ?? '';
	const fp = partial?.fp?.trim() ?? '';
	const n = partial?.n?.trim() ?? '';

	if (!t || !s || !fn || !i || !fp || !/^[1-4]$/.test(n)) {
		return null;
	}

	return extractFiscalReceiptFields(
		buildRawReceiptQrPayload({
			dateTime: t,
			amount: s.replace(',', '.'),
			fn,
			i,
			fp,
			n: n as '1' | '2' | '3' | '4',
		}),
	);
}

function extractPartialFiscalReceiptFieldsFromDirectUrlParams(url: URL): PartialExtractedFiscalReceiptFields | null {
	const fields: PartialExtractedFiscalReceiptFields = {
		dateTime: sanitizeFiscalFieldValue(url.searchParams.get('t')),
		amount: sanitizeFiscalFieldValue(url.searchParams.get('s'))?.replace(',', '.'),
		fn: sanitizeFiscalNumericValue(url.searchParams.get('fn')),
		i: sanitizeFiscalNumericValue(url.searchParams.get('i') ?? url.searchParams.get('fd')),
		fp: sanitizeFiscalNumericValue(url.searchParams.get('fp') ?? url.searchParams.get('fs')),
		n: sanitizeOperationTypeValue(url.searchParams.get('n')),
	};

	return fields.dateTime || fields.amount || fields.fn || fields.i || fields.fp || fields.n ? fields : null;
}

function extractPartialFiscalReceiptFieldsFromUrlPath(url: URL): PartialExtractedFiscalReceiptFields | null {
	const segments = url.pathname
		.split('/')
		.map((segment) => sanitizeUrlPathSegment(segment))
		.filter(Boolean);
	if (segments.length === 0) {
		return null;
	}

	const fields: PartialExtractedFiscalReceiptFields = {};
	for (let index = 0; index < segments.length - 1; index += 1) {
		const key = segments[index].toLowerCase();
		const next = segments[index + 1];
		switch (key) {
			case 'fn':
				fields.fn = sanitizeFiscalNumericValue(next) ?? fields.fn;
				break;
			case 'fd':
			case 'i':
				fields.i = sanitizeFiscalNumericValue(next) ?? fields.i;
				break;
			case 'fp':
			case 'fs':
				fields.fp = sanitizeFiscalNumericValue(next) ?? fields.fp;
				break;
			case 'n':
				fields.n = sanitizeOperationTypeValue(next) ?? fields.n;
				break;
			default:
				break;
		}
	}

	return fields.fn || fields.i || fields.fp || fields.n ? fields : null;
}

function buildQrPayloadCandidates(value: string): string[] {
	const cleaned = value
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.trim();
	const variants = new Set<string>();
	if (cleaned) {
		variants.add(cleaned);
		variants.add(cleaned.replace(/\s+/g, ''));
	}

	const repaired = repairCorruptedQrPayload(cleaned);
	if (repaired && repaired !== cleaned) {
		variants.add(repaired);
		variants.add(repaired.replace(/\s+/g, ''));
	}

	return Array.from(variants).filter(Boolean);
}

function repairCorruptedQrPayload(value: string): string {
	if (!value) {
		return '';
	}

	return value
		.split('&')
		.map((segment) => repairCorruptedQrSegment(segment))
		.join('&');
}

function repairCorruptedQrUrlCandidate(value: string): string {
	if (!value) {
		return '';
	}

	return value.replace(/([?&])(t|s|fn|fp|fs|i|fd|n)#(\d[\d.,T]*)/gi, (_match, prefix, key, rawValue) => {
		return `${prefix}${key}=${rawValue}`;
	});
}

function repairCorruptedQrSegment(segment: string): string {
	const trimmed = segment.trim();
	const match = trimmed.match(/^([a-z]{1,2})\s+(.+)$/i);
	if (!match) {
		return trimmed;
	}

	const [, key, rawValue] = match;
	const normalizedKey = key.toLowerCase();
	let normalizedValue = rawValue.trim();
	if (normalizedKey === 't' && /^\d{6}T\d{4}$/.test(normalizedValue)) {
		normalizedValue = `20${normalizedValue}`;
	}

	return `${key}=${normalizedValue}`;
}

function sanitizeFiscalFieldValue(value: string | null | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const normalized = value
		.replace(/[\u200B-\u200D\uFEFF]/g, '')
		.trim();
	return normalized || undefined;
}

function sanitizeFiscalNumericValue(value: string | null | undefined): string | undefined {
	const normalized = sanitizeFiscalFieldValue(value);
	if (!normalized) {
		return undefined;
	}

	const digits = normalized.replace(/[^\d]/g, '');
	return digits || undefined;
}

function sanitizeOperationTypeValue(value: string | null | undefined): '1' | '2' | '3' | '4' | undefined {
	const normalized = sanitizeFiscalFieldValue(value);
	return normalized && /^[1-4]$/.test(normalized) ? normalized as '1' | '2' | '3' | '4' : undefined;
}

function sanitizeUrlPathSegment(value: string): string {
	return decodeRepeatedUrlComponent(value)
		.replace(/[)>,"'\]]+$/g, '')
		.trim();
}

function decodeRepeatedUrlComponent(value: string, maxRounds = 3): string {
	let current = value;
	for (let i = 0; i < maxRounds; i += 1) {
		try {
			const decoded = decodeURIComponent(current);
			if (decoded === current) {
				return decoded;
			}
			current = decoded;
		} catch {
			return current;
		}
	}
	return current;
}

function mapRussianMonth(value: string): string | null {
	const normalized = value.toLocaleLowerCase('ru-RU');
	switch (normalized) {
		case 'янв':
		case 'января':
			return '01';
		case 'фев':
		case 'февраля':
			return '02';
		case 'мар':
		case 'марта':
			return '03';
		case 'апр':
		case 'апреля':
			return '04';
		case 'май':
		case 'мая':
			return '05';
		case 'июн':
		case 'июня':
			return '06';
		case 'июл':
		case 'июля':
			return '07';
		case 'авг':
		case 'августа':
			return '08';
		case 'сен':
		case 'сентября':
			return '09';
		case 'окт':
		case 'октября':
			return '10';
		case 'ноя':
		case 'ноября':
			return '11';
		case 'дек':
		case 'декабря':
			return '12';
		default:
			return null;
	}
}
