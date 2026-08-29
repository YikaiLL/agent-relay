//! The daily token budget: a cap, a policy, and the decision they make together.
//!
//! Deliberately pure. The decision takes the numbers as arguments and returns a
//! verdict — no store, no lock, no clock — so every branch below is reachable
//! from a unit test, and the caller in the turn path can hold its own locks for
//! as short a time as it likes.
//!
//! What this is NOT: an interrupt. Nothing here stops a turn that is already
//! running, because the relay has no primitive for that (only the specialised
//! stranded-run paths in `state/app/{review,team,workflow}.rs`, which recover a
//! run rather than cancel one). Both policies gate the START of a turn, and the
//! copy on the screen says so.

use serde::{Deserialize, Serialize};

/// What happens once the day's cap is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BudgetPolicy {
    /// Hold autonomous work — team runs and reviewer jobs — and let a person
    /// keep typing.
    ///
    /// The asymmetry is the point. The person watching the number is the one who has
    /// to decide what to do about it, and a relay that locked them out of their
    /// own transcript at exactly that moment would be answering "you are
    /// spending too much" with "so you may not look". Autonomous work has no
    /// such claim: it spends without anyone watching, which is what a cap is
    /// for.
    #[default]
    HoldNewWork,
    /// Refuse every new turn, a person's included.
    ///
    /// For a relay whose budget is hard — a shared key, a prepaid balance —
    /// where continuing to spend is worse than being unable to work.
    StopEverything,
}

impl BudgetPolicy {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::HoldNewWork => "hold_new_work",
            Self::StopEverything => "stop_everything",
        }
    }

    /// Parse a wire value. Unknown strings fall back to the softer policy
    /// rather than erroring: this is read from a persisted state file that a
    /// future version may have written, and refusing every turn on a string we
    /// do not recognise would turn a forward-compatibility gap into an outage.
    pub(crate) fn parse(value: &str) -> Self {
        match value {
            "stop_everything" => Self::StopEverything,
            _ => Self::HoldNewWork,
        }
    }
}

/// The relay-wide budget, as persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct BudgetSettings {
    /// Tokens per local day. `None` — and, defensively, `Some(0)` — mean no cap.
    pub(crate) daily_cap: Option<u64>,
    pub(crate) policy: BudgetPolicy,
}

impl BudgetSettings {
    pub(crate) fn cap(&self) -> Option<u64> {
        self.daily_cap.filter(|value| *value > 0)
    }
}

/// Who is asking to start a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnOrigin {
    /// Someone typed it.
    Person,
    /// A team run, a reviewer job — work that proceeds without anyone watching.
    Autonomous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BudgetVerdict {
    Allow,
    /// Refuse, with the sentence to put in front of the user. The reason is
    /// built here rather than at the call site so that every refusal — typed,
    /// team-driven, reviewer-driven — says the same thing.
    Refuse(String),
}

impl BudgetVerdict {
    pub(crate) fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// May a turn start?
///
/// `spent_today` is the local day's total from the ledger. The comparison is
/// `>=`, not `>`: reaching the cap is the event, and a cap of exactly the
/// amount spent has already been reached.
///
/// A relay with no cap set, or a cap of zero, allows everything — "no budget"
/// must not read as "a budget of nothing", which would refuse the first turn on
/// a fresh install.
pub(crate) fn decide(
    settings: &BudgetSettings,
    spent_today: u64,
    origin: TurnOrigin,
) -> BudgetVerdict {
    let Some(cap) = settings.cap() else {
        return BudgetVerdict::Allow;
    };
    if spent_today < cap {
        return BudgetVerdict::Allow;
    }
    match (settings.policy, origin) {
        (BudgetPolicy::HoldNewWork, TurnOrigin::Person) => BudgetVerdict::Allow,
        (BudgetPolicy::HoldNewWork, TurnOrigin::Autonomous) => BudgetVerdict::Refuse(format!(
            "The daily token budget is used up ({} of {}). New autonomous work is on hold \
             until tomorrow; you can still send messages yourself. Raise the cap in Usage \
             to start work now.",
            compact(spent_today),
            compact(cap)
        )),
        (BudgetPolicy::StopEverything, _) => BudgetVerdict::Refuse(format!(
            "The daily token budget is used up ({} of {}), and this relay is set to stop \
             everything when it runs out. Turns already running will finish. Raise the cap \
             in Usage to send again.",
            compact(spent_today),
            compact(cap)
        )),
    }
}

/// Token counts as they appear in the refusal sentence.
///
/// Mirrors the frontend's `formatTokens` rather than printing the raw integer:
/// a refusal that says "5000000" makes the reader do the arithmetic to connect
/// it to the "5M" on the screen they were just looking at.
fn compact(value: u64) -> String {
    if value >= 1_000_000 {
        let millions = value as f64 / 1_000_000.0;
        if millions >= 100.0 {
            return format!("{}M", millions.round() as u64);
        }
        return format!("{}M", trim_zero(format!("{millions:.1}")));
    }
    if value >= 1_000 {
        let thousands = value as f64 / 1_000.0;
        if thousands >= 100.0 {
            return format!("{}k", thousands.round() as u64);
        }
        return format!("{}k", trim_zero(format!("{thousands:.1}")));
    }
    value.to_string()
}

fn trim_zero(text: String) -> String {
    match text.strip_suffix(".0") {
        Some(trimmed) => trimmed.to_string(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(cap: Option<u64>, policy: BudgetPolicy) -> BudgetSettings {
        BudgetSettings {
            daily_cap: cap,
            policy,
        }
    }

    /// The fresh-install case. No cap must not behave like a cap of nothing.
    #[test]
    fn no_cap_allows_everything() {
        let none = settings(None, BudgetPolicy::StopEverything);
        assert!(decide(&none, u64::MAX, TurnOrigin::Autonomous).is_allowed());
        // A stored 0 is the same statement as absent, and arrives from a UI that
        // cleared the field.
        let zero = settings(Some(0), BudgetPolicy::StopEverything);
        assert!(decide(&zero, 1, TurnOrigin::Person).is_allowed());
    }

    #[test]
    fn under_the_cap_allows_everything() {
        let s = settings(Some(5_000_000), BudgetPolicy::StopEverything);
        assert!(decide(&s, 4_999_999, TurnOrigin::Autonomous).is_allowed());
    }

    /// Reaching the cap is the event, not exceeding it.
    #[test]
    fn the_cap_is_reached_at_equality() {
        let s = settings(Some(5_000_000), BudgetPolicy::StopEverything);
        assert!(!decide(&s, 5_000_000, TurnOrigin::Person).is_allowed());
    }

    /// The asymmetry that separates the two policies.
    #[test]
    fn holding_new_work_still_lets_a_person_type() {
        let s = settings(Some(1_000), BudgetPolicy::HoldNewWork);
        assert!(decide(&s, 5_000, TurnOrigin::Person).is_allowed());
        assert!(!decide(&s, 5_000, TurnOrigin::Autonomous).is_allowed());
    }

    #[test]
    fn stopping_everything_refuses_a_person_too() {
        let s = settings(Some(1_000), BudgetPolicy::StopEverything);
        assert!(!decide(&s, 5_000, TurnOrigin::Person).is_allowed());
        assert!(!decide(&s, 5_000, TurnOrigin::Autonomous).is_allowed());
    }

    /// The refusal has to be readable on its own — it is the only thing the
    /// user sees — and has to carry the numbers in the same units as the screen.
    #[test]
    fn the_refusal_names_the_numbers_the_screen_shows() {
        let s = settings(Some(5_000_000), BudgetPolicy::StopEverything);
        let BudgetVerdict::Refuse(reason) = decide(&s, 5_200_000, TurnOrigin::Person) else {
            panic!("expected a refusal");
        };
        assert!(reason.contains("5.2M"), "got: {reason}");
        assert!(reason.contains("5M"), "got: {reason}");
        // and it must say what to do next
        assert!(reason.contains("Raise the cap"), "got: {reason}");
    }

    #[test]
    fn a_held_autonomous_turn_says_a_person_can_still_send() {
        let s = settings(Some(1_000), BudgetPolicy::HoldNewWork);
        let BudgetVerdict::Refuse(reason) = decide(&s, 2_000, TurnOrigin::Autonomous) else {
            panic!("expected a refusal");
        };
        assert!(
            reason.contains("you can still send messages"),
            "got: {reason}"
        );
    }

    /// Forward compatibility: a policy string this build does not know must not
    /// become "refuse everything".
    #[test]
    fn an_unknown_policy_falls_back_to_the_softer_one() {
        assert_eq!(
            BudgetPolicy::parse("stop_everything"),
            BudgetPolicy::StopEverything
        );
        assert_eq!(
            BudgetPolicy::parse("hold_new_work"),
            BudgetPolicy::HoldNewWork
        );
        assert_eq!(
            BudgetPolicy::parse("pause_and_email_finance"),
            BudgetPolicy::HoldNewWork
        );
        assert_eq!(BudgetPolicy::parse(""), BudgetPolicy::HoldNewWork);
    }

    #[test]
    fn compact_matches_the_screens_units() {
        assert_eq!(compact(999), "999");
        assert_eq!(compact(1_000), "1k");
        assert_eq!(compact(41_900), "41.9k");
        assert_eq!(compact(586_000), "586k");
        assert_eq!(compact(1_000_000), "1M");
        assert_eq!(compact(2_900_000), "2.9M");
        assert_eq!(compact(128_000_000), "128M");
    }
}
