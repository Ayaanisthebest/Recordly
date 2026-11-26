import type { GifFitPreference } from "./types";
import { GITHUB_GIF_MAX_BYTES } from "./types";

/** Leave headroom for encoder variance vs GitHub's hard limit. */
export const GITHUB_GIF_SAFE_BUDGET_BYTES = Math.floor(GITHUB_GIF_MAX_BYTES * 0.98);

export const GIF_FIT_FPS_STEPS = [15, 12, 10, 8] as const;
export const GIF_FIT_COLOR_STEPS = [256, 192, 128, 64] as const;
export const GIF_FIT_MIN_SCALE = 0.35;
export const GIF_FIT_MAX_SCALE = 1;

export type GifFitFps = (typeof GIF_FIT_FPS_STEPS)[number];
export type GifFitColors = (typeof GIF_FIT_COLOR_STEPS)[number];

export interface GifFitCandidateSettings {
	fps: number;
	scale: number;
	maxColors: number;
	width: number;
	height: number;
}

export interface GifFitCandidateResult extends GifFitCandidateSettings {
	bytes: number;
}

export interface GifFitResult {
	settings: GifFitCandidateSettings;
	bytes: number;
	overBudget: boolean;
	preference: GifFitPreference;
	attempts: number;
}

export interface GifSizeFitOptions {
	baseWidth: number;
	baseHeight: number;
	preference?: GifFitPreference;
	targetMaxBytes?: number;
	/** Encode a GIF with the given settings; return byte size (and optionally path side-effects). */
	encode: (settings: GifFitCandidateSettings) => Promise<number>;
	onAttempt?: (info: {
		attempt: number;
		settings: GifFitCandidateSettings;
		bytes: number;
	}) => void;
	signal?: { cancelled?: boolean };
}

type Dial = "colors" | "scale" | "fps";

/** Outer loop order: sacrifice first → protect last. */
export const GIF_FIT_SEARCH_ORDER: Record<GifFitPreference, readonly Dial[]> = {
	resolution: ["colors", "fps", "scale"],
	smoothness: ["colors", "scale", "fps"],
	colors: ["scale", "fps", "colors"],
};

export const GIF_FIT_SCORE_WEIGHTS: Record<
	GifFitPreference,
	{ scale: number; fps: number; colors: number }
> = {
	resolution: { scale: 3, fps: 1, colors: 1 },
	smoothness: { scale: 1, fps: 3, colors: 1 },
	colors: { scale: 1, fps: 1, colors: 3 },
};

export function evenDimension(value: number): number {
	const rounded = Math.max(2, Math.round(value));
	return rounded % 2 === 0 ? rounded : rounded - 1;
}

export function scaleDimensions(
	baseWidth: number,
	baseHeight: number,
	scale: number,
): { width: number; height: number } {
	const clamped = Math.min(GIF_FIT_MAX_SCALE, Math.max(GIF_FIT_MIN_SCALE, scale));
	return {
		width: evenDimension(baseWidth * clamped),
		height: evenDimension(baseHeight * clamped),
	};
}

export function scoreGifFitCandidate(
	candidate: Pick<GifFitCandidateSettings, "fps" | "scale" | "maxColors">,
	preference: GifFitPreference,
): number {
	const weights = GIF_FIT_SCORE_WEIGHTS[preference];
	const scaleTerm = candidate.scale * candidate.scale * weights.scale;
	const fpsTerm = (candidate.fps / 15) * weights.fps;
	const colorsTerm = (Math.log2(Math.max(2, candidate.maxColors)) / 8) * weights.colors;
	return scaleTerm + fpsTerm + colorsTerm;
}

export function estimateScaleForBudget(measuredBytes: number, budgetBytes: number): number {
	if (!Number.isFinite(measuredBytes) || measuredBytes <= 0) {
		return GIF_FIT_MAX_SCALE;
	}
	if (measuredBytes <= budgetBytes) {
		return GIF_FIT_MAX_SCALE;
	}
	const predicted = Math.sqrt(budgetBytes / measuredBytes);
	return Math.min(GIF_FIT_MAX_SCALE, Math.max(GIF_FIT_MIN_SCALE, predicted));
}

function buildSettings(
	baseWidth: number,
	baseHeight: number,
	fps: number,
	scale: number,
	maxColors: number,
): GifFitCandidateSettings {
	const dims = scaleDimensions(baseWidth, baseHeight, scale);
	return {
		fps,
		scale,
		maxColors,
		width: dims.width,
		height: dims.height,
	};
}

/**
 * Binary-search scale for fixed fps/colors to land just under the budget.
 */
async function binarySearchScale(options: {
	baseWidth: number;
	baseHeight: number;
	fps: number;
	maxColors: number;
	budgetBytes: number;
	initialScale: number;
	encode: GifSizeFitOptions["encode"];
	onAttempt?: GifSizeFitOptions["onAttempt"];
	signal?: GifSizeFitOptions["signal"];
	attemptCounter: { value: number };
}): Promise<GifFitCandidateResult | null> {
	let low = GIF_FIT_MIN_SCALE;
	let high = Math.min(GIF_FIT_MAX_SCALE, Math.max(GIF_FIT_MIN_SCALE, options.initialScale));
	let best: GifFitCandidateResult | null = null;

	for (let i = 0; i < 5; i += 1) {
		if (options.signal?.cancelled) {
			throw new Error("GIF size-fit cancelled");
		}
		const scale = i === 0 ? high : (low + high) / 2;
		const settings = buildSettings(
			options.baseWidth,
			options.baseHeight,
			options.fps,
			scale,
			options.maxColors,
		);
		options.attemptCounter.value += 1;
		const bytes = await options.encode(settings);
		options.onAttempt?.({
			attempt: options.attemptCounter.value,
			settings,
			bytes,
		});

		if (bytes <= options.budgetBytes) {
			best = { ...settings, bytes };
			low = scale;
		} else {
			high = scale;
		}

		if (Math.abs(high - low) < 0.03) {
			break;
		}
	}

	return best;
}

function enumerateScaleSteps(predictedScale: number): number[] {
	const raw = [GIF_FIT_MAX_SCALE, predictedScale, 0.75, 0.55, GIF_FIT_MIN_SCALE];
	const unique = Array.from(
		new Set(
			raw.map((value) =>
				Math.min(GIF_FIT_MAX_SCALE, Math.max(GIF_FIT_MIN_SCALE, Number(value.toFixed(3)))),
			),
		),
	);
	return unique.sort((a, b) => b - a);
}

function enumerateFixedDialValues(dial: Dial, predictedScale: number): number[] {
	if (dial === "fps") {
		return [...GIF_FIT_FPS_STEPS];
	}
	if (dial === "colors") {
		return [...GIF_FIT_COLOR_STEPS];
	}
	return enumerateScaleSteps(predictedScale);
}

/**
 * Fit a GIF under a byte budget by toning down colors, resolution, and FPS
 * according to the caller's preference.
 */
export async function fitGifUnderBudget(options: GifSizeFitOptions): Promise<GifFitResult> {
	const preference = options.preference ?? "resolution";
	const budgetBytes = Math.min(
		options.targetMaxBytes ?? GITHUB_GIF_SAFE_BUDGET_BYTES,
		GITHUB_GIF_SAFE_BUDGET_BYTES,
	);
	const attemptCounter = { value: 0 };
	const order = GIF_FIT_SEARCH_ORDER[preference];

	const probe = buildSettings(
		options.baseWidth,
		options.baseHeight,
		GIF_FIT_FPS_STEPS[0],
		GIF_FIT_MAX_SCALE,
		GIF_FIT_COLOR_STEPS[0],
	);
	attemptCounter.value += 1;
	const probeBytes = await options.encode(probe);
	options.onAttempt?.({ attempt: attemptCounter.value, settings: probe, bytes: probeBytes });

	if (probeBytes <= budgetBytes) {
		return {
			settings: probe,
			bytes: probeBytes,
			overBudget: false,
			preference,
			attempts: attemptCounter.value,
		};
	}

	const predictedScale = estimateScaleForBudget(probeBytes, budgetBytes);
	let bestUnderBudget: GifFitCandidateResult | null = null;
	let smallestAttempt: GifFitCandidateResult = { ...probe, bytes: probeBytes };

	const fixedA = order[0];
	const fixedB = order[1];
	const freeDial = order[2];

	const aList = enumerateFixedDialValues(fixedA, predictedScale);
	const bList = enumerateFixedDialValues(fixedB, predictedScale);

	for (const valueA of aList) {
		for (const valueB of bList) {
			if (options.signal?.cancelled) {
				throw new Error("GIF size-fit cancelled");
			}

			let fps: number = GIF_FIT_FPS_STEPS[0];
			let maxColors: number = GIF_FIT_COLOR_STEPS[0];
			let scaleHint = predictedScale;

			if (fixedA === "fps") fps = valueA;
			if (fixedA === "colors") maxColors = valueA;
			if (fixedA === "scale") scaleHint = valueA;

			if (fixedB === "fps") fps = valueB;
			if (fixedB === "colors") maxColors = valueB;
			if (fixedB === "scale") scaleHint = valueB;

			if (freeDial === "scale") {
				const found = await binarySearchScale({
					baseWidth: options.baseWidth,
					baseHeight: options.baseHeight,
					fps,
					maxColors,
					budgetBytes,
					initialScale: scaleHint,
					encode: options.encode,
					onAttempt: options.onAttempt,
					signal: options.signal,
					attemptCounter,
				});
				if (found) {
					if (
						!bestUnderBudget ||
						scoreGifFitCandidate(found, preference) >
							scoreGifFitCandidate(bestUnderBudget, preference)
					) {
						bestUnderBudget = found;
					}
					if (found.bytes < smallestAttempt.bytes) {
						smallestAttempt = found;
					}
				} else {
					// Record the floor attempt for over-budget reporting.
					const floor = buildSettings(
						options.baseWidth,
						options.baseHeight,
						fps,
						GIF_FIT_MIN_SCALE,
						maxColors,
					);
					attemptCounter.value += 1;
					const floorBytes = await options.encode(floor);
					options.onAttempt?.({
						attempt: attemptCounter.value,
						settings: floor,
						bytes: floorBytes,
					});
					if (floorBytes < smallestAttempt.bytes) {
						smallestAttempt = { ...floor, bytes: floorBytes };
					}
					if (floorBytes <= budgetBytes) {
						const asResult = { ...floor, bytes: floorBytes };
						if (
							!bestUnderBudget ||
							scoreGifFitCandidate(asResult, preference) >
								scoreGifFitCandidate(bestUnderBudget, preference)
						) {
							bestUnderBudget = asResult;
						}
					}
				}
			} else {
				// Free dial is fps or colors — walk that ladder at the predicted scale.
				const freeValues = enumerateFixedDialValues(freeDial, predictedScale);
				for (const freeValue of freeValues) {
					if (freeDial === "fps") fps = freeValue;
					if (freeDial === "colors") maxColors = freeValue;

					const settings = buildSettings(
						options.baseWidth,
						options.baseHeight,
						fps,
						scaleHint,
						maxColors,
					);
					attemptCounter.value += 1;
					const bytes = await options.encode(settings);
					options.onAttempt?.({
						attempt: attemptCounter.value,
						settings,
						bytes,
					});

					const result = { ...settings, bytes };
					if (bytes < smallestAttempt.bytes) {
						smallestAttempt = result;
					}
					if (bytes <= budgetBytes) {
						if (
							!bestUnderBudget ||
							scoreGifFitCandidate(result, preference) >
								scoreGifFitCandidate(bestUnderBudget, preference)
						) {
							bestUnderBudget = result;
						}
						break;
					}
				}
			}

			// Once we have a strong under-budget candidate for this preference,
			// we can stop walking lower-quality outer dials.
			if (bestUnderBudget && bestUnderBudget.scale >= predictedScale * 0.9) {
				break;
			}
		}
		if (bestUnderBudget && bestUnderBudget.scale >= predictedScale * 0.95) {
			break;
		}
	}

	if (bestUnderBudget) {
		return {
			settings: bestUnderBudget,
			bytes: bestUnderBudget.bytes,
			overBudget: false,
			preference,
			attempts: attemptCounter.value,
		};
	}

	return {
		settings: smallestAttempt,
		bytes: smallestAttempt.bytes,
		overBudget: true,
		preference,
		attempts: attemptCounter.value,
	};
}
