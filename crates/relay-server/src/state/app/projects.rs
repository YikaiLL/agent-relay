use super::*;

impl AppState {
    /// Manual Projects write path: create / rename / delete a Project, or assign /
    /// unassign a session. Returns the full post-action project list + membership so
    /// the calling client updates immediately, and `notify()`s so passive clients
    /// re-sync. Projects are global (not device-scoped); `device_id` is actor-only.
    pub async fn project_action(
        &self,
        input: ProjectActionInput,
    ) -> Result<ProjectActionReceipt, String> {
        let actor = input
            .device_id
            .as_deref()
            .unwrap_or("local operator")
            .to_string();
        let mut relay = self.relay.write().await;
        let message = match input.action {
            ProjectAction::Create { name } => {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return Err("project name must not be empty".to_string());
                }
                let project = relay.create_project(new_project_id(), name.clone());
                relay.push_log(
                    "info",
                    format!("Created project \"{name}\" ({}) [{actor}]", project.id),
                );
                format!("Created project \"{name}\".")
            }
            ProjectAction::Rename { project_id, name } => {
                let name = name.trim().to_string();
                if name.is_empty() {
                    return Err("project name must not be empty".to_string());
                }
                relay.rename_project(&project_id, name.clone())?;
                relay.push_log(
                    "info",
                    format!("Renamed project {project_id} to \"{name}\" [{actor}]"),
                );
                format!("Renamed project to \"{name}\".")
            }
            ProjectAction::Delete { project_id } => {
                relay.delete_project(&project_id)?;
                relay.push_log("info", format!("Deleted project {project_id} [{actor}]"));
                "Project deleted.".to_string()
            }
            ProjectAction::Assign {
                thread_id,
                project_id,
            } => {
                relay.assign_thread_to_project(&thread_id, &project_id)?;
                relay.push_log(
                    "info",
                    format!("Assigned session {thread_id} to project {project_id} [{actor}]"),
                );
                "Session assigned to project.".to_string()
            }
            ProjectAction::Unassign { thread_id } => {
                relay.unassign_thread_from_project(&thread_id);
                relay.push_log("info", format!("Unassigned session {thread_id} [{actor}]"));
                "Session moved to Unassigned.".to_string()
            }
        };
        let receipt = ProjectActionReceipt {
            projects: relay.projects_view(),
            thread_project_id: relay.thread_project_id.clone(),
            message,
        };
        relay.notify();
        Ok(receipt)
    }
}

/// Random, stable-shaped project id. (The seed migration was dropped, so ids are
/// never derived from cwd — every Project is user-created with a fresh id.)
fn new_project_id() -> String {
    format!("proj_{:016x}", rand::random::<u64>())
}
