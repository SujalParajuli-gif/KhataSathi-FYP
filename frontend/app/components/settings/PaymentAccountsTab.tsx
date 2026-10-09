import { useEffect, useState, useRef } from "react";
import Icon from "~/components/ui/Icon";
import { ModalFrame } from "~/components/ui/Modal";
import { useToast } from "~/components/ui/Toast";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import { getAuthUser } from "~/lib/auth";
import {
  listPaymentAccountsApi,
  createPaymentAccountApi,
  patchPaymentAccountApi,
  reorderPaymentAccountsApi,
  uploadQrAssetApi,
  listPaymentAccountAuditApi,
  fetchAuthenticatedBlobUrl,
  type PaymentReceivingAccountDto,
  type PaymentAccountAuditLogDto,
  type CreatePaymentAccountPayload,
  type PatchPaymentAccountPayload,
} from "~/lib/api/paymentAccounts";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export default function PaymentAccountsTab() {
  const { showToast } = useToast();

  // Auth & role tracking
  // Auth & role tracking
  const [userRole, setUserRole] = useState<string | null>(() => getAuthUser()?.role ?? null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => getAuthUser()?.id ?? null);
  const isAdmin = userRole === "admin";

  const [accounts, setAccounts] = useState<PaymentReceivingAccountDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isReordering, setIsReordering] = useState(false);

  // Dialog & Form states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createDraft, setCreateDraft] = useState<CreatePaymentAccountPayload>({
    id: "",
    providerLabel: "",
    accountHolder: "",
    accountIdentifier: "",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
  });
  const [pendingCreateDraft, setPendingCreateDraft] = useState<CreatePaymentAccountPayload | null>(null);
  const pendingCreateRef = useRef<CreatePaymentAccountPayload | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createConflict, setCreateConflict] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);

  const [editingAccount, setEditingAccount] = useState<PaymentReceivingAccountDto | null>(null);
  const [editDraft, setEditDraft] = useState<PatchPaymentAccountPayload>({
    expectedVersion: 1,
    providerLabel: "",
    accountHolder: "",
    accountIdentifier: "",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  interface PendingUploadRecord {
    uploadId: string;
    accountId: string;
    expectedVersion: number;
    file: File;
    previewUrl: string | null;
    error: string | null;
  }

  const [uploadTarget, setUploadTarget] = useState<PaymentReceivingAccountDto | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<Record<string, PendingUploadRecord>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadConflict, setUploadConflict] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  const [auditTarget, setAuditTarget] = useState<PaymentReceivingAccountDto | null>(null);
  const [auditLogs, setAuditLogs] = useState<PaymentAccountAuditLogDto[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Blob URLs map and lifecycle tracking
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const blobUrlsRef = useRef<Record<string, string>>({});
  const allCreatedUrlsRef = useRef<Set<string>>(new Set());
  const listAbortRef = useRef<AbortController | null>(null);
  const auditAbortRef = useRef<AbortController | null>(null);

  // Generations and locks
  const authGenerationRef = useRef(0);
  const listGenerationRef = useRef(0);
  const auditGenerationRef = useRef(0);
  const activeAuditAccountIdRef = useRef<string | null>(null);
  const operationLockRef = useRef(false);

  const isOperationBusy = createBusy || editBusy || uploadBusy || isReordering || busyId !== null || loading;

  function revokeAllBlobUrls() {
    for (const url of allCreatedUrlsRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
    allCreatedUrlsRef.current.clear();
    blobUrlsRef.current = {};
    setBlobUrls({});
  }

  function isLiveAdmin(capturedUserId?: string | null, capturedAuthGen?: number): boolean {
    const live = getAuthUser();
    if (live?.role !== "admin") return false;
    if (capturedUserId !== undefined && live.id !== capturedUserId) return false;
    if (capturedAuthGen !== undefined && capturedAuthGen !== authGenerationRef.current) return false;
    return true;
  }

  // Auth sync on storage / focus / visibility
  useEffect(() => {
    function syncAuth() {
      authGenerationRef.current++;
      const user = getAuthUser();
      const nextRole = user?.role ?? null;
      const nextId = user?.id ?? null;
      setUserRole(nextRole);
      setCurrentUserId(nextId);

      if (nextRole !== "admin") {
        listAbortRef.current?.abort();
        auditAbortRef.current?.abort();
        revokeAllBlobUrls();
        setAccounts([]);
        setAuditLogs([]);
        setAuditTarget(null);
        setShowCreateModal(false);
        setEditingAccount(null);
        setUploadTarget(null);
        setLoading(false);
      }
    }

    window.addEventListener("storage", syncAuth);
    window.addEventListener("focus", syncAuth);
    document.addEventListener("visibilitychange", syncAuth);

    return () => {
      window.removeEventListener("storage", syncAuth);
      window.removeEventListener("focus", syncAuth);
      document.removeEventListener("visibilitychange", syncAuth);
    };
  }, []);

  async function loadAccounts(): Promise<PaymentReceivingAccountDto[] | null> {
    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;
    const listGen = ++listGenerationRef.current;

    if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
      setLoading(false);
      return null;
    }

    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const data = await listPaymentAccountsApi({ signal: controller.signal });
      if (controller.signal.aborted || !isLiveAdmin(capturedUserId, capturedAuthGen) || listGen !== listGenerationRef.current) {
        return null;
      }
      setAccounts(data);

      // Reconcile pending create if matching ID was committed with exact payload
      if (pendingCreateRef.current) {
        const pending = pendingCreateRef.current;
        const match = data.find((a) => a.id === pending.id);
        if (match) {
          const isExactMatch =
            match.providerLabel.trim() === pending.providerLabel.trim() &&
            match.accountHolder.trim() === pending.accountHolder.trim() &&
            (match.accountIdentifier?.trim() || null) === (pending.accountIdentifier?.trim() || null) &&
            (match.settlementMethod || null) === (pending.settlementMethod || null) &&
            match.confirmationMode === pending.confirmationMode;

          if (isExactMatch) {
            pendingCreateRef.current = null;
            setPendingCreateDraft(null);
            setShowCreateModal(false);
            setCreateConflict(false);
            setCreateError(null);
            showToast("success", "Payment receiving account created and confirmed.");
          } else {
            setCreateConflict(true);
            setCreateError("A conflicting account with identical ID already exists on the server. Please reset or create with a new ID.");
          }
        }
      }

      loadThumbnails(data, controller.signal, listGen, capturedUserId, capturedAuthGen);
      return data;
    } catch (err: any) {
      if (controller.signal.aborted || !isLiveAdmin(capturedUserId, capturedAuthGen) || listGen !== listGenerationRef.current) {
        return null;
      }
      setError(err?.response?.data?.error || err.message || "Failed to load payment receiving accounts");
      return null;
    } finally {
      if (!controller.signal.aborted && isLiveAdmin(capturedUserId, capturedAuthGen) && listGen === listGenerationRef.current) {
        setLoading(false);
      }
    }
  }

  async function loadThumbnails(
    list: PaymentReceivingAccountDto[],
    signal: AbortSignal,
    listGen: number,
    capturedUserId: string | null,
    capturedAuthGen: number,
  ) {
    const actorId = capturedUserId || "admin";
    const newBlobs: Record<string, string> = {};

    for (const acc of list) {
      if (signal.aborted || !isLiveAdmin(capturedUserId, capturedAuthGen) || listGen !== listGenerationRef.current) break;
      if (acc.activeQrAssetId) {
        const cacheKey = `${actorId}:${acc.id}:${acc.version}:${acc.activeQrAssetId}`;
        if (!blobUrlsRef.current[cacheKey]) {
          try {
            const url = `/api/settings/payment-accounts/${acc.id}/qr/${acc.activeQrAssetId}/thumbnail`;
            const blobUrl = await fetchAuthenticatedBlobUrl(url, signal);
            if (signal.aborted || !isLiveAdmin(capturedUserId, capturedAuthGen) || listGen !== listGenerationRef.current) {
              try {
                URL.revokeObjectURL(blobUrl);
              } catch {}
              break;
            }
            newBlobs[cacheKey] = blobUrl;
            blobUrlsRef.current[cacheKey] = blobUrl;
            allCreatedUrlsRef.current.add(blobUrl);
          } catch {
            // Thumbnail load failure is non-blocking
          }
        }
      }
    }

    if (
      Object.keys(newBlobs).length > 0 &&
      !signal.aborted &&
      isLiveAdmin(capturedUserId, capturedAuthGen) &&
      listGen === listGenerationRef.current
    ) {
      setBlobUrls((prev) => ({ ...prev, ...newBlobs }));
    }
  }

  useEffect(() => {
    if (!isAdmin) {
      listAbortRef.current?.abort();
      auditAbortRef.current?.abort();
      revokeAllBlobUrls();
      setAccounts([]);
      setLoading(false);
      return;
    }
    loadAccounts();
    return () => {
      listAbortRef.current?.abort();
      auditAbortRef.current?.abort();
      revokeAllBlobUrls();
    };
  }, [isAdmin, userRole, currentUserId]);

  function openCreate() {
    if (accounts.length >= 100 && !pendingCreateDraft) {
      showToast("danger", "Maximum limit of 100 payment accounts reached.");
      return;
    }
    if (pendingCreateDraft) {
      setCreateDraft(pendingCreateDraft);
    } else {
      const newId = crypto.randomUUID();
      setCreateDraft({
        id: newId,
        providerLabel: "",
        accountHolder: "",
        accountIdentifier: "",
        settlementMethod: "FONEPAY",
        confirmationMode: "MANUAL_RECEIPT",
      });
      setCreateError(null);
      setCreateConflict(false);
    }
    setShowCreateModal(true);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (operationLockRef.current || isOperationBusy) return;
    operationLockRef.current = true;

    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;

    const normalized: CreatePaymentAccountPayload = {
      id: createDraft.id || crypto.randomUUID(),
      providerLabel: createDraft.providerLabel.trim(),
      accountHolder: createDraft.accountHolder.trim(),
      accountIdentifier: createDraft.accountIdentifier?.trim() || null,
      settlementMethod:
        createDraft.confirmationMode === "MANUAL_RECEIPT"
          ? createDraft.settlementMethod || "FONEPAY"
          : null,
      confirmationMode: createDraft.confirmationMode,
    };

    if (!normalized.providerLabel || !normalized.accountHolder) {
      operationLockRef.current = false;
      setCreateError("Provider label and account holder are required.");
      showToast("danger", "Provider label and account holder are required.");
      return;
    }
    if (
      normalized.confirmationMode === "MANUAL_RECEIPT" &&
      normalized.settlementMethod === "BANK_TRANSFER" &&
      !normalized.accountIdentifier
    ) {
      operationLockRef.current = false;
      setCreateError("Account number / identifier is required for Bank Transfer settlement.");
      showToast("danger", "Account number / identifier is required for Bank Transfer settlement.");
      return;
    }

    setPendingCreateDraft(normalized);
    pendingCreateRef.current = normalized;
    setCreateBusy(true);
    setCreateError(null);
    setCreateConflict(false);

    try {
      await createPaymentAccountApi(normalized);

      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      setPendingCreateDraft(null);
      pendingCreateRef.current = null;
      setShowCreateModal(false);
      showToast("success", "Payment receiving account created. Upload a QR to enable it.");
      await loadAccounts();
    } catch (err: any) {
      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err?.message || "Failed to create account";

      if (status === 409) {
        setCreateConflict(true);
        setCreateError(`Conflict: ${msg}. Refreshing account list. Review details before resubmitting.`);
        showToast("danger", msg);
        await loadAccounts();
      } else if (status >= 400 && status < 500) {
        setPendingCreateDraft(null);
        pendingCreateRef.current = null;
        setCreateError(msg);
        showToast("danger", msg);
      } else {
        setCreateError(`Creation outcome uncertain (${msg}). Click Retry to resubmit exact attempt.`);
        showToast("danger", "Creation status uncertain. Please retry.");
      }
    } finally {
      setCreateBusy(false);
      operationLockRef.current = false;
    }
  }

  function handleResetCreateDraft() {
    setPendingCreateDraft(null);
    pendingCreateRef.current = null;
    setCreateConflict(false);
    setCreateError(null);
    setCreateDraft({
      id: crypto.randomUUID(),
      providerLabel: "",
      accountHolder: "",
      accountIdentifier: "",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
    });
  }

  function openEdit(acc: PaymentReceivingAccountDto) {
    if (isOperationBusy) return;
    setEditingAccount(acc);
    setEditError(null);
    setEditDraft({
      expectedVersion: acc.version,
      providerLabel: acc.providerLabel,
      accountHolder: acc.accountHolder,
      accountIdentifier: acc.accountIdentifier || "",
      settlementMethod: acc.settlementMethod,
      confirmationMode: acc.confirmationMode,
    });
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingAccount || operationLockRef.current || isOperationBusy) return;
    operationLockRef.current = true;

    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;

    if (!editDraft.providerLabel?.trim() || !editDraft.accountHolder?.trim()) {
      operationLockRef.current = false;
      setEditError("Provider label and account holder are required.");
      showToast("danger", "Provider label and account holder are required.");
      return;
    }
    if (
      editDraft.confirmationMode === "MANUAL_RECEIPT" &&
      editDraft.settlementMethod === "BANK_TRANSFER" &&
      !editDraft.accountIdentifier?.trim()
    ) {
      operationLockRef.current = false;
      setEditError("Account number / identifier is required for Bank Transfer settlement.");
      showToast("danger", "Account number / identifier is required for Bank Transfer settlement.");
      return;
    }

    setEditBusy(true);
    setEditError(null);
    try {
      await patchPaymentAccountApi(editingAccount.id, {
        expectedVersion: editDraft.expectedVersion,
        providerLabel: editDraft.providerLabel.trim(),
        accountHolder: editDraft.accountHolder.trim(),
        accountIdentifier: editDraft.accountIdentifier?.trim() || null,
        settlementMethod:
          editDraft.confirmationMode === "MANUAL_RECEIPT"
            ? editDraft.settlementMethod
            : null,
        confirmationMode: editDraft.confirmationMode,
      });

      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      showToast("success", "Payment receiving account updated.");
      setEditingAccount(null);
      await loadAccounts();
    } catch (err: any) {
      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err.message || "Failed to update account";
      setEditError(msg);
      showToast("danger", msg);
      if (status === 409) {
        await loadAccounts();
      }
    } finally {
      setEditBusy(false);
      operationLockRef.current = false;
    }
  }

  async function toggleEnable(acc: PaymentReceivingAccountDto) {
    if (operationLockRef.current || isOperationBusy) return;
    if (!acc.enabled && !acc.activeQrAssetId) {
      showToast("danger", "Cannot enable account without a published QR asset. Upload a QR first.");
      return;
    }
    operationLockRef.current = true;
    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;

    setBusyId(acc.id);
    try {
      await patchPaymentAccountApi(acc.id, {
        expectedVersion: acc.version,
        enabled: !acc.enabled,
      });

      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      showToast("success", `Account ${!acc.enabled ? "enabled" : "disabled"}.`);
      await loadAccounts();
    } catch (err: any) {
      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      showToast("danger", err?.response?.data?.error || err.message || "Failed to update status.");
      await loadAccounts();
    } finally {
      setBusyId(null);
      operationLockRef.current = false;
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (operationLockRef.current || isOperationBusy) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= accounts.length) return;

    operationLockRef.current = true;
    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;

    const newAccounts = [...accounts];
    const [moved] = newAccounts.splice(index, 1);
    newAccounts.splice(targetIndex, 0, moved);

    const orders = newAccounts.map((acc) => ({
      id: acc.id,
      expectedVersion: acc.version,
    }));

    setIsReordering(true);
    try {
      const updated = await reorderPaymentAccountsApi(orders);

      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      setAccounts(updated);
      showToast("success", "Account order saved.");
    } catch (err: any) {
      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      showToast("danger", err?.response?.data?.error || err.message || "Failed to reorder accounts.");
      await loadAccounts();
    } finally {
      setIsReordering(false);
      operationLockRef.current = false;
    }
  }

  function openUpload(acc: PaymentReceivingAccountDto) {
    if (isOperationBusy) return;
    setUploadTarget(acc);
    setUploadBusy(false);
    setUploadConflict(false);

    const pending = pendingUploads[acc.id];
    if (pending) {
      setSelectedFile(pending.file);
      setFilePreviewUrl(pending.previewUrl);
      setUploadError(pending.error || "Pending upload attempt frozen. Click Retry Exact Upload to retry.");
    } else {
      setSelectedFile(null);
      if (filePreviewUrl) {
        try {
          URL.revokeObjectURL(filePreviewUrl);
        } catch {}
      }
      setFilePreviewUrl(null);
      setUploadError(null);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && uploadTarget) {
      const validMimes = ["image/jpeg", "image/png", "image/webp"];
      if (!validMimes.includes(file.type)) {
        setUploadError("Only JPEG, PNG, or WebP images are allowed.");
        showToast("danger", "Only JPEG, PNG, or WebP images are allowed.");
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setUploadError("File size must be under 5 MiB.");
        showToast("danger", "File size must be under 5 MiB.");
        return;
      }
      setSelectedFile(file);
      setUploadError(null);
      setUploadConflict(false);
      if (filePreviewUrl) {
        try {
          URL.revokeObjectURL(filePreviewUrl);
        } catch {}
      }
      const preview = URL.createObjectURL(file);
      allCreatedUrlsRef.current.add(preview);
      setFilePreviewUrl(preview);
    }
  }

  async function handleUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadTarget || operationLockRef.current || isOperationBusy) return;
    operationLockRef.current = true;

    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;

    let attempt = pendingUploads[uploadTarget.id] || null;
    if (!attempt) {
      if (!selectedFile) {
        operationLockRef.current = false;
        setUploadError("Please select a QR code image file.");
        return;
      }
      attempt = {
        uploadId: crypto.randomUUID(),
        accountId: uploadTarget.id,
        expectedVersion: uploadTarget.version,
        file: selectedFile,
        previewUrl: filePreviewUrl,
        error: null,
      };
    }

    setUploadBusy(true);
    setUploadError(null);
    setUploadConflict(false);

    try {
      const publishedAsset = await uploadQrAssetApi(
        attempt.accountId,
        attempt.uploadId,
        attempt.expectedVersion,
        attempt.file,
      );

      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      setPendingUploads((prev) => {
        const next = { ...prev };
        delete next[attempt!.accountId];
        return next;
      });

      if (filePreviewUrl) {
        try {
          URL.revokeObjectURL(filePreviewUrl);
        } catch {}
      }
      setFilePreviewUrl(null);
      setSelectedFile(null);
      const targetId = uploadTarget.id;
      setUploadTarget(null);

      const refreshed = await loadAccounts();
      const matched = refreshed?.find((a) => a.id === targetId);
      if (matched && matched.activeQrAssetId && matched.activeQrAssetId !== publishedAsset.id) {
        showToast("info", "Original QR upload was acknowledged by the server, but current active QR differs.");
      } else {
        showToast("success", "QR asset published successfully.");
      }
    } catch (err: any) {
      if (!isLiveAdmin(capturedUserId, capturedAuthGen)) {
        revokeAllBlobUrls();
        setAccounts([]);
        return;
      }

      const status = err?.response?.status;
      const msg = err?.response?.data?.error || err?.message || "Failed to upload QR asset";

      if (status === 409) {
        setPendingUploads((prev) => {
          const next = { ...prev };
          delete next[attempt!.accountId];
          return next;
        });
        setUploadConflict(true);
        setUploadError(`Version conflict: ${msg}. Refreshing account. Review refreshed version before republishing.`);
        showToast("danger", msg);
        await loadAccounts();
        setAccounts((latest) => {
          const match = latest.find((a) => a.id === uploadTarget.id);
          if (match) {
            setUploadTarget(match);
          }
          return latest;
        });
      } else if (status >= 400 && status < 500) {
        setPendingUploads((prev) => {
          const next = { ...prev };
          delete next[attempt!.accountId];
          return next;
        });
        setUploadError(msg);
        showToast("danger", msg);
      } else {
        const uncertainError = `Upload outcome uncertain (${msg}). Click Retry to retry exact upload.`;
        setPendingUploads((prev) => ({
          ...prev,
          [attempt!.accountId]: {
            ...attempt!,
            error: uncertainError,
            previewUrl: filePreviewUrl,
          },
        }));
        setUploadError(uncertainError);
        showToast("danger", "Upload outcome uncertain. Please retry.");
      }
    } finally {
      setUploadBusy(false);
      operationLockRef.current = false;
    }
  }

  async function openAudit(acc: PaymentReceivingAccountDto) {
    if (operationLockRef.current || isOperationBusy) return;
    const capturedUserId = getAuthUser()?.id ?? null;
    const capturedAuthGen = authGenerationRef.current;
    const auditGen = ++auditGenerationRef.current;
    activeAuditAccountIdRef.current = acc.id;

    auditAbortRef.current?.abort();
    const controller = new AbortController();
    auditAbortRef.current = controller;

    setAuditTarget(acc);
    setAuditLogs([]);
    setAuditLoading(true);

    try {
      const logs = await listPaymentAccountAuditApi(acc.id, { signal: controller.signal });
      if (
        !controller.signal.aborted &&
        isLiveAdmin(capturedUserId, capturedAuthGen) &&
        auditGen === auditGenerationRef.current &&
        activeAuditAccountIdRef.current === acc.id
      ) {
        setAuditLogs(logs);
      }
    } catch (err: any) {
      if (
        !controller.signal.aborted &&
        isLiveAdmin(capturedUserId, capturedAuthGen) &&
        auditGen === auditGenerationRef.current &&
        activeAuditAccountIdRef.current === acc.id
      ) {
        showToast("danger", err?.response?.data?.error || err.message || "Failed to load audit history.");
      }
    } finally {
      if (
        !controller.signal.aborted &&
        auditGen === auditGenerationRef.current &&
        activeAuditAccountIdRef.current === acc.id
      ) {
        setAuditLoading(false);
      }
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-xs">
        <Icon name="lock" sizePx={32} className="mx-auto text-slate-400" />
        <h3 className="mt-2 text-sm font-bold text-slate-800">Admin Privileges Required</h3>
        <p className="mt-1 text-xs text-slate-500">
          Managing static QR payment receiving accounts is restricted to administrator accounts.
        </p>
      </div>
    );
  }

  const actorId = currentUserId || "admin";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Icon name="qr_code" sizePx={24} className="text-slate-700" />
            Static QR Payment Accounts
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Configure receiving bank accounts and digital wallets for Cashier POS QR scanning and manual payment confirmation.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          disabled={isOperationBusy || (accounts.length >= 100 && !pendingCreateDraft)}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-slate-950 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
        >
          <Icon name="add" sizePx={18} />
          Add Payment Account
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-medium text-rose-800 flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={loadAccounts}
            disabled={loading}
            className="rounded border border-rose-300 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Account List */}
      {loading ? (
        <div className="flex h-48 items-center justify-center text-xs font-medium text-slate-400">
          <Icon name="progress_activity" sizePx={20} className="animate-spin mr-2" />
          Loading payment accounts…
        </div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center">
          <Icon name="account_balance" sizePx={40} className="mx-auto text-slate-400" />
          <h3 className="mt-3 text-sm font-bold text-slate-800">No payment accounts configured</h3>
          <p className="mt-1 text-xs text-slate-500 max-w-sm mx-auto">
            Add receiving accounts (Fonepay merchant QR, Bank Transfer accounts, or Wallets) so cashiers can present scannable QRs during billing.
          </p>
          <button
            type="button"
            onClick={openCreate}
            disabled={isOperationBusy}
            className="mt-4 inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
          >
            <Icon name="add" sizePx={16} />
            Create First Account
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="divide-y divide-slate-100">
            {accounts.map((acc, index) => {
              const blobKey = `${actorId}:${acc.id}:${acc.version}:${acc.activeQrAssetId}`;
              const thumbnailSrc = blobUrls[blobKey] || null;
              const hasLinkedPayments = (acc.linkedPaymentsCount || 0) > 0;

              return (
                <div
                  key={acc.id}
                  className={cn(
                    "flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between transition",
                    !acc.enabled ? "bg-slate-50/70" : "bg-white",
                  )}
                >
                  <div className="flex items-start gap-3.5 min-w-0">
                    {/* Thumbnail preview */}
                    <div className="h-16 w-16 shrink-0 rounded-lg border border-slate-200 bg-slate-100 p-1 flex items-center justify-center overflow-hidden">
                      {thumbnailSrc ? (
                        <PreviewableImage
                          src={thumbnailSrc}
                          alt={`${acc.providerLabel} QR`}
                          title={`${acc.providerLabel} (${acc.accountHolder})`}
                          subtitle={acc.accountIdentifier || "Receiving QR"}
                          enableZoom
                          className="h-full w-full"
                          imgClassName="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center text-[10px] text-slate-400 font-medium text-center">
                          <Icon name="qr_code" sizePx={22} className="text-slate-300" />
                          <span>No QR</span>
                        </div>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900">{acc.providerLabel}</span>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            acc.enabled
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-slate-100 text-slate-600 border border-slate-200",
                          )}
                        >
                          {acc.enabled ? "Enabled" : "Disabled"}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                          v{acc.version}
                        </span>
                        {acc.confirmationMode === "MANUAL_RECEIPT" ? (
                          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 border border-blue-200">
                            {acc.settlementMethod === "FONEPAY" ? "Fonepay" : "Bank Transfer"} Settlement
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 border border-amber-200">
                            Display Only
                          </span>
                        )}
                      </div>

                      <div className="mt-1 text-xs text-slate-600 font-medium">
                        <span>Holder: <strong className="text-slate-800">{acc.accountHolder}</strong></span>
                        {acc.accountIdentifier ? (
                          <span className="ml-3">
                            ID/A/C: <strong className="font-mono text-slate-800">{acc.accountIdentifier}</strong>
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                        <span>Assets: {acc.totalAssetsCount || 0}</span>
                        <span>•</span>
                        <span>Linked payments: {acc.linkedPaymentsCount || 0}</span>
                        {hasLinkedPayments ? (
                          <>
                            <span>•</span>
                            <span className="text-slate-500 font-medium">Identity locked (in use)</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-1.5 self-end sm:self-center">
                    {/* Reorder Up/Down */}
                    <div className="inline-flex rounded-lg border border-slate-200 bg-white">
                      <button
                        type="button"
                        disabled={index === 0 || isOperationBusy}
                        onClick={() => handleMove(index, -1)}
                        className="p-1.5 text-slate-600 hover:text-slate-900 disabled:opacity-30"
                        title="Move Up"
                        aria-label="Move Up"
                      >
                        <Icon name="arrow_upward" sizePx={16} />
                      </button>
                      <button
                        type="button"
                        disabled={index === accounts.length - 1 || isOperationBusy}
                        onClick={() => handleMove(index, 1)}
                        className="p-1.5 text-slate-600 hover:text-slate-900 border-l border-slate-200 disabled:opacity-30"
                        title="Move Down"
                        aria-label="Move Down"
                      >
                        <Icon name="arrow_downward" sizePx={16} />
                      </button>
                    </div>

                    {/* Upload QR */}
                    <button
                      type="button"
                      disabled={isOperationBusy}
                      onClick={() => openUpload(acc)}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Icon name="upload" sizePx={15} />
                      {acc.activeQrAssetId ? "Replace QR" : "Upload QR"}
                    </button>

                    {/* Edit */}
                    <button
                      type="button"
                      disabled={isOperationBusy}
                      onClick={() => openEdit(acc)}
                      className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <Icon name="edit" sizePx={15} />
                      Edit
                    </button>

                    {/* Enable / Disable Toggle */}
                    <button
                      type="button"
                      disabled={busyId === acc.id || isOperationBusy || (!acc.enabled && !acc.activeQrAssetId)}
                      onClick={() => toggleEnable(acc)}
                      className={cn(
                        "inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold shadow-sm transition disabled:opacity-50",
                        acc.enabled
                          ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          : "bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-slate-300",
                      )}
                    >
                      {acc.enabled ? "Disable" : "Enable"}
                    </button>

                    {/* Audit */}
                    <button
                      type="button"
                      disabled={isOperationBusy}
                      onClick={() => openAudit(acc)}
                      className="p-2 text-slate-400 hover:text-slate-700 disabled:opacity-50"
                      title="View Audit History"
                      aria-label="View Audit History"
                    >
                      <Icon name="history" sizePx={18} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Create Account Modal */}
      <ModalFrame
        open={showCreateModal}
        title="Add Static QR Payment Account"
        description="Create a receiving account profile before publishing its static QR asset."
        onClose={() => {
          if (!createBusy) setShowCreateModal(false);
        }}
        maxWidthClass="max-w-[520px]"
      >
        <form onSubmit={handleCreateSubmit} className="space-y-4 pt-2">
          {createError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
              {createError}
            </div>
          ) : null}

          {pendingCreateDraft ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-center justify-between">
              <div>
                <strong className="font-bold">Pending submission frozen:</strong>
                <p className="mt-0.5 text-[11px] opacity-90">
                  Exact account ID <code className="font-mono text-[10px]">{pendingCreateDraft.id.slice(0, 8)}…</code> is bound to this attempt.
                </p>
              </div>
              {createConflict ? (
                <button
                  type="button"
                  onClick={handleResetCreateDraft}
                  className="rounded border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-50"
                >
                  Create with New ID
                </button>
              ) : null}
            </div>
          ) : null}

          <div>
            <label className="block text-xs font-bold text-slate-700">Provider / Bank / Wallet Name *</label>
            <input
              type="text"
              required
              disabled={Boolean(pendingCreateDraft) && !createConflict}
              placeholder="e.g. Fonepay QR, Nabil Bank, eSewa Merchant"
              value={createDraft.providerLabel}
              onChange={(e) => setCreateDraft({ ...createDraft, providerLabel: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700">Account Holder Name *</label>
            <input
              type="text"
              required
              disabled={Boolean(pendingCreateDraft) && !createConflict}
              placeholder="e.g. KhataSathi Store Pvt. Ltd."
              value={createDraft.accountHolder}
              onChange={(e) => setCreateDraft({ ...createDraft, accountHolder: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Confirmation Mode *</label>
            <ProjectSelect
              value={createDraft.confirmationMode}
              disabled={Boolean(pendingCreateDraft) && !createConflict}
              onChange={(e) => {
                const mode = e.target.value as "MANUAL_RECEIPT" | "DISPLAY_ONLY";
                setCreateDraft({
                  ...createDraft,
                  confirmationMode: mode,
                  settlementMethod: mode === "MANUAL_RECEIPT" ? "FONEPAY" : null,
                });
              }}
            >
              <option value="MANUAL_RECEIPT">Manual Receipt Confirmation (Cashier verifies receipt & reference)</option>
              <option value="DISPLAY_ONLY">Display Only (QR scannable in gallery; manual checkout settlement not supported)</option>
            </ProjectSelect>
          </div>

          {createDraft.confirmationMode === "MANUAL_RECEIPT" ? (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Settlement Method *</label>
              <ProjectSelect
                value={createDraft.settlementMethod || "FONEPAY"}
                disabled={Boolean(pendingCreateDraft) && !createConflict}
                onChange={(e) =>
                  setCreateDraft({
                    ...createDraft,
                    settlementMethod: e.target.value as "FONEPAY" | "BANK_TRANSFER",
                  })
                }
              >
                <option value="FONEPAY">Fonepay</option>
                <option value="BANK_TRANSFER">Bank Transfer</option>
              </ProjectSelect>
            </div>
          ) : null}

          <div>
            <label className="block text-xs font-bold text-slate-700">
              Account Number / Merchant ID {createDraft.settlementMethod === "BANK_TRANSFER" ? "*" : "(Optional)"}
            </label>
            <input
              type="text"
              required={createDraft.settlementMethod === "BANK_TRANSFER"}
              disabled={Boolean(pendingCreateDraft) && !createConflict}
              placeholder={createDraft.settlementMethod === "BANK_TRANSFER" ? "e.g. 01234567890123" : "e.g. Merchant ID or Phone"}
              value={createDraft.accountIdentifier || ""}
              onChange={(e) => setCreateDraft({ ...createDraft, accountIdentifier: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              disabled={createBusy}
              onClick={() => setShowCreateModal(false)}
              className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createBusy}
              className="min-h-10 rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {createBusy ? "Saving…" : pendingCreateDraft ? "Retry Exact Creation" : "Save Account"}
            </button>
          </div>
        </form>
      </ModalFrame>

      {/* Edit Account Modal */}
      {editingAccount ? (
        <ModalFrame
          open={Boolean(editingAccount)}
          title={`Edit ${editingAccount.providerLabel}`}
          description={`Update metadata for version ${editingAccount.version}.`}
          onClose={() => {
            if (!editBusy) setEditingAccount(null);
          }}
          maxWidthClass="max-w-[520px]"
        >
          <form onSubmit={handleEditSubmit} className="space-y-4 pt-2">
            {editError ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                {editError}
              </div>
            ) : null}

            <div>
              <label className="block text-xs font-bold text-slate-700">Provider / Bank / Wallet Name *</label>
              <input
                type="text"
                required
                disabled={editBusy}
                value={editDraft.providerLabel || ""}
                onChange={(e) => setEditDraft({ ...editDraft, providerLabel: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700">Account Holder Name *</label>
              <input
                type="text"
                required
                disabled={editBusy}
                value={editDraft.accountHolder || ""}
                onChange={(e) => setEditDraft({ ...editDraft, accountHolder: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
              />
            </div>

            {(editingAccount.linkedPaymentsCount || 0) > 0 ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                <strong className="font-semibold">Identity locked:</strong> This account has completed historical payments. Settlement method, confirmation mode, and account identifier cannot be changed. Disable this account and create a new one to change banking details.
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Confirmation Mode *</label>
                  <ProjectSelect
                    value={editDraft.confirmationMode}
                    disabled={editBusy}
                    onChange={(e) => {
                      const mode = e.target.value as "MANUAL_RECEIPT" | "DISPLAY_ONLY";
                      setEditDraft({
                        ...editDraft,
                        confirmationMode: mode,
                        settlementMethod: mode === "MANUAL_RECEIPT" ? "FONEPAY" : null,
                      });
                    }}
                  >
                    <option value="MANUAL_RECEIPT">Manual Receipt Confirmation</option>
                    <option value="DISPLAY_ONLY">Display Only</option>
                  </ProjectSelect>
                </div>

                {editDraft.confirmationMode === "MANUAL_RECEIPT" ? (
                  <div>
                    <label className="block text-xs font-bold text-slate-700 mb-1">Settlement Method *</label>
                    <ProjectSelect
                      value={editDraft.settlementMethod || "FONEPAY"}
                      disabled={editBusy}
                      onChange={(e) =>
                        setEditDraft({
                          ...editDraft,
                          settlementMethod: e.target.value as "FONEPAY" | "BANK_TRANSFER",
                        })
                      }
                    >
                      <option value="FONEPAY">Fonepay</option>
                      <option value="BANK_TRANSFER">Bank Transfer</option>
                    </ProjectSelect>
                  </div>
                ) : null}

                <div>
                  <label className="block text-xs font-bold text-slate-700">
                    Account Number / Identifier {editDraft.settlementMethod === "BANK_TRANSFER" ? "*" : "(Optional)"}
                  </label>
                  <input
                    type="text"
                    required={editDraft.settlementMethod === "BANK_TRANSFER"}
                    disabled={editBusy}
                    value={editDraft.accountIdentifier || ""}
                    onChange={(e) => setEditDraft({ ...editDraft, accountIdentifier: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-50"
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                disabled={editBusy}
                onClick={() => setEditingAccount(null)}
                className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={editBusy}
                className="min-h-10 rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {editBusy ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </form>
        </ModalFrame>
      ) : null}

      {/* Upload QR Modal */}
      {uploadTarget ? (() => {
        const currentPendingUpload = pendingUploads[uploadTarget.id] || null;
        return (
          <ModalFrame
            open={Boolean(uploadTarget)}
            title={`Upload QR Image: ${uploadTarget.providerLabel}`}
            description={`Upload a JPEG, PNG, or WebP image under 5 MiB for version ${uploadTarget.version}.`}
            onClose={() => {
              if (!uploadBusy) {
                if (!currentPendingUpload) {
                  setSelectedFile(null);
                  if (filePreviewUrl) {
                    try {
                      URL.revokeObjectURL(filePreviewUrl);
                    } catch {}
                  }
                  setFilePreviewUrl(null);
                  setUploadError(null);
                }
                setUploadTarget(null);
              }
            }}
            maxWidthClass="max-w-[480px]"
          >
            <form onSubmit={handleUploadSubmit} className="space-y-4 pt-2">
              {uploadError ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  {uploadError}
                </div>
              ) : null}

              {currentPendingUpload ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <strong className="font-bold">Pending upload attempt frozen:</strong>
                  <p className="mt-0.5 text-[11px] opacity-90">
                    Bound to upload ID <code className="font-mono text-[10px]">{currentPendingUpload.uploadId.slice(0, 8)}…</code> and expected version v{currentPendingUpload.expectedVersion}.
                  </p>
                </div>
              ) : null}

              <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center">
                {filePreviewUrl ? (
                  <div className="space-y-3">
                    <img
                      src={filePreviewUrl}
                      alt="Selected QR preview"
                      className="max-h-48 max-w-full rounded-lg object-contain shadow-sm border border-slate-200 bg-white p-2 mx-auto"
                    />
                    <p className="text-xs font-semibold text-slate-700">{selectedFile?.name}</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Icon name="qr_code_scanner" sizePx={36} className="mx-auto text-slate-400" />
                    <p className="text-xs font-semibold text-slate-700">Choose a clear static QR code image</p>
                    <p className="text-[11px] text-slate-400">JPEG, PNG, or WebP (max 5 MiB)</p>
                  </div>
                )}

                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploadBusy || Boolean(currentPendingUpload)}
                  onChange={handleFileSelect}
                  className="mt-3 text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-slate-800 disabled:opacity-50"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  disabled={uploadBusy}
                  onClick={() => {
                    if (!currentPendingUpload) {
                      setSelectedFile(null);
                      if (filePreviewUrl) {
                        try {
                          URL.revokeObjectURL(filePreviewUrl);
                        } catch {}
                      }
                      setFilePreviewUrl(null);
                      setUploadError(null);
                    }
                    setUploadTarget(null);
                  }}
                  className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={(!selectedFile && !currentPendingUpload) || uploadBusy}
                  className="min-h-10 rounded-lg bg-slate-950 px-4 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {uploadBusy ? "Uploading & Publishing…" : currentPendingUpload ? "Retry Exact Upload" : "Publish QR"}
                </button>
              </div>
            </form>
          </ModalFrame>
        );
      })() : null}

      {/* Audit Modal */}
      {auditTarget ? (
        <ModalFrame
          open={Boolean(auditTarget)}
          title={`Audit History: ${auditTarget.providerLabel}`}
          description="Recent settings mutations and QR asset publication events."
          onClose={() => {
            auditAbortRef.current?.abort();
            setAuditTarget(null);
            setAuditLogs([]);
          }}
          maxWidthClass="max-w-[640px]"
        >
          <div className="max-h-[60dvh] overflow-y-auto space-y-3 pt-2">
            {auditLoading ? (
              <div className="p-8 text-center text-xs text-slate-400">Loading audit history…</div>
            ) : auditLogs.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">No audit events recorded for this account.</div>
            ) : (
              <div className="divide-y divide-slate-100 text-xs">
                {auditLogs.map((log) => (
                  <div key={log.id} className="py-2.5 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-800">{log.action.replace("PAYMENT_ACCOUNT_", "")}</span>
                      <span className="text-[11px] text-slate-400">
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-slate-600">
                      By: <strong className="text-slate-800">{log.actor?.name || log.actorId}</strong> ({log.actor?.role || "USER"})
                    </div>
                    {log.meta ? (
                      <pre className="rounded bg-slate-50 p-2 text-[10px] font-mono text-slate-700 overflow-x-auto">
                        {JSON.stringify(log.meta, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </ModalFrame>
      ) : null}
    </div>
  );
}
