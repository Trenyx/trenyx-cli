import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Lang } from "./types.js";

export interface CatalogueEntry {
  name: string;
  how: string;
}

/** What a source may be told: the language and file types only, never code. */
export interface CatalogueHints {
  language: Lang;
  fileTypes: string[];
}

/** Where the common kinds of bug come from. Bundled with the package today. */
export interface CatalogueSource {
  load(hints: CatalogueHints): Promise<CatalogueEntry[]>;
}

export const bundledCatalogue: CatalogueSource = {
  async load({ language }) {
    const file = fileURLToPath(new URL("../../catalogue/slice.json", import.meta.url));
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { kinds: Record<string, CatalogueEntry[]> };
    return doc.kinds[language] ?? [];
  },
};

const DRAW_SHARE = 2 / 3;       // enough for the writer to find kinds that fit, few enough that a run can't be studied for

export const newSeed = () => randomBytes(4).toString("hex");

/** A random part of the kinds, so a suite can't be tuned to a fixed list. Each kind's place comes only from the seed and
 * its own name, so the same seed draws the same kinds, in the catalogue's order. */
export function drawKinds(kinds: CatalogueEntry[], seed: string): CatalogueEntry[] {
  const place = new Map(kinds.map((k) => [k, createHash("sha256").update(`${seed}\0${k.name}`).digest("hex")]));
  const drawn = new Set([...kinds].sort((a, b) => (place.get(a)! < place.get(b)! ? -1 : 1)).slice(0, Math.ceil(kinds.length * DRAW_SHARE)));
  return kinds.filter((k) => drawn.has(k));
}
