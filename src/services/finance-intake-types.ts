import type { TransactionData, TransactionType } from '../types';
import type { FinanceIntakeRoute } from 'obsidian-para-suite-contracts/finance-intake';

export type FinanceIntakeIntent = TransactionType | 'neutral';

export interface FinanceMetadataHints {
	area?: string;
	project?: string;
}

export interface FinanceCaptionMetadata extends FinanceMetadataHints {
	comment: string;
}

export interface FinanceTextProposalRequest extends FinanceMetadataHints {
	text: string;
	intent: FinanceIntakeIntent;
	source?: TransactionData['source'];
	knownCategories?: string[];
	knownProjects?: string[];
	knownAreas?: string[];
}

export interface FinanceReceiptProposalRequest extends FinanceMetadataHints {
	bytes: ArrayBuffer;
	fileName: string;
	mimeType?: string;
	caption?: string;
	intent: FinanceIntakeIntent;
	source?: TransactionData['source'];
	knownCategories?: string[];
	knownProjects?: string[];
	knownAreas?: string[];
}

export interface FinanceReceiptProposalResult {
	data: TransactionData;
	source: 'api' | 'local';
}

export interface FinanceIntakeRoutingDecision {
	providerKind: 'rule-based' | 'ai';
	route: FinanceIntakeRoute;
	reason: string;
}

export interface FinanceIntakeProvider {
	createTextTransaction(request: FinanceTextProposalRequest): Promise<TransactionData | null>;
	createReceiptTransaction(request: FinanceReceiptProposalRequest): Promise<FinanceReceiptProposalResult>;
	parseCaption?(caption: string): FinanceCaptionMetadata;
	extractMetadataHints?(value: string): FinanceMetadataHints;
}
