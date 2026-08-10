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

function documentDisplayTitle(doc: Pick<DocumentRecord, "title" | "fileName">) {
  return doc.title?.trim() || doc.fileName;
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

  function returnFromViewer() {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/documents");
  }

  function closeViewer() {
    if (window.opener) {
      window.close();
      return;
    }
    returnFromViewer();
  }

  return (
    <div className="fixed inset-0 z-[80] flex h-[100dvh] flex-col bg-[#F3F4F6] text-[#11120d] lg:static lg:h-[calc(100dvh-72px)]">
      <header className="flex min-h-[64px] shrink-0 items-center justify-between gap-2 border-b border-[#CFCFD3] bg-white px-3 py-2 lg:px-5 lg:py-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={returnFromViewer}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]"
            title="Go back"
          >
            <Icon name="arrow_back" sizePx={20} />
          </button>
          <div className="min-w-0">
            <h1 className="line-clamp-2 break-words text-[14px] font-extrabold leading-5 text-[#11120d] lg:truncate lg:text-[18px]" title={doc ? documentDisplayTitle(doc) : undefined}>
              {doc ? documentDisplayTitle(doc) : "Document viewer"}
            </h1>
            <p className="mt-0.5 hidden text-[12px] font-semibold text-[#8C8889] sm:block">
              {doc ? `${typeLabel(doc.documentType)} | ${formatBytes(doc.fileSize)} | ${doc.mimeType}` : "Loading document..."}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (previewUrl) window.open(previewUrl, "_blank", "noopener,noreferrer");
            }}
            disabled={!previewUrl}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50 lg:w-auto lg:px-4"
            title="Open in browser"
          >
            <Icon name="open_in_new" sizePx={18} />
            <span className="ml-2 hidden text-[12px] font-extrabold lg:inline">Open</span>
          </button>
          <button
            type="button"
            onClick={() => void downloadDocument()}
            disabled={!doc}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6] disabled:pointer-events-none disabled:opacity-50 lg:w-auto lg:px-4"
            title="Download"
          >
            <Icon name="download" sizePx={18} />
            <span className="ml-2 hidden text-[12px] font-extrabold lg:inline">Download</span>
          </button>
          <button
            type="button"
            onClick={closeViewer}
            className="inline-flex h-11 w-11 items-center justify-center rounded-[12px] border border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27] lg:w-auto lg:px-4"
            title="Close viewer"
          >
            <Icon name="close" sizePx={18} />
            <span className="ml-2 hidden text-[12px] font-extrabold lg:inline">Close</span>
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 lg:p-4">
        <section className="flex h-full min-h-0 overflow-hidden bg-white lg:rounded-[18px] lg:border lg:border-[#CFCFD3] lg:shadow-sm">
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
                onClick={returnFromViewer}
                className="mt-5 h-[40px] rounded-[12px] border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] hover:bg-[#F3F4F6]"
              >
                Back to Documents
              </button>
            </div>
          ) : doc?.mimeType.startsWith("image/") ? (
            <div className="flex flex-1 items-center justify-center overflow-auto bg-[#F3F4F6] lg:p-4">
              <img src={previewUrl} alt={doc.fileName} className="max-h-full max-w-full object-contain" />
            </div>
          ) : doc?.mimeType === "application/pdf" ? (
            <iframe src={`${previewUrl}#view=FitH`} title={doc.fileName} className="h-full w-full border-0 bg-white" />
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
