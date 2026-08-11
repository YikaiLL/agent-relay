//! Placeholder for the proprietary crate.
//!
//! Building with `--features private` against THIS crate fails on purpose: the
//! feature promises logic that a public checkout does not have, and a stub that
//! silently satisfied it would ship a relay whose task teams quietly do nothing.
//! Without the feature — the default — this file is never compiled.
