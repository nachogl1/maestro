//! The user's privacy answers (issue #684): whether the Workshop and the
//! History summaries may send conversation text to Claude. Both start off and
//! stay off until the frontend passes on the user's answer, so a frontend bug
//! can never make either feature send text on its own.
//!
//! The usage bar's switch (issue #709) is the other way round: its request
//! sends only the Claude login, no conversation text, so it starts on and stays
//! on until the frontend passes on that the user switched it off.

use std::sync::atomic::{AtomicBool, Ordering};

/// One on/off answer per feature that sends conversation text to Claude.
pub struct PrivacyConsent {
    workshop: AtomicBool,
    history_summaries: AtomicBool,
    usage_bar: AtomicBool,
}

impl PrivacyConsent {
    /// Both features off: nothing is sent until the user says yes. The usage
    /// bar on: it asks for usage until the user switches it off.
    pub const fn new() -> Self {
        Self {
            workshop: AtomicBool::new(false),
            history_summaries: AtomicBool::new(false),
            usage_bar: AtomicBool::new(true),
        }
    }

    /// Records the user's current answers.
    pub fn set(&self, workshop: bool, history_summaries: bool) {
        self.workshop.store(workshop, Ordering::Relaxed);
        self.history_summaries
            .store(history_summaries, Ordering::Relaxed);
    }

    /// True while the user lets the Workshop run.
    pub fn workshop(&self) -> bool {
        self.workshop.load(Ordering::Relaxed)
    }

    /// True while the user lets History write summaries.
    pub fn history_summaries(&self) -> bool {
        self.history_summaries.load(Ordering::Relaxed)
    }

    /// Records whether the usage bar may ask Anthropic for the account's usage.
    pub fn set_usage_bar(&self, on: bool) {
        self.usage_bar.store(on, Ordering::Relaxed);
    }

    /// True while the usage bar may ask Anthropic for the account's usage.
    pub fn usage_bar(&self) -> bool {
        self.usage_bar.load(Ordering::Relaxed)
    }
}

impl Default for PrivacyConsent {
    fn default() -> Self {
        Self::new()
    }
}

/// The app's answers, set by the `set_privacy_consent` and
/// `set_usage_bar_allowed` commands. Tests never switch the two text features
/// on: the commands they gate would then reach the real CLI.
pub static CONSENT: PrivacyConsent = PrivacyConsent::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_both_features_off() {
        let consent = PrivacyConsent::new();
        assert!(!consent.workshop());
        assert!(!consent.history_summaries());
        assert!(!CONSENT.workshop());
        assert!(!CONSENT.history_summaries());
    }

    #[test]
    fn starts_with_the_usage_bar_on() {
        assert!(PrivacyConsent::new().usage_bar());
        assert!(CONSENT.usage_bar());
    }

    #[test]
    fn keeps_each_answer_apart() {
        let consent = PrivacyConsent::new();
        consent.set(true, false);
        assert!(consent.workshop());
        assert!(!consent.history_summaries());
        consent.set(false, true);
        assert!(!consent.workshop());
        assert!(consent.history_summaries());
        consent.set_usage_bar(false);
        assert!(!consent.usage_bar());
        assert!(!consent.workshop());
        assert!(consent.history_summaries());
    }
}
