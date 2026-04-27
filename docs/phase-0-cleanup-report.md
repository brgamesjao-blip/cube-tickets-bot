# Phase 0 — Cleanup Report

This document records the Phase 0 cleanup of the `cube-tickets-bot` repository, performed as the first step in rebuilding the Cube Graphics platform into a SaaS product.

The goal of Phase 0 was to remove every command and subsystem from the bot **except the ticket creation system**, so that the new bot (Phase 3) can be built on a clean foundation without inheriting clutter, dead code, or conflicting handlers.

---

## Repository state before cleanup

- Single file: `index.js` (791 lines)
- Single dependency: `discord.js` ^14.14.1
- Hosting: Railway (auto-deploy from GitHub on push)
- Asset directory: `portfolio/` (19 PNG files for `!portfolio`)
- Asset file: `ORDER_NOW_-_BANNER.png` (used by `!ordermsg`)
- External dependency: Cloudflare Worker at `https://cube-api.brgamesjao.workers.dev` (admin dashboard + check-in queue KV)

---

## What was removed

### Commands

| Command | Purpose |
|---|---|
| `!done` | Order completion form (designer + currency + description + price); posted result to the Cloudflare Worker `/admin/complete` |
| `!testcheckin @user` | Test 7-day check-in DM to a user |
| `!testreminder` | Manually trigger the 12h reminder |
| `!portfolio <designer>` | Send portfolio images for `Lyus`, `Thz`, `Nosher`, `Soda` |
| `!help` | List all commands |
| `!rush` / `!unrush` | Toggle a `⚠️` prefix on the ticket channel name |
| `!revision` | Increment a per-ticket revision counter (max 3) |
| `!cleanrevision` | Reset the revision counter |

### Subsystems

- **`!done` form orchestration:** all `done_designer`, `done_currency`, `done_details`, `done_modal`, `done_confirm`, `done_cancel` interaction handlers, the `pendingDone` Map, the `updateDoneEmbed()` helper, and the `formatPrice()` helper.
- **Reminder loop:** `sendReminder()`, the 12-hour `setInterval`, the 60-second startup `setTimeout`, and the `REMINDER_CHANNEL_NAME` constant.
- **Check-in system:** `addToCheckinQueue()`, `processCheckins()`, the `channelDelete` listener, and the 6-hour `setInterval`. Removing this also removes all bot calls into the Cloudflare Worker.
- **Cloudflare Worker integration:** `WORKER_URL` and `ADMIN_PW` constants, all `fetch()` calls into `cube-api.brgamesjao.workers.dev`. The Worker itself is **not** touched as part of Phase 0 (see "Cloudflare-hosted code" below).
- **Hardcoded data:** the `DESIGNERS` array (used only by `!done`).
- **Imports no longer needed:** `StringSelectMenuBuilder`, `ModalBuilder`, `TextInputBuilder`, `TextInputStyle` (all `!done`-only), and the unused top-level `path` require.

### Files

- `portfolio/` directory and all 19 PNG files inside (consumed only by `!portfolio`). New designer portfolio storage will live in Supabase (`designer_samples` table) per the platform spec.

### Welcome message edit

The welcome embed posted by `createTicket()` referenced `!done` ("Use `!done` when the order is complete."). That line was removed because the command no longer exists. The `!close` instruction was kept. This is the only edit inside the ticket creation system itself; otherwise it was left untouched per Phase 0 constraints.

---

## What was kept (the ticket creation system)

The full ticket creation flow remains intact:

- `createTicket(guild, member, orderData)` — creates a private channel under the `TICKETS` category, sets permission overwrites for client + Artist role + bot, posts the welcome embed with the close button, and pre-fills order details if an `orderData` payload is provided.
- `messageCreate` listener for "Cube AI" webhook embeds (with title containing `New Order`) — extracts the Discord username and triggers ticket creation if the user is in the guild, otherwise queues into `pendingOrders`.
- `guildMemberAdd` listener — when a queued user joins the guild, their ticket is created.
- `pendingOrders` Map and its 1-hour cleanup `setInterval` (24h TTL).
- `!ticket @user` admin command — manual ticket creation by mention.
- `!ordermsg` admin command — posts the permanent order banner with the **Open a Ticket** button. This is the primary client entry point inside Discord, so it stays.
- `!close` command — closes (deletes) a ticket channel after a 5-second delay.
- `open_ticket` button handler — entry point fired by clients clicking the banner button.
- `close_ticket` button handler — fired by the close button in the welcome embed.
- `isTicketChannel()` helper — used by `!close`.
- Constants `ARTIST_ROLE_ID` and `TICKET_CATEGORY_NAME`.

---

## Cloudflare-hosted code

The bot referenced one Cloudflare Worker, `cube-api.brgamesjao.workers.dev`, with the following endpoints:

- `POST /admin/complete` — received the `!done` form payload and powered the legacy admin dashboard at `cubegraphics.org`.
- `POST /bot/checkin-add`, `POST /bot/checkin-list`, `POST /bot/checkin-remove` — KV-backed queue for the 7-day client check-in DMs.

The Worker source is **not** in any GitHub repo accessible to this audit (likely edited directly in the Cloudflare dashboard). Per the Phase 0 decision, the Worker is left running and untouched; the new platform will replace its dashboard role in Phase 6, and the Worker can be retired during the Phase 7 launch / migration.

The bot no longer calls into the Worker.

---

## Result

- `index.js` reduced from **791 lines to ~200 lines**.
- File count: `index.js`, `package.json`, `ORDER_NOW_-_BANNER.png`, `docs/phase-0-cleanup-report.md`.
- Dependencies unchanged: `discord.js` ^14.14.1.
- Deployment configuration unchanged: Railway auto-deploy on push, `npm start` → `node index.js`.
- No new dependencies introduced.
- No refactoring of the ticket creation system itself, beyond removing the dead `!done` reference from the welcome embed.

---

## Verification

Local verification (running `node index.js` against a dev guild) was **skipped** because no development bot token is currently available. The bot will be verified against the live Railway deployment after this branch is merged.

Functional surface remaining for verification:

1. `!ordermsg` (admin) posts the banner with the Open a Ticket button.
2. Clicking **Open a Ticket** creates a private channel under the `TICKETS` category with correct permission overwrites.
3. `!ticket @user` (admin) creates a ticket for the mentioned user.
4. A "Cube AI" webhook embed with title containing `New Order` triggers automatic ticket creation for the matched Discord user.
5. A user joining the guild with a pending order has a ticket created automatically.
6. `!close` and the **Close Ticket** button delete the ticket channel after 5 seconds.

---

## Next phase

After this PR is reviewed and merged, the next session begins **Phase 1**: scaffold the new Next.js platform with Supabase, Discord OAuth, and the DM verification fallback. Phase 1 happens in a new repository, not in this one.
