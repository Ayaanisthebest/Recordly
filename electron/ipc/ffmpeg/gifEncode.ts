import type { GifFitPreference } from "../../../src/lib/exporter/types";

export interface GithubGifEncodeOptions {
	width: number;
	height: number;
	fps: number;
	maxColors: number;
	loop: boolean;
}

/**
 * Build ffmpeg args for a palettegen/paletteuse GIF encode from a video file.
 */
export function buildGithubGifArgs(
	inputPath: string,
	outputPath: string,
	options: GithubGifEncodeOptions,
): string[] {
	const width = Math.max(2, Math.round(options.width));
	const height = Math.max(2, Math.round(options.height));
	const evenWidth = width % 2 === 0 ? width : width - 1;
	const evenHeight = height % 2 === 0 ? height : height - 1;
	const fps = Math.max(1, Math.round(options.fps));
	const maxColors = Math.min(256, Math.max(2, Math.round(options.maxColors)));
	// FFmpeg GIF loop: -1 = infinite, 0 = play once? Actually for -loop on GIF output:
	// -loop 0 = infinite, -loop 1 = play once. (differs from gif.js repeat!)
	const loop = options.loop ? 0 : 1;

	const filter =
		`fps=${fps},scale=${evenWidth}:${evenHeight}:flags=lanczos,split[s0][s1];` +
		`[s0]palettegen=max_colors=${maxColors}:stats_mode=diff[p];` +
		`[s1][p]paletteuse=dither=bayer:bayer_scale=5`;

	return [
		"-y",
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		inputPath,
		"-an",
		"-vf",
		filter,
		"-loop",
		String(loop),
		outputPath,
	];
}

export type { GifFitPreference };
