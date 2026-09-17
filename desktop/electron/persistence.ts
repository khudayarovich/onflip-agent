import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomically, withoutBom } from "onflip/dist/config";

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function readJsonFile(file: string): unknown {
  return JSON.parse(withoutBom(fs.readFileSync(file, "utf8")));
}

/** Preserve the unreadable original for diagnosis and manual recovery. */
export function preserveCorruptFile(file: string, label: string, error: unknown): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = `${file}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(file, copy);
    console.warn(`[${label}] unreadable data preserved at ${copy}: ${error instanceof Error ? error.message : String(error)}`);
    return copy;
  } catch {
    console.warn(`[${label}] unreadable data left untouched at ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomically(file, `${JSON.stringify(value, null, 2)}\n`);
}
