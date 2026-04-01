export interface PluginBuildInfo {
	pluginId: string;
	pluginName: string;
	pluginVersion: string;
	buildNumber: number;
	builtAt: string;
}

declare const __PARA_PLUGIN_BUILD_INFO__: PluginBuildInfo;

export const PLUGIN_BUILD_INFO: PluginBuildInfo = __PARA_PLUGIN_BUILD_INFO__;

export function formatPluginBuildInfo(buildInfo: PluginBuildInfo = PLUGIN_BUILD_INFO): string {
	return `v${buildInfo.pluginVersion} build #${buildInfo.buildNumber} (${buildInfo.builtAt})`;
}
