
Enhancements to pithagoras:
When tasks are implemented, add a notification using ntfy to inform when the task is done.
- [x] allow selecting a default model for pi to override the default selected by pi.
      Implemented (both paths): (1) Settings → General → "Default model" for new chats,
      persisted via `setSettings`/`getSettings` → `chatModel` → executor `--model`/`--provider`
      (see server/src/db.ts, server/src/server.ts PUT /api/settings,
      server/src/session-manager.ts startClient, server/src/executors/index.ts piArgs);
      (2) the `PI_MODEL` environment override for deploy-time pinning. Documented in
      .env.example and docs/reference/configuration.md. Verified: server type-checks clean.
chrome browser in android has an option to install a webpage as an app. make sure we can do this. add support for creating notifications via the browser that pop up in android. use this style of notification for chats when the chat finishes if the page is not actively being viewed
add timestamps on chats (optional feature that can be enabled or disabled in settings if it doesnt already exist)
bypass the login requirement

