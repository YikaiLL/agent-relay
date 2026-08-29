//! Configurable-team catalog (mockup 13a).
//!
//! Lives in the same SQLite file as the token ledger. The live `TeamRun` cursor
//! stays in `session.json`; this module is the durable definition a run pins
//! and the Teams screen lists.

mod catalog;

pub(crate) use catalog::{
    build_catalog, TeamCatalogReport, TeamCatalogRole, TeamCatalogStats, TeamCatalogTeam,
};
