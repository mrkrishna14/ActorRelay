import type { ComponentTag } from "./types";

/** One metre-based floor layout drives the interactive 2D plan and 3D hall. +Z is south. */
export type PlantPoint = [number, number, number];
export const HALL = { x0: -16, x1: 16, z0: -12, z1: 12, height: 9.5 } as const;
export const FEED_VESSELS = [
  { id: "V-001", x: -7.2, z: -1.6, radius: 1.12, height: 3.15 },
  { id: "V-002", x: -7.2, z: 1.6, radius: 1.12, height: 3.15 },
] as const;
export const PRODUCT_VESSELS = [
  { id: "V-201", x: 6.8, z: -.5, radius: .74, height: 2.6 },
  { id: "V-202", x: 8.9, z: -.5, radius: .74, height: 2.6 },
] as const;
export const MEZZANINE = { x: -12, z: -7, width: 5.2, depth: 5, height: 3.1 } as const;
export const UTILITY = { x: 10, z: -7 } as const;
export const EXCHANGER = { x: 6.8, z: -4.1 } as const;
export const RACK = { x0: -13.5, x1: 13.5, z: -5.5, height: 5.4 } as const;
export const EQUIPMENT_CENTERS: Record<ComponentTag, PlantPoint> = {
  "P-100": [-2.75, .8, .32], "TK-101": [0, 2.6, 0],
  "LV-101": [2.67, 1, .52], "E-101": [.2, 2.95, 0], "TV-101": [1.46, 4.7, -.55],
};

export const FEED_PATH: PlantPoint[] = [[-1.85, .58, .32], [-1.6, .58, .32], [-1.41, .77, .32], [-1.41, 1.2, .32], [-1.28, 1.39, .32], [-1.02, 1.4, .32]];
export const OUTLET_PATH: PlantPoint[] = [[.55, 1.01, .52], [.8, .73, .52], [1.2, .68, .52], [2.5, .68, .52], [3.6, .68, .52], [4.15, .73, .52]];
export const STEAM_PATH: PlantPoint[] = [[-4.2, 4.5, -.55], [-2.5, 4.5, -.55], [.6, 4.5, -.55], [1.7, 4.5, -.55], [2.12, 4.5, -.55], [2.32, 4.31, -.55], [2.32, 2.5, -.55], [2.15, 2.3, -.55], [1.1, 2.3, -.25]];
export const SUCTION_PATH: PlantPoint[] = [[-7.2, .62, 1.6], [-5.1, .62, 1.6], [-5.1, .62, 1.05], [-3.85, .62, 1.05], [-2.12, .62, 1.05], [-2.12, .66, .63]];
export const PRODUCT_PATH: PlantPoint[] = [[4.15, .73, .52], [5.35, .73, .52], [5.35, .73, -.5], [6.8, .73, -.5]];
export const RACK_STEAM_PATH: PlantPoint[] = [[10, 2.3, -7], [10, 5.4, -7], [10, 5.4, -5.5], [-4.2, 5.4, -5.5], [-4.2, 4.5, -5.5], [-4.2, 4.5, -.55]];
export const CONDENSATE_PATH: PlantPoint[] = [[-.2, .32, -.8], [-.2, .32, -3.9], [4.4, .32, -3.9], [4.4, 4.8, -5.1], [10.7, 4.8, -5.1], [10.7, .7, -7]];

export type PlantService = "water" | "steam" | "condensate";
export type PlantRoute = { id: string; service: PlantService; points: PlantPoint[]; radius: number };
/** Context connections terminate on the same vessels, skid and utility drops in both views. */
export const CONTEXT_ROUTES: PlantRoute[] = [
  { id: "buffer-link", service: "water", points: [[-7.2, .62, -1.6], [-5.1, .62, -1.6], [-5.1, .62, 1.6]], radius: .085 },
  { id: "receiver-link", service: "water", points: [[6.8, .73, -.5], [6.8, .73, 1], [8.9, .73, 1], [8.9, .73, -.5]], radius: .085 },
  { id: "feed-header", service: "water", points: [[-13.5, 4.95, -5.8], [-7.2, 4.95, -5.8], [-7.2, 4.95, -1.6], [-7.2, 3.5, -1.6]], radius: .11 },
  { id: "steam-header", service: "steam", points: [[-13.5, 5.4, -5.5], [-4.2, 5.4, -5.5]], radius: .14 },
  { id: "steam-exchanger", service: "steam", points: [[10, 5.4, -5.5], [6.8, 5.4, -5.5], [6.8, 2, -4.1]], radius: .085 },
  { id: "exchanger-return", service: "condensate", points: [[6.8, 1.1, -4.1], [7.7, .7, -4.1], [7.7, .7, -7], [10.7, .7, -7]], radius: .055 },
];
export const PROCESS_ROUTES: PlantRoute[] = [
  { id: "suction", service: "water", points: SUCTION_PATH, radius: .095 },
  { id: "feed", service: "water", points: FEED_PATH, radius: .095 },
  { id: "outlet", service: "water", points: OUTLET_PATH, radius: .1 },
  { id: "product", service: "water", points: PRODUCT_PATH, radius: .1 },
  { id: "steam-supply", service: "steam", points: RACK_STEAM_PATH, radius: .14 },
  { id: "steam-drop", service: "steam", points: STEAM_PATH, radius: .075 },
  { id: "condensate", service: "condensate", points: CONDENSATE_PATH, radius: .055 },
];
