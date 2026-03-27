import { App, normalizePath, TFile } from 'obsidian';
import type { ExpenseManagerSettings } from '../settings';

export interface PluginLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

export class ConsolePluginLogger implements PluginLogger {
	info(message: string, ...args: unknown[]): void {
		console.info(message, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		console.warn(message, ...args);
	}

	error(message: string, ...args: unknown[]): void {
		console.error(message, ...args);
	}

	debug(message: string, ...args: unknown[]): void {
		console.debug(message, ...args);
	}
}

export class VaultDebugFileLogger implements PluginLogger {
	private writeQueue: Promise<void> = Promise.resolve();
	private readonly fallbackLogger: PluginLogger;
	private readonly maxCharacters = 200_000;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => ExpenseManagerSettings,
		fallbackLogger?: PluginLogger,
	) {
		this.fallbackLogger = fallbackLogger ?? new ConsolePluginLogger();
	}

	info(message: string, ...args: unknown[]): void {
		this.fallbackLogger.info(message, ...args);
		this.enqueueWrite('INFO', message, args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.fallbackLogger.warn(message, ...args);
		this.enqueueWrite('WARN', message, args);
	}

	error(message: string, ...args: unknown[]): void {
		this.fallbackLogger.error(message, ...args);
		this.enqueueWrite('ERROR', message, args);
	}

	debug(message: string, ...args: unknown[]): void {
		this.fallbackLogger.debug(message, ...args);
		this.enqueueWrite('DEBUG', message, args);
	}

	getLogPath(): string {
		return normalizePath(this.getSettings().debugLogFilePath || 'ExpenseManager/debug-log.md');
	}

	async ensureLogFileExists(): Promise<TFile | null> {
		const path = this.getLogPath();
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}

		await this.ensureParentDirectory(path);
		await this.app.vault.adapter.write(path, '# Expense Manager Debug Log\n\n');
		const created = this.app.vault.getAbstractFileByPath(path);
		return created instanceof TFile ? created : null;
	}

	private enqueueWrite(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, args: unknown[]): void {
		if (!this.getSettings().enableDebugFileLogging) {
			return;
		}

		this.writeQueue = this.writeQueue
			.then(() => this.appendLine(level, message, args))
			.catch((error) => {
				this.fallbackLogger.error('VaultDebugFileLogger: failed to write debug log entry', error);
			});
	}

	private async appendLine(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, args: unknown[]): Promise<void> {
		const path = this.getLogPath();
		await this.ensureParentDirectory(path);

		const exists = await this.app.vault.adapter.exists(path);
		if (!exists) {
			await this.app.vault.adapter.write(path, '# Expense Manager Debug Log\n\n');
		}

		const timestamp = new Date().toISOString();
		const serializedArgs = args.length > 0
			? ` ${args.map((value) => this.serializeValue(value)).join(' ')}`
			: '';
		const line = `- ${timestamp} [${level}] ${message}${serializedArgs}\n`;
		await this.app.vault.adapter.append(path, line);
		await this.trimIfNeeded(path);
	}

	private async trimIfNeeded(path: string): Promise<void> {
		const content = await this.app.vault.adapter.read(path);
		if (content.length <= this.maxCharacters) {
			return;
		}

		const header = '# Expense Manager Debug Log\n\n';
		const tail = content.slice(-this.maxCharacters);
		const firstEntryIndex = tail.indexOf('\n- ');
		const trimmedBody = firstEntryIndex >= 0 ? tail.slice(firstEntryIndex + 1) : tail;
		await this.app.vault.adapter.write(path, `${header}${trimmedBody.trimStart()}\n`);
	}

	private async ensureParentDirectory(path: string): Promise<void> {
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (!parent) {
			return;
		}

		const segments = parent.split('/').filter(Boolean);
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			const exists = await this.app.vault.adapter.exists(current);
			if (!exists) {
				await this.app.vault.adapter.mkdir(current);
			}
		}
	}

	private serializeValue(value: unknown): string {
		if (value instanceof Error) {
			return JSON.stringify({
				name: value.name,
				message: value.message,
				stack: value.stack,
			});
		}

		if (typeof value === 'string') {
			return value;
		}

		try {
			return JSON.stringify(value);
		} catch (_error) {
			return String(value);
		}
	}
}
