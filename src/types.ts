export type Lang = "go" | "python" | "typescript" | "rust";

export const LANG_NAME: Record<Lang, string> = { go: "Go", python: "Python", typescript: "TypeScript/JavaScript", rust: "Rust" };

/** One bug: one exact-text edit to one file. */
export interface Bug {
  id: string;
  title: string;
  kind?: string;
  file: string;
  old: string;
  new: string;
  line?: number;
}

/** A stop the developer should read: printed as plain words, exit code 1, no stack trace. */
export class Stop extends Error {}
