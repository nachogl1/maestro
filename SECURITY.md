# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately by email to **i.gonzalezluengo95@gmail.com** with the subject
`[SECURITY] <short summary>`. You will receive an acknowledgement, and we will
work with you on a fix and coordinated disclosure.

Please include: affected version/commit, reproduction steps, and impact.

## Scope

Maestro is a desktop app that spawns terminal sessions, executes shell commands,
and manages MCP server configuration. Areas of particular interest:

- Shell / command injection via session input or quick actions.
- Token / secret exposure (e.g. credentials stored in MCP config such as `.mcp.json`).
- Worktree / path traversal in git worktree handling.

## Handling secrets

Never commit secrets. `.mcp.json` is gitignored and may hold API tokens —
prefer referencing tokens via environment variables (e.g. `${RAILWAY_API_TOKEN}`)
rather than plaintext, and rotate any token that has been exposed.
