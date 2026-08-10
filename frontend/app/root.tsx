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

// loading Google Material Symbols font — we use this for all icons across the app
export const links: Route.LinksFunction = () => [
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200",
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
