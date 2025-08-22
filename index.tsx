/**
 * index.tsx – entry point for the Escher Tessellation Lab app
 */
import React from "react";
import ReactDOM from "react-dom/client";
import EscherLab from "./EscherLab";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    <EscherLab />
  </React.StrictMode>
);
