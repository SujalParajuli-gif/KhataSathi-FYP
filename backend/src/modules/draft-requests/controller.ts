import { Request, Response } from "express";
import { formatZodIssues } from "../../lib/requestValidation";
import * as draftRequestService from "./service";
import {
  acceptDraftRequestSchema,
  completeDraftRequestSchema,
  createDraftRequestSchema,
  rejectDraftRequestSchema,
  updateDraftRequestSchema,
} from "./validation";

function statusForDraftError(err: any) {
  if (err?.statusCode) return err.statusCode;
  const message = String(err?.message || "");
  if (message.includes("not found")) return 404;
  if (message.includes("cannot view") || message.includes("Only")) return 403;
  return 400;
}

function sendDraftError(res: Response, err: any, fallback: string) {
  if (err?.message) {
    res.status(statusForDraftError(err)).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: fallback });
}

export async function list(req: Request, res: Response) {
  try {
    const result = await draftRequestService.listDraftRequests(req.user!, {
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
      mode: typeof req.query.mode === "string" ? req.query.mode : undefined,
      page: typeof req.query.page === "string" ? Number(req.query.page) : undefined,
      pageSize: typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error("List draft requests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getOne(req: Request, res: Response) {
  try {
    const request = await draftRequestService.getDraftRequest(String(req.params.id), req.user!);
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not load draft request");
  }
}

export async function create(req: Request, res: Response) {
  const parsed = createDraftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid draft request",
      issues: formatZodIssues(parsed.error),
    });
    return;
  }

  try {
    const request = await draftRequestService.createDraftRequest(req.user!, parsed.data);
    res.status(201).json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not create draft request");
  }
}

export async function update(req: Request, res: Response) {
  const parsed = updateDraftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid draft request update",
      issues: formatZodIssues(parsed.error),
    });
    return;
  }

  try {
    const request = await draftRequestService.updateDraftRequest(
      String(req.params.id),
      req.user!,
      parsed.data,
    );
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not update draft request");
  }
}

export async function cancel(req: Request, res: Response) {
  try {
    const request = await draftRequestService.cancelDraftRequest(
      String(req.params.id),
      req.user!,
    );
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not cancel draft request");
  }
}

export async function accept(req: Request, res: Response) {
  const parsed = acceptDraftRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid draft review",
      issues: formatZodIssues(parsed.error),
    });
    return;
  }

  try {
    const request = await draftRequestService.acceptDraftRequest(
      String(req.params.id),
      req.user!,
      parsed.data,
    );
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not accept draft request");
  }
}

export async function reject(req: Request, res: Response) {
  const parsed = rejectDraftRequestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid rejection note",
      issues: formatZodIssues(parsed.error),
    });
    return;
  }

  try {
    const request = await draftRequestService.rejectDraftRequest(
      String(req.params.id),
      req.user!,
      parsed.data.note,
    );
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not reject draft request");
  }
}

export async function complete(req: Request, res: Response) {
  const parsed = completeDraftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid completion payload",
      issues: formatZodIssues(parsed.error),
    });
    return;
  }

  try {
    const request = await draftRequestService.completeDraftRequest(
      String(req.params.id),
      req.user!,
      parsed.data.invoiceId,
    );
    res.json({ request });
  } catch (err: any) {
    sendDraftError(res, err, "Could not complete draft request");
  }
}
