import { useCallback, useSyncExternalStore } from "react";
import { getProductImportStatusApi, type ProductImportTaskStatus } from "./api/endpoints";

export const isImportActive = (status?: string) => !status || ["QUEUED", "PROCESSING", "CANCELLING", "COMMITTING"].includes(status);
type Snapshot = { data: ProductImportTaskStatus | null; error: string; unavailable: boolean; checkedAt: number | null };
const empty: Snapshot = { data: null, error: "", unavailable: false, checkedAt: null };
type Task = { snapshot: Snapshot; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>;
  request?: AbortController; failures: number; refresh?: () => void; refreshPending?: boolean };
const tasks = new Map<string, Task>();

function taskFor(id: string): Task {
  let task = tasks.get(id);
  if (!task) { task = { snapshot: empty, listeners: new Set(), failures: 0 }; tasks.set(id, task); }
  return task;
}

function start(id: string, task: Task) {
  const publish = (snapshot: Snapshot) => {
    task.snapshot = snapshot;
    task.listeners.forEach((listener) => listener());
  };
  async function poll() {
    if (!task.listeners.size) return;
    if (task.request) { task.refreshPending = true; return; }
    clearTimeout(task.timer);
    const request = new AbortController();
    task.request = request;
    try {
      const data = await getProductImportStatusApi(id, request.signal);
      if (request.signal.aborted) return;
      task.failures = 0;
      publish({ data, error: "", unavailable: false, checkedAt: Date.now() });
    } catch (error: any) {
      if (request.signal.aborted) return;
      task.failures++;
      const unavailable = [401, 403, 404].includes(error?.response?.status);
      publish({ data: task.snapshot.data, checkedAt: task.snapshot.checkedAt, unavailable, error: unavailable
        ? "This import is no longer available."
        : "Status connection lost. Retrying automatically; your import stays saved." });
    } finally {
      if (task.request === request) task.request = undefined;
      if (!request.signal.aborted && task.refreshPending) {
        task.refreshPending = false;
        void poll();
        return;
      }
      if (!request.signal.aborted && task.listeners.size && !task.snapshot.unavailable &&
        (task.failures > 0 || isImportActive(task.snapshot.data?.batch.status))) {
        const delay = task.failures ? Math.min(30000, 2500 * 2 ** Math.min(task.failures, 4)) : 2500;
        task.timer = setTimeout(poll, document.hidden ? Math.max(15000, delay) : delay);
      }
    }
  }
  task.refresh = () => { if (!document.hidden) void poll(); };
  document.addEventListener("visibilitychange", task.refresh);
  window.addEventListener("focus", task.refresh);
  void poll();
}

export function refreshImportTask(id: string) { tasks.get(id)?.refresh?.(); }

export function useImportTask(id?: string | null) {
  const subscribe = useCallback((listener: () => void) => {
    if (!id) return () => {};
    const task = taskFor(id);
    task.listeners.add(listener);
    if (task.listeners.size === 1) start(id, task);
    return () => {
      task.listeners.delete(listener);
      if (task.listeners.size) return;
      clearTimeout(task.timer);
      task.request?.abort();
      if (task.refresh) {
        document.removeEventListener("visibilitychange", task.refresh);
        window.removeEventListener("focus", task.refresh);
      }
      tasks.delete(id);
    };
  }, [id]);
  return useSyncExternalStore(subscribe, useCallback(() => id ? taskFor(id).snapshot : empty, [id]), () => empty);
}

export function importTaskLabel(status?: string) {
  switch (status) {
    case "DRAFT": return "Ready for review";
    case "IMPORTED": return "Import complete";
    case "FAILED": return "Extraction needs attention";
    case "INTERRUPTED": return "Extraction stopped — progress saved";
    case "CANCELLING": return "Stopping extraction…";
    case "COMMITTING": return "Applying reviewed products…";
    case "QUEUED": return "Waiting to process…";
    default: return "Extracting products…";
  }
}
