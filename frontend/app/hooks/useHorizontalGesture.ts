import { useRef, type PointerEvent as ReactPointerEvent } from "react";

const DEFAULT_IGNORED_TARGETS = [
  "button",
  "a",
  "input",
  "label",
  "textarea",
  "select",
  "[role='button']",
  "[role='switch']",
  "[contenteditable='true']",
  "[data-horizontal-gesture='ignore']",
  "[data-horizontal-scroll]",
].join(",");

export function isHorizontalGestureInteractiveTarget(
  target: Pick<HTMLElement, "closest">,
) {
  return Boolean(target.closest(DEFAULT_IGNORED_TARGETS));
}

type HorizontalGestureOptions = {
  enabled?: boolean;
  threshold?: number;
  velocityThreshold?: number;
  allowMouse?: boolean;
  ignoreInteractive?: boolean;
  edgeGuard?: number;
  maxViewportWidth?: number;
  onStart?: () => void;
  onMove?: (offsetX: number) => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onEnd?: (completed: boolean) => void;
};

type GestureState = {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  axis: "pending" | "horizontal" | "vertical";
  lastX: number;
};

export function useHorizontalGesture<T extends HTMLElement>({
  enabled = true,
  threshold = 56,
  velocityThreshold = 0.45,
  allowMouse = false,
  ignoreInteractive = true,
  edgeGuard = 0,
  maxViewportWidth,
  onStart,
  onMove,
  onSwipeLeft,
  onSwipeRight,
  onEnd,
}: HorizontalGestureOptions) {
  const gestureRef = useRef<GestureState | null>(null);
  const callbacksRef = useRef({ onStart, onMove, onSwipeLeft, onSwipeRight, onEnd });
  callbacksRef.current = { onStart, onMove, onSwipeLeft, onSwipeRight, onEnd };

  function reset(completed: boolean) {
    gestureRef.current = null;
    callbacksRef.current.onEnd?.(completed);
  }

  function onPointerDown(event: ReactPointerEvent<T>) {
    if (!enabled || !event.isPrimary) return;
    if (maxViewportWidth && window.innerWidth > maxViewportWidth) return;
    if (!allowMouse && event.pointerType === "mouse") return;
    if (
      edgeGuard > 0
      && (event.clientX <= edgeGuard || event.clientX >= window.innerWidth - edgeGuard)
    ) return;

    const target = event.target as HTMLElement;
    if (ignoreInteractive && isHorizontalGestureInteractiveTarget(target)) return;

    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
      axis: "pending",
      lastX: event.clientX,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<T>) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    gesture.lastX = event.clientX;

    if (gesture.axis === "pending") {
      if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < 8) return;
      if (Math.abs(deltaY) > Math.abs(deltaX) * 1.15) {
        gesture.axis = "vertical";
        reset(false);
        return;
      }
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
        gesture.axis = "horizontal";
        callbacksRef.current.onStart?.();
      } else {
        return;
      }
    }

    if (gesture.axis !== "horizontal") return;
    event.preventDefault();
    callbacksRef.current.onMove?.(deltaX);
  }

  function finish(event: ReactPointerEvent<T>, cancelled = false) {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    if (cancelled || gesture.axis !== "horizontal") {
      reset(false);
      return;
    }

    const deltaX = event.clientX - gesture.startX;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const velocity = deltaX / elapsed;
    const swipedLeft = deltaX <= -threshold || velocity <= -velocityThreshold;
    const swipedRight = deltaX >= threshold || velocity >= velocityThreshold;

    if (swipedLeft) callbacksRef.current.onSwipeLeft?.();
    if (swipedRight) callbacksRef.current.onSwipeRight?.();
    reset(swipedLeft || swipedRight);
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<T>) => finish(event),
    onPointerCancel: (event: ReactPointerEvent<T>) => finish(event, true),
    style: { touchAction: "pan-y" as const },
  };
}
