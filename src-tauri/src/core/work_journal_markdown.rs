//! The readable copy of the Work Journal backup (`work-journal.md`): every
//! page as Markdown, newest day first, so a person can read and search the
//! backup by eye (issue #568). The backup writer in
//! [`crate::core::work_journal`] writes it beside `work-journal.json`, only
//! when it writes the JSON. Nothing ever reads it back: restore reads only
//! the JSON.
//!
//! An entry card reads `**09:15** project (source) text`; a card without a
//! time or project leaves that part out. Free notes keep their text and
//! their formatting (bold, italic, strike-through, code, links, headings,
//! lists, task lists, quotes, code blocks and rules). Text is written as
//! typed, never escaped, since the file is for reading, not for parsing.
//!
//! The page bodies are the editor's JSON, stored as-is, so every reader here
//! takes any JSON value: a missing or malformed part is skipped, never an
//! error.

use serde_json::Value;

use crate::core::work_journal::{WorkJournal, WorkJournalPage};

/// The readable copy's file name inside the backup folder.
pub const FILE_NAME: &str = "work-journal.md";

/// The top of the file: what it is and that restore never reads it.
const INTRO: &str = "# Work Journal\n\nA readable copy of the backup, written together with \
work-journal.json, newest day first. Restore reads only work-journal.json; changes made \
here are never read back.\n";

/// The node type of an entry card (the front end's `WORK_JOURNAL_ENTRY_NODE`).
const ENTRY_NODE: &str = "journalEntry";

/// The source of a card whose source is missing: one made by hand.
const TYPED_SOURCE: &str = "typed";

/// Heading levels used by the file itself (`#` for the file, `##` for a
/// page); a heading inside a page moves down by this many levels.
const PAGE_HEADING_LEVELS: u64 = 2;

/// The deepest Markdown heading level.
const MAX_HEADING_LEVEL: u64 = 6;

/// The shortest code fence.
const MIN_FENCE: usize = 3;

/// The whole readable copy of `journal`.
pub fn render(journal: &WorkJournal) -> String {
    let mut out = String::from(INTRO);
    for page in journal.pages.values().rev() {
        out.push_str("\n## ");
        out.push_str(&page_heading(page));
        out.push('\n');
        if let Some(body) = block(&page.body) {
            out.push('\n');
            out.push_str(&body);
            out.push('\n');
        }
    }
    out
}

/// `<date> — <title>`, or the date alone when the title is blank or is the
/// date itself.
fn page_heading(page: &WorkJournalPage) -> String {
    let title = one_line(&page.title);
    if title.is_empty() || title == page.date {
        page.date.clone()
    } else {
        format!("{} — {title}", page.date)
    }
}

/// The node's type, or "" for anything that is not a typed node.
fn kind(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

/// The node's children; none when `content` is missing or not a list.
fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// A string attribute folded to one line; `None` when missing or blank.
fn text_attr(node: &Value, name: &str) -> Option<String> {
    node.get("attrs")
        .and_then(|attrs| attrs.get(name))
        .and_then(Value::as_str)
        .map(one_line)
        .filter(|value| !value.is_empty())
}

/// The Markdown of every block among `nodes` that has any text.
fn blocks(nodes: &[Value]) -> Vec<String> {
    nodes.iter().filter_map(block).collect()
}

/// The Markdown of one block node (or of the whole page for `doc`); `None`
/// when it holds no text.
fn block(node: &Value) -> Option<String> {
    let text = match kind(node) {
        "paragraph" => inline(children(node)),
        "heading" => heading(node),
        "bulletList" => list(node, |_, _| "- ".to_string()),
        "orderedList" => {
            let start = node
                .get("attrs")
                .and_then(|attrs| attrs.get("start"))
                .and_then(Value::as_u64)
                .unwrap_or(1);
            list(node, move |at, _| format!("{}. ", start.saturating_add(at)))
        }
        "taskList" => list(node, |_, item| {
            let checked = item
                .get("attrs")
                .and_then(|attrs| attrs.get("checked"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if checked { "- [x] " } else { "- [ ] " }.to_string()
        }),
        "blockquote" => prefix_lines(&blocks(children(node)).join("\n\n"), "> ", "> "),
        "codeBlock" => code_block(node),
        "horizontalRule" => "---".to_string(),
        ENTRY_NODE => card(node),
        "text" | "hardBreak" => inline(std::slice::from_ref(node)),
        // The page itself (`doc`), and any container this build does not know.
        _ => blocks(children(node)).join("\n\n"),
    };
    (!text.trim().is_empty()).then_some(text)
}

/// A heading, moved down below the page heading (capped at level six).
fn heading(node: &Value) -> String {
    let text = one_line(&inline(children(node)));
    if text.is_empty() {
        return text;
    }
    let level = node
        .get("attrs")
        .and_then(|attrs| attrs.get("level"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        .clamp(1, MAX_HEADING_LEVEL);
    let depth = (level + PAGE_HEADING_LEVELS).min(MAX_HEADING_LEVEL) as usize;
    format!("{} {text}", "#".repeat(depth))
}

/// A list: each item's blocks, the first line after the item's marker and
/// the rest indented under it, so nested lists stay nested.
fn list(node: &Value, marker: impl Fn(u64, &Value) -> String) -> String {
    let items = children(node).iter().filter(|item| item.is_object());
    items
        .enumerate()
        .map(|(at, item)| {
            let mark = marker(at as u64, item);
            let indent = " ".repeat(mark.chars().count());
            prefix_lines(&blocks(children(item)).join("\n"), &mark, &indent)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `text` with `first` before its first line and `rest` before every other;
/// a blank line keeps only the prefix, without trailing spaces.
fn prefix_lines(text: &str, first: &str, rest: &str) -> String {
    let mut lines = text.split('\n');
    let mut out = Vec::new();
    let head = lines.next().unwrap_or("");
    out.push(format!("{first}{head}").trim_end().to_string());
    for line in lines {
        out.push(format!("{rest}{line}").trim_end().to_string());
    }
    out.join("\n")
}

/// A fenced code block, its text exactly as written; the fence is longer
/// than any run of backticks inside, so the code cannot end it early.
fn code_block(node: &Value) -> String {
    let code: String = children(node)
        .iter()
        .filter_map(|child| child.get("text").and_then(Value::as_str))
        .collect();
    if code.trim().is_empty() {
        return String::new();
    }
    let fence = "`".repeat(longest_run(&code, '`').max(MIN_FENCE - 1) + 1);
    let language = text_attr(node, "language").unwrap_or_default();
    format!(
        "{fence}{language}\n{}\n{fence}",
        code.trim_end_matches('\n')
    )
}

/// The longest run of `c` in `text`.
fn longest_run(text: &str, c: char) -> usize {
    let mut longest = 0;
    let mut current = 0;
    for ch in text.chars() {
        current = if ch == c { current + 1 } else { 0 };
        longest = longest.max(current);
    }
    longest
}

/// An entry card: `**HH:MM** project (source) text`, each part on one line;
/// no time or no project leaves that part out, and a missing source reads as
/// typed. The text keeps its inline formatting.
fn card(node: &Value) -> String {
    let text = children(node)
        .iter()
        .map(|child| one_line(&inline(children(child))))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let mut parts = Vec::new();
    if let Some(time) = text_attr(node, "time") {
        parts.push(format!("**{time}**"));
    }
    if let Some(project) = text_attr(node, "project") {
        parts.push(project);
    }
    let source = text_attr(node, "source").unwrap_or_else(|| TYPED_SOURCE.to_string());
    parts.push(format!("({source})"));
    if !text.is_empty() {
        parts.push(text);
    }
    parts.join(" ")
}

/// The inline formatting of one piece of text.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Marks {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    link: Option<String>,
}

impl Marks {
    /// The marks of a text node this file can show; others (colour,
    /// underline, highlight) are dropped, keeping their text.
    fn of(node: &Value) -> Self {
        let mut marks = Marks::default();
        let Some(list) = node.get("marks").and_then(Value::as_array) else {
            return marks;
        };
        for mark in list {
            match kind(mark) {
                "bold" => marks.bold = true,
                "italic" => marks.italic = true,
                "strike" => marks.strike = true,
                "code" => marks.code = true,
                "link" => marks.link = text_attr(mark, "href"),
                _ => {}
            }
        }
        marks
    }

    /// `text` wrapped in these marks. Spaces at either end stay outside the
    /// markers, where Markdown needs them.
    fn wrap(&self, text: &str) -> String {
        let core = text.trim();
        if core.is_empty() {
            return text.to_string();
        }
        let start = &text[..text.len() - text.trim_start().len()];
        let end = &text[text.trim_end().len()..];
        let mut out = if self.code {
            let ticks = "`".repeat(longest_run(core, '`') + 1);
            let pad = if core.starts_with('`') || core.ends_with('`') {
                " "
            } else {
                ""
            };
            format!("{ticks}{pad}{core}{pad}{ticks}")
        } else {
            core.to_string()
        };
        if self.italic {
            out = format!("*{out}*");
        }
        if self.bold {
            out = format!("**{out}**");
        }
        if self.strike {
            out = format!("~~{out}~~");
        }
        if let Some(href) = &self.link {
            out = format!("[{out}]({href})");
        }
        format!("{start}{out}{end}")
    }
}

/// The inline Markdown of `nodes`: neighbouring text with the same marks is
/// joined first, so `**a****b**` never appears; a line break starts a new
/// line; any other inline node shows its own text.
fn inline(nodes: &[Value]) -> String {
    let mut runs: Vec<(String, Marks)> = Vec::new();
    collect_runs(nodes, &mut runs);
    runs.iter().map(|(text, marks)| marks.wrap(text)).collect()
}

fn collect_runs(nodes: &[Value], runs: &mut Vec<(String, Marks)>) {
    for node in nodes {
        let (text, marks) = match kind(node) {
            "text" => match node.get("text").and_then(Value::as_str) {
                Some(text) => (text.to_string(), Marks::of(node)),
                None => continue,
            },
            "hardBreak" => ("\n".to_string(), Marks::default()),
            _ => {
                collect_runs(children(node), runs);
                continue;
            }
        };
        match runs.last_mut() {
            Some((last, last_marks)) if *last_marks == marks && text != "\n" && last != "\n" => {
                last.push_str(&text)
            }
            _ => runs.push((text, marks)),
        }
    }
}

/// Folds text to one line.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::work_journal::PageOrigin;
    use serde_json::json;

    fn text(value: &str) -> Value {
        json!({ "type": "text", "text": value })
    }

    fn marked(value: &str, marks: Value) -> Value {
        json!({ "type": "text", "text": value, "marks": marks })
    }

    fn paragraph(content: Value) -> Value {
        json!({ "type": "paragraph", "content": content })
    }

    fn entry(attrs: Value, words: &str) -> Value {
        json!({ "type": ENTRY_NODE, "attrs": attrs, "content": [paragraph(json!([text(words)]))] })
    }

    fn doc(content: Value) -> Value {
        json!({ "type": "doc", "content": content })
    }

    fn journal(pages: &[(&str, &str, Value)]) -> WorkJournal {
        let mut journal = WorkJournal::default();
        for (date, title, body) in pages {
            journal.pages.insert(
                date.to_string(),
                WorkJournalPage {
                    date: date.to_string(),
                    title: title.to_string(),
                    body: body.clone(),
                    origin: PageOrigin::Auto,
                    rev: 1,
                },
            );
        }
        journal
    }

    #[test]
    fn test_render_lists_every_page_newest_day_first() {
        let journal = journal(&[
            (
                "2026-11-02",
                "Mon 2 Nov 2026",
                doc(json!([paragraph(json!([text("Older day")]))])),
            ),
            (
                "2026-11-04",
                "",
                doc(json!([paragraph(json!([text("Newest day")]))])),
            ),
            ("2026-11-03", "Tue 3 Nov 2026", doc(json!([]))),
        ]);

        let markdown = render(&journal);

        assert!(markdown.starts_with("# Work Journal\n"));
        let newest = markdown
            .find("## 2026-11-04\n")
            .expect("blank title: date only");
        let middle = markdown.find("## 2026-11-03 — Tue 3 Nov 2026\n").unwrap();
        let oldest = markdown.find("## 2026-11-02 — Mon 2 Nov 2026\n").unwrap();
        assert!(
            newest < middle && middle < oldest,
            "newest first:\n{markdown}"
        );
        assert!(markdown.contains("## 2026-11-04\n\nNewest day\n"));
        assert!(markdown.ends_with("Older day\n"));
    }

    #[test]
    fn test_render_of_an_empty_journal_is_the_intro_only() {
        assert_eq!(render(&WorkJournal::default()), INTRO);
    }

    #[test]
    fn test_cards_read_bold_time_project_source_and_text() {
        let cases = [
            (
                json!({ "time": "09:15", "project": "maestro", "source": "claude" }),
                "Fixed the flaky build: retries now stop",
                "**09:15** maestro (claude) Fixed the flaky build: retries now stop",
            ),
            (
                json!({ "time": null, "project": "orion", "source": "git-commit" }),
                "Untimed card",
                "orion (git-commit) Untimed card",
            ),
            (
                json!({ "time": "14:20", "project": null, "source": "granola" }),
                "Design review",
                "**14:20** (granola) Design review",
            ),
            (
                json!({ "time": "08:00" }),
                "No source",
                "**08:00** (typed) No source",
            ),
            (json!(null), "No attributes", "(typed) No attributes"),
            (
                json!({ "time": " 10:05 ", "project": "my\nproject", "source": "typed" }),
                "  spread\n over   lines ",
                "**10:05** my project (typed) spread over lines",
            ),
        ];
        for (attrs, words, expected) in cases {
            assert_eq!(
                block(&entry(attrs.clone(), words)).as_deref(),
                Some(expected),
                "{attrs}"
            );
        }
    }

    #[test]
    fn test_card_text_keeps_its_inline_formatting() {
        let card = json!({
            "type": ENTRY_NODE,
            "attrs": { "time": "11:00", "project": "maestro", "source": "typed" },
            "content": [paragraph(json!([
                marked("Shipped:", json!([{ "type": "bold" }])),
                text(" the parser"),
            ]))]
        });
        assert_eq!(
            block(&card).as_deref(),
            Some("**11:00** maestro (typed) **Shipped:** the parser")
        );
    }

    #[test]
    fn test_free_notes_keep_their_text_and_formatting() {
        let body = doc(json!([
            { "type": "heading", "attrs": { "level": 1 }, "content": [text("Plan")] },
            paragraph(json!([
                text("Plain, "),
                marked("bold ", json!([{ "type": "bold" }])),
                marked("italic", json!([{ "type": "italic" }])),
                text(", "),
                marked("gone", json!([{ "type": "strike" }])),
                text(", "),
                marked("npm test", json!([{ "type": "code" }])),
                text(", "),
                marked("docs", json!([{ "type": "link", "attrs": { "href": "https://example.com/a" } }])),
                text(" and "),
                marked("red", json!([{ "type": "textStyle", "attrs": { "color": "#f00" } }])),
            ])),
            paragraph(json!([text("line one"), { "type": "hardBreak" }, text("line two")])),
            { "type": "bulletList", "content": [
                { "type": "listItem", "content": [
                    paragraph(json!([text("first")])),
                    { "type": "bulletList", "content": [
                        { "type": "listItem", "content": [paragraph(json!([text("nested")]))] }
                    ]}
                ]},
                { "type": "listItem", "content": [paragraph(json!([text("second")]))] }
            ]},
            { "type": "orderedList", "attrs": { "start": 3 }, "content": [
                { "type": "listItem", "content": [paragraph(json!([text("three")]))] },
                { "type": "listItem", "content": [paragraph(json!([text("four")]))] }
            ]},
            { "type": "taskList", "content": [
                { "type": "taskItem", "attrs": { "checked": true }, "content": [paragraph(json!([text("done")]))] },
                { "type": "taskItem", "attrs": { "checked": false }, "content": [paragraph(json!([text("todo")]))] }
            ]},
            { "type": "blockquote", "content": [
                paragraph(json!([text("quoted")])),
                paragraph(json!([text("still quoted")]))
            ]},
            { "type": "codeBlock", "attrs": { "language": "rust" }, "content": [text("let a = 1;\n  let b = \"*x*\";")] },
            { "type": "horizontalRule" },
            entry(json!({ "time": "16:45", "project": "maestro", "source": "typed" }), "Card among notes"),
        ]));

        assert_eq!(
            block(&body).unwrap(),
            "### Plan\n\n\
             Plain, **bold** *italic*, ~~gone~~, `npm test`, [docs](https://example.com/a) and red\n\n\
             line one\nline two\n\n\
             - first\n  - nested\n- second\n\n\
             3. three\n4. four\n\n\
             - [x] done\n- [ ] todo\n\n\
             > quoted\n>\n> still quoted\n\n\
             ```rust\nlet a = 1;\n  let b = \"*x*\";\n```\n\n\
             ---\n\n\
             **16:45** maestro (typed) Card among notes"
        );
    }

    #[test]
    fn test_headings_move_below_the_page_heading_and_stop_at_six() {
        let level = |n: Value| {
            block(&json!({ "type": "heading", "attrs": { "level": n }, "content": [text("T")] }))
        };
        assert_eq!(level(json!(1)).as_deref(), Some("### T"));
        assert_eq!(level(json!(3)).as_deref(), Some("##### T"));
        assert_eq!(level(json!(6)).as_deref(), Some("###### T"));
        assert_eq!(level(json!(99)).as_deref(), Some("###### T"));
        assert_eq!(
            level(json!("two")).as_deref(),
            Some("### T"),
            "not a number: level 1"
        );
    }

    #[test]
    fn test_code_with_backticks_gets_a_longer_fence() {
        let code = json!({ "type": "codeBlock", "content": [text("a ``` b")] });
        assert_eq!(block(&code).as_deref(), Some("````\na ``` b\n````"));
        let inline_code = paragraph(json!([marked("a`b", json!([{ "type": "code" }]))]));
        assert_eq!(block(&inline_code).as_deref(), Some("``a`b``"));
    }

    #[test]
    fn test_malformed_bodies_are_skipped_never_an_error() {
        let shapes = [
            json!(null),
            json!("just a string"),
            json!(42),
            json!([1, 2]),
            json!({}),
            json!({ "type": "doc" }),
            json!({ "type": "doc", "content": null }),
            json!({ "type": "doc", "content": "not a list" }),
            json!({ "type": "doc", "content": [null, 1, "x", [], {}] }),
            json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [null, { "type": "text" }, { "type": "text", "text": 7 }] }] }),
            json!({ "type": "doc", "content": [{ "type": "bulletList", "content": [null, { "type": "listItem", "content": null }] }] }),
            json!({ "type": "doc", "content": [{ "type": ENTRY_NODE, "attrs": { "time": 9, "project": [], "source": {} }, "content": null }] }),
            json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "x", "marks": [null, { "type": "link", "attrs": null }, "bold"] }] }] }),
        ];
        for body in shapes {
            let journal = journal(&[("2026-11-05", "Thu 5 Nov 2026", body.clone())]);
            let markdown = render(&journal);
            assert!(
                markdown.contains("## 2026-11-05 — Thu 5 Nov 2026"),
                "{body}"
            );
        }
        let odd_card =
            json!({ "type": ENTRY_NODE, "attrs": { "time": 9, "project": [], "source": {} } });
        assert_eq!(
            block(&odd_card).as_deref(),
            Some("(typed)"),
            "wrong types read as missing"
        );
        let odd_marks = paragraph(
            json!([{ "type": "text", "text": "x", "marks": [null, { "type": "link", "attrs": null }] }]),
        );
        assert_eq!(block(&odd_marks).as_deref(), Some("x"));
    }

    #[test]
    fn test_unknown_nodes_keep_their_text() {
        let body = doc(json!([
            { "type": "callout", "content": [paragraph(json!([text("inside a future block")]))] },
            paragraph(json!([{ "type": "mention", "content": [text("@someone")] }, text(" said hi")])),
        ]));
        assert_eq!(
            block(&body).unwrap(),
            "inside a future block\n\n@someone said hi"
        );
    }
}
