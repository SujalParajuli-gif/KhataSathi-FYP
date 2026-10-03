export type PendingCheckoutSnapshot<TPayload> = {
  operationKey: string;
  payload: TPayload;
  activeDraftRequestId?: string | null;
};

export function resolvePendingCheckoutSnapshot<TPayload extends object>(
  pending: PendingCheckoutSnapshot<TPayload> | null,
  operationKey: string,
  payload: TPayload,
  activeDraftRequestId?: string | null,
): PendingCheckoutSnapshot<TPayload> {
  if (pending) return pending;
  return {
    operationKey,
    payload: {
      ...payload,
      draftRequestId: activeDraftRequestId || undefined,
    } as TPayload,
    activeDraftRequestId: activeDraftRequestId || null,
  };
}
