import { App } from 'obsidian';
import {
	EMAIL_PROVIDER_PLUGIN_ID,
	type IEmailProviderApi,
	type MailChannelSummary,
} from './types';
import { getPluginLogger } from '../../utils/plugin-debug-log';
import { parseEmailProviderChannelSelection } from './channel-selection';

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
	const runtime = resolveEmailProviderSelection(app, requestedChannelId);
	if (runtime.channels.length !== 1) {
		throw new Error(
			'This action requires exactly one email-provider channel. ' +
			'Specify a single channel id in Expense Manager settings or narrow the selection for this operation.',
		);
	}

	return {
		api: runtime.api,
		channel: runtime.channels[0],
	};
}

export function resolveEmailProviderSelection(
	app: App,
	requestedChannelSelection?: string,
): { api: IEmailProviderApi; channels: MailChannelSummary[] } {
	const api = getEmailProviderApi(app);
	if (!api) {
		throw new Error(
			'The workspace email-provider plugin is not available. Install and enable "obsidian-email-provider", then try again.',
		);
	}

	const requestedChannelIds = parseEmailProviderChannelSelection(requestedChannelSelection);
	if (requestedChannelIds.length > 0) {
		const channels = requestedChannelIds.map((channelId) => {
			const channel = api.getChannel(channelId);
			if (!channel) {
				throw new Error(`Email-provider channel "${channelId}" was not found.`);
			}
			if (!channel.enabled) {
				throw new Error(`Email-provider channel "${channelId}" is disabled.`);
			}

			return channel;
		});

		return {
			api,
			channels,
		};
	}

	const defaultChannel = api.getDefaultChannel();
	if (defaultChannel?.enabled) {
		return {
			api,
			channels: [defaultChannel],
		};
	}

	const enabledChannels = api.listChannels().filter((channel) => channel.enabled);
	if (enabledChannels.length === 1) {
		return {
			api,
			channels: enabledChannels,
		};
	}
	if (enabledChannels.length === 0) {
		throw new Error('The workspace email-provider plugin has no enabled channels.');
	}

	throw new Error(
		'Multiple enabled email-provider channels are configured. Set a default channel in obsidian-email-provider or specify one or more channel ids in Expense Manager settings.',
	);
}
