import { ipcMain } from "electron";
import {
	armRegionSelectWindowForRecording,
	closeRecordingRegionOverlayWindow,
	createRecordingRegionOverlayWindow,
	getRecordingRegionOverlayPhase,
	getRecordingRegionOverlayWindow,
	getRegionSelectWindow,
	setRecordingRegionOverlayPhase,
} from "../../windows";
import { nativeScreenRecordingActive, selectedSource } from "../state";
import type { CaptureRegion } from "../types";
import { getScreen } from "../utils";

function isValidCaptureRegion(region: unknown): region is CaptureRegion {
	if (!region || typeof region !== "object") {
		return false;
	}
	const candidate = region as CaptureRegion;
	return (
		Number.isFinite(candidate.x) &&
		Number.isFinite(candidate.y) &&
		Number.isFinite(candidate.width) &&
		Number.isFinite(candidate.height) &&
		candidate.width > 1 &&
		candidate.height > 1
	);
}

export function getRecordingRegionOverlayContext() {
	const region = selectedSource?.captureRegion;
	if (!isValidCaptureRegion(region)) {
		return { success: false as const, error: "No active capture region" };
	}

	const displayId = Number(selectedSource?.display_id);
	const display =
		(Number.isFinite(displayId)
			? getScreen()
					.getAllDisplays()
					.find((entry) => entry.id === displayId)
			: null) ?? getScreen().getPrimaryDisplay();

	const displays = getScreen().getAllDisplays();
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const entry of displays) {
		minX = Math.min(minX, entry.bounds.x);
		minY = Math.min(minY, entry.bounds.y);
		maxX = Math.max(maxX, entry.bounds.x + entry.bounds.width);
		maxY = Math.max(maxY, entry.bounds.y + entry.bounds.height);
	}
	const virtualBounds = {
		x: Number.isFinite(minX) ? minX : display.bounds.x,
		y: Number.isFinite(minY) ? minY : display.bounds.y,
		width: Number.isFinite(maxX - minX) ? Math.max(1, maxX - minX) : display.bounds.width,
		height: Number.isFinite(maxY - minY) ? Math.max(1, maxY - minY) : display.bounds.height,
	};

	const globalRegion = {
		x: display.bounds.x + region.x,
		y: display.bounds.y + region.y,
		width: region.width,
		height: region.height,
	};

	return {
		success: true as const,
		virtualBounds,
		displayBounds: display.bounds,
		displayId: display.id,
		region,
		globalRegion,
		phase: getRecordingRegionOverlayPhase(),
	};
}

export function showRecordingRegionOverlayIfNeeded(phase: "armed" | "recording" = "armed") {
	if (!isValidCaptureRegion(selectedSource?.captureRegion)) {
		closeRecordingRegionOverlayWindow();
		return { shown: false };
	}

	const existing = getRecordingRegionOverlayWindow();
	if (existing && !existing.isDestroyed()) {
		setRecordingRegionOverlayPhase(phase);
		return { shown: true };
	}

	// Still on the interactive picker window (confirm path raced ahead of promote).
	if (getRegionSelectWindow() && !getRegionSelectWindow()?.isDestroyed()) {
		if (armRegionSelectWindowForRecording()) {
			setRecordingRegionOverlayPhase(phase);
			return { shown: true };
		}
	}

	// Set phase before create so did-finish-load ships the right badge state.
	setRecordingRegionOverlayPhase(phase);
	createRecordingRegionOverlayWindow();
	return { shown: true };
}

export function hideRecordingRegionOverlay() {
	closeRecordingRegionOverlayWindow();
}

/** Hide only when a capture isn't actively running (e.g. cancelled countdown). */
export function hideRecordingRegionOverlayIfIdle() {
	if (nativeScreenRecordingActive) {
		return;
	}
	hideRecordingRegionOverlay();
}

export function registerRecordingRegionOverlayHandlers() {
	ipcMain.handle("get-recording-region-overlay-context", () => {
		return getRecordingRegionOverlayContext();
	});
}
