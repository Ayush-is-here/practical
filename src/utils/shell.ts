import fs from "node:fs";

/**
 * Pick a Unix-compatible shell so commands like `pwd`, `ls`, `find`, `grep`
 * work on Windows machines that have Git Bash installed. Falls back to the
 * platform default when no Unix shell is available.
 */
export function findBashShell(): string | undefined {
  if (process.platform !== "win32") return undefined; // `exec` defaults to /bin/sh on POSIX

  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Git\\bin\\bash.exe",
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore and keep trying
    }
  }
  return undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
