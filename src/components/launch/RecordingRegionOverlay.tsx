import { useEffect, useMemo, useState } from "react";

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Non-interactive macOS-style recording frame: dim outside the active
 * capture region and outline the area being recorded.
 *
 * Used when a region recording starts without an existing region-select
 * window to promote (the common path keeps RegionSelectOverlay armed instead).
 */
export function RecordingRegionOverlay() {
	const [virtualBounds, setVirtualBounds] = useState<Rect | null>(null);
	const [globalRegion, setGlobalRegion] = useState<Rect | null>(null);
	const [phase, setPhase] = useState<"armed" | "recording">("armed");

	useEffect(() => {
		void window.electronAPI.getRecordingRegionOverlayContext?.().then((context) => {
			if (!context?.success || !context.virtualBounds || !context.globalRegion) {
				return;
			}
			setVirtualBounds(context.virtualBounds);
			setGlobalRegion(context.globalRegion);
			if (context.phase === "armed" || context.phase === "recording") {
				setPhase(context.phase);
			}
		});
	}, []);

	useEffect(() => {
		return window.electronAPI.onRegionFramePhaseChange?.((nextPhase) => {
			if (nextPhase === "armed" || nextPhase === "recording") {
				setPhase(nextPhase);
			}
		});
	}, []);

	const localRegion = useMemo(() => {
		if (!virtualBounds || !globalRegion) return null;
		return {
			x: globalRegion.x - virtualBounds.x,
			y: globalRegion.y - virtualBounds.y,
			width: globalRegion.width,
			height: globalRegion.height,
		};
	}, [virtualBounds, globalRegion]);

	if (!virtualBounds || !localRegion) {
		return <div className="fixed inset-0 pointer-events-none" />;
	}

	return (
		<div className="fixed inset-0 pointer-events-none select-none">
			<div
				className="absolute bg-black/40"
				style={{ left: 0, top: 0, right: 0, height: Math.max(0, localRegion.y) }}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: 0,
					top: localRegion.y + localRegion.height,
					right: 0,
					bottom: 0,
				}}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: 0,
					top: localRegion.y,
					width: Math.max(0, localRegion.x),
					height: localRegion.height,
				}}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: localRegion.x + localRegion.width,
					top: localRegion.y,
					right: 0,
					height: localRegion.height,
				}}
			/>

			<div
				className="absolute"
				style={{
					left: localRegion.x,
					top: localRegion.y,
					width: localRegion.width,
					height: localRegion.height,
					boxShadow:
						"0 0 0 2px rgba(255,255,255,0.95), 0 0 0 3px rgba(37,99,235,0.55), 0 0 18px rgba(37,99,235,0.35)",
				}}
			>
				{phase === "recording" ? (
					<div
						className="absolute left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white"
						style={{
							top: -22,
							background: "rgba(225,29,72,0.92)",
							boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
						}}
					>
						REC
					</div>
				) : null}
			</div>
		</div>
	);
}
