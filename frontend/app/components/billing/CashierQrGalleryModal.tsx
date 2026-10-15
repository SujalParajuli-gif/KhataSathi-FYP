import { useEffect, useState, useRef, useCallback } from "react";
import Icon from "~/components/ui/Icon";
import { ModalFrame } from "~/components/ui/Modal";
import PreviewableImage from "~/components/ui/PreviewableImage";
import { getAuthUser } from "~/lib/auth";
import {
  getEnabledPaymentAccountsApi,
  fetchAuthenticatedBlobUrl,
  type EnabledPaymentAccountDto,
} from "~/lib/api/paymentAccounts";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type AccountAssetState = {
  thumbUrl: string | null;
  thumbLoading: boolean;
  thumbFailed: boolean;
  fileUrl: string | null;
  fileLoading: boolean;
  fileFailed: boolean;
};

type Props = {
  presentation?: "default" | "billing";
  open: boolean;
  onClose: () => void;
};

function isAuthorizedCashierActor(
  user: ReturnType<typeof getAuthUser>,
): user is NonNullable<ReturnType<typeof getAuthUser>> & {
  role: "admin" | "manager" | "cashier";
} {
  if (!user || !user.id) return false;
  return user.role === "admin" || user.role === "manager" || user.role === "cashier";
}

export default function CashierQrGalleryModal({
  open,
  presentation,
  onClose,
}: Props) {
  const [accounts, setAccounts] = useState<EnabledPaymentAccountDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [assetStates, setAssetStates] = useState<Record<string, AccountAssetState>>({});
  const generationRef = useRef<number>(0);
  const allCreatedUrlsRef = useRef<Set<string>>(new Set());
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const capturedActorRef = useRef<{ id: string; role: string } | null>(null);

  const getBlobKey = useCallback(
    (acc: EnabledPaymentAccountDto, actor?: { id: string; role: string } | null) => {
      const auth = actor || capturedActorRef.current || getAuthUser();
      const actorId = auth?.id || "anon";
      const role = auth?.role || "anon";
      return `${actorId}:${role}:${acc.id}:${acc.version}:${acc.activeQrAssetId}`;
    },
    [],
  );

  const revokeAllCreatedUrls = useCallback(() => {
    for (const url of allCreatedUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore revocation error
      }
    }
    allCreatedUrlsRef.current.clear();
  }, []);

  const loadAccountAsset = useCallback(
    async (
      acc: EnabledPaymentAccountDto,
      generation: number,
      capturedActor: { id: string; role: string },
      signal: AbortSignal,
      target: "both" | "thumb" | "file" = "both",
    ) => {
      const key = getBlobKey(acc, capturedActor);

      if (target === "both" || target === "thumb") {
        if (acc.activeQrThumbnailUrl) {
          setAssetStates((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              thumbUrl: prev[key]?.thumbUrl || null,
              thumbLoading: true,
              thumbFailed: false,
              fileUrl: prev[key]?.fileUrl || null,
              fileLoading: prev[key]?.fileLoading || false,
              fileFailed: prev[key]?.fileFailed || false,
            },
          }));

          try {
            const thumbUrl = await fetchAuthenticatedBlobUrl(acc.activeQrThumbnailUrl, signal);
            const liveAuth = getAuthUser();
            if (
              signal.aborted ||
              generationRef.current !== generation ||
              !isAuthorizedCashierActor(liveAuth) ||
              liveAuth?.id !== capturedActor.id ||
              liveAuth?.role !== capturedActor.role
            ) {
              try {
                URL.revokeObjectURL(thumbUrl);
              } catch {}
              return;
            }
            allCreatedUrlsRef.current.add(thumbUrl);
            setAssetStates((prev) => ({
              ...prev,
              [key]: {
                ...prev[key],
                thumbUrl,
                thumbLoading: false,
                thumbFailed: false,
              },
            }));
          } catch {
            const liveAuth = getAuthUser();
            if (
              signal.aborted ||
              generationRef.current !== generation ||
              !isAuthorizedCashierActor(liveAuth) ||
              liveAuth?.id !== capturedActor.id ||
              liveAuth?.role !== capturedActor.role
            ) {
              return;
            }
            setAssetStates((prev) => ({
              ...prev,
              [key]: {
                ...prev[key],
                thumbLoading: false,
                thumbFailed: true,
              },
            }));
          }
        }
      }

      if (target === "both" || target === "file") {
        if (acc.activeQrFileUrl) {
          setAssetStates((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              thumbUrl: prev[key]?.thumbUrl || null,
              thumbLoading: prev[key]?.thumbLoading || false,
              thumbFailed: prev[key]?.thumbFailed || false,
              fileUrl: prev[key]?.fileUrl || null,
              fileLoading: true,
              fileFailed: false,
            },
          }));

          try {
            const fileUrl = await fetchAuthenticatedBlobUrl(acc.activeQrFileUrl, signal);
            const liveAuth = getAuthUser();
            if (
              signal.aborted ||
              generationRef.current !== generation ||
              !isAuthorizedCashierActor(liveAuth) ||
              liveAuth?.id !== capturedActor.id ||
              liveAuth?.role !== capturedActor.role
            ) {
              try {
                URL.revokeObjectURL(fileUrl);
              } catch {}
              return;
            }
            allCreatedUrlsRef.current.add(fileUrl);
            setAssetStates((prev) => ({
              ...prev,
              [key]: {
                ...prev[key],
                fileUrl,
                fileLoading: false,
                fileFailed: false,
              },
            }));
          } catch {
            const liveAuth = getAuthUser();
            if (
              signal.aborted ||
              generationRef.current !== generation ||
              !isAuthorizedCashierActor(liveAuth) ||
              liveAuth?.id !== capturedActor.id ||
              liveAuth?.role !== capturedActor.role
            ) {
              return;
            }
            setAssetStates((prev) => ({
              ...prev,
              [key]: {
                ...prev[key],
                fileLoading: false,
                fileFailed: true,
              },
            }));
          }
        }
      }
    },
    [getBlobKey],
  );

  const fetchAccountsAndAssets = useCallback(async () => {
    const liveAuth = getAuthUser();
    if (!isAuthorizedCashierActor(liveAuth)) {
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
      generationRef.current++;
      revokeAllCreatedUrls();
      setAccounts([]);
      setAssetStates({});
      setLoading(false);
      setError(null);
      onClose();
      return;
    }

    const capturedActor = { id: liveAuth!.id, role: liveAuth!.role };
    capturedActorRef.current = capturedActor;

    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
    }
    const currentGeneration = ++generationRef.current;
    revokeAllCreatedUrls();
    setAssetStates({});

    const controller = new AbortController();
    activeAbortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const list = await getEnabledPaymentAccountsApi({ signal: controller.signal });
      const currentAuth = getAuthUser();
      if (
        controller.signal.aborted ||
        generationRef.current !== currentGeneration ||
        !isAuthorizedCashierActor(currentAuth) ||
        currentAuth?.id !== capturedActor.id ||
        currentAuth?.role !== capturedActor.role
      ) {
        return;
      }
      setAccounts(list);
      setLoading(false);

      for (const acc of list) {
        void loadAccountAsset(acc, currentGeneration, capturedActor, controller.signal, "both");
      }
    } catch (err: any) {
      const currentAuth = getAuthUser();
      if (
        controller.signal.aborted ||
        generationRef.current !== currentGeneration ||
        !isAuthorizedCashierActor(currentAuth) ||
        currentAuth?.id !== capturedActor.id ||
        currentAuth?.role !== capturedActor.role
      ) {
        return;
      }
      setError(err?.response?.data?.error || err.message || "Failed to load receiving QR accounts");
      setLoading(false);
    }
  }, [loadAccountAsset, revokeAllCreatedUrls, onClose]);

  useEffect(() => {
    if (!open) {
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
      generationRef.current++;
      revokeAllCreatedUrls();
      setAccounts([]);
      setAssetStates({});
      setLoading(false);
      setError(null);
      return;
    }

    const liveAuth = getAuthUser();
    if (!isAuthorizedCashierActor(liveAuth)) {
      onClose();
      return;
    }

    void fetchAccountsAndAssets();

    const handleAuthRefresh = () => {
      const activeUser = getAuthUser();
      if (!isAuthorizedCashierActor(activeUser)) {
        if (activeAbortControllerRef.current) {
          activeAbortControllerRef.current.abort();
          activeAbortControllerRef.current = null;
        }
        generationRef.current++;
        revokeAllCreatedUrls();
        setAccounts([]);
        setAssetStates({});
        setLoading(false);
        setError(null);
        onClose();
        return;
      }
      if (
        activeUser.id !== capturedActorRef.current?.id ||
        activeUser.role !== capturedActorRef.current?.role
      ) {
        void fetchAccountsAndAssets();
      }
    };

    window.addEventListener("storage", handleAuthRefresh);
    window.addEventListener("focus", handleAuthRefresh);
    document.addEventListener("visibilitychange", handleAuthRefresh);

    return () => {
      window.removeEventListener("storage", handleAuthRefresh);
      window.removeEventListener("focus", handleAuthRefresh);
      document.removeEventListener("visibilitychange", handleAuthRefresh);
      if (activeAbortControllerRef.current) {
        activeAbortControllerRef.current.abort();
        activeAbortControllerRef.current = null;
      }
      generationRef.current++;
      revokeAllCreatedUrls();
    };
  }, [open, onClose, fetchAccountsAndAssets, revokeAllCreatedUrls]);

  return (
    <ModalFrame presentation={presentation}
      open={open}
      title="Store Payment QRs Gallery"
      description="Scan static QR codes to receive payment. Cashier verifies confirmation on merchant account."
      onClose={onClose}
      maxWidthClass="max-w-[880px]"
      layer="critical"
    >
      <div className="space-y-4 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500">
            {accounts.length > 0 ? `${accounts.length} enabled payment ${accounts.length === 1 ? "QR" : "QRs"}` : "Present active store QR to customer"}
          </span>
          <button
            type="button"
            onClick={() => {
              void fetchAccountsAndAssets();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
          >
            <Icon name="sync" sizePx={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
        {error ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                void fetchAccountsAndAssets();
              }}
              className="rounded border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
            >
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="flex h-56 items-center justify-center text-xs font-medium text-slate-500">
            <Icon name="progress_activity" sizePx={20} className="animate-spin mr-2" />
            Loading receiving QRs…
          </div>
        ) : accounts.length === 0 && !error ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <Icon name="qr_code" sizePx={36} className="mx-auto text-slate-400" />
            <p className="mt-2 text-xs font-semibold text-slate-700">No active receiving QRs enabled</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Admin must publish and enable static QR accounts under Settings → Payment Accounts.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 max-h-[65dvh] overflow-y-auto pr-1">
            {accounts.map((acc) => {
              const blobKey = getBlobKey(acc);
              const assetState = assetStates[blobKey];
              const thumbUrl = assetState?.thumbUrl || null;
              const isFullFileReady = Boolean(assetState?.fileUrl);
              const fullFileUrl = isFullFileReady ? assetState!.fileUrl : null;

              return (
                <div
                  key={acc.id}
                  className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm transition hover:border-slate-300"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h4 className="font-bold text-sm text-slate-900 leading-tight">
                          {acc.providerLabel}
                        </h4>
                        <p className="text-[11px] font-medium text-slate-500 mt-0.5">
                          {acc.accountHolder}
                        </p>
                      </div>
                      {acc.supportedSettlement ? (
                        <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[9px] font-semibold text-slate-800 shrink-0">
                          {acc.settlementMethod === "FONEPAY" ? "Fonepay" : "Bank Transfer"}
                        </span>
                      ) : (
                        <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-semibold text-amber-800 shrink-0">
                          Display Only
                        </span>
                      )}
                    </div>

                    {acc.accountIdentifier ? (
                      <div className="rounded bg-slate-50 px-2 py-1 text-[11px] font-mono text-slate-700 border border-slate-200 truncate">
                        ID: <strong>{acc.accountIdentifier}</strong>
                      </div>
                    ) : null}

                    {/* QR Code Canvas */}
                    <div className="flex flex-col items-center justify-center rounded-lg border border-slate-200 bg-white p-2">
                      <div className="h-44 w-44 flex items-center justify-center">
                        {thumbUrl ? (
                          <PreviewableImage
                            src={thumbUrl}
                            previewSrc={fullFileUrl}
                            alt={`${acc.providerLabel} QR`}
                            title={`${acc.providerLabel} — ${acc.accountHolder}`}
                            subtitle={acc.accountIdentifier || undefined}
                            enableZoom={true}
                            enablePreview={isFullFileReady}
                            onRetryPreview={() => {
                              if (activeAbortControllerRef.current) {
                                void loadAccountAsset(
                                  acc,
                                  generationRef.current,
                                  capturedActorRef.current || { id: "anon", role: "anon" },
                                  activeAbortControllerRef.current.signal,
                                  "file",
                                );
                              }
                            }}
                            className="h-full w-full"
                            imgClassName="h-full w-full object-contain"
                          />
                        ) : assetState?.thumbLoading ? (
                          <div className="flex flex-col items-center justify-center text-slate-400 text-xs gap-1">
                            <Icon name="progress_activity" sizePx={24} className="animate-spin text-slate-400" />
                            <span>Loading QR…</span>
                          </div>
                        ) : assetState?.thumbFailed ? (
                          <div className="flex flex-col items-center justify-center text-rose-500 text-xs gap-1 text-center p-2">
                            <Icon name="broken_image" sizePx={24} className="text-rose-400" />
                            <span className="text-[11px] font-medium">Failed to load QR thumbnail</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (activeAbortControllerRef.current) {
                                  void loadAccountAsset(
                                    acc,
                                    generationRef.current,
                                    capturedActorRef.current || { id: "anon", role: "anon" },
                                    activeAbortControllerRef.current.signal,
                                    "thumb",
                                  );
                                }
                              }}
                              className="mt-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              Retry Thumbnail
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center text-slate-400 text-xs gap-1">
                            <Icon name="qr_code" sizePx={32} className="text-slate-300" />
                            <span>Loading QR…</span>
                          </div>
                        )}
                      </div>

                      {thumbUrl ? (
                        isFullFileReady ? (
                          <span className="text-[10px] font-semibold text-slate-500 mt-1 flex items-center gap-1">
                            <Icon name="zoom_in" sizePx={13} /> Click to enlarge & zoom
                          </span>
                        ) : assetState?.fileLoading ? (
                          <span className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                            <Icon name="progress_activity" sizePx={11} className="animate-spin" /> High-res preview loading…
                          </span>
                        ) : assetState?.fileFailed ? (
                          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-amber-700">
                            <span>High-res unavailable</span>
                            <button
                              type="button"
                              onClick={() => {
                                if (activeAbortControllerRef.current) {
                                  void loadAccountAsset(
                                    acc,
                                    generationRef.current,
                                    capturedActorRef.current || { id: "anon", role: "anon" },
                                    activeAbortControllerRef.current.signal,
                                    "file",
                                  );
                                }
                              }}
                              className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.2 text-[9px] font-semibold hover:bg-amber-100"
                            >
                              Retry Preview
                            </button>
                          </div>
                        ) : null
                      ) : null}
                    </div>

                    {!acc.supportedSettlement ? (
                      <p className="text-[10px] text-amber-800 italic text-center bg-amber-50/60 rounded p-1 border border-amber-100">
                        Manual settlement is not configured for this wallet. Scan for reference only; no provider verification.
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-xs text-slate-500">
          <span>Static QRs are managed in Settings by Administrator.</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 shadow-sm"
          >
            Close
          </button>
        </div>
      </div>
    </ModalFrame>
  );
}
