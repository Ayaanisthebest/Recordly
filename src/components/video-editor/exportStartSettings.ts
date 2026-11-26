import {
	calculateOutputDimensions,
	type ExportBackendPreference,
	type ExportEncodingMode,
	type ExportFormat,
	type ExportMp4FrameRate,
	type ExportPipelineModel,
	type ExportQuality,
	type ExportSettings,
	type GifExportMode,
	type GifFitPreference,
	GIF_SIZE_PRESETS,
	type GifFrameRate,
	type GifSizePreset,
	GITHUB_GIF_MAX_BYTES,
} from "@/lib/exporter";

export function resolveExportStartSettings({
	sourceWidth,
	sourceHeight,
	exportFormat,
	includeCaptionSidecar,
	exportEncodingMode,
	exportQuality,
	mp4FrameRate,
	exportBackendPreference,
	exportPipelineModel,
	gifFrameRate,
	gifLoop,
	gifSizePreset,
	gifExportMode = "manual",
	gifFitPreference = "resolution",
}: {
	sourceWidth: number;
	sourceHeight: number;
	exportFormat: ExportFormat;
	includeCaptionSidecar: boolean;
	exportEncodingMode: ExportEncodingMode;
	exportQuality: ExportQuality;
	mp4FrameRate: ExportMp4FrameRate;
	exportBackendPreference: ExportBackendPreference;
	exportPipelineModel: ExportPipelineModel;
	gifFrameRate: GifFrameRate;
	gifLoop: boolean;
	gifSizePreset: GifSizePreset;
	gifExportMode?: GifExportMode;
	gifFitPreference?: GifFitPreference;
}): ExportSettings {
	const isGithubGif = exportFormat === "gif" && gifExportMode === "github";
	const effectiveGifPreset: GifSizePreset = isGithubGif ? "medium" : gifSizePreset;
	const effectiveGifFrameRate: GifFrameRate = isGithubGif ? 15 : gifFrameRate;

	const gifDimensions =
		exportFormat === "gif"
			? calculateOutputDimensions(
					sourceWidth,
					sourceHeight,
					effectiveGifPreset,
					GIF_SIZE_PRESETS,
				)
			: null;

	return {
		format: exportFormat,
		includeCaptionSidecar: exportFormat === "mp4" ? includeCaptionSidecar : false,
		encodingMode: exportFormat === "mp4" ? exportEncodingMode : undefined,
		mp4FrameRate: exportFormat === "mp4" ? mp4FrameRate : undefined,
		backendPreference: exportFormat === "mp4" ? exportBackendPreference : undefined,
		pipelineModel: exportFormat === "mp4" ? exportPipelineModel : undefined,
		quality: exportFormat === "mp4" ? exportQuality : undefined,
		gifConfig:
			exportFormat === "gif" && gifDimensions
				? {
						frameRate: effectiveGifFrameRate,
						loop: gifLoop,
						sizePreset: effectiveGifPreset,
						width: gifDimensions.width,
						height: gifDimensions.height,
						mode: gifExportMode,
						fitPreference: isGithubGif ? gifFitPreference : undefined,
						targetMaxBytes: isGithubGif ? GITHUB_GIF_MAX_BYTES : undefined,
					}
				: undefined,
	};
}
