// Route views are code-split: each tab is its own chunk, loaded on first visit (the
// Softphone chunk also pulls in JsSIP, the largest dependency). App renders them inside
// a <Suspense> boundary and calls preloadViews() once idle so later tab switches don't
// wait on the network.
import { lazy } from "react";

const loaders = {
  Dashboard: () => import("./Dashboard"),
  Softphone: () => import("./Softphone"),
  Messages: () => import("./Messages"),
  SimConfig: () => import("./SimConfig"),
  Settings: () => import("./Settings"),
  Logs: () => import("./Logs"),
  Esim: () => import("./Esim"),
};

// A tab opened before a WebUI rebuild still references the old chunk hashes; the
// manager's SPA fallback answers those with index.html, so the import fails. Reload
// once to pick up the new build (the sessionStorage flag stops a reload loop when the
// failure is something else, e.g. the manager being down).
const RELOAD_FLAG = "vowifi-chunk-reload";

function recoverable<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().then(
      (mod) => {
        try {
          sessionStorage.removeItem(RELOAD_FLAG);
        } catch {}
        return mod;
      },
      (err) => {
        let reloaded = true;
        try {
          reloaded = sessionStorage.getItem(RELOAD_FLAG) !== null;
          if (!reloaded) sessionStorage.setItem(RELOAD_FLAG, "1");
        } catch {}
        if (!reloaded) {
          window.location.reload();
          return new Promise<T>(() => {}); // keep Suspense pending until reload
        }
        throw err;
      },
    );
}

export const Dashboard = lazy(recoverable(loaders.Dashboard));
export const Softphone = lazy(recoverable(loaders.Softphone));
export const Messages = lazy(recoverable(loaders.Messages));
export const SimConfig = lazy(recoverable(loaders.SimConfig));
export const Settings = lazy(recoverable(loaders.Settings));
export const Logs = lazy(recoverable(loaders.Logs));
export const Esim = lazy(recoverable(loaders.Esim));

// Warm the module cache for every view. import() is idempotent, so this resolves the
// same promises React.lazy awaits; failures are ignored here and surface (and are
// recovered from) when the view is actually rendered.
export function preloadViews(): void {
  for (const load of Object.values(loaders)) load().catch(() => {});
}
