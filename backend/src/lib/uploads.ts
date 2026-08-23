import fs from "fs/promises";
import path from "path";

const UPLOADS_PREFIX = "/uploads/"; // the URL prefix that all uploaded file paths start with
// Profile and product uploads are written to the repository-level uploads folder.
// This path works from both src/lib (development) and dist/lib (production).
export const uploadsRoot = process.env.UPLOADS_ROOT?.trim()
  ? path.resolve(process.env.UPLOADS_ROOT)
  : path.resolve(__dirname, "../../../uploads");

// Every application upload directory is derived from the same configurable
// root. This keeps local development and the mounted production volume aligned.
export const productUploadsDir = path.join(uploadsRoot, "products");

// converting a public URL like "/uploads/products/image.png" to the actual file path on disk
// we added multiple safety checks here to prevent path traversal attacks
// where someone could try to access files outside the uploads folder using "../" in the URL
export function resolveUploadFilePath(publicUrl?: string | null) {
  if (!publicUrl || typeof publicUrl !== "string") return null; // skip if no URL is provided
  if (!publicUrl.startsWith(UPLOADS_PREFIX)) return null; // reject URLs that do not start with /uploads/

  // extracting the relative path after "/uploads/" and normalizing path separators for the current OS
  const relativePath = publicUrl
    .slice(UPLOADS_PREFIX.length)
    .replace(/^[/\\]+/, "")
    .split("/")
    .join(path.sep);

  if (!relativePath) return null; // reject empty paths

  const absolutePath = path.resolve(uploadsRoot, relativePath);
  // making sure the resolved path is still inside the uploads folder
  // path.resolve can follow "../" segments, so we check the final path stays within bounds
  if (absolutePath !== uploadsRoot && !absolutePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return null;
  }

  return absolutePath;
}

// Checking a managed upload before returning its URL prevents the frontend from
// repeatedly requesting a file that was removed outside the application. URLs
// outside /uploads are not managed by this service and are left untouched.
export async function isUploadFileAvailable(publicUrl?: string | null) {
  if (!publicUrl) return false;

  const filePath = resolveUploadFilePath(publicUrl);
  if (!filePath) return true;

  try {
    await fs.access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    console.error("Failed to inspect upload file:", filePath, error);
    return true;
  }
}

// deleting an uploaded file from disk using its public URL
// we use this when a product image or profile photo is replaced with a new one, so the old file does not stay on disk
export async function deleteUploadFile(publicUrl?: string | null) {
  const filePath = resolveUploadFilePath(publicUrl); // converting the URL to an actual file path
  if (!filePath) return; // skip if the URL could not be resolved safely

  try {
    await fs.unlink(filePath); // removing the file from disk
  } catch (error: any) {
    // ENOENT means the file does not exist — we ignore this because it might have already been deleted
    // any other error is logged so we know something went wrong
    if (error?.code !== "ENOENT") {
      console.error("Failed to delete upload file:", filePath, error);
    }
  }
}

// deleting the old uploaded file when a new one replaces it
// we skip the deletion if no previous URL exists or if the old and new URLs are the same (no actual replacement)
export async function deleteReplacedUpload(
  previousUrl?: string | null,
  nextUrl?: string | null,
) {
  if (!previousUrl || previousUrl === nextUrl) return;
  await deleteUploadFile(previousUrl);
}
