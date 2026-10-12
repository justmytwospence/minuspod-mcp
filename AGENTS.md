# MinusPod MCP

Maintained source lives here, not in installed copies or dotfiles. Use conventional
commits and release tags. Run `npm test` before releasing. npm dependency releases
must be at least seven days old; pin exact versions and commit the lockfile.

Never run paid processing or mutating integration tests against production.
Keep capabilities narrow: no bulk, deletion, arbitrary paths/settings, global
models/provider/security configuration, media/JIT requests, or shadow controls.
Passwords/cookies remain server-side and must never enter logs or tool responses.
Read current pinned MinusPod API/docs before changing payloads. Never claim tool
annotations or an agent's “ask first” promise enforce human confirmation.
