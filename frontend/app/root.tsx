import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

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
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto p-4 pt-16">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
