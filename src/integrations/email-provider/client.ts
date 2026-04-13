import { App } from 'obsidian';
import {
	EMAIL_PROVIDER_PLUGIN_ID,
	type IEmailProviderApi,
	type MailChannelSummary,
} from './types';
import { getPluginLogger } from '../../utils/plugin-debug-log';

interface EmailProviderPluginLike {
	getApi?: () => IEmailProviderApi;
}

function isEmailProviderApi(value: unknown): value is IEmailProviderApi {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const api = value as Partial<IEmailProviderApi>;
	return typeof api.getApiVersion === 'function'
		&& typeof api.listChannels === 'function'
		&& typeof api.getChannel === 'function'
		&& typeof api.getDefaultChannel === 'function'
		&& typeof api.getChannelCapabilities === 'function'
		&& typeof api.testChannelConnection === 'function'
		&& typeof api.searchMessages === 'function'
		&& typeof api.getMessage === 'function'
		&& typeof api.materializeAttachment === 'function'
		&& typeof api.getCheckpoint === 'function'
		&& typeof api.saveCheckpoint === 'function';
}

export function getEmailProviderApi(app: App): IEmailProviderApi | null {
	try {
		// @ts-ignore - plugin registry is runtime-provided by Obsidian.
		const plugin = app.plugins?.plugins?.[EMAIL_PROVIDER_PLUGIN_ID] as EmailProviderPluginLike | undefined;
		if (!plugin || typeof plugin.getApi !== 'function') {
			return null;
		}

		const api = plugin.getApi();
		if (!isEmailProviderApi(api)) {
			return null;
		}

		return api;
	} catch (error) {
		getPluginLogger().info('Email provider API not available', error);
		return null;
	}
}

export function resolveEmailProviderRuntime(
	app: App,
	requestedChannelId?: string,
): { api: IEmailProviderApi; channel: MailChannelSummary } {
	const api = getEmailProviderApi(app);
	if (!api) {
		throw new Error(
			'The workspace email-provider plugin is not available. Install and enable "obsidian-email-provider", then try again.',
		);
	}

	const normalizedChannelId = requestedChannelId?.trim() ?? '';
	if (normalizedChannelId) {
		const channel = api.getChannel(normalizedChannelId);
		if (!channel) {
			throw new Error(`Email-provider channel "${normalizedChannelId}" was not found.`);
		}
		if (!channel.enabled) {
			throw new Error(`Email-provider channel "${normalizedChannelId}" is disabled.`);
		}

		return { api, channel };
	}

	const defaultChannel = api.getDefaultChannel();
	if (defaultChannel?.enabled) {
		return {
			api,
			channel: defaultChannel,
		};
	}

	const enabledChannels = api.listChannels().filter((channel) => channel.enabled);
	if (enabledChannels.length === 1) {
		return {
			api,
			channel: enabledChannels[0],
		};
	}
	if (enabledChannels.length === 0) {
		throw new Error('The workspace email-provider plugin has no enabled channels.');
	}

	throw new Error(
		'Multiple enabled email-provider channels are configured. Set a default channel in obsidian-email-provider or specify a channel id in Expense Manager settings.',
	);
}
