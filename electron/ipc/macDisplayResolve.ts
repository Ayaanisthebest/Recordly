import { desktopCapturer, type Display } from "electron";
import { getScreen } from "./utils";

export type ResolvedMacDisplay = {
	/** Prefer for ScreenCaptureKit (CGDirectDisplayID when available). */
	cgDisplayId: number;
	/** Electron `screen` display id. */
	electronDisplayId: number;
	bounds: { x: number; y: number; width: number; height: number };
};

/**
 * Resolve a display for native macOS capture. Electron display ids and
 * desktopCapturer / CGDirectDisplayID values can diverge; we keep Electron
 * bounds for geometry matching and prefer a capturer display_id when it looks
 * like a CGDirectDisplayID for the same monitor.
 */
export async function resolveMacDisplayForCapture(
	preferredElectronDisplayId?: number | string | null,
	capturerSources?: Electron.DesktopCapturerSource[],
): Promise<ResolvedMacDisplay> {
	const displays = [...getScreen().getAllDisplays()].sort(
		(left, right) =>
			left.bounds.x - right.bounds.x ||
			left.bounds.y - right.bounds.y ||
			left.id - right.id,
	);
	const primary = getScreen().getPrimaryDisplay();
	const preferredId = Number(preferredElectronDisplayId);
	const electronDisplay: Display =
		(Number.isFinite(preferredId)
			? displays.find((display) => display.id === preferredId)
			: null) ?? primary;

	let sources = capturerSources;
	if (!sources) {
		try {
			sources = await desktopCapturer.getSources({
				types: ["screen"],
				thumbnailSize: { width: 0, height: 0 },
			});
		} catch {
			sources = [];
		}
	}

	const screenSources = sources.filter((source) => source.id.startsWith("screen:"));
	let matched =
		screenSources.find((source) => String(source.display_id) === String(electronDisplay.id)) ??
		null;

	if (!matched && screenSources.length === displays.length) {
		const electronIndex = displays.findIndex((display) => display.id === electronDisplay.id);
		if (electronIndex >= 0) {
			matched = screenSources[electronIndex] ?? null;
		}
	}

	const capturerId = Number(matched?.display_id);
	const cgDisplayId =
		Number.isFinite(capturerId) && capturerId > 0 ? capturerId : electronDisplay.id;

	return {
		cgDisplayId,
		electronDisplayId: electronDisplay.id,
		bounds: {
			x: electronDisplay.bounds.x,
			y: electronDisplay.bounds.y,
			width: electronDisplay.bounds.width,
			height: electronDisplay.bounds.height,
		},
	};
}
