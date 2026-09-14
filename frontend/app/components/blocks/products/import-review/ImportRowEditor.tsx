import Icon from "~/components/ui/Icon";
import CreatableCombobox from "~/components/ui/CreatableCombobox";
import Switch from "~/components/ui/Switch";
import type { ProductImportReviewPage, ProductImportRow } from "~/lib/api/endpoints";
import {
  comparisonLabel,
  draftPayload,
  importRowToDraft,
  readableSourceHeader,
  validateImportDraft,
  type ImportReviewDraft,
} from "~/features/product-imports/reviewModel";
import { Field, inputClass, numberInput, statusTone, type MobilePanel } from "./shared";

export function ImportRowEditor({
  draft,
  activeRow,
  review,
  mobilePanel,
  setMobilePanel,
  moveActiveRow,
  dirty,
  saving,
  updateDraft,
  brandOptions,
  categoryOptions,
  supplierOptions,
  unitOptions,
  fileBrandSuggestion,
  focusReviewField,
  saveDraft,
  saveAndAdvance,
  restoreResolution,
}: {
  draft: ImportReviewDraft | null;
  activeRow: ProductImportRow | null;
  review: ProductImportReviewPage | null;
  mobilePanel: MobilePanel;
  setMobilePanel: (panel: MobilePanel) => void;
  moveActiveRow: (direction: -1 | 1) => void;
  dirty: boolean;
  saving: boolean;
  updateDraft: <K extends keyof ImportReviewDraft>(key: K, value: ImportReviewDraft[K]) => void;
  brandOptions: string[];
  categoryOptions: string[];
  supplierOptions: string[];
  unitOptions: string[];
  fileBrandSuggestion: string;
  focusReviewField: (field: string | null) => void;
  saveDraft: (overrideDraft?: Partial<ImportReviewDraft>) => Promise<boolean>;
  saveAndAdvance: (overrideDraft?: Partial<ImportReviewDraft>) => Promise<boolean>;
  restoreResolution: (row: ProductImportRow) => "CREATE_NEW" | "KEEP_EXISTING" | "UPDATE_MATCHED" | null;
}) {
  if (!draft || !activeRow) return <div className="flex h-full items-center justify-center rounded-[18px] border border-[#D8DBE0] bg-white p-6 text-[13px] font-bold text-[#7A7F89]">Select a row to review.</div>;
  const activeIndex = review?.rows.findIndex((row) => row.id === activeRow.id) ?? -1;
  const filteredPosition = review && activeIndex >= 0
    ? (review.pagination.page - 1) * review.pagination.pageSize + activeIndex + 1
    : 0;
  const canMovePrevious = Boolean(review && filteredPosition > 1);
  const canMoveNext = Boolean(review && filteredPosition < review.pagination.total);
  const baseline = draftPayload(importRowToDraft(review!.batch, activeRow));
  const comparisonStale = Object.entries(draftPayload(draft)).some(([key, value]) =>
    !["resolution", "acknowledgeWarnings"].includes(key) && JSON.stringify(value) !== JSON.stringify(baseline[key as keyof typeof baseline]));
  const issues = [
    ...validateImportDraft(draft, Boolean(review?.priceMapping?.required && !review.priceMapping.complete)),
    ...(!comparisonStale && draft.resolution !== "IGNORE" ? activeRow.reviewIssues || [] : []),
  ];
  const committed = ["IMPORTED", "UPDATED", "KEPT_EXISTING"].includes(activeRow.status);
  return (
    <section className={`${mobilePanel === "editor" ? "flex" : "hidden"} h-full min-h-0 flex-col overflow-hidden rounded-[16px] border border-[#D8DBE0] bg-white xl:flex xl:rounded-[18px]`}>
      <div className="shrink-0 border-b border-[#E2E4E8] bg-white px-3 sm:px-3.5 py-2.5 sm:py-3">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobilePanel("list")}
              className="inline-flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white text-[#11120d] transition active:bg-[#F3F4F6] touch-manipulation xl:hidden"
              aria-label="Back to product list"
              title="Back to list"
            >
              <Icon name="arrow_back" sizePx={16} />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap sm:flex-nowrap">
                <h2 className="text-[13.5px] sm:text-[14px] font-extrabold text-[#11120d] whitespace-nowrap">Review item</h2>
                <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[8.5px] sm:text-[9px] font-extrabold ${statusTone(draft.comparisonStatus)}`}>
                  {comparisonStale ? "Comparison pending" : comparisonLabel(draft.comparisonStatus)}
                </span>
                {dirty ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[8.5px] font-bold text-amber-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Unsaved
                  </span>
                ) : activeRow.reviewChanges?.length ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[8.5px] font-bold text-slate-700"
                    title={`Product corrections after import setup: ${activeRow.reviewChanges.join(", ")}`}
                  >
                    <Icon name="edit" sizePx={10} />
                    User changed
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[8.5px] font-bold text-emerald-800">
                    <Icon name="check" sizePx={10} className="text-emerald-600" />
                    {committed ? "Applied" : "Draft saved"}
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[10.5px] sm:text-[11px] font-semibold text-[#7A7F89]">
                {filteredPosition.toLocaleString()} of {review?.pagination.total.toLocaleString() || 0} · source row {draft.sourceLocator?.rowNumber || draft.rowNumber}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => moveActiveRow(-1)}
              disabled={!canMovePrevious}
              className="inline-flex h-8.5 items-center justify-center gap-1 rounded-[8px] border border-[#D4D7DC] bg-white px-2 sm:px-2.5 text-[11px] font-extrabold text-[#374151] transition hover:bg-[#F3F4F6] disabled:opacity-35"
              aria-label="Previous product row"
              title="Previous product row"
            >
              <Icon name="chevron_left" sizePx={16} />
              <span className="hidden sm:inline">Prev</span>
            </button>
            <button
              type="button"
              onClick={() => moveActiveRow(1)}
              disabled={!canMoveNext}
              className="inline-flex h-8.5 items-center justify-center gap-1 rounded-[8px] border border-[#D4D7DC] bg-white px-2 sm:px-2.5 text-[11px] font-extrabold text-[#374151] transition hover:bg-[#F3F4F6] disabled:opacity-35"
              aria-label="Next product row"
              title="Next product row"
            >
              <span className="hidden sm:inline">Next</span>
              <Icon name="chevron_right" sizePx={16} />
            </button>
          </div>
        </div>
      </div>

      <div role="status" className="max-h-36 shrink-0 overflow-y-auto border-b border-[#E2E4E8] bg-[#F8FAFC] px-3 py-2 text-[11px] leading-5">
        <p className="font-bold text-[#374151]">
          {committed ? "This row has already been applied. It is read-only."
            : draft.resolution === "IGNORE" ? "This row will be skipped. No catalog data will change."
            : comparisonStale ? "Unsaved changes — save this row to refresh its catalog comparison."
            : draft.comparisonStatus === "EXACT_DUPLICATE" ? activeRow.pendingWarnings?.length
              ? "Already in your catalog. Check the extraction warnings below before finishing."
              : "Already in your catalog. Existing values will be kept; no duplicate will be created."
            : draft.comparisonStatus === "MATCHED_WITH_CHANGES" ? "An existing product matches. Review the differences below before choosing what to keep."
            : draft.comparisonStatus === "IDENTIFIER_CONFLICT" ? "Conflicting product details. Correct the highlighted fields before importing."
            : issues.length ? "Check the highlighted fields against the source."
            : "Draft only — the catalog will change after Final import."}
        </p>
        {issues.length && !committed ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {[...new Map(issues.map(issue => [issue.field || issue.message, issue])).values()].map(issue =>
            <button key={issue.field || issue.message} type="button" onClick={() => focusReviewField(issue.field)}
              className="text-left font-semibold text-amber-900 underline decoration-amber-300 underline-offset-2">
              {issue.field ? `Check ${readableSourceHeader(issue.field)}` : issue.message}
            </button>)}
        </div> : null}
      </div>
      <fieldset disabled={committed} className="min-h-0 min-w-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain bg-[#FAFAFB] p-3">
        {!comparisonStale && draft.error ? (
          <div role="alert" className={`rounded-[10px] border px-3 py-2.5 text-[10.5px] font-semibold leading-5 ${draft.comparisonStatus === "IDENTIFIER_CONFLICT" ? "border-rose-200 bg-rose-50 text-rose-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
            <div className="flex items-start gap-2">
              <Icon name={draft.comparisonStatus === "IDENTIFIER_CONFLICT" ? "error" : "warning"} sizePx={16} className="mt-0.5 shrink-0" />
              <div><strong className="block font-extrabold">{draft.comparisonStatus === "IDENTIFIER_CONFLICT" ? "Resolve this conflict" : "Review required"}</strong>{draft.error}</div>
            </div>
          </div>
        ) : null}
        {!!activeRow.pendingWarnings?.length && draft.resolution !== "IGNORE" ? (
          <label className="flex items-start gap-2 rounded-[10px] border border-amber-200 bg-amber-50 p-3 text-[11px] font-semibold text-amber-950">
            <input type="checkbox" checked={draft.acknowledgeWarnings === true} onChange={event => updateDraft("acknowledgeWarnings", event.target.checked)} className="mt-1 shrink-0" />
            <span>I checked the extraction warnings against the source. Save this row to confirm.
              <span className="mt-1 block text-[10px] font-normal">{activeRow.pendingWarnings.join(" ")}</span>
            </span>
          </label>
        ) : null}
        {!comparisonStale && draft.changeSet && draft.changeSet.length > 0 ? (
          <div className="rounded-[12px] border border-amber-200 bg-amber-50 p-3">
            <div className="text-[12px] font-extrabold text-amber-950">Catalog comparison: existing → incoming</div>
            <div className="mt-2 grid gap-2">
              {draft.changeSet.map((change) => (
                <div key={change.field} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-[9px] bg-white/80 px-3 py-2 text-[10px] font-bold">
                  <span><span className="block text-xs text-slate-600">{readableSourceHeader(change.field)}</span>{String(change.currentValue ?? "Not entered")}</span>
                  <Icon name="arrow_forward" sizePx={15} />
                  <span className="text-amber-900">{String(change.incomingValue ?? "Not entered")}
                    {typeof change.currentValue === "number" && change.currentValue > 0 && typeof change.incomingValue === "number" && /price|rate/i.test(change.field) ? <span className="ml-2 font-semibold">({((change.incomingValue / change.currentValue - 1) * 100).toFixed(1)}%)</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!comparisonStale && draft.comparisonStatus === "MATCHED_WITH_CHANGES" ? (
          <div className="rounded-[12px] border border-amber-300/80 bg-amber-50/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <Icon name="published_with_changes" sizePx={16} className="text-amber-900" />
                <span className="text-[11.5px] font-extrabold text-amber-950">Resolution Decision</span>
              </div>
              <span className="rounded-full bg-amber-100/90 border border-amber-200 px-2 py-0.5 text-[9px] font-bold text-amber-900">
                {draft.resolution === "KEEP_EXISTING" ? "Keeping store data" : draft.resolution === "IGNORE" ? "Row ignored" : draft.resolution === "UPDATE_MATCHED" ? "Update selected" : "Choose a decision"}
              </span>
            </div>
            <p className="mt-1 text-[10.5px] font-medium text-amber-900/80">
              Differences found between source file and existing catalog item. Select your resolution:
            </p>

            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateDraft("resolution", "KEEP_EXISTING")}
                className={`group relative flex flex-col items-start gap-1 rounded-[9px] border p-2.5 text-left transition ${draft.resolution === "KEEP_EXISTING"
                    ? "border-slate-800 bg-white ring-2 ring-slate-800/10 shadow-sm"
                    : "border-slate-200 bg-white/80 hover:bg-white hover:border-slate-300"
                  }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-extrabold text-[#11120d]">
                    <Icon name={draft.resolution === "KEEP_EXISTING" ? "radio_button_checked" : "radio_button_unchecked"} sizePx={15} className={draft.resolution === "KEEP_EXISTING" ? "text-slate-900" : "text-slate-400"} />
                    Keep existing
                  </span>
                  {draft.resolution === "KEEP_EXISTING" ? (
                    <span className="rounded bg-slate-100 px-1.5 py-0.2 text-[8.5px] font-extrabold text-slate-700">Selected</span>
                  ) : null}
                </div>
                <span className="text-[9.5px] font-semibold text-slate-500 leading-normal pl-5">
                  Preserve current database values; ignore incoming changes.
                </span>
              </button>

              <button
                type="button"
                onClick={() => updateDraft("resolution", "UPDATE_MATCHED")}
                className={`group relative flex flex-col items-start gap-1 rounded-[9px] border p-2.5 text-left transition ${draft.resolution === "UPDATE_MATCHED"
                    ? "border-[#11120d] bg-[#11120d] text-white shadow-sm ring-2 ring-slate-900/10"
                    : "border-amber-300/80 bg-white hover:border-amber-400"
                  }`}
              >
                <div className="flex w-full items-center justify-between">
                  <span className={`flex items-center gap-1.5 text-[11px] font-extrabold ${draft.resolution === "UPDATE_MATCHED" ? "text-white" : "text-[#11120d]"}`}>
                    <Icon name={draft.resolution === "UPDATE_MATCHED" ? "check_circle" : "radio_button_unchecked"} sizePx={15} className={draft.resolution === "UPDATE_MATCHED" ? "text-emerald-400" : "text-slate-400"} />
                    Apply displayed changes
                  </span>
                  {draft.resolution === "UPDATE_MATCHED" ? (
                    <span className="rounded bg-white/20 px-1.5 py-0.2 text-[8.5px] font-extrabold text-white">Selected</span>
                  ) : null}
                </div>
                <span className={`text-[9.5px] font-semibold leading-normal pl-5 ${draft.resolution === "UPDATE_MATCHED" ? "text-slate-200" : "text-slate-600"}`}>
                  Update catalog product with the new source file values above.
                </span>
              </button>
            </div>
          </div>
        ) : null}
        <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
          <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
            <Icon name="sell" sizePx={16} className="text-[#11120d]" />
            Basic information
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Field label="Product name" field="name" issue={issues.find(issue => issue.field === "name")}>
                <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} className={inputClass} />
              </Field>
            </div>
            <div className="sm:col-span-3">
              <Field label="SKU" field="sku" issue={issues.find(issue => issue.field === "sku")}>
                <input value={draft.sku} onChange={(event) => updateDraft("sku", event.target.value)} className={inputClass} placeholder="Generated when saved if blank" />
              </Field>
            </div>
            <div>
              <Field label="Brand" field="brand" issue={issues.find(issue => issue.field === "brand")}>
                <CreatableCombobox value={draft.brand} onChange={(value) => updateDraft("brand", value)} options={brandOptions} placeholder="Search or enter brand" ariaLabel="Product brand" selectOnFocus compact showCreateHelp={false} />
              </Field>
              {!draft.brand && fileBrandSuggestion ? (
                <div className="mt-1.5 rounded-[8px] border border-amber-200 bg-amber-50 px-2 py-1.5 text-[9px] font-semibold leading-4 text-amber-950">
                  File name suggests <strong>{fileBrandSuggestion}</strong>. Verify it before using it as the brand.
                  <button type="button" className="ml-1 font-extrabold underline underline-offset-2" onClick={() => updateDraft("brand", fileBrandSuggestion)}>Use suggestion</button>
                </div>
              ) : null}
            </div>
            <div>
              <Field label="Category" field="category" issue={issues.find(issue => issue.field === "category")}>
                <CreatableCombobox value={draft.category} onChange={(value) => { updateDraft("category", value); updateDraft("categoryGroup", value); }} options={categoryOptions} placeholder="Search or enter category" ariaLabel="Product category" selectOnFocus compact showCreateHelp={false} />
              </Field>
            </div>
            <div>
              <Field label="Vendor source" field="vendorSource" issue={issues.find(issue => issue.field === "vendorSource")}>
                <CreatableCombobox value={draft.vendorSource || ""} onChange={(value) => updateDraft("vendorSource", value)} options={supplierOptions} placeholder="Search or enter supplier" ariaLabel="Vendor source" selectOnFocus compact showCreateHelp={false} />
              </Field>
            </div>
          </div>
          <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Barcode" field="barcode" issue={issues.find(issue => issue.field === "barcode")}>
              <input value={draft.barcode || ""} onChange={event => updateDraft("barcode", event.target.value)} className={inputClass} placeholder="Optional" />
            </Field>
            <Field label="Product code" field="productCodeVariant" issue={issues.find(issue => issue.field === "productCodeVariant")}>
              <input value={draft.productCodeVariant || ""} onChange={event => updateDraft("productCodeVariant", event.target.value)} className={inputClass} placeholder="Optional" />
            </Field>
          </div>
        </div>

        <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
          <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
            <Icon name="inventory_2" sizePx={16} className="text-[#11120d]" />
            Packaging and units
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Size" field="sizeValue" issue={issues.find(issue => issue.field === "sizeValue")}>
              <input type="number" value={draft.sizeValue ?? ""} onChange={(event) => updateDraft("sizeValue", numberInput(event.target.value))} className={inputClass} placeholder="e.g. 5" />
            </Field>
            <Field label="Size unit" field="sizeUnit" issue={issues.find(issue => issue.field === "sizeUnit")}>
              <CreatableCombobox value={draft.sizeUnit || ""} onChange={(value) => updateDraft("sizeUnit", value.toUpperCase())} options={unitOptions} placeholder="Unit (Ltr, Kg...)" ariaLabel="Size unit" selectOnFocus compact showCreateHelp={false} />
            </Field>
            <Field label="Package quantity" field="packageQuantity" issue={issues.find(issue => issue.field === "packageQuantity")}>
              <input type="number" value={draft.packageQuantity ?? ""} onChange={(event) => updateDraft("packageQuantity", numberInput(event.target.value))} className={inputClass} placeholder="Pieces in pack" />
            </Field>
            <Field label="Sale unit" field="saleUnit" issue={issues.find(issue => issue.field === "saleUnit")}>
              <CreatableCombobox value={draft.saleUnit || ""} onChange={(value) => updateDraft("saleUnit", value.toUpperCase())} options={unitOptions} placeholder="Sale unit" ariaLabel="Sale unit" selectOnFocus compact showCreateHelp={false} />
            </Field>
          </div>
        </div>

        <div className="rounded-[12px] border border-[#D8DBE0] bg-white p-3">
          <div className="mb-2.5 flex items-center gap-2 text-[12px] font-extrabold text-[#11120d]">
            <Icon name="payments" sizePx={16} className="text-[#11120d]" />
            Pricing
          </div>
          <label className="mb-2.5 flex items-center justify-between gap-3 rounded-[9px] border border-[#D4D7DC] bg-[#F8FAFC] px-2.5 py-2">
            <span className="min-w-0">
              <span className="block text-[11px] font-extrabold text-[#11120d]">Coming soon</span>
              <span className="block text-[9px] font-semibold leading-4 text-[#6B7280]">Keep this product in the catalog with its price pending.</span>
            </span>
            <Switch
              checked={draft.availabilityStatus === "COMING_SOON"}
              onChange={(checked) => updateDraft("availabilityStatus", checked ? "COMING_SOON" : "CATALOG_LISTED")}
              ariaLabel="Coming soon"
            />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Rate" field="ratePerPiece" issue={issues.find(issue => issue.field === "ratePerPiece")}>
              <input type="number" value={draft.ratePerPiece ?? ""} onChange={(event) => updateDraft("ratePerPiece", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder={draft.availabilityStatus === "COMING_SOON" ? "Later" : "Rate"} />
            </Field>
            <Field label="Retail (opt)" field="retailPrice" issue={issues.find(issue => issue.field === "retailPrice")}>
              <input type="number" value={draft.retailPrice ?? ""} onChange={(event) => updateDraft("retailPrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
            </Field>
            <Field label="Wholesale (opt)" field="wholesalePrice" issue={issues.find(issue => issue.field === "wholesalePrice")}>
              <input type="number" value={draft.wholesalePrice ?? ""} onChange={(event) => updateDraft("wholesalePrice", numberInput(event.target.value))} disabled={Boolean(review?.priceMapping?.required && !review.priceMapping.complete)} className={`${inputClass} disabled:bg-[#F3F4F6] disabled:text-[#8C8889]`} placeholder="Pending" />
            </Field>
          </div>
          {draft.availabilityStatus === "COMING_SOON" && !(review?.priceMapping?.required && !review.priceMapping.complete) ? (
            <div className="mt-2.5 rounded-[9px] border border-sky-200 bg-sky-50 px-2.5 py-2 text-[10px] font-bold text-sky-900">
              This product will remain searchable and display Coming soon until its price and availability are confirmed.
            </div>
          ) : null}
        </div>

      </fieldset>

      {/* Docked Triage Action Bar */}
      <div className="shrink-0 border-t border-[#E2E4E8] bg-white px-3 py-2.5 sm:py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.03)]">
        <div className="flex items-center justify-between gap-2">
          {/* Left: Ignore / Restore Row */}
          <button
            type="button"
            onClick={() => updateDraft("resolution", draft.resolution === "IGNORE" ? restoreResolution(activeRow) : "IGNORE")}
            disabled={committed || saving}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-[9px] border px-3 text-[11px] font-extrabold transition shrink-0 ${draft.resolution === "IGNORE"
                ? "border-slate-300 bg-slate-100 text-slate-800 hover:bg-slate-200"
                : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
              }`}
            title={draft.resolution === "IGNORE" ? "Restore row to import" : "Skip this row completely from import"}
          >
            <Icon name={draft.resolution === "IGNORE" ? "undo" : "close"} sizePx={15} />
            <span>{draft.resolution === "IGNORE" ? "Restore" : "Ignore"}</span>
            <span className="hidden sm:inline"> row</span>
          </button>

          {/* Right: Actions Cluster */}
          <div className="flex items-center gap-1.5 sm:gap-2 justify-end shrink-0">
            {/* Save Only (without advancing, visible when dirty) */}
            {dirty && !committed ? (
              <button
                type="button"
                onClick={() => void saveDraft()}
                disabled={saving}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[9px] border border-amber-300 bg-amber-50/80 px-3 text-[11px] font-extrabold text-amber-950 transition hover:bg-amber-100 disabled:opacity-45 shrink-0 shadow-sm"
                title="Save current row without advancing"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                <Icon name="save" sizePx={15} className="text-amber-800" />
                <span>{saving ? "Saving…" : "Save"}</span>
              </button>
            ) : null}

            {dirty && !committed ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveAndAdvance()}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[9px] bg-[#11120d] px-4 sm:px-5 text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-45 shadow-sm shrink-0"
              >
                <Icon name="save" sizePx={15} />
                <span>{saving ? "Saving…" : canMoveNext ? "Save & Next" : "Save row"}</span>
                {canMoveNext ? <Icon name="arrow_forward" sizePx={14} /> : null}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => moveActiveRow(1)}
                disabled={!canMoveNext}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-[9px] bg-[#11120d] px-4 sm:px-5 text-[11px] font-extrabold text-white transition hover:bg-[#2a2c27] disabled:opacity-35 shadow-sm shrink-0"
              >
                <span>Next item</span>
                <Icon name="arrow_forward" sizePx={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
