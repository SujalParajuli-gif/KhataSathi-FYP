import { useRef, type SetStateAction } from "react";
import type { SetURLSearchParams } from "react-router";

// Read committed controls from the URL. The pending params preserve sibling
// updates made in one event (for example changing a filter and resetting page).
export function useQueryControls(params: URLSearchParams, setParams: SetURLSearchParams) {
  const pending = useRef(params);
  const rendered = useRef(params.toString());
  if (rendered.current !== params.toString()) {
    rendered.current = params.toString();
    pending.current = params;
  }

  return function field<T extends string | number | boolean>(
    key: string,
    fallback: T,
    parse: (value: string | null) => T,
  ): [T, (value: SetStateAction<T>) => void] {
    return [parse(params.get(key)), (value) => {
      const nextValue = typeof value === "function" ? value(parse(pending.current.get(key))) : value;
      const next = new URLSearchParams(pending.current);
      if (nextValue === fallback || nextValue === "") next.delete(key);
      else next.set(key, String(nextValue));
      if (next.toString() === pending.current.toString()) return;
      pending.current = next;
      setParams(next, { replace: true, preventScrollReset: true });
    }];
  };
}
