import type {
	AnnotationRegion,
	AutoCaptionSettings,
	CaptionCue,
	CursorClickEffectStyle,
	CropRegion,
	CursorStyle,
	CursorTelemetryPoint,
	Padding,
	SpeedRegion,
	TrimRegion,
	WebcamOverlaySettings,
	ZoomMotionBlurTuning,
	ZoomRegion,
	ZoomTransitionEasing,
} from "@/components/video-editor/types";
import { buildGifFrameRendererConfig } from "./gifExporter";
import { FrameRenderer } from "./frameRenderer";
import { GITHUB_GIF_SAFE_BUDGET_BYTES } from "./gifSizeFit";
import { StreamingVideoDecoder } from "./streamingDecoder";
import type {
	ExportProgress,
	ExportResult,
	GifFitPreference,
	GifFrameRate,
	GifSizePreset,
} from "./types";
import { GITHUB_GIF_MAX_BYTES } from "./types";

const PROGRESS_SAMPLE_WINDOW_MS = 1_000;
const ASPIRATIONAL_GITHUB_FPS: GifFrameRate = 15;

interface GithubGifExporterConfig {
	videoUrl: string;
	width: number;
	height: number;
	frameRate: GifFrameRate;
	loop: boolean;
	sizePreset: GifSizePreset;
	fitPreference?: GifFitPreference;
	targetMaxBytes?: number;
	wallpaper: string;
	zoomRegions: ZoomRegion[];
	trimRegions?: TrimRegion[];
	speedRegions?: SpeedRegion[];
	showShadow: boolean;
	shadowIntensity: number;
	backgroundBlur: number;
	zoomMotionBlur?: number;
	zoomMotionBlurTuning?: ZoomMotionBlurTuning;
	zoomTemporalMotionBlur?: number;
	zoomMotionBlurSampleCount?: number | null;
	zoomMotionBlurShutterFraction?: number | null;
	connectZooms?: boolean;
	zoomInDurationMs?: number;
	zoomInOverlapMs?: number;
	zoomOutDurationMs?: number;
	connectedZoomGapMs?: number;
	connectedZoomDurationMs?: number;
	zoomInEasing?: ZoomTransitionEasing;
	zoomOutEasing?: ZoomTransitionEasing;
	connectedZoomEasing?: ZoomTransitionEasing;
	borderRadius?: number;
	padding?: Padding | number;
	videoPadding?: Padding | number;
	cropRegion: CropRegion;
	webcam?: WebcamOverlaySettings;
	webcamUrl?: string | null;
	annotationRegions?: AnnotationRegion[];
	autoCaptions?: CaptionCue[];
	autoCaptionSettings?: AutoCaptionSettings;
	cursorTelemetry?: CursorTelemetryPoint[];
	showCursor?: boolean;
	cursorStyle?: CursorStyle;
	cursorSize?: number;
	cursorSmoothing?: number;
	cursorSpringStiffnessMultiplier?: number;
	cursorSpringDampingMultiplier?: number;
	cursorSpringMassMultiplier?: number;
	cameraSpringStiffnessMultiplier?: number;
	cameraSpringDampingMultiplier?: number;
	cameraSpringMassMultiplier?: number;
	zoomSmoothness?: number;
	zoomClassicMode?: boolean;
	cursorMotionBlur?: number;
	cursorClickEffect?: CursorClickEffectStyle;
	cursorClickEffectColor?: string;
	cursorClickEffectScale?: number;
	cursorClickEffectOpacity?: number;
	cursorClickEffectDurationMs?: number;
	cursorClickBounce?: number;
	cursorClickBounceDuration?: number;
	cursorSway?: number;
	frame?: string | null;
	previewWidth?: number;
	previewHeight?: number;
	maxDecodeQueue?: number;
	maxPendingFrames?: number;
	onProgress?: (progress: ExportProgress) => void;
}

/**
 * Renders the editor scene once to a temp MP4, then uses FFmpeg size-fit
 * to produce a GitHub-budget GIF (≤10MB).
 */
export class GithubGifExporter {
	private config: GithubGifExporterConfig;
	private streamingDecoder: StreamingVideoDecoder | null = null;
	private renderer: FrameRenderer | null = null;
	private cancelled = false;
	private nativeSessionId: string | null = null;
	private gifFitSessionId: string | null = null;
	private unsubscribeFitProgress: (() => void) | null = null;
	private exportStartTimeMs = 0;
	private progressSampleStartTimeMs = 0;
	private progressSampleStartFrame = 0;

	constructor(config: GithubGifExporterConfig) {
		this.config = {
			...config,
			frameRate: ASPIRATIONAL_GITHUB_FPS,
		};
	}

	async export(): Promise<ExportResult> {
		let intermediatePath: string | null = null;
		try {
			this.cleanupSessions();
			this.cancelled = false;
			this.exportStartTimeMs = this.getNowMs();
			this.progressSampleStartTimeMs = this.exportStartTimeMs;
			this.progressSampleStartFrame = 0;

			if (
				typeof window === "undefined" ||
				!window.electronAPI?.nativeVideoExportStart ||
				!window.electronAPI?.encodeGifUnderBudget
			) {
				return {
					success: false,
					error: "GitHub GIF export requires the desktop FFmpeg export path",
				};
			}

			this.streamingDecoder = new StreamingVideoDecoder({
				maxDecodeQueue: this.config.maxDecodeQueue,
				maxPendingFrames: this.config.maxPendingFrames,
			});
			const videoInfo = await this.streamingDecoder.loadMetadata(this.config.videoUrl);
			this.renderer = new FrameRenderer(buildGifFrameRendererConfig(this.config, videoInfo));
			await this.renderer.initialize();

			const startResult = await window.electronAPI.nativeVideoExportStart({
				width: this.config.width,
				height: this.config.height,
				frameRate: this.config.frameRate,
				bitrate: 8_000_000,
				encodingMode: "fast",
				inputMode: "rawvideo",
			});
			if (!startResult.success || !startResult.sessionId) {
				return {
					success: false,
					error: startResult.error || "Failed to start intermediate native export",
				};
			}
			this.nativeSessionId = startResult.sessionId;

			const effectiveDuration = this.streamingDecoder.getEffectiveDuration(
				this.config.trimRegions,
				this.config.speedRegions,
			);
			const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
			const frameDurationUs = 1_000_000 / this.config.frameRate;
			let frameIndex = 0;

			await this.streamingDecoder.decodeAll(
				this.config.frameRate,
				this.config.trimRegions,
				this.config.speedRegions,
				async (videoFrame, _exportTimestampUs, sourceTimestampMs, cursorTimestampMs) => {
					if (this.cancelled) {
						return;
					}

					await this.renderer!.renderFrame(
						videoFrame,
						sourceTimestampMs * 1000,
						cursorTimestampMs * 1000,
						frameDurationUs,
						frameIndex * frameDurationUs,
					);

					const canvas = this.renderer!.getCanvas();
					const context = canvas.getContext("2d", { willReadFrequently: true });
					if (!context) {
						throw new Error("Failed to read rendered frame pixels");
					}
					const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
					const writeResult = await window.electronAPI.nativeVideoExportWriteFrame(
						this.nativeSessionId!,
						new Uint8Array(imageData.data.buffer.slice(0)),
					);
					if (!writeResult.success && !this.cancelled) {
						throw new Error(writeResult.error || "Failed to write intermediate frame");
					}

					frameIndex += 1;
					this.reportRenderProgress(frameIndex, totalFrames);
				},
			);

			if (this.cancelled) {
				return { success: false, error: "Export cancelled" };
			}

			const sessionId = this.nativeSessionId;
			this.nativeSessionId = null;
			const finishResult = await window.electronAPI.nativeVideoExportFinish(sessionId!, {
				audioMode: "none",
			});
			if (!finishResult.success || !finishResult.tempPath) {
				return {
					success: false,
					error: finishResult.error || "Failed to finalize intermediate video",
				};
			}
			intermediatePath = finishResult.tempPath;

			this.config.onProgress?.({
				currentFrame: totalFrames,
				totalFrames,
				percentage: 100,
				estimatedTimeRemaining: 0,
				phase: "finalizing",
				encodeBackend: "ffmpeg",
				renderProgress: 0,
			});

			this.unsubscribeFitProgress = window.electronAPI.onEncodeGifUnderBudgetProgress?.(
				(progress) => {
					this.gifFitSessionId = progress.sessionId;
					const mb = (progress.bytes / (1024 * 1024)).toFixed(1);
					this.config.onProgress?.({
						currentFrame: totalFrames,
						totalFrames,
						percentage: 100,
						estimatedTimeRemaining: 0,
						phase: "finalizing",
						encodeBackend: "ffmpeg",
						renderProgress: Math.min(99, progress.attempt * 8),
						encoderName: `${progress.settings.fps}fps · ${progress.settings.width}×${progress.settings.height} · ${progress.settings.maxColors}c · ${mb}MB`,
					});
				},
			);

			const fitResult = await window.electronAPI.encodeGifUnderBudget({
				inputPath: intermediatePath,
				baseWidth: this.config.width,
				baseHeight: this.config.height,
				loop: this.config.loop,
				preference: this.config.fitPreference ?? "resolution",
				targetMaxBytes: Math.min(
					this.config.targetMaxBytes ?? GITHUB_GIF_SAFE_BUDGET_BYTES,
					GITHUB_GIF_MAX_BYTES,
				),
			});
			if (fitResult.sessionId) {
				this.gifFitSessionId = fitResult.sessionId;
			}

			if (!fitResult.success || !fitResult.tempPath || !fitResult.settings) {
				return {
					success: false,
					error: fitResult.error || "Failed to fit GIF under GitHub size budget",
				};
			}

			return {
				success: true,
				tempFilePath: fitResult.tempPath,
				githubGifFit: {
					bytes: fitResult.bytes ?? 0,
					overBudget: Boolean(fitResult.overBudget),
					preference: fitResult.preference ?? this.config.fitPreference ?? "resolution",
					fps: fitResult.settings.fps,
					width: fitResult.settings.width,
					height: fitResult.settings.height,
					maxColors: fitResult.settings.maxColors,
					attempts: fitResult.attempts ?? 0,
				},
			};
		} catch (error) {
			console.error("GitHub GIF Export error:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (intermediatePath) {
				void window.electronAPI?.discardExportedTemp?.(intermediatePath);
			}
			this.cleanup();
		}
	}

	cancel(): void {
		this.cancelled = true;
		this.streamingDecoder?.cancel();
		if (this.nativeSessionId) {
			void window.electronAPI?.nativeVideoExportCancel?.(this.nativeSessionId);
			this.nativeSessionId = null;
		}
		if (this.gifFitSessionId) {
			void window.electronAPI?.encodeGifUnderBudgetCancel?.(this.gifFitSessionId);
			this.gifFitSessionId = null;
		}
		this.cleanup();
	}

	private reportRenderProgress(currentFrame: number, totalFrames: number) {
		const nowMs = this.getNowMs();
		const elapsedSeconds = Math.max((nowMs - this.exportStartTimeMs) / 1000, 0.001);
		const averageRenderFps = currentFrame / elapsedSeconds;
		const sampleElapsedMs = Math.max(nowMs - this.progressSampleStartTimeMs, 1);
		const sampleFrameDelta = Math.max(currentFrame - this.progressSampleStartFrame, 0);
		const renderFps = (sampleFrameDelta * 1000) / sampleElapsedMs;
		const remainingFrames = Math.max(totalFrames - currentFrame, 0);
		const estimatedTimeRemaining =
			averageRenderFps > 0 ? remainingFrames / averageRenderFps : 0;

		if (sampleElapsedMs >= PROGRESS_SAMPLE_WINDOW_MS) {
			this.progressSampleStartTimeMs = nowMs;
			this.progressSampleStartFrame = currentFrame;
		}

		this.config.onProgress?.({
			currentFrame,
			totalFrames,
			percentage: totalFrames > 0 ? (currentFrame / totalFrames) * 90 : 90,
			estimatedTimeRemaining,
			renderFps,
			encodeBackend: "ffmpeg",
		});
	}

	private getNowMs(): number {
		return typeof performance !== "undefined" ? performance.now() : Date.now();
	}

	private cleanupSessions(): void {
		this.unsubscribeFitProgress?.();
		this.unsubscribeFitProgress = null;
		this.gifFitSessionId = null;
	}

	private cleanup(): void {
		this.cleanupSessions();
		if (this.streamingDecoder) {
			try {
				this.streamingDecoder.destroy();
			} catch (e) {
				console.warn("Error destroying streaming decoder:", e);
			}
			this.streamingDecoder = null;
		}
		if (this.renderer) {
			try {
				this.renderer.destroy();
			} catch (e) {
				console.warn("Error destroying renderer:", e);
			}
			this.renderer = null;
		}
	}
}
