// Loads the P&ID drawing and finds its component groups. The drawing stays a file the simulation side owns;
// this module only reads it, removes anything that does not belong in the page, and measures where the tags are.
import { TAGS } from "./derive";

export const PID_URL = process.env.NEXT_PUBLIC_PID_URL ?? "/pid-tk-101.svg";

export type Box = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type Drawing = { markup: string; width: number; height: number; anchors: Record<string, Point> };

const MIN_TEXT_PX = 18;

function viewBoxOf(svg: Element): { width: number; height: number } {
  const parts = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = parts[2];
  const height = parts[3];
  if (parts.length === 4 && width !== undefined && height !== undefined && width > 0 && height > 0) return { width, height };
  throw new Error("the drawing has no viewBox");
}

export function prepareDrawing(source: string): Drawing {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  const svg = parsed.documentElement;
  if (svg.nodeName.toLowerCase() !== "svg" || parsed.querySelector("parsererror") !== null) {
    throw new Error("the drawing is not valid SVG");
  }
  const { width, height } = viewBoxOf(svg);
  svg.querySelectorAll("script, foreignObject, title").forEach((node) => node.remove());
  svg.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on")) node.removeAttribute(attribute.name);
    }
  });

  // Live values are HTML plates at 18px, so the drawing's own value slots become positions only.
  // They are removed rather than hidden because a hidden slot still stretches its group's bounding box.
  const anchors: Record<string, Point> = {};
  svg.querySelectorAll(".live-value").forEach((node) => {
    const tag = node.id.replace(/-value$/, "");
    const x = Number(node.getAttribute("x"));
    const y = Number(node.getAttribute("y"));
    if (Number.isFinite(x) && Number.isFinite(y)) anchors[tag] = { x, y };
    node.remove();
  });

  for (const tag of TAGS) svg.querySelector(`[id="${tag}"]`)?.setAttribute("data-tag", tag);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return { markup: new XMLSerializer().serializeToString(svg), width, height, anchors };
}

export async function loadDrawing(): Promise<Drawing | null> {
  const response = await fetch(PID_URL, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return prepareDrawing(await response.text());
}

/** Reads the mounted drawing. getBBox is in drawing units, so it does not change with the stage scale. */
export function measureTags(host: Element): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  for (const tag of TAGS) {
    const group = host.querySelector(`[id="${tag}"]`);
    if (group instanceof SVGGraphicsElement) {
      const { x, y, width, height } = group.getBBox();
      boxes[tag] = { x, y, width, height };
    }
  }
  return boxes;
}

/** The 18px rule covers the drawing too: raises any text that would render smaller at the current size. */
export function enforceMinimumText(host: Element, drawingWidth: number): number {
  const svg = host.querySelector("svg");
  if (svg === null) return 0;
  const scale = svg.getBoundingClientRect().width / drawingWidth / currentStageScale(svg);
  if (!(scale > 0)) return 0;
  const minimum = MIN_TEXT_PX / scale;
  let raised = 0;
  svg.querySelectorAll("text").forEach((text) => {
    const size = Number.parseFloat(getComputedStyle(text).fontSize);
    if (size < minimum) {
      text.style.fontSize = `${minimum}px`;
      raised += 1;
    }
  });
  return raised;
}

function currentStageScale(element: Element): number {
  const stage = element.closest(".stage");
  if (stage === null) return 1;
  const width = stage.getBoundingClientRect().width;
  return width > 0 ? width / 1920 : 1;
}
