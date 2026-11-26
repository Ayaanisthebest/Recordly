import { describe, expect, it } from "vitest";
import {
	estimateScaleForBudget,
	fitGifUnderBudget,
	GIF_FIT_MIN_SCALE,
	GITHUB_GIF_SAFE_BUDGET_BYTES,
	scoreGifFitCandidate,
} from "./gifSizeFit";

describe("gifSizeFit", () => {
	it("returns probe settings when already under budget", async () => {
		const result = await fitGifUnderBudget({
			baseWidth: 1280,
			baseHeight: 720,
			preference: "resolution",
			encode: async () => 1_000_000,
		});

		expect(result.overBudget).toBe(false);
		expect(result.settings.fps).toBe(15);
		expect(result.settings.scale).toBe(1);
		expect(result.settings.maxColors).toBe(256);
		expect(result.attempts).toBe(1);
	});

	it("estimates scale from the budget ratio", () => {
		expect(estimateScaleForBudget(40_000_000, 10_000_000)).toBeCloseTo(0.5, 5);
		expect(estimateScaleForBudget(5_000_000, 10_000_000)).toBe(1);
	});

	it("prefers resolution over fps when preference is resolution", async () => {
		const result = await fitGifUnderBudget({
			baseWidth: 1280,
			baseHeight: 720,
			preference: "resolution",
			targetMaxBytes: GITHUB_GIF_SAFE_BUDGET_BYTES,
			encode: async (settings) => {
				// Size model: pixels * fps * colors factor
				return Math.round(
					settings.width *
						settings.height *
						settings.fps *
						(settings.maxColors / 64) *
						0.02,
				);
			},
		});

		expect(result.overBudget).toBe(false);
		expect(result.bytes).toBeLessThanOrEqual(GITHUB_GIF_SAFE_BUDGET_BYTES);
		expect(result.settings.scale).toBeGreaterThanOrEqual(GIF_FIT_MIN_SCALE);
	});

	it("weights smoothness preference toward higher fps", () => {
		const lowFps = scoreGifFitCandidate(
			{ fps: 8, scale: 1, maxColors: 256 },
			"smoothness",
		);
		const highFps = scoreGifFitCandidate(
			{ fps: 15, scale: 0.7, maxColors: 128 },
			"smoothness",
		);
		expect(highFps).toBeGreaterThan(lowFps);
	});

	it("weights resolution preference toward higher scale", () => {
		const lowScale = scoreGifFitCandidate(
			{ fps: 15, scale: 0.4, maxColors: 256 },
			"resolution",
		);
		const highScale = scoreGifFitCandidate(
			{ fps: 10, scale: 0.9, maxColors: 64 },
			"resolution",
		);
		expect(highScale).toBeGreaterThan(lowScale);
	});

	it("marks overBudget when even the floor exceeds the limit", async () => {
		const result = await fitGifUnderBudget({
			baseWidth: 1280,
			baseHeight: 720,
			preference: "colors",
			encode: async () => GITHUB_GIF_SAFE_BUDGET_BYTES + 5_000_000,
		});

		expect(result.overBudget).toBe(true);
		expect(result.bytes).toBeGreaterThan(GITHUB_GIF_SAFE_BUDGET_BYTES);
	});
});
