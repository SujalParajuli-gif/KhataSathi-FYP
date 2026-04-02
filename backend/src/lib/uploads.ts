import fs from "fs/promises";
import path from "path";

const UPLOADS_PREFIX = "/uploads/";
const uploadsRoot = path.resolve(__dirname, "../../uploads");

function resolveUploadFile(publicUrl?: string | null) {
  if (!publicUrl || typeof publicUrl !== "string") return null;
  if (!publicUrl.startsWith(UPLOADS_PREFIX)) return null;

  const relativePath = publicUrl
    .slice(UPLOADS_PREFIX.length)
    .replace(/^[/\\]+/, "")
    .split("/")
    .join(path.sep);

  if (!relativePath) return null;

  const absolutePath = path.resolve(uploadsRoot, relativePath);
  if (absolutePath !== uploadsRoot && !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return null;
  }

  return absolutePath;
}

export async function deleteUploadFile(publicUrl?: string | null) {
  const filePath = resolveUploadFile(publicUrl);
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error("Failed to delete upload file:", filePath, error);
    }
  }
}

export async function deleteReplacedUpload(
  previousUrl?: string | null,
  nextUrl?: string | null,
) {
  if (!previousUrl || previousUrl === nextUrl) return;
  await deleteUploadFile(previousUrl);
}
