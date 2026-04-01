import { App, EventRef } from 'obsidian';

/**
 * Opens a one-time startup gate for background sync work.
 *
 * Preferred signal:
 * - `metadataCache.resolved`, because it means Obsidian finished resolving file metadata.
 *
 * Fallback signal:
 * - a short post-layout timeout, in case the initial `resolved` event happened before
 *   this service subscribed or does not arrive on a given startup path.
 */
export class StartupSyncGate {
	private resolvedRef: EventRef | null = null;
	private fallbackTimer: number | null = null;
	private opened = false;

	constructor(
		private readonly app: App,
		private readonly fallbackDelayMs = 1500,
	) {}

	arm(callback: () => void): void {
		const open = () => {
			if (this.opened) {
				return;
			}

			this.opened = true;
			this.dispose();
			callback();
		};

		this.resolvedRef = this.app.metadataCache.on('resolved', open);

		this.app.workspace.onLayoutReady(() => {
			if (this.opened) {
				return;
			}

			if (this.fallbackTimer !== null) {
				window.clearTimeout(this.fallbackTimer);
			}

			this.fallbackTimer = window.setTimeout(() => {
				this.fallbackTimer = null;
				open();
			}, this.fallbackDelayMs);
		});
	}

	dispose(): void {
		if (this.fallbackTimer !== null) {
			window.clearTimeout(this.fallbackTimer);
			this.fallbackTimer = null;
		}

		if (this.resolvedRef) {
			this.app.metadataCache.offref(this.resolvedRef);
			this.resolvedRef = null;
		}
	}
}
