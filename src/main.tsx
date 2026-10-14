import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IssueMapWindow } from "./components/git/issues/IssueMapWindow";
import { readIssueMapTarget } from "./lib/issueMapWindow";
import "./styles/fonts.css";
import "./styles/globals.css";

// Apply platform class for CSS overrides (e.g. Linux performance fixes)
if (navigator.userAgent.includes("Linux")) {
  document.documentElement.classList.add("platform-linux");
}

// The issue map opens in its own window, which loads this same page.
const issueMapTarget = readIssueMapTarget(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {issueMapTarget ? <IssueMapWindow initial={issueMapTarget} /> : <App />}
  </React.StrictMode>,
);
