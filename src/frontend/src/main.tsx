/**
 * @file Application entry point.
 *
 * Mounts the root React component tree into the DOM element with id `"root"`.
 *
 * The component hierarchy at this level is:
 * 1. `<React.StrictMode>` — Enables additional development-time checks and
 *    warnings (double-invokes effects in dev to catch impure side effects).
 * 2. `<BrowserRouter>` — Provides client-side routing via `react-router-dom`.
 *    Uses the HTML5 History API for clean URLs (no hash fragments).
 * 3. `<App>` — The root application component that handles auth gating and
 *    page routing (see `App.tsx`).
 *
 * Global styles are imported from `index.css` which sets up CSS custom
 * properties for the dark theme and base element styles.
 *
 * @module main
 */

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
