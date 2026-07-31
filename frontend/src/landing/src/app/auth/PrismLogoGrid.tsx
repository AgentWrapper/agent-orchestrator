"use client";

import { useEffect, useRef } from "react";

const logoSource = "/ao-logo.svg";
const minimumCellSize = 24;
const maximumCellSize = 32;
const revealDuration = 1_000;

interface GlyphCell {
  left: number;
  top: number;
  size: number;
  red: number;
  green: number;
  blue: number;
  opacity: number;
  revealAt: number;
}

interface GridScene {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  cellSize: number;
  offsetX: number;
  offsetY: number;
  cells: GlyphCell[];
  compact: boolean;
}

function randomReveal(row: number, column: number) {
  let value = Math.imul(row + 31, 73856093) ^ Math.imul(column + 17, 19349663);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function createScene(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement | null,
  compact: boolean,
): GridScene | null {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);

  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const cellSize = compact
    ? Math.max(6, Math.min(9, Math.round(width / 22)))
    : Math.max(
        minimumCellSize,
        Math.min(maximumCellSize, Math.round(width / 25)),
      );
  const offsetX = (width % cellSize) / 2;
  const offsetY = (height % cellSize) / 2;
  const scene = {
    context,
    width,
    height,
    cellSize,
    offsetX,
    offsetY,
    cells: [] as GlyphCell[],
    compact,
  };
  if (!image?.complete || image.naturalWidth === 0) return scene;

  const sample = document.createElement("canvas");
  sample.width = width;
  sample.height = height;
  const sampleContext = sample.getContext("2d", {
    willReadFrequently: true,
  });
  if (!sampleContext) return scene;

  const logoSize = compact
    ? Math.min(width * 0.76, height * 0.76)
    : Math.min(width * 0.67, height * 0.7, 590);
  const logoLeft = (width - logoSize) / 2;
  const logoTop = (height - logoSize) / 2;
  sampleContext.drawImage(image, logoLeft, logoTop, logoSize, logoSize);
  const pixels = sampleContext.getImageData(0, 0, width, height).data;

  let row = -1;
  const sampleStep = compact ? 1 : 3;
  for (let top = offsetY - cellSize; top < height + cellSize; top += cellSize) {
    let column = -1;
    for (
      let left = offsetX - cellSize;
      left < width + cellSize;
      left += cellSize
    ) {
      column += 1;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let visibleSamples = 0;
      let totalSamples = 0;
      const startX = Math.max(0, Math.floor(left));
      const endX = Math.min(width, Math.ceil(left + cellSize));
      const startY = Math.max(0, Math.floor(top));
      const endY = Math.min(height, Math.ceil(top + cellSize));

      for (let y = startY; y < endY; y += sampleStep) {
        for (let x = startX; x < endX; x += sampleStep) {
          totalSamples += 1;
          const index = (y * width + x) * 4;
          const pixelAlpha = pixels[index + 3] / 255;
          if (pixelAlpha < 0.08) continue;
          visibleSamples += 1;
          red += pixels[index] * pixelAlpha;
          green += pixels[index + 1] * pixelAlpha;
          blue += pixels[index + 2] * pixelAlpha;
          alpha += pixelAlpha;
        }
      }

      const coverage = visibleSamples / Math.max(1, totalSamples);
      if (coverage < (compact ? 0.018 : 0.045) || alpha === 0) continue;

      scene.cells.push({
        left: Math.round(left),
        top: Math.round(top),
        size: cellSize,
        red: Math.round(red / alpha),
        green: Math.round(green / alpha),
        blue: Math.round(blue / alpha),
        opacity: compact
          ? Math.min(0.98, 0.5 + coverage * 1.6)
          : Math.min(0.94, 0.36 + coverage * 1.35),
        revealAt: randomReveal(row, column) * 0.72,
      });
    }
    row += 1;
  }
  return scene;
}

function paintScene(scene: GridScene, progress: number) {
  const { context, width, height, cellSize, offsetX, offsetY, cells, compact } =
    scene;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#08090b";
  context.fillRect(0, 0, width, height);

  context.beginPath();
  context.strokeStyle = compact
    ? "rgba(221, 231, 244, 0)"
    : "rgba(221, 231, 244, 0.055)";
  context.lineWidth = 1;
  for (let x = offsetX; x <= width; x += cellSize) {
    context.moveTo(Math.round(x) + 0.5, 0);
    context.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = offsetY; y <= height; y += cellSize) {
    context.moveTo(0, Math.round(y) + 0.5);
    context.lineTo(width, Math.round(y) + 0.5);
  }
  context.stroke();

  for (const cell of cells) {
    const localProgress = Math.max(
      0,
      Math.min(1, (progress - cell.revealAt) / 0.28),
    );
    if (localProgress === 0) continue;
    const eased = 1 - Math.pow(1 - localProgress, 3);
    const inset = 1 + (1 - eased) * cell.size * 0.18;
    context.fillStyle = `rgba(${cell.red}, ${cell.green}, ${cell.blue}, ${
      cell.opacity * eased
    })`;
    context.fillRect(
      cell.left + inset,
      cell.top + inset,
      cell.size - inset * 2 + 1,
      cell.size - inset * 2 + 1,
    );
  }
}

export function PrismLogoGrid({
  variant = "hero",
}: {
  variant?: "hero" | "loader";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compact = variant === "loader";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;
    let scene: GridScene | null = null;
    let startedAt: number | null = null;
    let lastProgress = 0;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const image = new Image();

    const animate = (now: number) => {
      if (!scene || startedAt === null) return;
      if (reduceMotion) {
        lastProgress = 1;
      } else if (compact) {
        const phase = (now - startedAt) % 1_800;
        if (phase < 650) lastProgress = phase / 650;
        else if (phase < 1_000) lastProgress = 1;
        else if (phase < 1_650) lastProgress = 1 - (phase - 1_000) / 650;
        else lastProgress = 0;
      } else {
        lastProgress = Math.min(1, (now - startedAt) / revealDuration);
      }
      paintScene(scene, lastProgress);
      if (compact || lastProgress < 1) {
        frame = window.requestAnimationFrame(animate);
      }
    };

    const rebuild = () => {
      window.cancelAnimationFrame(frame);
      scene = createScene(canvas, image, compact);
      if (!scene) return;
      paintScene(scene, lastProgress);
      if (startedAt !== null && (compact || lastProgress < 1)) {
        frame = window.requestAnimationFrame(animate);
      }
    };

    const reveal = () => {
      scene = createScene(canvas, image, compact);
      if (!scene) return;
      startedAt = performance.now();
      lastProgress = reduceMotion ? 1 : 0;
      frame = window.requestAnimationFrame(animate);
    };

    image.addEventListener("load", reveal);
    image.src = logoSource;
    const resizeObserver = new ResizeObserver(rebuild);
    resizeObserver.observe(canvas);
    rebuild();

    return () => {
      window.cancelAnimationFrame(frame);
      image.removeEventListener("load", reveal);
      resizeObserver.disconnect();
    };
  }, [compact]);

  if (compact) {
    return (
      <div
        className="relative size-40 overflow-hidden bg-[#08090b]"
        role="status"
        aria-label="Loading cloud workspace"
      >
        <canvas
          ref={canvasRef}
          className="pointer-events-none block size-full"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_28%,rgba(8,9,11,0.24)_72%,#08090b_100%)]"
          aria-hidden="true"
        />
      </div>
    );
  }

  return (
    <div className="auth-grid-enter relative h-full min-h-0 overflow-hidden bg-[#08090b]">
      <canvas
        ref={canvasRef}
        className="pointer-events-none block size-full"
        role="img"
        aria-label="Agent Orchestrator logo rendered as a colored square grid"
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_20%,rgba(8,9,11,0.08)_58%,rgba(8,9,11,0.72)_100%)]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#08090b] to-transparent"
        aria-hidden="true"
      />
      <p className="pointer-events-none absolute bottom-8 left-8 font-mono text-[10px] uppercase tracking-[0.16em] text-white/25">
        Coordinate every agent from one place
      </p>
    </div>
  );
}
