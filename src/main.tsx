import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { IssueMapWindow } from "./components/git/issues/IssueMapWindow";
import { WorkJournalWindow } from "./components/workjournal/WorkJournalWindow";
import { forwardErrorsToLog } from "./lib/frontendLog";
import { readIssueMapTarget } from "./lib/issueMapWindow";
import { getProjectWindowId, getProjectWindowTabId } from "./lib/projectWindow";
import { isWorkJournalWindowView } from "./lib/workJournalWindow";
import { ProjectWindowApp } from "./ProjectWindowApp";
import "./styles/fonts.css";
import "./styles/globals.css";

// Apply platform class for CSS overrides (e.g. Linux performance fixes)
if (navigator.userAgent.includes("Linux")) {
  document.documentElement.classList.add("platform-linux");
}

// Release builds have no web console: keep front-end errors in the log file.
forwardErrorsToLog();

// The issue map opens in its own window, which loads this same page.
const issueMapTarget = readIssueMapTarget(window.location.search);
// So does the popped-out Work Journal.
const workJournalWindow = isWorkJournalWindowView(window.location.search);
// And a project tab moved to its own window (`?projectWindow=<tabId>&windowId=<id>`).
const projectWindowTabId = getProjectWindowTabId();
const projectWindowId = getProjectWindowId();

function Root() {
  if (issueMapTarget) return <IssueMapWindow initial={issueMapTarget} />;
  if (workJournalWindow) return <WorkJournalWindow />;
  if (projectWindowTabId && projectWindowId) {
    return <ProjectWindowApp tabId={projectWindowTabId} windowId={projectWindowId} />;
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
