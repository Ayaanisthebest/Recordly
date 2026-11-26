import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
} from "react";

type Rect = { x: number; y: number; width: number; height: number };
type Handle =
	| "move"
	| "n"
	| "s"
	| "e"
	| "w"
	| "ne"
	| "nw"
	| "se"
	| "sw"
	| "create";

const MIN_SIZE = 48;
const LAST_REGION_KEY = "recordly.regionSelect.lastGlobalRect";

function clampRect(rect: Rect, bounds: Rect): Rect {
	const width = Math.max(MIN_SIZE, Math.min(rect.width, bounds.width));
	const height = Math.max(MIN_SIZE, Math.min(rect.height, bounds.height));
	const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - width));
	const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - height));
	return { x, y, width, height };
}

function defaultRectForDisplay(displayBounds: Rect): Rect {
	const width = Math.round(displayBounds.width * 0.62);
	const height = Math.round(displayBounds.height * 0.62);
	return {
		x: Math.round(displayBounds.x + (displayBounds.width - width) / 2),
		y: Math.round(displayBounds.y + (displayBounds.height - height) / 2),
		width,
		height,
	};
}

function loadRememberedRect(fallback: Rect): Rect {
	try {
		const raw = localStorage.getItem(LAST_REGION_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Rect;
		if (
			Number.isFinite(parsed.x) &&
			Number.isFinite(parsed.y) &&
			Number.isFinite(parsed.width) &&
			Number.isFinite(parsed.height)
		) {
			return parsed;
		}
	} catch {
		/* ignore */
	}
	return fallback;
}

/**
 * macOS Cmd+Shift+5–style region picker: dimmed desktop, dashed selection,
 * corner/edge handles, Confirm / Cancel.
 */
export function RegionSelectOverlay() {
	const [ready, setReady] = useState(false);
	const [phase, setPhase] = useState<"select" | "armed" | "recording">("select");
	const [virtualBounds, setVirtualBounds] = useState<Rect | null>(null);
	const [selection, setSelection] = useState<Rect | null>(null);
	const [hoverHandle, setHoverHandle] = useState<Handle | null>(null);
	const dragRef = useRef<{
		handle: Handle;
		startX: number;
		startY: number;
		origin: Rect;
	} | null>(null);
	const confirmingRef = useRef(false);
	const interactive = phase === "select";

	useEffect(() => {
		void window.electronAPI.getRegionSelectContext?.().then((context) => {
			if (!context?.success || !context.virtualBounds) {
				return;
			}
			const bounds = context.virtualBounds;
			setVirtualBounds(bounds);

			const preferred =
				context.displays?.find((d) => d.id === context.preferredDisplayId) ??
				context.displays?.find((d) => d.primary) ??
				context.displays?.[0];
			const preferredBounds = preferred?.bounds ?? bounds;
			const fallback = defaultRectForDisplay(preferredBounds);
			const remembered = loadRememberedRect(fallback);
			setSelection(clampRect(remembered, bounds));
			setReady(true);
		});
	}, []);

	useEffect(() => {
		return window.electronAPI.onRegionFramePhaseChange?.((nextPhase) => {
			if (nextPhase === "select" || nextPhase === "armed" || nextPhase === "recording") {
				setPhase(nextPhase);
			}
		});
	}, []);

	const confirm = useCallback(async () => {
		if (!selection || !interactive || confirmingRef.current) return;
		confirmingRef.current = true;
		try {
			localStorage.setItem(LAST_REGION_KEY, JSON.stringify(selection));
		} catch {
			/* ignore */
		}
		try {
			await window.electronAPI.confirmRegionSelect?.(selection);
		} finally {
			// Keep locked — window arms / closes after a successful confirm.
			confirmingRef.current = true;
		}
	}, [interactive, selection]);

	const cancel = useCallback(async () => {
		if (!interactive || confirmingRef.current) return;
		await window.electronAPI.cancelRegionSelect?.();
	}, [interactive]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!interactive) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				void cancel();
			} else if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				void confirm();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [cancel, confirm, interactive]);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent, handle: Handle) => {
			if (!interactive || !selection || !virtualBounds) return;
			event.preventDefault();
			event.stopPropagation();
			(event.target as HTMLElement).setPointerCapture?.(event.pointerId);
			const globalX = Number.isFinite(event.screenX)
				? event.screenX
				: event.clientX + virtualBounds.x;
			const globalY = Number.isFinite(event.screenY)
				? event.screenY
				: event.clientY + virtualBounds.y;
			dragRef.current = {
				handle,
				startX: globalX,
				startY: globalY,
				origin: { ...selection },
			};
		},
		[interactive, selection, virtualBounds],
	);

	const onBackgroundPointerDown = useCallback(
		(event: ReactPointerEvent) => {
			if (!interactive || !virtualBounds) return;
			const globalX = Number.isFinite(event.screenX)
				? event.screenX
				: event.clientX + virtualBounds.x;
			const globalY = Number.isFinite(event.screenY)
				? event.screenY
				: event.clientY + virtualBounds.y;
			const origin = { x: globalX, y: globalY, width: 0, height: 0 };
			setSelection(origin);
			dragRef.current = {
				handle: "create",
				startX: globalX,
				startY: globalY,
				origin,
			};
			(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
		},
		[interactive, virtualBounds],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent) => {
			if (!interactive || !dragRef.current || !virtualBounds) return;
			const { handle, startX, startY, origin } = dragRef.current;
			const globalX = Number.isFinite(event.screenX)
				? event.screenX
				: event.clientX + virtualBounds.x;
			const globalY = Number.isFinite(event.screenY)
				? event.screenY
				: event.clientY + virtualBounds.y;
			const dx = globalX - startX;
			const dy = globalY - startY;

			let next = { ...origin };

			if (handle === "create") {
				next = {
					x: Math.min(startX, globalX),
					y: Math.min(startY, globalY),
					width: Math.abs(dx),
					height: Math.abs(dy),
				};
			} else if (handle === "move") {
				next.x = origin.x + dx;
				next.y = origin.y + dy;
			} else {
				if (handle.includes("e")) {
					next.width = origin.width + dx;
				}
				if (handle.includes("s")) {
					next.height = origin.height + dy;
				}
				if (handle.includes("w")) {
					next.x = origin.x + dx;
					next.width = origin.width - dx;
				}
				if (handle.includes("n")) {
					next.y = origin.y + dy;
					next.height = origin.height - dy;
				}
				if (next.width < MIN_SIZE) {
					if (handle.includes("w")) {
						next.x = origin.x + origin.width - MIN_SIZE;
					}
					next.width = MIN_SIZE;
				}
				if (next.height < MIN_SIZE) {
					if (handle.includes("n")) {
						next.y = origin.y + origin.height - MIN_SIZE;
					}
					next.height = MIN_SIZE;
				}
			}

			setSelection(clampRect(next, virtualBounds));
		},
		[interactive, virtualBounds],
	);

	const onPointerUp = useCallback(() => {
		dragRef.current = null;
	}, []);

	const localSelection = useMemo(() => {
		if (!selection || !virtualBounds) return null;
		return {
			x: selection.x - virtualBounds.x,
			y: selection.y - virtualBounds.y,
			width: selection.width,
			height: selection.height,
		};
	}, [selection, virtualBounds]);

	if (!ready || !virtualBounds || !localSelection) {
		return (
			<div
				className="fixed inset-0 bg-black/35"
				onClick={interactive ? () => void cancel() : undefined}
			/>
		);
	}

	const handlePositions: Array<{ id: Handle; style: CSSProperties; cursor: string }> = [
		{ id: "nw", style: { left: -5, top: -5 }, cursor: "nwse-resize" },
		{ id: "n", style: { left: "50%", top: -5, transform: "translateX(-50%)" }, cursor: "ns-resize" },
		{ id: "ne", style: { right: -5, top: -5 }, cursor: "nesw-resize" },
		{ id: "e", style: { right: -5, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
		{ id: "se", style: { right: -5, bottom: -5 }, cursor: "nwse-resize" },
		{ id: "s", style: { left: "50%", bottom: -5, transform: "translateX(-50%)" }, cursor: "ns-resize" },
		{ id: "sw", style: { left: -5, bottom: -5 }, cursor: "nesw-resize" },
		{ id: "w", style: { left: -5, top: "50%", transform: "translateY(-50%)" }, cursor: "ew-resize" },
	];

	const frameShadow = interactive
		? "0 0 0 1px rgba(255,255,255,0.95), inset 0 0 0 1px rgba(0,0,0,0.25)"
		: "0 0 0 2px rgba(255,255,255,0.95), 0 0 0 3px rgba(37,99,235,0.55), 0 0 18px rgba(37,99,235,0.35)";

	return (
		<div
			className="fixed inset-0 select-none"
			style={{
				cursor: interactive && hoverHandle === "create" ? "crosshair" : "default",
				pointerEvents: interactive ? "auto" : "none",
			}}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		>
			{/* Dimmed overlays around the selection (4 panes) */}
			<div
				className="absolute bg-black/40"
				style={{ left: 0, top: 0, right: 0, height: Math.max(0, localSelection.y) }}
				onPointerDown={onBackgroundPointerDown}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: 0,
					top: localSelection.y + localSelection.height,
					right: 0,
					bottom: 0,
				}}
				onPointerDown={onBackgroundPointerDown}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: 0,
					top: localSelection.y,
					width: Math.max(0, localSelection.x),
					height: localSelection.height,
				}}
				onPointerDown={onBackgroundPointerDown}
			/>
			<div
				className="absolute bg-black/40"
				style={{
					left: localSelection.x + localSelection.width,
					top: localSelection.y,
					right: 0,
					height: localSelection.height,
				}}
				onPointerDown={onBackgroundPointerDown}
			/>

			{/* Selection / recording frame */}
			<div
				className="absolute"
				style={{
					left: localSelection.x,
					top: localSelection.y,
					width: localSelection.width,
					height: localSelection.height,
					boxShadow: frameShadow,
					outline: interactive ? "1px dashed rgba(255,255,255,0.85)" : undefined,
					outlineOffset: interactive ? "-1px" : undefined,
					cursor: interactive ? "move" : "default",
				}}
				onPointerDown={(event) => onPointerDown(event, "move")}
				onPointerEnter={() => interactive && setHoverHandle("move")}
				onPointerLeave={() => setHoverHandle(null)}
			>
				{interactive &&
					handlePositions.map((handle) => (
						<div
							key={handle.id}
							onPointerDown={(event) => onPointerDown(event, handle.id)}
							onPointerEnter={() => setHoverHandle(handle.id)}
							onPointerLeave={() => setHoverHandle(null)}
							style={{
								position: "absolute",
								width: 10,
								height: 10,
								background: "#fff",
								border: "1px solid rgba(0,0,0,0.35)",
								borderRadius: 2,
								cursor: handle.cursor,
								...handle.style,
							}}
						/>
					))}

				{interactive ? (
					<div
						className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-md px-2 py-0.5 text-[11px] font-medium text-white"
						style={{
							top: -28,
							background: "rgba(0,0,0,0.72)",
							backdropFilter: "blur(8px)",
						}}
					>
						{Math.round(localSelection.width)} × {Math.round(localSelection.height)}
					</div>
				) : phase === "recording" ? (
					<div
						className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white"
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

			{interactive && (
				<div
					className="pointer-events-auto absolute left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-2xl px-3 py-2"
					style={{
						bottom: 28,
						background: "rgba(30,30,30,0.92)",
						boxShadow: "0 10px 40px rgba(0,0,0,0.45)",
						border: "1px solid rgba(255,255,255,0.08)",
					}}
				>
					<button
						type="button"
						onClick={() => void cancel()}
						className="rounded-xl px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void confirm()}
						className="rounded-xl bg-[#E11D48] px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#E11D48]/90"
					>
						Record
					</button>
				</div>
			)}
		</div>
	);
}
