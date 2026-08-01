"use client";

import * as React from "react";

const { useRef, useCallback, useMemo, useEffect } = React;

function toRGB(color: string): [number, number, number] {
	if (typeof color === "string") {
		if (color.startsWith("#")) {
			let hex = color.slice(1);
			if (hex.length === 3) {
				hex = hex
					.split("")
					.map((char) => char + char)
					.join("");
			}
			const n = parseInt(hex.slice(0, 6), 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		}

		const m = color.match(/rgba?\(([^)]+)\)/);
		if (m) {
			const p = m[1]?.split(",").map((s) => parseFloat(s)) ?? [];
			return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
		}
	}

	return [255, 255, 255];
}

interface Disc {
	p: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Point {
	x: number;
	y: number;
}

interface Particle {
	x: number;
	sx: number;
	dx: number;
	y: number;
	vy: number;
	p: number;
	r: number;
	c: string;
}

interface BlackHoleBGState {
	discs: Disc[];
	lines: Point[][];
	particles: Particle[];
	clip: {
		disc?: Disc;
		i?: number;
		path?: Path2D;
	};
	startDisc: Disc;
	endDisc: Disc;
	rect: { width: number; height: number };
	render: { width: number; height: number; dpi: number };
	particleArea: {
		sw: number;
		ew: number;
		h: number;
		sx: number;
		ex: number;
	};
	linesCanvas: HTMLCanvasElement | null;
}

interface BlackHoleBGProps {
	speed?: number;
	strokeColor?: string;
	lineWidth?: number;
	lines?: number;
	discs?: number;
	particles?: boolean;
	particleColor?: string;
	particleCount?: number;
	glow?: boolean;
	glowColor?: string;
	backgroundColor?: string;
	canvasOpacity?: number;
	style?: React.CSSProperties;
	children?: React.ReactNode;
}

export function BlackHoleBG({
	speed = 50,
	strokeColor = "#FFFFFF",
	lineWidth = 1,
	lines = 80,
	discs = 80,
	particles = true,
	particleColor = "#FFFFFF",
	particleCount = 300,
	glow = true,
	glowColor = "#FFFFFF",
	backgroundColor = "transparent",
	canvasOpacity = 0.45,
	style,
	children,
}: BlackHoleBGProps) {
	const particleRGBColor = useMemo(() => toRGB(particleColor), [particleColor]);

	const speedRef = useRef({ discInc: 0.001, vyScale: 1 });
	speedRef.current = {
		discInc: (speed / 100) * 0.002,
		vyScale: speed / 50,
	};

	const canvasRef = useRef<HTMLCanvasElement>(null);
	const animationFrameIdRef = useRef<number>(0);
	const stateRef = useRef<BlackHoleBGState>({
		discs: [],
		lines: [],
		particles: [],
		clip: {},
		startDisc: { p: 0, x: 0, y: 0, w: 0, h: 0 },
		endDisc: { p: 0, x: 0, y: 0, w: 0, h: 0 },
		rect: { width: 0, height: 0 },
		render: { width: 0, height: 0, dpi: 1 },
		particleArea: { sw: 0, ew: 0, h: 0, sx: 0, ex: 0 },
		linesCanvas: null,
	});

	const linear = (p: number) => p;
	const easeInExpo = (p: number) => (p === 0 ? 0 : Math.pow(2, 10 * (p - 1)));

	const tweenValue = useCallback(
		(start: number, end: number, p: number, ease: "inExpo" | null = null) => {
			const delta = end - start;
			const easeFn = ease === "inExpo" ? easeInExpo : linear;
			return start + delta * easeFn(p);
		},
		[],
	);

	const tweenDisc = useCallback(
		(disc: Disc) => {
			const { startDisc, endDisc } = stateRef.current;
			disc.x = tweenValue(startDisc.x, endDisc.x, disc.p);
			disc.y = tweenValue(startDisc.y, endDisc.y, disc.p, "inExpo");
			disc.w = tweenValue(startDisc.w, endDisc.w, disc.p);
			disc.h = tweenValue(startDisc.h, endDisc.h, disc.p);
		},
		[tweenValue],
	);

	const setSize = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const rect = canvas.getBoundingClientRect();
		stateRef.current.rect = { width: rect.width, height: rect.height };
		stateRef.current.render = {
			width: rect.width,
			height: rect.height,
			dpi: window.devicePixelRatio || 1,
		};

		canvas.width = Math.max(1, stateRef.current.render.width * stateRef.current.render.dpi);
		canvas.height = Math.max(1, stateRef.current.render.height * stateRef.current.render.dpi);
	}, []);

	const setDiscs = useCallback(() => {
		const { width, height } = stateRef.current.rect;
		if (!width || !height) return;

		stateRef.current.discs = [];
		stateRef.current.startDisc = {
			p: 0,
			x: width * 0.5,
			y: height * 0.45,
			w: width * 0.75,
			h: height * 0.7,
		};
		stateRef.current.endDisc = { p: 1, x: width * 0.5, y: height * 0.95, w: 0, h: 0 };

		let prevBottom = height;
		stateRef.current.clip = {};

		for (let i = 0; i < discs; i++) {
			const p = i / discs;
			const disc: Disc = { p, x: 0, y: 0, w: 0, h: 0 };
			tweenDisc(disc);
			const bottom = disc.y + disc.h;
			if (bottom <= prevBottom) {
				stateRef.current.clip = { disc: { ...disc }, i };
			}
			prevBottom = bottom;
			stateRef.current.discs.push(disc);
		}

		const clipDisc = stateRef.current.clip.disc;
		if (!clipDisc) return;

		const clipPath = new Path2D();
		clipPath.ellipse(clipDisc.x, clipDisc.y, clipDisc.w, clipDisc.h, 0, 0, Math.PI * 2);
		clipPath.rect(clipDisc.x - clipDisc.w, 0, clipDisc.w * 2, clipDisc.y);
		stateRef.current.clip.path = clipPath;
	}, [discs, tweenDisc]);

	const setLines = useCallback(() => {
		const { width, height } = stateRef.current.rect;
		if (!width || !height) return;

		stateRef.current.lines = [];
		const linesAngle = (Math.PI * 2) / lines;
		for (let i = 0; i < lines; i++) {
			stateRef.current.lines.push([]);
		}

		stateRef.current.discs.forEach((disc) => {
			for (let i = 0; i < lines; i++) {
				const angle = i * linesAngle;
				const p: Point = {
					x: disc.x + Math.cos(angle) * disc.w,
					y: disc.y + Math.sin(angle) * disc.h,
				};
				stateRef.current.lines[i]?.push(p);
			}
		});

		const dpi = stateRef.current.render.dpi || 1;
		const offCanvas = document.createElement("canvas");
		offCanvas.width = Math.max(1, Math.round(width * dpi));
		offCanvas.height = Math.max(1, Math.round(height * dpi));

		const ctx = offCanvas.getContext("2d");
		const clipPath = stateRef.current.clip.path;
		if (!ctx || !clipPath) return;

		ctx.lineWidth = 1;
		const enters = stateRef.current.lines.map((line) => {
			for (let j = 1; j < line.length; j++) {
				const p = line[j];
				if (!p) continue;
				if (ctx.isPointInPath(clipPath, p.x, p.y) || ctx.isPointInStroke(clipPath, p.x, p.y)) {
					return j;
				}
			}
			return -1;
		});

		ctx.scale(dpi, dpi);
		ctx.strokeStyle = strokeColor;
		ctx.lineWidth = lineWidth;
		ctx.lineJoin = "round";
		ctx.lineCap = "round";

		const strokePolyline = (points: Point[]) => {
			if (points.length < 2) return;
			ctx.beginPath();
			ctx.moveTo(points[0]?.x ?? 0, points[0]?.y ?? 0);
			for (let j = 1; j < points.length; j++) {
				ctx.lineTo(points[j]?.x ?? 0, points[j]?.y ?? 0);
			}
			ctx.stroke();
		};

		stateRef.current.lines.forEach((line, i) => {
			const enter = enters[i] ?? -1;
			if (enter === -1) {
				strokePolyline(line);
				return;
			}
			strokePolyline(line.slice(0, enter + 1));
			ctx.save();
			ctx.clip(clipPath);
			strokePolyline(line.slice(enter));
			ctx.restore();
		});

		stateRef.current.linesCanvas = offCanvas;
	}, [lines, strokeColor, lineWidth]);

	const initParticle = useCallback(
		(start = false): Particle => {
			const area = stateRef.current.particleArea;
			const sx = area.sx + area.sw * Math.random();
			const ex = area.ex + area.ew * Math.random();
			const dx = ex - sx;
			const y = start ? area.h * Math.random() : area.h;
			const r = 0.5 + Math.random() * 4;
			const vy = 0.5 + Math.random();
			return {
				x: sx,
				sx,
				dx,
				y,
				vy,
				p: 0,
				r,
				c: `rgba(${particleRGBColor[0]}, ${particleRGBColor[1]}, ${particleRGBColor[2]}, ${Math.random()})`,
			};
		},
		[particleRGBColor],
	);

	const setParticles = useCallback(() => {
		const { width, height } = stateRef.current.rect;
		stateRef.current.particles = [];

		if (!particles || !width || !height || !stateRef.current.clip.disc) return;

		const disc = stateRef.current.clip.disc;
		stateRef.current.particleArea = {
			sw: disc.w * 0.5,
			ew: disc.w * 2,
			h: height * 0.85,
			sx: (width - disc.w * 0.5) / 2,
			ex: (width - disc.w * 2) / 2,
		};

		for (let i = 0; i < particleCount; i++) {
			stateRef.current.particles.push(initParticle(true));
		}
	}, [initParticle, particles, particleCount]);

	const drawDiscs = useCallback(
		(ctx: CanvasRenderingContext2D) => {
			ctx.strokeStyle = strokeColor;
			ctx.lineWidth = lineWidth;

			const outerDisc = stateRef.current.startDisc;
			ctx.beginPath();
			ctx.ellipse(outerDisc.x, outerDisc.y, outerDisc.w, outerDisc.h, 0, 0, Math.PI * 2);
			ctx.stroke();
			ctx.closePath();

			stateRef.current.discs.forEach((disc, i) => {
				if (i % 5 !== 0) return;

				const clipDisc = stateRef.current.clip.disc;
				const clipPath = stateRef.current.clip.path;
				if (clipDisc && clipPath && disc.w < clipDisc.w - 5) {
					ctx.save();
					ctx.clip(clipPath);
				}

				ctx.beginPath();
				ctx.ellipse(disc.x, disc.y, disc.w, disc.h, 0, 0, Math.PI * 2);
				ctx.stroke();
				ctx.closePath();

				if (clipDisc && clipPath && disc.w < clipDisc.w - 5) {
					ctx.restore();
				}
			});
		},
		[strokeColor, lineWidth],
	);

	const drawLines = useCallback((ctx: CanvasRenderingContext2D) => {
		const off = stateRef.current.linesCanvas;
		if (!off) return;
		const { width, height } = stateRef.current.rect;
		ctx.drawImage(off, 0, 0, width, height);
	}, []);

	const drawParticles = useCallback((ctx: CanvasRenderingContext2D) => {
		if (!stateRef.current.clip.path) return;
		ctx.save();
		ctx.clip(stateRef.current.clip.path);
		stateRef.current.particles.forEach((particle) => {
			ctx.fillStyle = particle.c;
			ctx.beginPath();
			ctx.arc(particle.x + particle.r / 2, particle.y + particle.r / 2, particle.r / 2, 0, Math.PI * 2);
			ctx.closePath();
			ctx.fill();
		});
		ctx.restore();
	}, []);

	const moveDiscs = useCallback(() => {
		const inc = speedRef.current.discInc;
		stateRef.current.discs.forEach((disc) => {
			disc.p = (disc.p + inc) % 1;
			tweenDisc(disc);
		});
	}, [tweenDisc]);

	const moveParticles = useCallback(() => {
		const vyScale = speedRef.current.vyScale;
		stateRef.current.particles.forEach((particle, idx) => {
			particle.p = 1 - particle.y / stateRef.current.particleArea.h;
			particle.x = particle.sx + particle.dx * particle.p;
			particle.y -= particle.vy * vyScale;
			if (particle.y < 0) {
				stateRef.current.particles[idx] = initParticle();
			}
		});
	}, [initParticle]);

	const tick = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.save();
		ctx.scale(stateRef.current.render.dpi, stateRef.current.render.dpi);
		if (stateRef.current.clip.path) {
			moveDiscs();
			moveParticles();
			drawDiscs(ctx);
			drawLines(ctx);
			drawParticles(ctx);
		}
		ctx.restore();
		animationFrameIdRef.current = requestAnimationFrame(tick);
	}, [moveDiscs, moveParticles, drawDiscs, drawLines, drawParticles]);

	const init = useCallback(() => {
		setSize();
		setDiscs();
		setLines();
		setParticles();
	}, [setSize, setDiscs, setLines, setParticles]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		init();
		tick();

		const ro = new ResizeObserver(() => {
			setSize();
			setDiscs();
			setLines();
			setParticles();
		});

		ro.observe(canvas);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(animationFrameIdRef.current);
		};
	}, [init, tick, setSize, setDiscs, setLines, setParticles]);

	return (
		<div
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				overflow: "hidden",
				background: backgroundColor,
				...style,
			}}
		>
			<canvas
				ref={canvasRef}
				style={{
					position: "absolute",
					inset: 0,
					display: "block",
					width: "100%",
					height: "100%",
					opacity: canvasOpacity,
				}}
			/>
			{glow ? (
				<div
					style={{
						position: "absolute",
						zIndex: 5,
						top: "50%",
						left: "50%",
						width: "100%",
						height: "100%",
						transform: "translate3d(-50%, -50%, 0)",
						background: `radial-gradient(ellipse at 50% 75%, ${glowColor} 20%, transparent 75%)`,
						mixBlendMode: "overlay",
						pointerEvents: "none",
					}}
				/>
			) : null}
			{children}
		</div>
	);
}
