import path from "node:path";

/**
 * Database paths must not depend on the operating system that created them.
 * New values use POSIX separators; existing Windows values remain readable
 * after moving the database to Linux/Docker.
 */
export function normalizeDocumentRelativePath(value: string): string | null {
  const portable = String(value || "").trim().replace(/\\/g, "/");
  if (!portable || path.posix.isAbsolute(portable)) return null;

  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }

  return normalized;
}

export function resolveDocumentStoragePath(
  storageRoot: string,
  relativePath: string,
  storedFileName: string,
): string | null {
  const normalizedRelativePath = normalizeDocumentRelativePath(relativePath);
  const normalizedFileName = String(storedFileName || "").trim();
  if (
    !normalizedRelativePath ||
    !normalizedFileName ||
    normalizedFileName === "." ||
    normalizedFileName === ".." ||
    normalizedFileName.includes("/") ||
    normalizedFileName.includes("\\")
  ) {
    return null;
  }

  const normalizedRoot = path.resolve(storageRoot);
  const absolutePath = path.resolve(
    normalizedRoot,
    ...normalizedRelativePath.split("/"),
    normalizedFileName,
  );
  if (
    absolutePath !== normalizedRoot &&
    !absolutePath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    return null;
  }

  return absolutePath;
}
