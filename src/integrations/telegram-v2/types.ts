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

export type TelegramOutboundFile = TFile | string | ArrayBuffer | Uint8Array;

export interface SendDocumentOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	disableContentTypeDetection?: boolean;
}

export interface SendPhotoOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	hasSpoiler?: boolean;
}

export interface SendAudioOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	performer?: string;
	title?: string;
}

export interface SendVideoOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
	supportsStreaming?: boolean;
	hasSpoiler?: boolean;
}

export interface SendAnimationOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
	width?: number;
	height?: number;
	hasSpoiler?: boolean;
}

export interface SendVoiceOptions extends SendMessageOptions {
	caption?: string;
	fileName?: string;
	duration?: number;
}

export interface SendVideoNoteOptions extends SendMessageOptions {
	fileName?: string;
	duration?: number;
	length?: number;
}

export interface TelegramMediaGroupBaseItem {
	file: TelegramOutboundFile;
	fileName?: string;
	caption?: string;
}

export interface TelegramPhotoGroupItem extends TelegramMediaGroupBaseItem {
	type: 'photo';
	hasSpoiler?: boolean;
}

export interface TelegramVideoGroupItem extends TelegramMediaGroupBaseItem {
	type: 'video';
	duration?: number;
	width?: number;
	height?: number;
	supportsStreaming?: boolean;
	hasSpoiler?: boolean;
}

export interface TelegramAudioGroupItem extends TelegramMediaGroupBaseItem {
	type: 'audio';
	duration?: number;
	performer?: string;
	title?: string;
}

export interface TelegramDocumentGroupItem extends TelegramMediaGroupBaseItem {
	type: 'document';
	disableContentTypeDetection?: boolean;
}

export type TelegramMediaGroupItem =
	| TelegramPhotoGroupItem
	| TelegramVideoGroupItem
	| TelegramAudioGroupItem
	| TelegramDocumentGroupItem;

export interface TelegramLocation {
	latitude: number;
	longitude: number;
}

export interface SendLocationOptions extends SendMessageOptions {
	horizontalAccuracy?: number;
	livePeriod?: number;
	heading?: number;
	proximityAlertRadius?: number;
}

export type SendFileOptions = SendDocumentOptions;

export interface SentTelegramMessageRef {
	messageId: number;
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
	getInputFocus?(): Promise<InputFocusState | null>;
	saveFileToVault(
		file: TelegramFileDescriptor,
		options: SaveTelegramFileOptions,
	): Promise<TFile>;
	sendMessage(text: string, options?: SendMessageOptions): Promise<SentTelegramMessageRef>;
	sendDocument?(
		file: TelegramOutboundFile,
		options?: SendDocumentOptions,
	): Promise<SentTelegramMessageRef>;
	sendFile?(
		file: TelegramOutboundFile,
		options?: SendFileOptions,
	): Promise<SentTelegramMessageRef>;
	sendPhoto?(
		file: TelegramOutboundFile,
		options?: SendPhotoOptions,
	): Promise<SentTelegramMessageRef>;
	sendAudio?(
		file: TelegramOutboundFile,
		options?: SendAudioOptions,
	): Promise<SentTelegramMessageRef>;
	sendVideo?(
		file: TelegramOutboundFile,
		options?: SendVideoOptions,
	): Promise<SentTelegramMessageRef>;
	sendAnimation?(
		file: TelegramOutboundFile,
		options?: SendAnimationOptions,
	): Promise<SentTelegramMessageRef>;
	sendVoice?(
		file: TelegramOutboundFile,
		options?: SendVoiceOptions,
	): Promise<SentTelegramMessageRef>;
	sendVideoNote?(
		file: TelegramOutboundFile,
		options?: SendVideoNoteOptions,
	): Promise<SentTelegramMessageRef>;
	sendMediaGroup?(
		items: TelegramMediaGroupItem[],
	): Promise<SentTelegramMessageRef[]>;
	sendLocation?(
		location: TelegramLocation,
		options?: SendLocationOptions,
	): Promise<SentTelegramMessageRef>;
	editMessage?(
		messageId: number,
		text: string,
		options?: SendMessageOptions,
	): Promise<void>;
	deleteMessage?(messageId: number): Promise<void>;
	answerCallbackQuery?(callbackId: string, text?: string): Promise<void>;
	encodeCallbackPayload?(payload: TelegramCallbackPayload): string;
	decodeCallbackPayload?(data: string): TelegramCallbackPayload | null;
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
