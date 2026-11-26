import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import {
	fitGifUnderBudget,
	type GifFitCandidateSettings,
	type GifFitResult,
	GITHUB_GIF_SAFE_BUDGET_BYTES,
} from "../../../src/lib/exporter/gifSizeFit";
import type { GifFitPreference } from "../../../src/lib/exporter/types";
import { GITHUB_GIF_MAX_BYTES } from "../../../src/lib/exporter/types";
import { registerOwnedExportPath } from "../export/exportStream";
import { removeTemporaryExportFile } from "../export/native-video";
import { getFfmpegBinaryPath } from "./binary";
import { buildGithubGifArgs } from "./gifEncode";

export interface EncodeGifUnderBudgetOptions {
	inputPath: string;
	baseWidth: number;
	baseHeight: number;
	loop: boolean;
	preference?: GifFitPreference;
	targetMaxBytes?: number;
	onProgress?: (info: {
		phase: "fitting";
		attempt: number;
		settings: GifFitCandidateSettings;
		bytes: number;
		preference: GifFitPreference;
	}) => void;
	signal?: { cancelled?: boolean };
}

export interface EncodeGifUnderBudgetResult {
	success: boolean;
	tempPath?: string;
	bytes?: number;
	settings?: GifFitCandidateSettings;
	preference?: GifFitPreference;
	overBudget?: boolean;
	attempts?: number;
	error?: string;
}

async function runFfmpeg(args: string[]): Promise<void> {
	const ffmpegPath = getFfmpegBinaryPath();
	await new Promise<void>((resolve, reject) => {
		const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		proc.once("error", reject);
		proc.once("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
		});
	});
}

/**
 * Encode an input video to a GitHub-budget GIF, searching settings via fitGifUnderBudget.
 * Returns an app-owned temp path to the winning GIF.
 */
export async function encodeGifUnderBudget(
	options: EncodeGifUnderBudgetOptions,
): Promise<EncodeGifUnderBudgetResult> {
	const preference = options.preference ?? "resolution";
	const budget = Math.min(
		options.targetMaxBytes ?? GITHUB_GIF_SAFE_BUDGET_BYTES,
		GITHUB_GIF_SAFE_BUDGET_BYTES,
	);
	const workDir = path.join(
		app.getPath("temp"),
		`recordly-gif-fit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const candidates: string[] = [];

	try {
		await fs.mkdir(workDir, { recursive: true });

		const encode = async (settings: GifFitCandidateSettings): Promise<number> => {
			if (options.signal?.cancelled) {
				throw new Error("GIF size-fit cancelled");
			}
			const outputPath = path.join(
				workDir,
				`c-${settings.fps}fps-${settings.width}x${settings.height}-c${settings.maxColors}.gif`,
			);
			const args = buildGithubGifArgs(options.inputPath, outputPath, {
				width: settings.width,
				height: settings.height,
				fps: settings.fps,
				maxColors: settings.maxColors,
				loop: options.loop,
			});
			await runFfmpeg(args);
			const stat = await fs.stat(outputPath);
			candidates.push(outputPath);
			return stat.size;
		};

		const fit: GifFitResult = await fitGifUnderBudget({
			baseWidth: options.baseWidth,
			baseHeight: options.baseHeight,
			preference,
			targetMaxBytes: budget,
			encode,
			signal: options.signal,
			onAttempt: (info) => {
				options.onProgress?.({
					phase: "fitting",
					attempt: info.attempt,
					settings: info.settings,
					bytes: info.bytes,
					preference,
				});
			},
		});

		const winnerName = `c-${fit.settings.fps}fps-${fit.settings.width}x${fit.settings.height}-c${fit.settings.maxColors}.gif`;
		const winnerPath = path.join(workDir, winnerName);
		await fs.access(winnerPath);

		const finalTempPath = path.join(
			app.getPath("temp"),
			`recordly-github-gif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gif`,
		);
		await fs.rename(winnerPath, finalTempPath);
		registerOwnedExportPath(finalTempPath);

		// Cleanup losers + work dir
		for (const candidate of candidates) {
			if (candidate !== winnerPath) {
				await removeTemporaryExportFile(candidate);
			}
		}
		try {
			await fs.rm(workDir, { recursive: true, force: true });
		} catch {
			// ignore
		}

		return {
			success: true,
			tempPath: finalTempPath,
			bytes: fit.bytes,
			settings: fit.settings,
			preference: fit.preference,
			overBudget: fit.overBudget,
			attempts: fit.attempts,
		};
	} catch (error) {
		for (const candidate of candidates) {
			await removeTemporaryExportFile(candidate);
		}
		try {
			await fs.rm(workDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			preference,
		};
	}
}

export { GITHUB_GIF_MAX_BYTES, GITHUB_GIF_SAFE_BUDGET_BYTES };
