use super::*;

use crate::protocol::ThreadSummaryView;

/// Hard bounds on user-chosen session titles, for the same reason `project_action` has
/// them: a paired device drives this path, and the map is persisted.
///
/// The character cap is deliberately the SMALLEST wire budget any surface applies to a
/// name (remote lists compact to 96 chars; local web to 120). A user-set title is
/// therefore never truncated on its way to a client — which matters because the rename
/// dialogs seed themselves from the title they were shown. Allow 200 here and a phone
/// receives `Refactor the auth…`, the user presses OK, and the ellipsised prefix becomes
/// the session's real stored name, silently destroying the tail. Capping at what every
/// surface can carry whole makes that round trip lossless by construction, instead of by
/// a string heuristic that cannot tell a relay-added ellipsis from one the user typed.
///
/// A tab is ~200px wide, so 96 characters is already far more than any surface renders.
pub(super) const MAX_THREAD_NAME_CHARS: usize = 96;
const MAX_CUSTOM_THREAD_NAMES: usize = 10_000;

/// How deep a title search scans before giving up.
///
/// `limit` is a PAGE size — what the sidebar shows at rest. A search must not honour it
/// as its scan bound, or it could only ever find rows the sidebar was already showing:
/// precisely the sessions nobody needs to search for. This bounds the scan instead;
/// `limit` still caps what comes back.
const SEARCH_SCAN_LIMIT: usize = 1_000;

/// Normalize a raw `q` into a matchable needle, or `None` for "no search".
///
/// Blank and whitespace-only both mean "no search", so clearing the box restores the
/// normal list rather than asking for every thread whose title contains "".
/// The query is matched WHOLE, deliberately. Capping its length would make two different
/// queries collide: the relay would answer for a prefix while the box still shows what
/// the user typed, so the extra characters would look like they were silently ignored.
/// (An earlier cap reasoned from `MAX_THREAD_NAME_CHARS`, which bounds user-set names —
/// not previews, which are unbounded and are exactly what a long query matches against.)
/// Query length is not the cost here; the provider scan is, and that is bounded
/// separately by `SEARCH_SCAN_LIMIT`.
fn normalize_thread_query(query: Option<&str>) -> Option<String> {
    let trimmed = query?.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(trimmed.to_lowercase())
}

/// The string the row actually SHOWS — which is what a search has to match.
///
/// Every surface renders `thread.name || thread.preview || shortId(id)`
/// (`frontend/shared/thread-list-react.js`). Matching only `name` would leave a row that
/// displays its preview — because the provider never titled it — impossible to search
/// for while it sits visible in the list. The id is the third rung of that same ladder,
/// and it is used ONLY when the first two are empty: the id is a fallback label, not a
/// second searchable field, so a titled row never answers to a query that happens to
/// look like its id.
///
/// `name` is already the user's rename when one exists: `apply_custom_thread_name`
/// overlays it BEFORE this runs. That ordering is what makes a renamed session findable
/// under its new title and not under the provider's old one.
fn thread_display_title(thread: &ThreadSummaryView) -> &str {
    match thread.name.as_deref() {
        Some(name) if !name.is_empty() => name,
        _ if !thread.preview.is_empty() => thread.preview.as_str(),
        // The UI shows the first 8 characters; matching the whole id keeps those 8
        // findable (they are a prefix) and also accepts a pasted full id.
        _ => thread.id.as_str(),
    }
}

/// How many ids one probe may ask about.
///
/// A probe's caller is a client listing the sessions it still holds a reference to — open
/// tabs — so the realistic count is single digits. The cap is a bound on what an untrusted
/// client can make the relay do, not a product limit.
///
/// Exceeding it is an ERROR, not a truncation. A dropped id is absent from the answer, and
/// absence is exactly how a probe's caller concludes "deleted" — so truncating here would
/// turn this one number disagreeing with the client's copy of it into mass closure of live
/// sessions, silently, in the direction (lowering it) that looks harmless from this side.
/// Failing loudly makes the bound enforced rather than documented: the caller discards a
/// sweep it could not complete, so the worst case is that nothing happens.
const MAX_THREAD_ID_PROBE: usize = 128;

/// Normalize a raw id list into a probe set, or `None` for "not a probe".
///
/// An EMPTY list normalizes to `None` — i.e. "the normal page" — rather than to "a probe
/// about nothing". The alternative is worse than it looks: a probe about nothing answers
/// with nothing, and a caller that diffs its ids against an empty answer concludes every
/// session it asked about is gone. Making the degenerate input mean "no probe" keeps a
/// client bug from reading as mass deletion.
///
/// Deduplicated BEFORE the cap, so a caller that repeats an id does not spend its budget
/// on the same question twice.
fn normalize_thread_id_probe(ids: Option<&[String]>) -> Result<Option<HashSet<String>>, String> {
    let Some(ids) = ids else {
        return Ok(None);
    };
    let mut wanted = ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .collect::<Vec<_>>();
    wanted.sort();
    wanted.dedup();
    if wanted.len() > MAX_THREAD_ID_PROBE {
        return Err(format!(
            "a thread-id probe may ask about at most {MAX_THREAD_ID_PROBE} sessions; \
             got {}. Split it — a truncated answer is indistinguishable from those \
             sessions being deleted.",
            wanted.len()
        ));
    }
    if wanted.is_empty() {
        return Ok(None);
    }
    Ok(Some(wanted.into_iter().collect::<HashSet<_>>()))
}

impl AppState {
    pub async fn list_threads(
        &self,
        limit: usize,
        device_id: Option<String>,
    ) -> Result<ThreadsResponse, String> {
        self.list_threads_matching(limit, device_id, None, None)
            .await
    }

    /// `list_threads`, optionally narrowed to rows whose displayed title contains
    /// `query` (case-insensitive), or to an explicit set of thread `ids`.
    pub async fn list_threads_matching(
        &self,
        limit: usize,
        device_id: Option<String>,
        query: Option<&str>,
        ids: Option<&[String]>,
    ) -> Result<ThreadsResponse, String> {
        let query = normalize_thread_query(query);
        let wanted_ids = normalize_thread_id_probe(ids)?;
        // Read reviewer ids before the provider fetch so we can request a larger
        // page from each provider. If the newest N slots are all reviewer threads
        // we would return fewer than `limit` normal threads otherwise.
        let reviewer_count = {
            let relay = self.relay.read().await;
            relay.reviewer_thread_ids().len()
        };
        // A search asks each provider for a deep scan, because the row it is looking
        // for is almost always one that fell off the end of a normal page.
        //
        // An id probe scans the same way, and for a stronger reason: its caller is asking
        // whether specific sessions still exist, so a shallow scan would answer "gone" for
        // every session older than the page and be indistinguishable from the truth.
        let scan_limit = if query.is_some() || wanted_ids.is_some() {
            SEARCH_SCAN_LIMIT.max(limit)
        } else {
            limit
        };
        let fetch_limit = scan_limit.saturating_add(reviewer_count);

        let mut all_threads = Vec::new();
        // A provider that fails to list is dropped from the merge and the request still
        // succeeds — right for the resting list, but it must not be SILENT. For a search
        // the difference matters: an empty answer is otherwise read as "that session does
        // not exist" when it means "we could not look".
        let mut unavailable_providers = Vec::new();
        for (provider_name, bridge) in &self.providers {
            match bridge.list_threads(fetch_limit).await {
                Ok(mut threads) => {
                    for thread in &mut threads {
                        thread.provider = provider_name.clone();
                    }
                    all_threads.extend(threads);
                }
                Err(error) => {
                    unavailable_providers.push(provider_name.clone());
                    self.push_runtime_log(
                        "warn",
                        format!("Failed to list {provider_name} threads: {error}"),
                    )
                    .await;
                }
            }
        }
        // `self.providers` is a HashMap, so its iteration order is not stable.
        unavailable_providers.sort();
        let mut relay = self.relay.write().await;
        let allowed_roots = relay.allowed_roots.clone();
        let device_scope = device_id
            .as_deref()
            .map(|id| relay.device_path_scope(id))
            .unwrap_or_default();
        for thread in &mut all_threads {
            if thread.cwd.is_empty() {
                if let Some(cwd) = relay.thread_cwd(&thread.id) {
                    thread.cwd = cwd;
                }
            }
        }
        // Reviewer threads are owned by their review (surfaced through the
        // Reviewer panel), not peer sessions — keep them out of the thread list
        // ENTIRELY, even while the reviewer is briefly the active thread during
        // the review handoff. The user should never see a transient reviewer
        // "conversation" pop into navigation; the review's status and result live
        // only in the Reviewer tab (which fetches the reviewer transcript by id
        // directly when you click in).
        let reviewer_ids = relay.reviewer_thread_ids();
        let mut threads = relay
            .filter_deleted_threads(all_threads)
            .into_iter()
            .filter(|thread| path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots))
            .filter(|thread| !reviewer_ids.contains(&thread.id))
            .collect::<Vec<_>>();

        // Preserve the active thread even when no provider lists it yet. A
        // deferred-start Claude session lives under a synthetic `claude-pending-`
        // id until its first turn promotes it to a real SDK session, so the
        // bridge's `list_threads` can't return it. Without this, starting a blank
        // session (or any later thread-list refresh) would drop the conversation
        // the user is actively viewing — it would never appear in the sidebar.
        // ...but never re-add a reviewer thread: it must stay hidden from nav even
        // when it is the active thread mid-review.
        if let Some(active_id) = relay.active_thread_id.clone() {
            if !reviewer_ids.contains(&active_id)
                && !threads.iter().any(|thread| thread.id == active_id)
            {
                if let Some(active_thread) = relay
                    .threads
                    .iter()
                    .find(|thread| thread.id == active_id)
                    .filter(|thread| {
                        path_within_device_scope(&thread.cwd, &device_scope, &allowed_roots)
                    })
                    .cloned()
                {
                    threads.push(active_thread);
                }
            }
        }

        // Replace the provider's session-file mtime — which any resume/selection
        // bumps to ~now (a no-prompt click spins up a live SDK session that
        // rewrites the session file) — with our honest last-activity timestamp,
        // for both ordering AND the displayed "last message" time. Threads we've
        // never resumed aren't tracked and keep their (never-polluted) provider
        // value.
        for thread in &mut threads {
            thread.updated_at = relay.thread_last_activity_or(&thread.id, thread.updated_at);
            thread.forked_from = relay.thread_forked_from(&thread.id);
            // Overlay the user's chosen title over the provider's auto-derived one. This
            // is the list every surface renders tabs and sidebar rows from, and it is
            // rebuilt from the providers on each call — so the override has to be
            // re-applied here or a rename would last only until the next refresh.
            relay.apply_custom_thread_name(thread);
        }
        // AFTER the rename overlay, so a renamed session is findable under the title it
        // shows and not under the provider's superseded one. BEFORE `truncate`, which is
        // the entire point: filtering the page would only search rows already on screen.
        if let Some(needle) = &query {
            threads.retain(|thread| thread_display_title(thread).to_lowercase().contains(needle));
        }
        // Applied AFTER the active-thread re-add above, so a probe cannot be handed a row
        // it did not ask about.
        if let Some(wanted) = &wanted_ids {
            threads.retain(|thread| wanted.contains(&thread.id));
        }
        sort_threads_by_recency(&mut threads);
        // A probe is bounded by how many ids it asked about, never by the page size — the
        // caller's `limit` describes a sidebar, and truncating to it would drop answers it
        // explicitly requested, which reads as "deleted".
        threads.truncate(match &wanted_ids {
            Some(wanted) => wanted.len(),
            None => limit,
        });
        let response_threads = threads.clone();

        if query.is_some() || wanted_ids.is_some() {
            // A search is a NARROWED VIEW, not a new authoritative list: assigning it to
            // the routing cache would stop every non-matching thread routing while the
            // sidebar kept rendering it. Hints go in their own map instead — see
            // `RelayState::search_routing_hints` for why appending here is not enough.
            //
            // An id probe is narrower still, and unlike a search it is issued
            // automatically on every remote boot rather than by someone typing. Its worst
            // case is also worse: when every probed session really is gone the answer is
            // EMPTY, so the cache would be wiped to reviewer rows and nothing would be
            // routable at all. The hints are what keep the probed threads — old ones, by
            // construction — routable afterwards, which is exactly what they exist for.
            for thread in &response_threads {
                relay.remember_search_routing_hint(thread);
            }
            // Deliberately no `notify()`. A search is one client narrowing its own view;
            // waking every connected client per keystroke would be pure noise. A probe is
            // the same claim: it tells the asker something, not the room.
        } else {
            // The routing cache (relay.threads) must retain reviewer-thread rows even
            // though they are filtered from the nav-visible response. `find_thread_provider`
            // looks up threads by id in this cache, and a synthetic `claude-pending-…`
            // reviewer is only there (not yet in the provider's own thread list), so
            // losing its row would make it unroutable for `send_message_to_thread`.
            // We preserve any reviewer rows that were already cached here.
            let retained_reviewer_rows: Vec<_> = relay
                .threads
                .iter()
                .filter(|cached| reviewer_ids.contains(&cached.id))
                .cloned()
                .collect();
            let mut cached_threads = response_threads.clone();
            cached_threads.extend(retained_reviewer_rows);
            relay.threads = cached_threads;

            relay.notify();
        }
        Ok(ThreadsResponse {
            threads: response_threads,
            unavailable_providers,
        })
    }

    pub async fn update_allowed_roots(
        &self,
        input: AllowedRootsInput,
    ) -> Result<AllowedRootsReceipt, String> {
        let allowed_roots = normalize_allowed_roots(input.allowed_roots)?;
        let mut relay = self.relay.write().await;
        let changed = relay.set_allowed_roots(allowed_roots.clone());

        if changed {
            let current_cwd = relay.current_cwd.clone();
            relay.push_log(
                "info",
                if allowed_roots.is_empty() {
                    "Cleared relay workspace restrictions. Any workspace can be started or resumed."
                        .to_string()
                } else {
                    format!("Updated relay allowed roots: {}.", allowed_roots.join(", "))
                },
            );
            if relay.active_thread_id.is_some()
                && !path_within_allowed_roots(&current_cwd, &allowed_roots)
            {
                relay.push_log(
                    "warn",
                    format!(
                        "Current session workspace {} is outside the configured allowed roots. New sends, starts, and resumes will be blocked until you switch back to an allowed directory.",
                        current_cwd
                    ),
                );
            }
            relay.notify();
        }

        Ok(AllowedRootsReceipt {
            allowed_roots,
            message: if changed {
                "Relay workspace restrictions saved.".to_string()
            } else {
                "Relay workspace restrictions were already up to date.".to_string()
            },
        })
    }

    /// Set or clear a session's user-chosen title.
    ///
    /// Pure relay-owned metadata — deliberately NOT routed to a provider. Neither
    /// bridge exposes a "set title" call we could trust to stick (Claude re-derives its
    /// summary as the conversation grows; Codex titles server-side), which is exactly
    /// why the title drifts today. Keeping the override on our side is what makes a
    /// rename permanent.
    ///
    /// Consequences of being metadata, all intentional and mirroring `project_action`:
    ///   * no session slot / control claim is taken — renaming a tab must not fight the
    ///     agent for the relay-wide lease, and must work while a turn is running;
    ///   * an id that is not currently loaded into the thread list is still renamable;
    ///   * a reviewer thread is not, because it is hidden from navigation entirely.
    pub async fn rename_thread(
        &self,
        thread_id: &str,
        input: RenameThreadInput,
    ) -> Result<ThreadRenameReceipt, String> {
        if thread_id.len() > MAX_THREAD_ID_BYTES {
            return Err(format!(
                "thread id must be at most {MAX_THREAD_ID_BYTES} bytes"
            ));
        }
        let actor = input.device_id.as_deref().unwrap_or("local operator");
        // Absent, null, empty and whitespace-only all mean the same thing: drop the
        // override and go back to the provider's own title.
        let name = match input.name.map(|name| name.trim().to_string()) {
            Some(name) if !name.is_empty() => {
                if name.chars().count() > MAX_THREAD_NAME_CHARS {
                    return Err(format!(
                        "session name must be at most {MAX_THREAD_NAME_CHARS} characters"
                    ));
                }
                Some(name)
            }
            _ => None,
        };

        let mut relay = self.relay.write().await;
        // A client can legitimately still be holding a `claude-pending-…` id: promotion
        // to the real SDK id happens on the first send, and clients only learn about it
        // from the next snapshot. Keying the write off the id as sent would land it on a
        // dead key — invisible to every reader, and orphaned forever in a PERSISTED map,
        // since no cleanup path ever sees a pending id again. Resolve first, then act.
        let thread_id = &relay.resolve_promoted_thread_id(thread_id);
        if relay.reviewer_thread_ids().contains(thread_id) {
            return Err(format!(
                "`{thread_id}` is a reviewer thread and cannot be renamed"
            ));
        }
        // A permanently deleted session must not be renamable. Deletion clears the
        // override (`mark_thread_deleted`), but the tombstone outlives the row, so a
        // stale client acting on a thread it still lists would RE-CREATE the entry —
        // one nothing will ever clean up again, occupying a slot under the persisted
        // cap and waiting to be inherited by a reused id after a restart.
        if relay.thread_is_locally_deleted(thread_id) {
            return Err(format!("session `{thread_id}` was deleted"));
        }
        // The thread must be one the relay can actually PLACE. An id it cannot resolve to
        // a workspace is an id it cannot prove is in scope — and because this map is
        // persisted, accepting arbitrary ids would let a caller mint durable rows for
        // sessions that do not exist: orphans no cleanup path can ever reach, each
        // occupying a slot under `MAX_CUSTOM_THREAD_NAMES`.
        //
        // It also closes the archived-session hole. Archive drops the runtime and the
        // cached row (`remove_thread`), so after it there is no cwd to resolve and a
        // stale client can no longer resurrect the override that archive just cleared.
        let Some(cwd) = relay.thread_cwd(thread_id) else {
            return Err(format!(
                "session `{thread_id}` is not available on this relay"
            ));
        };
        // Scope the write exactly as `list_threads` scopes the READ — same predicate,
        // same arguments — so a caller can only rename what it can see. A title is
        // per-SESSION metadata and sessions are scope-filtered; a device that cannot see
        // a session must not be able to relabel it for everyone else.
        //
        // The scope is passed THROUGH rather than short-circuited on when empty. An empty
        // device scope does not mean "anywhere": `path_within_device_scope` reads it as
        // "the relay's own `allowed_roots`", which is the boundary an unscoped paired
        // device still has to respect. The local operator (`device_id: None`) takes the
        // same path with an empty scope, so it too is held to `allowed_roots` — again
        // matching what its own session list already shows it.
        //
        // This is deliberately STRICTER than `project_action`'s membership writes, which
        // accept any thread id. Project membership is a global grouping; a session's
        // title is the session's own.
        let scope = input
            .device_id
            .as_deref()
            .map(|device_id| relay.device_path_scope(device_id))
            .unwrap_or_default();
        let allowed_roots = relay.allowed_roots.clone();
        if !path_within_device_scope(&cwd, &scope, &allowed_roots) {
            return Err(format!(
                "session `{thread_id}` is outside this device's allowed paths"
            ));
        }
        // Bound the persisted map: refuse a NEW override once it is full. Clearing, and
        // re-renaming an already-renamed session, both stay possible — neither grows it.
        if name.is_some()
            && relay.thread_custom_name(thread_id).is_none()
            && relay.custom_thread_name_count() >= MAX_CUSTOM_THREAD_NAMES
        {
            return Err(format!(
                "renamed-session limit reached ({MAX_CUSTOM_THREAD_NAMES})"
            ));
        }

        let changed = relay.set_thread_custom_name(thread_id, name.clone());
        let message = match &name {
            Some(name) => format!("Renamed session to \"{name}\"."),
            None => "Session name reset to the agent's own title.".to_string(),
        };
        if changed {
            relay.push_log(
                "info",
                match &name {
                    Some(name) => format!("Renamed session {thread_id} to \"{name}\" [{actor}]"),
                    None => format!("Reset session {thread_id} to its agent title [{actor}]"),
                },
            );
            // Wakes the SSE/snapshot path (carrying the bumped `threads_revision`) AND
            // schedules the debounced state save, so the rename reaches other devices
            // and survives a restart. A no-op rename skips both on purpose.
            relay.notify();
        }
        Ok(ThreadRenameReceipt {
            thread_id: thread_id.to_string(),
            name,
            message,
        })
    }

    /// Archive a thread (soft remove from local history). If the thread is the
    /// PARENT of reviewer thread(s), `delete_reviewers` decides their fate:
    /// `Some(true)` → permanently delete them (reviewer threads have no "archived"
    /// state of their own); `Some(false)`/`None` → keep them as normal, un-hidden
    /// threads. Archive is a soft, non-destructive operation, so a bodyless request
    /// (no explicit choice) DEFAULTS TO KEEP — only an explicit `true` permanently
    /// deletes. Either way the reviewer is never left stranded (hidden, no UI entry).
    /// The frontend always sends an explicit choice when reviewers are present, so
    /// this default only governs non-UI/bodyless callers. (Permanent delete, by
    /// contrast, defaults to cascade-delete — see `delete_thread_permanently`.)
    pub async fn archive_thread(
        &self,
        thread_id: &str,
        delete_reviewers: Option<bool>,
    ) -> Result<ThreadArchiveReceipt, String> {
        let _slot = self.acquire_session_slot()?;
        {
            // Don't let a user archive a thread that a running review owns (its
            // parent or reviewer). Terminal-review cleanup (delete) is unaffected
            // because the job is terminal by then, so the thread is not locked.
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
        }
        let reviewer_threads = {
            let relay = self.relay.read().await;
            relay.reviewer_threads_of_parent(thread_id)
        };
        let archived_active_thread = {
            let relay = self.relay.read().await;
            relay.can_archive_thread(thread_id)?
        };

        self.find_thread_provider(thread_id)
            .await?
            .1
            .archive_thread(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            let removed = relay.remove_thread(thread_id);
            // The thread is gone — stop hiding it as a reviewer thread (no-op if it
            // wasn't one).
            relay.forget_reviewer_thread(thread_id);
            if archived_active_thread {
                relay.clear_active_session();
            }
            relay.push_log(
                "info",
                if archived_active_thread {
                    format!("Archived active thread {thread_id} from local history and cleared the current session.")
                } else {
                    format!("Archived thread {thread_id} from local history.")
                },
            );
            if removed {
                relay.notify();
            }
        }

        let mut message = "Session archived and removed from local history.".to_string();
        if !reviewer_threads.is_empty() {
            // Non-destructive default: keep (un-hide) reviewers unless told to delete.
            let delete = delete_reviewers.unwrap_or(false);
            let kept = self
                .handle_parent_reviewer_threads(reviewer_threads, delete)
                .await;
            if kept > 0 {
                message.push_str(&format!(
                    " ({kept} reviewer thread{} could not be deleted and {} kept as normal threads)",
                    if kept == 1 { "" } else { "s" },
                    if kept == 1 { "was" } else { "were" },
                ));
            }
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadArchiveReceipt {
            thread_id: thread_id.to_string(),
            message,
        })
    }

    /// Permanently delete a thread. If the thread is the PARENT of one or more
    /// (hidden) reviewer threads, `delete_reviewers` controls what happens to them:
    ///   - `Some(true)` / `None` (default): also delete each reviewer thread.
    ///   - `Some(false)`: keep them on disk but un-hide them — they become normal,
    ///     navigable threads.
    /// Either way, any in-memory review job that referenced a handled reviewer
    /// thread is dropped so the Reviewer panel can't show a card pointing at a
    /// deleted/promoted thread.
    pub async fn delete_thread_permanently(
        &self,
        thread_id: &str,
        delete_reviewers: Option<bool>,
    ) -> Result<ThreadDeleteReceipt, String> {
        let _slot = self.acquire_session_slot()?;
        {
            // Don't let a user delete a thread a running review owns. Terminal-
            // review cleanup (delete) is unaffected (job is terminal → not locked).
            let relay = self.relay.read().await;
            if relay.is_thread_review_locked(thread_id) {
                return Err(REVIEW_LOCKED_THREAD_MSG.to_string());
            }
            if relay.is_thread_or_cwd_workflow_locked(thread_id) {
                return Err(WORKFLOW_LOCKED_THREAD_MSG.to_string());
            }
        }
        let reviewer_threads = {
            let relay = self.relay.read().await;
            relay.reviewer_threads_of_parent(thread_id)
        };

        // Delete the parent thread itself (no slot re-acquisition — we hold it).
        let mut receipt = self.delete_thread_inner(thread_id).await?;

        // Handle the parent's reviewer threads (delete or keep-as-normal).
        if !reviewer_threads.is_empty() {
            let delete = delete_reviewers.unwrap_or(true);
            let kept = self
                .handle_parent_reviewer_threads(reviewer_threads, delete)
                .await;
            let _ = self.list_threads(20, None).await;
            if kept > 0 {
                receipt.message.push_str(&format!(
                    " ({kept} reviewer thread{} could not be deleted and {} kept as normal threads)",
                    if kept == 1 { "" } else { "s" },
                    if kept == 1 { "was" } else { "were" },
                ));
            }
        }

        Ok(receipt)
    }

    /// Handle the reviewer threads owned by a parent that is being deleted or
    /// archived. `delete = true` permanently deletes each; `false` keeps them as
    /// normal (un-hidden) threads. A reviewer that CAN'T be deleted is un-hidden
    /// anyway, so it can never become a stranded, hidden, entryless thread — it
    /// becomes a normal thread the user can retry. Drops each handled reviewer's
    /// in-memory review job. Returns the number that could not be deleted (partial
    /// failure, only when `delete` is true).
    pub(super) async fn handle_parent_reviewer_threads(
        &self,
        reviewer_ids: Vec<String>,
        delete: bool,
    ) -> usize {
        let mut failed = 0usize;
        for reviewer_id in reviewer_ids {
            if delete {
                if let Err(error) = self.delete_thread_inner(&reviewer_id).await {
                    // Could not delete it — un-hide it rather than strand it.
                    self.push_runtime_log(
                        "warn",
                        format!(
                            "Could not delete reviewer thread {reviewer_id}: {error}; kept it as a \
normal thread instead."
                        ),
                    )
                    .await;
                    let mut relay = self.relay.write().await;
                    relay.forget_reviewer_thread(&reviewer_id);
                    relay.notify();
                    failed += 1;
                }
            } else {
                // Keep it, but stop hiding it: it becomes a normal, navigable thread.
                let mut relay = self.relay.write().await;
                relay.forget_reviewer_thread(&reviewer_id);
                relay.notify();
            }
            // Drop any stale in-memory review job referencing this reviewer.
            let mut relay = self.relay.write().await;
            relay.drop_review_jobs_for_reviewer(&reviewer_id);
            relay.drop_workflow_runs_for_reviewer(&reviewer_id);
            relay.notify();
        }
        failed
    }

    /// Core single-thread permanent delete (no session slot, no review-lock check,
    /// no reviewer-thread fan-out). Shared by `delete_thread_permanently` so it can
    /// delete the parent and each reviewer thread under one held slot.
    async fn delete_thread_inner(&self, thread_id: &str) -> Result<ThreadDeleteReceipt, String> {
        let deleted_active_thread = {
            let relay = self.relay.read().await;
            relay.can_delete_thread(thread_id)?
        };

        let delete_summary = self
            .find_thread_provider(thread_id)
            .await?
            .1
            .delete_thread_permanently(thread_id)
            .await?;

        {
            let mut relay = self.relay.write().await;
            if deleted_active_thread {
                relay.clear_active_session();
            }
            relay.mark_thread_deleted(thread_id);
            // The thread is gone — stop hiding it as a reviewer thread.
            relay.forget_reviewer_thread(thread_id);
            relay.push_log(
                "info",
                format!(
                    "{} local thread {thread_id} from provider storage ({} rollout file{} removed, provider row removed: {}).",
                    if deleted_active_thread {
                        "Permanently deleted active"
                    } else {
                        "Permanently deleted"
                    },
                    delete_summary.deleted_paths.len(),
                    if delete_summary.deleted_paths.len() == 1 { "" } else { "s" },
                    delete_summary.deleted_thread_row
                ),
            );
            relay.notify();
        }

        let _ = self.list_threads(20, None).await;

        Ok(ThreadDeleteReceipt {
            thread_id: thread_id.to_string(),
            message: if deleted_active_thread {
                "Active session permanently deleted from local provider storage.".to_string()
            } else {
                "Session permanently deleted from local provider storage.".to_string()
            },
        })
    }
}
