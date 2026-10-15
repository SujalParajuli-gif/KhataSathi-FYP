import React, { useEffect, useRef, useState } from "react";
import { ModalFrame } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import { evaluateCalculatorExpression, type CalculatorEvaluationResult } from "~/lib/calculator";

interface BillingCalculatorModalProps {
  open: boolean;
  onClose: () => void;
}

export default function BillingCalculatorModal({
  open,
  onClose,
}: BillingCalculatorModalProps) {
  const [expression, setExpression] = useState("");
  const [evaluation, setEvaluation] = useState<CalculatorEvaluationResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setCopied(false);
      setCopyError(null);
    }
  }, [open]);

  function handleEvaluate() {
    if (!expression.trim()) {
      setEvaluation(null);
      return;
    }
    const result = evaluateCalculatorExpression(expression);
    setEvaluation(result);
  }

  function handleKeyPress(char: string) {
    setExpression((prev) => {
      if (prev.length >= 128) return prev;
      return prev + char;
    });
    setCopied(false);
    setCopyError(null);
  }

  function handleClear() {
    setExpression("");
    setEvaluation(null);
    setCopied(false);
    setCopyError(null);
  }

  function handleBackspace() {
    setExpression((prev) => prev.slice(0, -1));
    setCopied(false);
    setCopyError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === "=") {
      e.preventDefault();
      handleEvaluate();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  async function handleCopyResult() {
    if (!evaluation || !evaluation.success) return;
    setCopyError(null);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(evaluation.formatted.replaceAll(",", ""));
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        throw new Error("Clipboard API unavailable.");
      }
    } catch (err: any) {
      setCopied(false);
      setCopyError(err?.message || "Failed to copy to clipboard.");
      setTimeout(() => setCopyError(null), 3000);
    }
  }

  return (
    <ModalFrame presentation="billing"
      open={open}
      title="Scratchpad Calculator"
      description="Quick arithmetic calculations for manual billing reference."
      onClose={onClose}
      dialogClassName="billing-calculator-dialog"
      maxWidthClass="max-w-[360px]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-[38px] rounded-xl border border-[#CFCFD3] bg-white px-4 text-[13px] font-bold text-[#565449] hover:bg-slate-100"
          >
            Close
          </button>
          {evaluation?.success ? (
            <button
              type="button"
              onClick={handleCopyResult}
              className="flex h-[38px] items-center gap-1.5 rounded-xl bg-[#11120d] px-4 text-[13px] font-bold text-white hover:bg-black"
            >
              <Icon name={copied ? "check" : "content_copy"} className="text-[16px]" />
              <span>{copied ? "Copied!" : "Copy Result"}</span>
            </button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3">
        {/* Calculator Display - Light Theme */}
        <div className="rounded-xl border border-[#CFCFD3] bg-[#F9FAFB] p-3 text-right font-mono text-[#11120D]">
          <input
            ref={inputRef}
            type="text"
            value={expression}
            onChange={(e) => {
              setExpression(e.target.value.slice(0, 128));
              setCopied(false);
              setCopyError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="0"
            className="w-full bg-transparent text-right font-mono text-[20px] font-bold text-[#11120D] placeholder:text-[#8C8889] focus:outline-none"
            aria-label="Calculator input"
          />
          <div className="mt-1 text-[22px] font-extrabold" aria-live="polite">
            {evaluation ? (
              evaluation.success ? (
                <span className="text-emerald-700">= {evaluation.formatted}</span>
              ) : (
                <span className="text-[12px] font-sans font-semibold text-rose-600">
                  {evaluation.error}
                </span>
              )
            ) : (
              null
            )}
          </div>
        </div>

        {copyError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-center text-[11px] font-semibold text-rose-700">
            {copyError}
          </div>
        ) : null}

        {/* Buttons Keypad */}
        <div className="grid grid-cols-4 gap-2 text-[16px] font-bold">
          <button
            type="button"
            onClick={handleClear}
            className="h-[44px] rounded-xl bg-rose-50 text-rose-700 hover:bg-rose-100 active:scale-95 transition"
          >
            C
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("(")}
            className="h-[44px] rounded-xl bg-slate-100 text-slate-800 hover:bg-slate-200 active:scale-95 transition"
          >
            (
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(")")}
            className="h-[44px] rounded-xl bg-slate-100 text-slate-800 hover:bg-slate-200 active:scale-95 transition"
          >
            )
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(" / ")}
            className="h-[44px] rounded-xl bg-amber-100 text-amber-900 hover:bg-amber-200 active:scale-95 transition font-mono"
          >
            ÷
          </button>

          <button
            type="button"
            onClick={() => handleKeyPress("7")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            7
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("8")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            8
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("9")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            9
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(" * ")}
            className="h-[44px] rounded-xl bg-amber-100 text-amber-900 hover:bg-amber-200 active:scale-95 transition font-mono"
          >
            ×
          </button>

          <button
            type="button"
            onClick={() => handleKeyPress("4")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            4
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("5")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            5
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("6")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            6
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(" - ")}
            className="h-[44px] rounded-xl bg-amber-100 text-amber-900 hover:bg-amber-200 active:scale-95 transition font-mono"
          >
            −
          </button>

          <button
            type="button"
            onClick={() => handleKeyPress("1")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            1
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("2")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            2
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress("3")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            3
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(" + ")}
            className="h-[44px] rounded-xl bg-amber-100 text-amber-900 hover:bg-amber-200 active:scale-95 transition font-mono"
          >
            +
          </button>

          <button
            type="button"
            onClick={() => handleKeyPress("0")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            0
          </button>
          <button
            type="button"
            onClick={() => handleKeyPress(".")}
            className="h-[44px] rounded-xl bg-slate-50 text-slate-900 border border-slate-200 hover:bg-slate-100 active:scale-95 transition"
          >
            .
          </button>
          <button
            type="button"
            onClick={handleBackspace}
            aria-label="Backspace"
            className="h-[44px] rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200 active:scale-95 transition flex items-center justify-center"
          >
            <Icon name="backspace" className="text-[18px]" />
          </button>
          <button
            type="button"
            onClick={handleEvaluate}
            className="h-[44px] rounded-xl bg-[#11120d] text-white hover:bg-black active:scale-95 transition font-mono"
          >
            =
          </button>
        </div>

        <p className="text-[10px] text-center text-[#8C8889] pt-1">
          Scratchpad calculator does not alter billing cart prices or invoice totals.
        </p>
      </div>
    </ModalFrame>
  );
}
