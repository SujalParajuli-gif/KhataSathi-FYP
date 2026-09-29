import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import Icon from "~/components/ui/Icon";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: "/assets/fonts/IBM_Plex_Sans/IBMPlexSans-VariableFont_wdth,wght.ttf",
    as: "font",
    type: "font/ttf",
    crossOrigin: "anonymous",
  },
  {
    rel: "manifest",
    href: "/manifest.webmanifest",
  },
  {
    rel: "apple-touch-icon",
    href: "/assets/icons/smalllogo.png",
  },
  // this replaces the default browser tab icon with our project branding
  {
    rel: "icon",
    type: "image/png",
    href: "/assets/icons/smalllogo.png",
  },
  // some browsers still prefer the shortcut icon relationship for favicons
  {
    rel: "shortcut icon",
    type: "image/png",
    href: "/assets/icons/smalllogo.png",
  },
];

// the root HTML layout — wraps every page in the app
// this sets up the base HTML structure with meta tags, stylesheets, and scripts
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#11120D" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="KhataSathi" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// initial hydration fallback — rendered while React Router SPA client loads bundles
export function HydrateFallback() {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center bg-[#F7F7F5] px-4 text-[#11120D]"
      role="status"
      aria-label="Loading KhataSathi"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl bg-white p-2 shadow-sm ring-1 ring-black/5">
          <img
            src="/assets/icons/smalllogo.png"
            alt="KhataSathi logo"
            className="h-12 w-12 object-contain"
            width={48}
            height={48}
          />
          <span className="absolute -inset-1.5 -z-10 animate-pulse rounded-[22px] bg-slate-200/60" />
        </div>
        <div className="space-y-1.5">
          <div className="text-[16px] font-extrabold tracking-tight text-[#11120D]">
            KhataSathi
          </div>
          <div className="flex items-center justify-center gap-2 text-[12px] font-semibold text-[#6E6B5F]">
            <span className="inline-block h-2 w-2 animate-ping rounded-full bg-[#11120D]" />
            <span>Loading workspace…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// the main App component — renders whatever route is currently active via Outlet
export default function App() {
  return <Outlet />;
}

// global error boundary — catches any unhandled errors in the app
// shows a 404 message for missing pages, and a generic error for everything else
// in development mode, we also show the error stack trace for easier debugging
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Something went wrong";
  let details = "KhataSathi could not finish loading this page. Your saved shop data has not been changed.";
  let icon = "error";
  let isNotFound = false;
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    isNotFound = error.status === 404;
    if (isNotFound) {
      message = "Page not found";
      details = "The page may have moved, or this account may no longer use that address.";
      icon = "search_off";
    } else if (error.status === 403) {
      message = "Access denied";
      details = "Your account does not have permission to open this page.";
      icon = "lock";
    } else if (error.statusText) {
      details = error.statusText;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#F7F7F5] p-5 text-[#11120d]">
      <section className="w-full max-w-[520px] rounded-[22px] border border-[#DADDE3] bg-white p-6 text-center shadow-[0_18px_50px_rgba(15,23,42,0.09)] md:p-8" role="alert">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-rose-50 text-rose-700">
          <Icon name={icon} sizePx={29} />
        </div>
        <h1 className="mt-4 text-[21px] font-extrabold">{message}</h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] font-semibold leading-6 text-[#565449]">{details}</p>
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {!isNotFound ? (
            <button type="button" onClick={() => window.location.reload()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[13px] bg-[#11120d] px-4 text-[13px] font-extrabold text-white">
              <Icon name="refresh" sizePx={18} />
              Try again
            </button>
          ) : null}
          <a href="/" className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-[13px] border border-[#CFCFD3] bg-white px-4 text-[13px] font-extrabold text-[#11120d] ${isNotFound ? "sm:col-span-2" : ""}`}>
            <Icon name="home" sizePx={18} />
            Return home
          </a>
        </div>
        {stack ? (
          <details className="mt-5 text-left">
            <summary className="cursor-pointer text-[12px] font-extrabold text-[#64748B]">Developer details</summary>
            <pre className="mt-2 max-h-56 w-full overflow-auto rounded-[12px] bg-slate-950 p-3 text-[11px] leading-5 text-slate-100"><code>{stack}</code></pre>
          </details>
        ) : null}
      </section>
    </main>
  );
}
