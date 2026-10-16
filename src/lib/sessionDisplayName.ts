/**
 * The one label every surface shows for a terminal (header, Agents and
 * Injector lists, footer navigator, parked shelf, zoom strips): its
 * agent/session name, else "Terminal N" with N the session id — so an unnamed
 * session reads the same everywhere and keeps its label when neighbours close.
 */
export function sessionDisplayName(session: { id: number; name?: string | null }): string {
  return session.name?.trim() || `Terminal ${session.id}`;
}
