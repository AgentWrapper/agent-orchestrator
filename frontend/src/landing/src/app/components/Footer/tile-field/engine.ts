const TAU = Math.PI * 2;

type Row = {
	word: string;
	font: (px: number) => string;
	letterTrack: number;
	fillFrac: number;
	bright: boolean;
};

const ROWS: Row[] = [
	{
		word: "Spawn Agents",
		font: (px) => `700 ${px}px ui-sans-serif, system-ui, Arial, sans-serif`,
		letterTrack: -0.01,
		fillFrac: 0.95,
		bright: false,
	},
	{
		word: "Step Away",
		font: (px) => `700 ${px}px ui-sans-serif, system-ui, Arial, sans-serif`,
		letterTrack: -0.01,
		fillFrac: 0.95,
		bright: false,
	},
	{
		word: "Ship Faster",
		font: (px) => `700 ${px}px ui-sans-serif, system-ui, Arial, sans-serif`,
		letterTrack: -0.01,
		fillFrac: 0.95,
		bright: false,
	},
];

const REST_FALLBACK = "oklch(0.82 0.018 106.9)";
const GLOW_FALLBACK = "oklch(0.995 0.004 106.5)";
const BRAND_HUE = 107;
const SPARK = "180,200,170";

const MAXSZ = 0.9;
const SPEED = 0.02;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (x: number, e0: number, e1: number) => {
	const t = clamp((x - e0) / (e1 - e0), 0, 1);
	return t * t * (3 - 2 * t);
};

function hash(x: number, y: number) {
	const r = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
	return r - Math.floor(r);
}

const HUE_STEPS = 24;
const ALPHA_STEPS = 6;

export type TileFieldOptions = Record<string, never>;

interface Disc {
	p: number;
	x: number;
	y: number;
	w: number;
	h: number;
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

interface Point {
	x: number;
	y: number;
}

interface TileState {
	discs: Disc[];
	lines: Point[][];
	particles: Particle[];
	clip: {
		disc?: Disc;
		i?: number;
		path?: Path2D;
	};
	startDisc: Partial<Disc>;
	endDisc: Partial<Disc>;
	rect: { width: number; height: number };
	render: { width: number; height: number; dpi: number };
	particleArea: {
		sx: number;
		sw: number;
		ex: number;
		ew: number;
		h: number;
	};
	linesCanvas: HTMLCanvasElement | null;
}

export class TileField {
	private host: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private reduced: boolean;
	private dpr = Math.min(2, window.devicePixelRatio || 1);
	private viewW = 0;
	private viewH = 0;
	private cell = 10;
	private time = 0;

	private n = 0;
	private px = new Float32Array(0);
	private py = new Float32Array(0);
	private rowOf = new Uint8Array(0);
	private hueSeed = new Float32Array(0);
	private spark = new Uint8Array(0);
	private lit = new Float32Array(0);
	private seed = new Float32Array(0);

	private hasPointer = false;
	private rawX = 0;
	private rawY = 0;
	private lightX = 0;
	private lightY = 0;
	private lightSpeed = 0;
	private raf = 0;

	private stepL = new Float32Array(HUE_STEPS);
	private stepC = new Float32Array(HUE_STEPS);
	private restColor = REST_FALLBACK;
	private glowColor = GLOW_FALLBACK;

	private speedRef = { discInc: 0.001, vyScale: 1 };
	private state: TileState = {
		discs: [],
		lines: [],
		particles: [],
		clip: {},
		startDisc: {},
		endDisc: {},
		rect: { width: 0, height: 0 },
		render: { width: 0, height: 0, dpi: 1 },
		particleArea: { sx: 0, sw: 0, ex: 0, ew: 0, h: 0 },
		linesCanvas: null,
	};

	constructor(host: HTMLElement, _opts: TileFieldOptions = {}) {
		this.host = host;
		this.canvas = document.createElement("canvas");
		this.canvas.className =
			"pointer-events-none absolute inset-0 block h-full w-full";
		this.ctx = this.canvas.getContext("2d")!;
		this.host.appendChild(this.canvas);
		this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const rootStyles = window.getComputedStyle(document.documentElement);
		this.restColor = rootStyles.getPropertyValue("--muted-foreground").trim() || REST_FALLBACK;
		this.glowColor = rootStyles.getPropertyValue("--foreground").trim() || GLOW_FALLBACK;
		this.speedRef = { discInc: (23 / 100) * 0.002, vyScale: 23 / 50 };
		this.resize();
		window.addEventListener("pointermove", this.onMove, { passive: true });
		window.addEventListener("pointerleave", this.onLeave);
	}

	private linear = (p: number) => p;
	private easeInExpo = (p: number) => (p === 0 ? 0 : Math.pow(2, 10 * (p - 1)));

	private tweenValue = (
		start: number,
		end: number,
		p: number,
		ease: "inExpo" | null = null,
	) => {
		const delta = end - start;
		const easeFn = ease === "inExpo" ? this.easeInExpo : this.linear;
		return start + delta * easeFn(p);
	};

	private tweenDisc = (disc: Disc) => {
		const startDisc = this.state.startDisc;
		const endDisc = this.state.endDisc;
		disc.x = this.tweenValue(startDisc.x ?? 0, endDisc.x ?? 0, disc.p);
		disc.y = this.tweenValue(startDisc.y ?? 0, endDisc.y ?? 0, disc.p, "inExpo");
		disc.w = this.tweenValue(startDisc.w ?? 0, endDisc.w ?? 0, disc.p);
		disc.h = this.tweenValue(startDisc.h ?? 0, endDisc.h ?? 0, disc.p);
	};

	resize = () => {
		const rect = this.canvas.getBoundingClientRect();
		this.viewW = rect.width;
		this.viewH = rect.height;
		this.dpr = Math.min(2, window.devicePixelRatio || 1);
		this.cell = Math.max(2, Math.round(this.viewW / 460));
		this.state.rect = { width: rect.width, height: rect.height };
		this.state.render = { width: rect.width, height: rect.height, dpi: this.dpr };
		this.canvas.style.width = `${Math.round(this.viewW)}px`;
		this.canvas.style.height = `${Math.round(this.viewH)}px`;
		this.canvas.width = Math.max(1, Math.ceil(this.viewW * this.dpr));
		this.canvas.height = Math.max(1, Math.ceil(this.viewH * this.dpr));
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.ctx.imageSmoothingEnabled = false;

		const { width: viewW, height: viewH } = this.state.rect;
		const cell = this.cell;
		const splits = ROWS.map(() => 1 / ROWS.length);
		const bandTops: number[] = [];
		const bandHeights: number[] = [];
		let acc = 0;
		for (const frac of splits) {
			bandTops.push(acc * viewH);
			bandHeights.push(frac * viewH);
			acc += frac;
		}

		const xs: number[] = [];
		const ys: number[] = [];
		const rw: number[] = [];
		const sp: number[] = [];
		const sd: number[] = [];
		const hs: number[] = [];

		ROWS.forEach((row, ri) => {
			const bandTop = bandTops[ri] ?? 0;
			const bandH = bandHeights[ri] ?? viewH;
			const padX = viewW * 0.04;
			const availableW = Math.max(1, viewW - padX * 2);

			const sc = document.createElement("canvas");
			sc.width = Math.max(1, Math.floor(viewW));
			sc.height = Math.max(1, Math.floor(bandH));
			const s = sc.getContext("2d");
			if (!s) return;

			const sls = s as CanvasRenderingContext2D & { letterSpacing?: string };
			s.fillStyle = "#000";
			s.textAlign = "left";
			s.textBaseline = "middle";

			let fs = bandH * 0.8;
			sls.letterSpacing = `${row.letterTrack * fs}px`;
			s.font = row.font(fs);
			const measured = s.measureText(row.word).width || 1;
			fs *= (availableW * row.fillFrac) / measured;
			fs = Math.min(fs, bandH * 0.82);
			sls.letterSpacing = `${row.letterTrack * fs}px`;
			s.font = row.font(fs);
			s.fillText(row.word, padX, bandH / 2);

			const data = s.getImageData(0, 0, sc.width, sc.height).data;
			const cols = Math.ceil(viewW / cell);
			const rows = Math.ceil(bandH / cell);
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					const lx = Math.floor(c * cell + cell / 2);
					const ly = Math.floor(r * cell + cell / 2);
					if (lx >= sc.width || ly >= sc.height) continue;
					const a = (data[(ly * sc.width + lx) * 4 + 3] ?? 0) / 255;
					if (a <= 0.5) continue;
					const gx = lx;
					const gy = ly + bandTop;
					xs.push(gx);
					ys.push(gy);
					rw.push(ri);
					sp.push(hash(gx + 7, gy - 3) > 0.82 ? 1 : 0);
					sd.push(hash(gx * 1.3, gy * 0.7));
					hs.push(hash(gx * 0.7 + 11, gy * 1.9 - 5));
				}
			}
		});

		this.n = xs.length;
		this.px = new Float32Array(xs);
		this.py = new Float32Array(ys);
		this.rowOf = new Uint8Array(rw);
		this.spark = new Uint8Array(sp);
		this.seed = new Float32Array(sd);
		this.hueSeed = new Float32Array(hs);
		this.lit = new Float32Array(this.n);

		this.init();
		if (this.reduced) this.renderStatic();
	};

	private setDiscs = () => {
		const { width, height } = this.state.rect;
		if (!width || !height) return;
		this.state.discs = [];
		this.state.startDisc = {
			x: width * 0.5,
			y: height * 0.45,
			w: width * 0.75,
			h: height * 0.7,
		};
		this.state.endDisc = {
			x: width * 0.5,
			y: height * 0.95,
			w: 0,
			h: 0,
		};

		let prevBottom = height;
		this.state.clip = {};
		for (let i = 0; i < 80; i++) {
			const p = i / 80;
			const disc: Disc = { p, x: 0, y: 0, w: 0, h: 0 };
			this.tweenDisc(disc);
			const bottom = disc.y + disc.h;
			if (bottom <= prevBottom) this.state.clip = { disc: { ...disc }, i };
			prevBottom = bottom;
			this.state.discs.push(disc);
		}

		const clipDisc = this.state.clip.disc;
		if (!clipDisc) return;
		const clipPath = new Path2D();
		clipPath.ellipse(clipDisc.x, clipDisc.y, clipDisc.w, clipDisc.h, 0, 0, Math.PI * 2);
		clipPath.rect(clipDisc.x - clipDisc.w, 0, clipDisc.w * 2, clipDisc.y);
		this.state.clip.path = clipPath;
	};

	private setLines = () => {
		const { width, height } = this.state.rect;
		if (!width || !height) return;
		const lines = 12;
		this.state.lines = Array.from({ length: lines }, () => []);
		const linesAngle = (Math.PI * 2) / lines;
		this.state.discs.forEach((disc) => {
			for (let i = 0; i < lines; i++) {
				const angle = i * linesAngle;
				const p = {
					x: disc.x + Math.cos(angle) * disc.w,
					y: disc.y + Math.sin(angle) * disc.h,
				};
				this.state.lines[i]?.push(p);
			}
		});

		const dpi = this.state.render.dpi || 1;
		const offCanvas = document.createElement("canvas");
		offCanvas.width = Math.max(1, Math.round(width * dpi));
		offCanvas.height = Math.max(1, Math.round(height * dpi));
		const ctx = offCanvas.getContext("2d");
		const clipPath = this.state.clip.path;
		if (!ctx || !clipPath) return;

		ctx.scale(dpi, dpi);
		ctx.strokeStyle = "#FFFFFF";
		ctx.lineWidth = 1;
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

		this.state.lines.forEach((line) => {
			ctx.save();
			ctx.clip(clipPath);
			strokePolyline(line);
			ctx.restore();
		});

		this.state.linesCanvas = offCanvas;
	};

	private initParticle = (start = false): Particle => {
		const sx = this.state.particleArea.sx + this.state.particleArea.sw * Math.random();
		const ex = this.state.particleArea.ex + this.state.particleArea.ew * Math.random();
		const dx = ex - sx;
		const y = start ? this.state.particleArea.h * Math.random() : this.state.particleArea.h;
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
			c: `rgba(${SPARK}, ${Math.random()})`,
		};
	};

	private setParticles = () => {
		const { width, height } = this.state.rect;
		this.state.particles = [];
		const clipDisc = this.state.clip.disc;
		if (!width || !height || !clipDisc) return;
		this.state.particleArea = {
			sw: clipDisc.w * 0.5,
			ew: clipDisc.w * 2,
			h: height * 0.85,
			sx: (width - clipDisc.w * 0.5) / 2,
			ex: (width - clipDisc.w * 2) / 2,
		};
		for (let i = 0; i < 220; i++) this.state.particles.push(this.initParticle(true));
	};

	private drawDiscs = (ctx: CanvasRenderingContext2D) => {
		ctx.strokeStyle = "#FFFFFF";
		ctx.lineWidth = 1;
		const outer = this.state.startDisc;
		ctx.beginPath();
		ctx.ellipse(outer.x ?? 0, outer.y ?? 0, outer.w ?? 0, outer.h ?? 0, 0, 0, Math.PI * 2);
		ctx.stroke();
		ctx.closePath();
	};

	private drawLines = (ctx: CanvasRenderingContext2D) => {
		const off = this.state.linesCanvas;
		if (!off) return;
		const { width, height } = this.state.rect;
		ctx.drawImage(off, 0, 0, width, height);
	};

	private drawParticles = (ctx: CanvasRenderingContext2D) => {
		const clipPath = this.state.clip.path;
		if (!clipPath) return;
		ctx.save();
		ctx.clip(clipPath);
		this.state.particles.forEach((particle) => {
			ctx.fillStyle = particle.c;
			ctx.beginPath();
			ctx.arc(
				particle.x + particle.r / 2,
				particle.y + particle.r / 2,
				particle.r / 2,
				0,
				Math.PI * 2,
			);
			ctx.closePath();
			ctx.fill();
		});
		ctx.restore();
	};

	private moveDiscs = () => {
		const inc = this.speedRef.discInc;
		this.state.discs.forEach((disc) => {
			disc.p = (disc.p + inc) % 1;
			this.tweenDisc(disc);
		});
	};

	private moveParticles = () => {
		const vyScale = this.speedRef.vyScale;
		this.state.particles.forEach((particle, idx) => {
			particle.p = 1 - particle.y / this.state.particleArea.h;
			particle.x = particle.sx + particle.dx * particle.p;
			particle.y -= particle.vy * vyScale;
			if (particle.y < 0) this.state.particles[idx] = this.initParticle();
		});
	};

	private distSegSq = (
		qx: number,
		qy: number,
		ax: number,
		ay: number,
		bx: number,
		by: number,
	) => {
		const dx = bx - ax;
		const dy = by - ay;
		if (dx === 0 && dy === 0) {
			const ex = qx - ax;
			const ey = qy - ay;
			return ex * ex + ey * ey;
		}
		const t = clamp(((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy), 0, 1);
		const ex = qx - (ax + dx * t);
		const ey = qy - (ay + dy * t);
		return ex * ex + ey * ey;
	};

	private frame = (t: number) => {
		const ctx = this.ctx;
		const { viewW, viewH, cell, n, px, py, rowOf, hueSeed, spark, lit, seed } = this;

		ctx.clearRect(0, 0, viewW, viewH);
		this.time += SPEED;
		const time = this.time;

		const prevX = this.lightX;
		const prevY = this.lightY;
		if (this.hasPointer) {
			this.lightX += (this.rawX - this.lightX) * 0.5;
			this.lightY += (this.rawY - this.lightY) * 0.5;
		}
		const lightX = this.lightX;
		const lightY = this.lightY;
		const stepDist = Math.hypot(lightX - prevX, lightY - prevY);
		this.lightSpeed = 0.9 * this.lightSpeed + 0.1 * stepDist;
		const lightSpeed = this.lightSpeed;
		const moving = this.hasPointer;

		const reach = clamp(viewH * 0.22 + lightSpeed * 0.9, viewH * 0.18, viewH * 0.42);
		const influence = 1.5 * reach;
		const influenceSq = influence * influence;
		const minX = Math.min(prevX, lightX) - influence;
		const maxX = Math.max(prevX, lightX) + influence;
		const minY = Math.min(prevY, lightY) - influence;
		const maxY = Math.max(prevY, lightY) + influence;

		const T = time;
		const grayP = new Path2D();
		const litList: number[] = [];
		const buckets: Path2D[][] = Array.from({ length: HUE_STEPS }, () =>
			Array.from({ length: ALPHA_STEPS }, () => new Path2D()),
		);
		const hueOfStep = new Float32Array(HUE_STEPS);

		for (let i = 0; i < n; i++) {
			const x = px[i] ?? 0;
			const y = py[i] ?? 0;
			let target = 0;
			if (moving && x >= minX && x <= maxX && y >= minY && y <= maxY) {
				const dSq = this.distSegSq(x, y, prevX, prevY, lightX, lightY);
				if (dSq <= influenceSq) {
					const ang = Math.atan2(y - lightY, x - lightX);
					const wobble =
						1 +
						0.3 * Math.sin(3 * ang + time * 1.6) +
						0.16 * Math.sin(5 * ang - time * 1.1 + 1.3);
					const f = clamp(1 - Math.sqrt(dSq) / (reach * wobble), 0, 1);
					target = f * f * (3 - 2 * f);
				}
			}

			const litValue = lit[i] ?? 0;
			const rate = target > litValue ? 0.24 : 0.02;
			lit[i] = litValue + (target - litValue) * rate;

			const u = x / Math.max(viewW, 1);
			const v = y / Math.max(viewH, 1);
			const flow =
				Math.sin((u * 1.6 + 0.4 * Math.sin(T * 0.3)) * TAU + T * 0.8) +
				0.7 * Math.sin((v * 2.1 - u * 0.9) * TAU - T * 0.6 + 1.7) +
				0.5 * Math.sin((u * 3.3 + v * 2.7) * TAU + T * 0.4 + 4.2) +
				0.4 * Math.cos((v * 1.3 - 1.1 * Math.sin(T * 0.2)) * TAU - T * 0.5);

			let colorAmt = smoothstep(flow, 0.1, 1.6);
			colorAmt = Math.max(colorAmt, lit[i] ?? 0);

			const breathe = 0.5 + 0.5 * Math.sin((seed[i] ?? 0) * TAU + time * 1.3);
			const base = 0.22 + 0.1 * breathe;
			const sz = cell * (base + (MAXSZ - base) * colorAmt);
			const h = sz / 2;
			grayP.rect(x - h, y - h, sz, sz);

			if (colorAmt > 0.04) {
				let hue: number;
				let chroma: number;
				if (ROWS[rowOf[i] ?? 0]?.bright) {
					hue = (((hueSeed[i] ?? 0) * 360 + time * 26) % 360 + 360) % 360;
					chroma = 0.19;
				} else {
					const drift = (flow - 0.8) * 16;
					hue = BRAND_HUE + drift + ((hueSeed[i] ?? 0) - 0.5) * 8;
					chroma = 0.085;
				}
				const hStep =
					((Math.round((hue / 360) * HUE_STEPS) % HUE_STEPS) + HUE_STEPS) %
					HUE_STEPS;
				const lightness = ROWS[rowOf[i] ?? 0]?.bright ? 0.72 : 0.64;
				hueOfStep[hStep] = hue;
				const as = Math.min(
					ALPHA_STEPS - 1,
					Math.floor(colorAmt * ALPHA_STEPS),
				);
				buckets[hStep]?.[as]?.rect(x - h, y - h, sz, sz);
				this.stepL[hStep] = lightness;
				this.stepC[hStep] = chroma;
			}

			if ((lit[i] ?? 0) > 0.02) litList.push(i);
		}

		ctx.fillStyle = this.restColor;
		ctx.fill(grayP);

		for (let hsI = 0; hsI < HUE_STEPS; hsI++) {
			const hue = hueOfStep[hsI] ?? 0;
			for (let as = 0; as < ALPHA_STEPS; as++) {
				const p = buckets[hsI]?.[as];
				if (!p) continue;
				ctx.globalAlpha = (as + 1) / ALPHA_STEPS;
				ctx.fillStyle = `oklch(${this.stepL[hsI] ?? 0.5} ${this.stepC[hsI] ?? 0.08} ${hue})`;
				ctx.fill(p);
			}
		}
		ctx.globalAlpha = 1;

		for (const i of litList) {
			const L = lit[i] ?? 0;
			const x = px[i] ?? 0;
			const y = py[i] ?? 0;
			const gsz = cell * (0.7 + (MAXSZ - 0.7) * L);
			const gh = gsz / 2;
			if ((spark[i] ?? 0) === 1) {
				const ph = seed[i] ?? 0;
				const tt = 0.00025 * t;
				const amp = (0.45 + ph) * cell * 0.28;
				const jx = x + Math.sin(0.05 * x + 1.3 * tt + ph * TAU) * amp;
				const jy = y + Math.cos(0.04 * y - 0.9 * tt + ph * TAU) * amp;
				ctx.fillStyle = `rgba(${SPARK},${(0.1 * L).toFixed(3)})`;
				ctx.fillRect(jx - gh * 1.5, jy - gh * 1.5, gsz * 1.5, gsz * 1.5);
				ctx.fillStyle = `rgba(${SPARK},${(0.55 * L).toFixed(3)})`;
				ctx.fillRect(jx - gh, jy - gh, gsz, gsz);
			} else {
				ctx.globalAlpha = 1 * L;
				ctx.fillStyle = this.glowColor;
				ctx.fillRect(x - gh, y - gh, gsz, gsz);
				ctx.globalAlpha = 1;
			}
		}

		this.raf = requestAnimationFrame(this.frame);
	};

	private renderStatic() {
		this.ctx.clearRect(0, 0, this.viewW, this.viewH);
		const grayP = new Path2D();
		for (let i = 0; i < this.n; i++) {
			const sz = this.cell * 0.5;
			const h = sz / 2;
			grayP.rect((this.px[i] ?? 0) - h, (this.py[i] ?? 0) - h, sz, sz);
		}
		this.ctx.fillStyle = this.restColor;
		this.ctx.fill(grayP);
	}

	private onMove = (e: PointerEvent) => {
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		if (x >= -40 && y >= -40 && x <= rect.width + 40 && y <= rect.height + 40) {
			if (!this.hasPointer) {
				this.hasPointer = true;
				this.lightX = x;
				this.lightY = y;
				this.lightSpeed = 0;
			}
			this.rawX = x;
			this.rawY = y;
		} else {
			this.hasPointer = false;
		}
	};

	private onLeave = () => {
		this.hasPointer = false;
	};

	private init = () => {
		this.setDiscs();
		this.setLines();
		this.setParticles();
	};

	start() {
		if (this.reduced) return;
		if (!this.raf) this.raf = requestAnimationFrame(this.frame);
	}

	stop() {
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	destroy() {
		this.stop();
		window.removeEventListener("pointermove", this.onMove);
		window.removeEventListener("pointerleave", this.onLeave);
		this.canvas.remove();
	}
}
