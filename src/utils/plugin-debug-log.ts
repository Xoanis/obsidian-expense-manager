import { App, TFile } from 'obsidian';
import type { IParaCoreApi } from '../integrations/para-core/types';

export interface PluginLogger {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

interface ParaLoggerLike {
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
}

export class ConsolePluginLogger implements PluginLogger {
	constructor(private readonly scope = 'Expense Manager') {}

	info(message: string, ...args: unknown[]): void {
		console.info(this.format(message), ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		console.warn(this.format(message), ...args);
	}

	error(message: string, ...args: unknown[]): void {
		console.error(this.format(message), ...args);
	}

	debug(message: string, ...args: unknown[]): void {
		console.debug(this.format(message), ...args);
	}

	private format(message: string): string {
		return `${this.scope}: ${message}`;
	}
}

export class ParaCorePluginLogger implements PluginLogger {
	constructor(private readonly logger: ParaLoggerLike) {}

	info(message: string, ...args: unknown[]): void {
		this.logger.info(message, ...args);
	}

	warn(message: string, ...args: unknown[]): void {
		this.logger.warn(message, ...args);
	}

	error(message: string, ...args: unknown[]): void {
		this.logger.error(message, ...args);
	}

	debug(message: string, ...args: unknown[]): void {
		this.logger.debug(message, ...args);
	}
}

let activePluginLogger: PluginLogger = new ConsolePluginLogger();

export function createPluginLogger(scope: string, paraCoreApi?: IParaCoreApi | null): PluginLogger {
	const createLogger = (paraCoreApi as unknown as { createLogger?: (scope: string) => ParaLoggerLike } | null)?.createLogger;
	if (typeof createLogger === 'function') {
		return new ParaCorePluginLogger(createLogger(scope));
	}

	return new ConsolePluginLogger(scope);
}

export function setActivePluginLogger(logger: PluginLogger): void {
	activePluginLogger = logger;
}

export function getPluginLogger(): PluginLogger {
	return activePluginLogger;
}

export async function openSharedRuntimeLog(app: App, paraCoreApi?: IParaCoreApi | null): Promise<TFile | null> {
	const getRuntimeLogPath = (paraCoreApi as unknown as { getRuntimeLogPath?: () => string } | null)?.getRuntimeLogPath;
	if (typeof getRuntimeLogPath !== 'function') {
		return null;
	}

	const path = getRuntimeLogPath();
	const existing = app.vault.getAbstractFileByPath(path);
	return existing instanceof TFile ? existing : null;
}
