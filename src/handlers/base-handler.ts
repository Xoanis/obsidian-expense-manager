import { HandlerResult } from '../types';

/**
 * Abstract base handler for transaction input methods
 */
export abstract class BaseHandler {
	/**
	 * Handle transaction input and return result
	 */
	abstract handle(): Promise<HandlerResult>;

	/**
	 * Get handler name for identification
	 */
	abstract getName(): string;
}
