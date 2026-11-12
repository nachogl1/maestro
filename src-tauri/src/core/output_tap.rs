//! Per-session PTY output tap: a bounded scrollback buffer plus ordered
//! subscribers.
//!
//! The PTY emitter broadcasts every batch as a `pty-output-{id}` event. A
//! terminal view that mounts after the session started (a project tab moved
//! into a pop-out window, or docked back into the main window) would see a
//! blank screen, because the event carries no history. Such a view attaches
//! here instead: it is sent the retained scrollback, then every later batch,
//! in order. Snapshot and registration happen under the same lock as
//! [`OutputTap::record`], so no batch is lost or duplicated across the switch.

use std::sync::Mutex;

/// Bytes of output retained per session for replay.
pub const SCROLLBACK_CAP: usize = 256 * 1024;

/// A subscriber callback. Returns `false` once the receiver is gone, which
/// drops the subscription.
pub type OutputSink = Box<dyn Fn(&str) -> bool + Send>;

#[derive(Default)]
struct TapState {
    scrollback: String,
    subscribers: Vec<(u64, OutputSink)>,
    next_subscriber_id: u64,
}

/// Retained output and live subscribers for one PTY session.
#[derive(Default)]
pub struct OutputTap {
    state: Mutex<TapState>,
}

impl OutputTap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends a batch to the scrollback and forwards it to every subscriber.
    pub fn record(&self, data: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.scrollback.push_str(data);
        // Trim only once the buffer doubles, so the front-drain memmove is
        // amortized over many small batches instead of paid on each one.
        if state.scrollback.len() > SCROLLBACK_CAP * 2 {
            let start = trim_start(&state.scrollback, SCROLLBACK_CAP);
            state.scrollback.drain(..start);
        }
        state.subscribers.retain(|(_, sink)| sink(data));
    }

    /// Sends the retained scrollback to `sink`, then registers it for every
    /// later batch. Returns the subscription id for [`Self::detach`].
    pub fn attach(&self, sink: OutputSink) -> Option<u64> {
        let mut state = self.state.lock().ok()?;
        if !state.scrollback.is_empty() && !sink(&state.scrollback) {
            return None;
        }
        let id = state.next_subscriber_id;
        state.next_subscriber_id += 1;
        state.subscribers.push((id, sink));
        Some(id)
    }

    /// Removes a subscription. Unknown ids are ignored.
    pub fn detach(&self, subscriber_id: u64) {
        if let Ok(mut state) = self.state.lock() {
            state.subscribers.retain(|(id, _)| *id != subscriber_id);
        }
    }

    #[cfg(test)]
    fn scrollback_len(&self) -> usize {
        self.state.lock().unwrap().scrollback.len()
    }
}

/// Byte index to drain up to so that roughly `keep` bytes remain. Lands on a
/// char boundary, and on the start of a line when one is near, so replay does
/// not begin halfway through an escape sequence.
fn trim_start(buf: &str, keep: usize) -> usize {
    let mut start = buf.len().saturating_sub(keep);
    while !buf.is_char_boundary(start) {
        start += 1;
    }
    const LINE_SEARCH: usize = 4096;
    let window_end = (start + LINE_SEARCH).min(buf.len());
    if let Some(pos) = buf.as_bytes()[start..window_end]
        .iter()
        .position(|&b| b == b'\n')
    {
        start += pos + 1;
    }
    start
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn collecting_sink() -> (OutputSink, Arc<Mutex<String>>) {
        let out = Arc::new(Mutex::new(String::new()));
        let out_clone = out.clone();
        let sink: OutputSink = Box::new(move |data| {
            out_clone.lock().unwrap().push_str(data);
            true
        });
        (sink, out)
    }

    #[test]
    fn attach_replays_scrollback_then_streams_live_output() {
        let tap = OutputTap::new();
        tap.record("before\r\n");
        let (sink, out) = collecting_sink();
        tap.attach(sink).unwrap();
        tap.record("after\r\n");
        assert_eq!(*out.lock().unwrap(), "before\r\nafter\r\n");
    }

    #[test]
    fn attach_on_empty_tap_sends_nothing_until_output() {
        let tap = OutputTap::new();
        let calls = Arc::new(Mutex::new(0));
        let calls_clone = calls.clone();
        tap.attach(Box::new(move |_| {
            *calls_clone.lock().unwrap() += 1;
            true
        }))
        .unwrap();
        assert_eq!(*calls.lock().unwrap(), 0);
        tap.record("x");
        assert_eq!(*calls.lock().unwrap(), 1);
    }

    #[test]
    fn detach_stops_delivery() {
        let tap = OutputTap::new();
        let (sink, out) = collecting_sink();
        let id = tap.attach(sink).unwrap();
        tap.record("a");
        tap.detach(id);
        tap.record("b");
        assert_eq!(*out.lock().unwrap(), "a");
    }

    #[test]
    fn dead_sink_is_dropped() {
        let tap = OutputTap::new();
        tap.attach(Box::new(|_| false)).unwrap();
        tap.record("a");
        assert!(tap.state.lock().unwrap().subscribers.is_empty());
    }

    #[test]
    fn scrollback_stays_bounded() {
        let tap = OutputTap::new();
        let line = format!("{}\n", "x".repeat(1023));
        for _ in 0..2000 {
            tap.record(&line);
        }
        assert!(tap.scrollback_len() <= SCROLLBACK_CAP * 2);
        assert!(tap.scrollback_len() >= SCROLLBACK_CAP - 4096);
    }

    #[test]
    fn trim_start_lands_on_line_and_char_boundary() {
        let buf = format!("{}é\nkeep", "a".repeat(10));
        let start = trim_start(&buf, 6);
        assert!(buf.is_char_boundary(start));
        assert_eq!(&buf[start..], "keep");
    }
}
