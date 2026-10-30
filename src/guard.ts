export type Rejection = "too_large" | "forbidden_field";

export const MAX_RECORD_BYTES = 64 * 1024;

const FORBIDDEN_KEYS = new Set([
  "path", "cwd", "folder", "dir", "localpath", "repopath",
  "rawoutput", "raw", "stdout", "stderr", "output",
  "apikey", "api_key", "secret", "password",
  "credential", "credentials", "token", "accesstoken", "devicetoken",
]);

const PATH_LIKE = /^[A-Za-z]:[\\/]|^\\\\|^\/(home|Users|root|mnt|var|tmp)\//;
const SECRET_LIKE = /(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]|-----BEGIN [A-Z ]*PRIVATE KEY)/;

function hasForbidden(value: unknown, depth = 0): boolean {
  if (depth > 10) return true;
  if (typeof value === "string") {
    return PATH_LIKE.test(value) || SECRET_LIKE.test(value);
  }
  if (Array.isArray(value)) return value.some((v) => hasForbidden(v, depth + 1));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) return true;
      if (hasForbidden(v, depth + 1)) return true;
    }
  }
  return false;
}

export function checkData(data: unknown): Rejection | null {
  if (Buffer.byteLength(JSON.stringify(data ?? {})) > MAX_RECORD_BYTES) return "too_large";
  return hasForbidden(data) ? "forbidden_field" : null;
}