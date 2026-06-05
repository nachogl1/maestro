import { invoke } from "@tauri-apps/api/core";

/** Usage data from Anthropic's OAuth API. */
export interface UsageData {
  sessionPercent: number;
  sessionResetsAt: string | null;
  weeklyPercent: number;
  weeklyResetsAt: string | null;
  weeklyOpusPercent: number;
  weeklyOpusResetsAt: string | null;
  errorMessage: string | null;
  needsAuth: boolean;
}

export async function getClaudeUsage(forceRefresh = false): Promise<UsageData> {
  return invoke<UsageData>("get_claude_usage", { forceRefresh });
}

export interface ClaudeAccount {
  loggedIn: boolean;
  email: string | null;
  subscriptionType: string | null;
}

export async function getClaudeAccount(): Promise<ClaudeAccount> {
  return invoke<ClaudeAccount>("get_claude_account");
}

/** Format a reset time as a short relative string (e.g. "2h 30m", "3d"). */
export function formatResetTime(isoDate: string | null): string {
  if (!isoDate) return "";
  try {
    const resetDate = new Date(isoDate);
    const time = resetDate.getTime();
    // Invalid dates yield NaN, which silently slips past the comparisons below
    // and renders as "NaNm" — guard explicitly.
    if (Number.isNaN(time)) return "";
    const diffMs = time - Date.now();
    if (diffMs <= 0) return "now";
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays > 0) {
      const remH = diffHours % 24;
      return remH > 0 ? `${diffDays}d ${remH}h` : `${diffDays}d`;
    }
    if (diffHours > 0) {
      const remM = diffMins % 60;
      return remM > 0 ? `${diffHours}h ${remM}m` : `${diffHours}h`;
    }
    return `${diffMins}m`;
  } catch {
    return "";
  }
}
