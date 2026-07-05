import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installConsoleCapture } from "./lib/consoleCapture";
import "./styles.css";

installConsoleCapture();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
