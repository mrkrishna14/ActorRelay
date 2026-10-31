import type { Engine } from "./harness";

// PROP_TARGET=reference runs the spec reference. Everything else runs the real logic.
const reference = process.env.PROP_TARGET === "reference";
export const engine: Engine = reference
  ? (await import("./reference")).engine
  : (await import("./real-adapter")).engine;
export const isReal = !reference;
