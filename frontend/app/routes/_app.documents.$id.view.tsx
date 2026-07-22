import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import Icon from "~/components/ui/Icon";
import {
  fetchDocumentFileBlobApi,
  getDocumentApi,
  type DocumentRecord,
} from "~/lib/api/endpoints";

function formatBytes(bytes: number, decimals = 1) {
  if (!Number(bytes)) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

function typeLabel(value: string) {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function DocumentFullViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadDocument() {
      if (!id) {
        setError("Document id is missing.");
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError("");
        const [documentRecord, blob] = await Promise.all([
          getDocumentApi(id),
          fetchDocumentFileBlobApi(id),
        ]);
        objectUrl = URL.createObjectURL(blob);
        if (active) {
          setDoc(documentRecord);
          setPreviewUrl(objectUrl);
        }
      } catch (err: any) {
        if (active) setError(err?.message || "Failed to open document.");
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDocument();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  async function downloadDocument() {
    if (!doc || !id) return;
    try {
      const blob = await fetchDocumentFileBlobApi(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || "Failed to download document.");
    }
  }

  return (
    <div className="flex h-[calc(100dvh-72px)] flex-col bg-[#F3F4F6] text-[#11120d]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[#CFCFD3] bg-white px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/documents")}
            className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]"
            title="Back to documents"
          >
            <Icon name="arrow_back" sizePx={20} />
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-extrabold text-[#11120d]">
              {doc?.fileName || "Document viewer"}
            </h1>
            <p className="mt-0.5 text-[12px] font-semibold text-[#8C8889]">
              {doc ? `${typeLabel(doc.documentType)} | ${formatBytes(doc.fileSize)} | ${doc.mimeType}` : "Loading document..."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void downloadDocument()}
            disabled={!doc}
            className="inline-flex h-[40px] items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon name="download" sizePx={18} />
            Download
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="inline-flex h-[40px] items-center gap-2 rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white hover:bg-[#2a2c27]"
          >
            <Icon name="close" sizePx={18} />
            Close
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 p-4">
        <section className="flex h-full min-h-0 overflow-hidden rounded-[18px] border border-[#CFCFD3] bg-white shadow-sm">
          {loading ? (
            <div className="flex flex-1 items-center justify-center text-[13px] font-extrabold text-[#8C8889]">
              Loading preview...
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <Icon name="error" sizePx={46} className="text-rose-600" />
              <div className="mt-3 text-[15px] font-extrabold text-[#11120d]">{error}</div>
              <button
                type="button"
                onClick={() => navigate("/documents")}
                className="mt-5 h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
              >
                Back to Documents
              </button>
            </div>
          ) : doc?.mimeType.startsWith("image/") ? (
            <div className="flex flex-1 items-center justify-center overflow-auto bg-[#F3F4F6] p-4">
              <img src={previewUrl} alt={doc.fileName} className="max-h-full max-w-full object-contain" />
            </div>
          ) : doc?.mimeType === "application/pdf" ? (
            <iframe src={previewUrl} title={doc.fileName} className="h-full w-full border-0 bg-white" />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
              <Icon name="description" sizePx={52} className="text-[#8C8889]" />
              <div className="mt-3 text-[15px] font-extrabold text-[#11120d]">Preview not available</div>
              <button
                type="button"
                onClick={() => void downloadDocument()}
                className="mt-5 h-[40px] rounded-[12px] border border-[#11120d] bg-[#11120d] px-4 text-[12px] font-extrabold text-white hover:bg-[#2a2c27]"
              >
                Download File
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
