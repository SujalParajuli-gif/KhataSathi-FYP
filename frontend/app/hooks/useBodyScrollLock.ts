import { useEffect } from "react";

type ScrollLockSnapshot = {
  bodyOverflow: string;
  bodyPaddingRight: string;
  documentOverflow: string;
  appScroller: HTMLElement | null;
  appScrollerOverflow: string;
};

const activeLocks = new Set<symbol>();
let snapshot: ScrollLockSnapshot | null = null;

function acquireBodyScrollLock(lockId: symbol) {
  if (activeLocks.has(lockId)) return;

  const { body, documentElement } = document;
  if (activeLocks.size === 0) {
    const appScroller = document.querySelector<HTMLElement>(
      "[data-app-scroll-container]",
    );
    snapshot = {
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
      documentOverflow: documentElement.style.overflow,
      appScroller,
      appScrollerOverflow: appScroller?.style.overflow ?? "",
    };

    const scrollbarWidth = Math.max(
      0,
      window.innerWidth - documentElement.clientWidth,
    );
    const currentPaddingRight = Number.parseFloat(
      window.getComputedStyle(body).paddingRight,
    );

    documentElement.style.overflow = "hidden";
    body.style.overflow = "hidden";
    if (appScroller) appScroller.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
    }
    body.dataset.scrollLocked = "true";
  }

  activeLocks.add(lockId);
}

function releaseBodyScrollLock(lockId: symbol) {
  if (!activeLocks.delete(lockId) || activeLocks.size > 0) return;

  const { body, documentElement } = document;
  body.style.overflow = snapshot?.bodyOverflow ?? "";
  body.style.paddingRight = snapshot?.bodyPaddingRight ?? "";
  documentElement.style.overflow = snapshot?.documentOverflow ?? "";
  if (snapshot?.appScroller?.isConnected) {
    snapshot.appScroller.style.overflow = snapshot.appScrollerOverflow;
  }
  delete body.dataset.scrollLocked;
  snapshot = null;
}

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const lockId = Symbol("body-scroll-lock");
    acquireBodyScrollLock(lockId);

    return () => {
      releaseBodyScrollLock(lockId);
    };
  }, [locked]);
}
