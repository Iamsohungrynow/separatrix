import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
// after the base styles, so tilt/magnetic/lift transitions win over .card/.btn ones
import "./motion.css";
import App from "./App";
import { initMotion } from "./lib/motion";

initMotion();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
