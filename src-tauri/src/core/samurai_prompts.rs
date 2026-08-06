//! Samurai instruction text builders (Phase 2, issue #53; PRD §5.3).
//!
//! Injected instructions travel through `ProcessManager::write_stdin`
//! straight into a live terminal, so every builder returns ONE paste-able
//! line — no embedded newlines, which the terminal would treat as an early
//! submit. The injector appends the final `\r` itself.
//!
//! This issue ships the minimal handoff instruction: state that Maestro is
//! requesting a handoff and require an immediate, recognizable ACK. P2.3
//! (issue #54) extends it with the actual handoff-file writing brief.

/// The exact acknowledgement value generation `generation` must echo inside
/// `<samurai-ack>…</samurai-ack>`. The injector's ACK scanner expects this
/// same string — built here so instruction and scanner can never drift.
pub fn handoff_ack_value(generation: u32) -> String {
    format!("handoff gen-{generation}")
}

/// Minimal idle-injected handoff instruction (PRD §5.3): Maestro is
/// requesting a handoff, and the orchestrator must reply immediately with
/// the recognizable ACK marker. Single line by construction (see module doc).
pub fn handoff_instruction(generation: u32) -> String {
    format!(
        "[Maestro Samurai] Handoff requested: this session crossed the configured context \
         threshold and will be handed off to a successor. Acknowledge IMMEDIATELY by replying \
         with a message that contains exactly <samurai-ack>{}</samurai-ack> — then finish only \
         your current atomic step and wait for handoff instructions; do not start new work.",
        handoff_ack_value(generation)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_instruction_is_a_single_pasteable_line() {
        // write_stdin types this into a terminal: any embedded newline would
        // submit a partial instruction. The trailing \r is the injector's job.
        let text = handoff_instruction(3);
        assert!(!text.contains('\n'), "instruction must not contain \\n");
        assert!(!text.contains('\r'), "instruction must not contain \\r");
        assert!(!text.is_empty());
    }

    #[test]
    fn test_instruction_carries_the_exact_ack_marker() {
        let text = handoff_instruction(7);
        assert!(text.contains("<samurai-ack>handoff gen-7</samurai-ack>"));
        // And it says what is happening: this is a handoff request.
        assert!(text.to_lowercase().contains("handoff requested"));
    }

    #[test]
    fn test_ack_value_encodes_the_generation() {
        assert_eq!(handoff_ack_value(1), "handoff gen-1");
        assert_eq!(handoff_ack_value(42), "handoff gen-42");
    }
}
