import { TFile } from 'obsidian';

export type Reply = string | null;
export type HandlerResult = {
	processed: boolean;
	answer: Reply;
};
export type CommandHandler = (processed_before: boolean) => Promise<HandlerResult>;
export type TextHandler = (text: string, processed_before: boolean) => Promise<HandlerResult>;
export type FileHandler = (file: TFile, processed_before: boolean, caption?: string) => Promise<HandlerResult>;
export interface ITelegramBotPluginAPIv1 {
	addCommandHandler(cmd: string, handler: CommandHandler, unit_name: string): void;
	addTextHandler(handler: TextHandler, unit_name: string): void;
	addFileHandler(handler: FileHandler, unit_name: string, mime_type?: string): void;

	sendMessage(text: string): Promise<void>;

}
