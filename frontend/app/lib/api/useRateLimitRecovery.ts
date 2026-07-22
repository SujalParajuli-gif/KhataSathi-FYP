import { useCallback, useEffect, useRef } from "react";

/**
 * Schedules one route-owned reload after the shared API cooldown clears.
 *
 * The API client retries a safe read once. If that retry is also rate-limited,
 * the route still needs to ask for fresh data after the next cooldown. Keeping
 * that responsibility here prevents retry loops while avoiding pages that stay
 * empty until the browser is refreshed.
 */
export function useRateLimitRecovery(recover: () => void | Promise<void>) {
  const recoverRef = useRef(recover);
  const recoveryNeededRef = useRef(false);
  const recoveryRunningRef = useRef(false);

  recoverRef.current = recover;

  useEffect(() => {
    let mounted = true;

    function handleRateLimitCleared() {
      if (!recoveryNeededRef.current || recoveryRunningRef.current) return;

      recoveryNeededRef.current = false;
      recoveryRunningRef.current = true;

      void Promise.resolve(recoverRef.current())
        .catch(() => {
          // The route owns its visible error state. A later 429 will call
          // requestRecovery again and wait for the next clear event.
        })
        .finally(() => {
          if (mounted) recoveryRunningRef.current = false;
        });
    }

    window.addEventListener("rate_limit_cleared", handleRateLimitCleared);
    return () => {
      mounted = false;
      window.removeEventListener("rate_limit_cleared", handleRateLimitCleared);
    };
  }, []);

  return useCallback(() => {
    recoveryNeededRef.current = true;
  }, []);
}
