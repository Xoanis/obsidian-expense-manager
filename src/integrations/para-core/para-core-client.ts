import { App } from 'obsidian';
import { IParaCoreApi } from './types';

interface ParaCorePluginLike {
	getApi?: () => IParaCoreApi;
}

const PARA_CORE_PLUGIN_ID = 'para-core';

export function getParaCoreApi(app: App): IParaCoreApi | null {
	try {
		// @ts-ignore - plugin registry is runtime-provided by Obsidian.
		const plugin = app.plugins?.plugins?.[PARA_CORE_PLUGIN_ID] as ParaCorePluginLike | undefined;
		if (!plugin || typeof plugin.getApi !== 'function') {
			return null;
		}

		const api = plugin.getApi();
		if (
			!api ||
			typeof api.registerDomain !== 'function' ||
			typeof api.registerTemplateContribution !== 'function' ||
			typeof api.registerMetadataContribution !== 'function' ||
			typeof api.createNote !== 'function' ||
			typeof api.getDomainRecordsPath !== 'function'
		) {
			return null;
		}

		return api;
	} catch (error) {
		console.log('PARA Core API not available:', error);
		return null;
	}
}
