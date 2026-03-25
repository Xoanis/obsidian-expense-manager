import type { App, TFile } from 'obsidian';

export type TelegramMessageKind =
	| 'command'
	| 'text'
	| 'photo'
	| 'voice'
	| 'video'
	| 'video_note'
	| 'audio'
	| 'document'
	| 'animation'
	| 'mixed'
	| 'unknown';

export interface TelegramFileDescriptor {
	fileId: string;
	uniqueId?: string;
	kind: TelegramMessageKind;
	mimeType?: string;
	size?: number;
	suggestedName: string;
	caption?: string;
}

export interface TelegramCommandDescriptor {
	name: string;
	args: string;
}

export interface TelegramMessageContext {
	messageId?: number;
	date?: number;
	kind: TelegramMessageKind;
	text?: string;
	caption?: string;
	command?: TelegramCommandDescriptor;
	files: TelegramFileDescriptor[];
	raw: unknown;
}

export interface TelegramHandlerResult {
	processed: boolean;
	answer: string | null;
}

export interface TelegramInlineButton {
	text: string;
	callbackData: string;
}

export type TelegramInlineKeyboard = TelegramInlineButton[][];

export interface SendMessageOptions {
	inlineKeyboard?: TelegramInlineKeyboard;
}

export interface TelegramCallbackContext {
	messageId?: number;
	callbackId: string;
	data: string;
	raw: unknown;
}

export interface TelegramCallbackPayload {
	unit: string;
	action: string;
	token?: string;
	data?: Record<string, string>;
}

export type InputFocusMode = 'next-text' | 'next-message' | 'session';

export interface InputFocusState {
	unitName: string;
	mode: InputFocusMode;
	context?: Record<string, unknown>;
	expiresAt?: number;
}

export interface SetInputFocusOptions {
	mode?: InputFocusMode;
	context?: Record<string, unknown>;
	expiresInMs?: number;
}

export interface SaveTelegramFileOptions {
	folder: string;
	fileName?: string;
	conflictStrategy?: 'rename' | 'replace' | 'error';
}

export interface TelegramBotApiV2 {
	registerMessageHandler(
		handler: (
			message: TelegramMessageContext,
			processedBefore: boolean,
		) => Promise<TelegramHandlerResult>,
		unitName: string,
	): void;
	registerCallbackHandler(
		handler: (
			callback: TelegramCallbackContext,
			processedBefore: boolean,
		) => Promise<TelegramHandlerResult>,
		unitName: string,
	): void;
	registerFocusedInputHandler(
		handler: (
			message: TelegramMessageContext,
			focus: InputFocusState,
		) => Promise<TelegramHandlerResult>,
		unitName: string,
	): void;
	setInputFocus(unitName: string, options?: SetInputFocusOptions): Promise<void>;
	clearInputFocus(unitName?: string): Promise<void>;
	saveFileToVault(
		file: TelegramFileDescriptor,
		options: SaveTelegramFileOptions,
	): Promise<TFile>;
	sendMessage(text: string, options?: SendMessageOptions): Promise<{ messageId: number }>;
	encodeCallbackPayload(payload: TelegramCallbackPayload): string;
	decodeCallbackPayload(data: string): TelegramCallbackPayload | null;
	disposeHandlersForUnit(unitName: string): void;
}

interface TelegramPluginLike {
	getAPIv2?: () => TelegramBotApiV2;
}

interface AppWithPlugins extends App {
	plugins?: {
		plugins?: Record<string, TelegramPluginLike | undefined>;
	};
}

const TELEGRAM_PLUGIN_ID = 'obsidian-telegram-bot-plugin';

export function getTelegramBotApiV2(app: App): TelegramBotApiV2 | null {
	const plugin = (app as AppWithPlugins).plugins?.plugins?.[TELEGRAM_PLUGIN_ID];
	const api = plugin?.getAPIv2?.();
	return api ?? null;
}
