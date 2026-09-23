import { lazy, Suspense, useEffect } from "react";
import { Footer, Nav } from "./components/Chrome";
import { Cursor } from "./components/Cursor";
import { navigate, RouterProvider, setPreloader, useLocation } from "./lib/router";
import Home from "./pages/Home";

const loaders = {
  solve: () => import("./pages/Solve"),
  dicke: () => import("./pages/Dicke"),
  benchmarks: () => import("./pages/Benchmarks"),
  learn: () => import("./pages/Learn"),
};
const Solve = lazy(loaders.solve);
const Dicke = lazy(loaders.dicke);
const Benchmarks = lazy(loaders.benchmarks);
const Learn = lazy(loaders.learn);
const NotFound = lazy(() => import("./pages/NotFound"));

// Warm a page's chunk when a link to it is hovered, so the page transition
// animates into the real page rather than into the loading fallback.
setPreloader((href) => {
  const key = href.split(/[/?#]/)[1] as keyof typeof loaders;
  loaders[key]?.();
});

function Routes() {
  const { path } = useLocation();
  useEffect(() => {
    // The old static demo lived at /demo; keep its links working.
    if (path === "/demo") navigate("/solve/portfolio", { replace: true });
  }, [path]);

  useEffect(() => {
    // After the first page settles, fetch the other pages in the background.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    idle(() => Object.values(loaders).forEach((l) => l()));
  }, []);

  let page;
  if (path === "/") page = <Home />;
  else if (path === "/solve" || path.startsWith("/solve/")) page = <Solve />;
  else if (path === "/dicke") page = <Dicke />;
  else if (path === "/benchmarks") page = <Benchmarks />;
  else if (path === "/learn") page = <Learn />;
  else if (path === "/demo") page = null;
  else page = <NotFound />;

  return (
    <Suspense fallback={<div className="wrap route-wait" aria-hidden="true"><i /><i /><i /></div>}>
      <main id="main">{page}</main>
    </Suspense>
  );
}

export default function App() {
  return (
    <RouterProvider>
      <div className="ambient" aria-hidden="true"><i /><i /><i /></div>
      <a href="#main" className="sr-only">Skip to content</a>
      <Nav />
      <Routes />
      <Footer />
      <Cursor />
    </RouterProvider>
  );
}
