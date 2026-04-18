import fs from "fs/promises";
import path from "path";

const UPLOADS_PREFIX = "/uploads/"; // the URL prefix that all uploaded file paths start with
const uploadsRoot = path.resolve(__dirname, "../../uploads"); // absolute path to the uploads folder on disk

// converting a public URL like "/uploads/products/image.png" to the actual file path on disk
// we added multiple safety checks here to prevent path traversal attacks
// where someone could try to access files outside the uploads folder using "../" in the URL
function resolveUploadFile(publicUrl?: string | null) {
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

// deleting an uploaded file from disk using its public URL
// we use this when a product image or profile photo is replaced with a new one, so the old file does not stay on disk
export async function deleteUploadFile(publicUrl?: string | null) {
  const filePath = resolveUploadFile(publicUrl); // converting the URL to an actual file path
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
