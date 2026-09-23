// A deliberately tiny History-API router. The app has five routes; a routing
// library would be more code than the routes themselves.
import { createContext, useContext, useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./motion";

interface Location { path: string; search: string }

const RouterCtx = createContext<Location>({ path: "/", search: "" });

function read(): Location {
  return { path: window.location.pathname.replace(/\/+$/, "") || "/", search: window.location.search };
}

/** Scroll to top once the next location has rendered (not before, or the old page jumps). */
let scrollOnCommit = false;
/** Route chunks to warm up on hover, registered by the app shell. */
let preloader: ((path: string) => void) | null = null;
export const setPreloader = (fn: (path: string) => void) => { preloader = fn; };

export function navigate(to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  scrollOnCommit = !opts.keepScroll && !to.includes("#");
  window.dispatchEvent(new Event("app:navigate"));
}

const section = (path: string) => path.split("/")[1] ?? "";

type VTDocument = Document & { startViewTransition?: (cb: () => void) => unknown };

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Location>(read);
  useEffect(() => {
    let current = read();
    const update = () => {
      const next = read();
      const scroll = scrollOnCommit;
      scrollOnCommit = false;
      // flushSync only inside a view transition, where the snapshot needs the
      // DOM updated synchronously. Elsewhere it would warn when navigate() is
      // called from an effect (the /solve and /demo redirects do exactly that).
      const commit = (sync: boolean) => {
        if (sync) flushSync(() => setLoc(next));
        else setLoc(next);
        if (scroll) window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      };
      // Cross-fade between pages; tab and query changes inside a page stay instant.
      const doc = document as VTDocument;
      const crossPage = section(next.path) !== section(current.path);
      current = next;
      if (crossPage && doc.startViewTransition && !prefersReducedMotion()) doc.startViewTransition(() => commit(true));
      else commit(false);
    };
    window.addEventListener("popstate", update);
    window.addEventListener("app:navigate", update);
    // Child effects run before this one, so a redirect issued during the first
    // render (e.g. /demo -> /solve/portfolio) fired before we were listening.
    setLoc(current);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("app:navigate", update);
    };
  }, []);
  return <RouterCtx.Provider value={loc}>{children}</RouterCtx.Provider>;
}

export const useLocation = () => useContext(RouterCtx);

export function Link({ href, children, onClick, onPointerEnter, onFocus, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const external = /^https?:/.test(href) || href.startsWith("mailto:");
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || external || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (href.startsWith("#")) return;
    e.preventDefault();
    navigate(href);
  };
  const warm = () => { if (!external && !href.startsWith("#")) preloader?.(href); };
  return (
    <a
      href={href}
      onClick={handle}
      onPointerEnter={(e) => { warm(); onPointerEnter?.(e); }}
      onFocus={(e) => { warm(); onFocus?.(e); }}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}
