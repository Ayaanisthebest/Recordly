import { BrowserWindow, ipcMain } from "electron";
import {
	armRegionSelectWindowForRecording,
	closeRecordingRegionOverlayWindow,
	closeRegionSelectWindow,
	createRegionSelectWindow,
	getHudOverlayWindow,
	getRegionSelectWindow,
	restoreHudOverlayFromRegionSelect,
} from "../../windows";
import { setSelectedSource } from "../state";
import type { CaptureRegion, SelectedSource } from "../types";
import { getScreen } from "../utils";
import { getScreenSourceIdForDisplay } from "./sourceMapping";

type RegionSelectResult =
	| {
			success: true;
			canceled?: false;
			source: SelectedSource;
	  }
	| {
			success: false;
			canceled: true;
			error?: string;
	  }
	| {
			success: false;
			canceled?: false;
			error: string;
	  };

type PendingRegionSelect = {
	resolve: (result: RegionSelectResult) => void;
	preferredDisplayId?: number;
};

let pendingRegionSelect: PendingRegionSelect | null = null;

function getDisplayLocalRegion(
	globalRect: CaptureRegion & { x: number; y: number },
): { displayId: number; region: CaptureRegion; displayName: string } | null {
	const displays = getScreen().getAllDisplays();
	const center = {
		x: globalRect.x + globalRect.width / 2,
		y: globalRect.y + globalRect.height / 2,
	};
	const display =
		displays.find(
			(d) =>
				center.x >= d.bounds.x &&
				center.x < d.bounds.x + d.bounds.width &&
				center.y >= d.bounds.y &&
				center.y < d.bounds.y + d.bounds.height,
		) ??
		getScreen().getDisplayNearestPoint(center) ??
		getScreen().getPrimaryDisplay();

	const region: CaptureRegion = {
		x: Math.round(globalRect.x - display.bounds.x),
		y: Math.round(globalRect.y - display.bounds.y),
		width: Math.round(globalRect.width),
		height: Math.round(globalRect.height),
	};

	// Clamp into display
	region.x = Math.max(0, Math.min(region.x, display.bounds.width - 2));
	region.y = Math.max(0, Math.min(region.y, display.bounds.height - 2));
	region.width = Math.max(2, Math.min(region.width, display.bounds.width - region.x));
	region.height = Math.max(2, Math.min(region.height, display.bounds.height - region.y));

	return {
		displayId: display.id,
		region,
		displayName: display.label || `Display ${display.id}`,
	};
}

function settlePending(result: RegionSelectResult) {
	const pending = pendingRegionSelect;
	pendingRegionSelect = null;
	if (result.success) {
		// Keep the same overlay window as a click-through recording frame so
		// the crop never blanks out for countdown / capture start.
		if (!armRegionSelectWindowForRecording()) {
			closeRegionSelectWindow();
		}
	} else {
		closeRegionSelectWindow();
		closeRecordingRegionOverlayWindow();
	}
	restoreHudOverlayFromRegionSelect();
	pending?.resolve(result);
}

export function registerRegionSelectHandlers() {
	ipcMain.handle(
		"start-region-select",
		async (_event, options?: { displayId?: number | string | null }) => {
			if (pendingRegionSelect) {
				return {
					success: false,
					error: "Region selection is already in progress",
				} satisfies RegionSelectResult;
			}

			// Drop any leftover armed recording frame before picking again.
			closeRecordingRegionOverlayWindow();

			const preferredDisplayId =
				options?.displayId === undefined || options?.displayId === null
					? undefined
					: Number(options.displayId);

			return await new Promise<RegionSelectResult>((resolve) => {
				pendingRegionSelect = {
					resolve,
					preferredDisplayId: Number.isFinite(preferredDisplayId)
						? preferredDisplayId
						: undefined,
				};

				const hud = getHudOverlayWindow();
				if (hud && !hud.isDestroyed()) {
					hud.minimize();
				}

				const win = createRegionSelectWindow();
				win.once("closed", () => {
					if (pendingRegionSelect) {
						settlePending({ success: false, canceled: true });
					}
				});
			});
		},
	);

	ipcMain.handle("get-region-select-context", () => {
		const displays = getScreen().getAllDisplays().map((display) => ({
			id: display.id,
			bounds: display.bounds,
			label: display.label || `Display ${display.id}`,
			scaleFactor: display.scaleFactor,
			primary: display.id === getScreen().getPrimaryDisplay().id,
		}));

		const virtualBounds = (() => {
			if (displays.length === 0) {
				return getScreen().getPrimaryDisplay().bounds;
			}
			let minX = Number.POSITIVE_INFINITY;
			let minY = Number.POSITIVE_INFINITY;
			let maxX = Number.NEGATIVE_INFINITY;
			let maxY = Number.NEGATIVE_INFINITY;
			for (const display of displays) {
				minX = Math.min(minX, display.bounds.x);
				minY = Math.min(minY, display.bounds.y);
				maxX = Math.max(maxX, display.bounds.x + display.bounds.width);
				maxY = Math.max(maxY, display.bounds.y + display.bounds.height);
			}
			return {
				x: minX,
				y: minY,
				width: Math.max(1, maxX - minX),
				height: Math.max(1, maxY - minY),
			};
		})();

		return {
			success: true,
			displays,
			virtualBounds,
			preferredDisplayId: pendingRegionSelect?.preferredDisplayId ?? null,
		};
	});

	ipcMain.handle(
		"confirm-region-select",
		(_event, payload: { x: number; y: number; width: number; height: number }) => {
			if (!pendingRegionSelect) {
				return { success: false, error: "No region selection in progress" };
			}

			if (
				!payload ||
				!Number.isFinite(payload.x) ||
				!Number.isFinite(payload.y) ||
				!Number.isFinite(payload.width) ||
				!Number.isFinite(payload.height) ||
				payload.width < 2 ||
				payload.height < 2
			) {
				return { success: false, error: "Invalid region" };
			}

			const mapped = getDisplayLocalRegion({
				x: payload.x,
				y: payload.y,
				width: payload.width,
				height: payload.height,
			});
			if (!mapped) {
				settlePending({ success: false, error: "Could not map region to a display" });
				return { success: false, error: "Could not map region to a display" };
			}

			const source: SelectedSource = {
				id: getScreenSourceIdForDisplay({
					displayId: String(mapped.displayId),
					platform: process.platform,
				}),
				name: `${mapped.displayName} · Region`,
				display_id: String(mapped.displayId),
				sourceType: "screen",
				captureRegion: mapped.region,
			};

			setSelectedSource(source);
			for (const win of BrowserWindow.getAllWindows()) {
				if (!win.isDestroyed()) {
					win.webContents.send("selected-source-changed", source);
				}
			}

			settlePending({ success: true, source });
			return { success: true, source };
		},
	);

	ipcMain.handle("cancel-region-select", () => {
		if (!pendingRegionSelect && !getRegionSelectWindow()) {
			return { success: true, canceled: true };
		}
		settlePending({ success: false, canceled: true });
		return { success: true, canceled: true };
	});
}
