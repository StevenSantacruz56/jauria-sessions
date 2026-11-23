//! Passive scanner for the explicit attention protocol in raw PTY output.
//!
//! Pure: no I/O, no clock, no allocation after construction. One `Scanner`
//! per session sees every byte once, in order, possibly split at any byte
//! between reads. It recognises exactly what the desktop client recognises
//! through xterm (`program-status.ts`, `terminal-attention.ts`):
//! - OSC 7501 program status (`state=working|blocked|error|done|idle|clear`),
//!   with the same root-subset validation as `parseProgramStatus`;
//! - BEL outside strings (xterm also executes BEL inside CSI/ESC sequences);
//! - OSC 9 notifications, except numeric subprotocols such as `9;4` progress;
//! - OSC 777 only with the `notify;` prefix.
//!
//! The scanner never keeps or exposes any payload (titles, messages, text of
//! 9/777): callers only receive enumerated `Signal`s and the offset of the byte
//! that completed the sequence. A declared state is what the PTY output says,
//! not the agent's truth: any program, or `cat` of a file containing a valid
//! sequence, can declare it. Memory is O(1) (one fixed 1 KiB buffer) and time
//! O(n). A tracked OSC whose payload exceeds the buffer is discarded whole
//! without examining its content.
//!
//! Byte-level state machine modelled on xterm.js `EscapeSequenceParser`:
//! - In an OSC, BEL ends it, ESC ends it successfully and starts an escape
//!   (so `ESC \` is ST), CAN/SUB abort it, other C0 bytes are dropped.
//! - DCS (`ESC P`) and SOS/PM/APC (`ESC X`, `ESC ^`, `ESC _`) are consumed
//!   without interpretation until ESC or CAN/SUB; BEL inside them is ignored.
//! - Raw 8-bit C1 bytes are ignored: 0x9D is also a UTF-8 continuation byte.
//!   Documented divergence: xterm decodes UTF-8 first and would honour the
//!   UTF-8 encoded C1 codepoints U+0080..U+009F; programs do not emit them.
//! - Invalid UTF-8 never breaks the state machine; inside an OSC 7501 payload
//!   invalid sequences are skipped like xterm's decoder does.

pub const MAX_PAYLOAD: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Declared { Working, Blocked, Error, Done, Idle }

impl Declared {
    pub fn as_str(self) -> &'static str {
        match self { Self::Working => "working", Self::Blocked => "blocked", Self::Error => "error", Self::Done => "done", Self::Idle => "idle" }
    }
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value { "working" => Self::Working, "blocked" => Self::Blocked, "error" => Self::Error, "done" => Self::Done, "idle" => Self::Idle, _ => return None })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal { State(Declared), Clear, Bell, Notify }

#[derive(Clone, Copy, PartialEq, Eq)]
enum St { Ground, Esc, EscInter, Csi, OscId, OscPayload, OscIgnore, Str }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Osc { Status, Nine, SevenSeventySeven }

pub struct Scanner {
    st: St,
    // OSC identifier: None until a digit arrives (xterm's -1). Saturates so a
    // very long identifier is simply unknown.
    id: Option<u32>,
    osc: Option<Osc>,
    len: usize,
    overflow: bool,
    buf: [u8; MAX_PAYLOAD],
}

impl Default for Scanner { fn default() -> Self { Self::new() } }

impl Scanner {
    pub fn new() -> Self {
        Self { st: St::Ground, id: None, osc: None, len: 0, overflow: false, buf: [0; MAX_PAYLOAD] }
    }

    /// Feeds one chunk. `emit(offset, signal)` receives the offset, within this
    /// chunk, of the byte that completed the signal.
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(usize, Signal)) {
        for (offset, &b) in bytes.iter().enumerate() {
            match self.st {
                St::Ground => match b {
                    0x07 => emit(offset, Signal::Bell),
                    0x1b => self.st = St::Esc,
                    _ => {}
                },
                St::Esc => match b {
                    b'[' => self.st = St::Csi,
                    b']' => { self.st = St::OscId; self.id = None; self.osc = None; self.len = 0; self.overflow = false; }
                    b'P' | b'X' | b'^' | b'_' => self.st = St::Str,
                    0x20..=0x2f => self.st = St::EscInter,
                    0x07 => emit(offset, Signal::Bell),
                    0x18 | 0x1a => self.st = St::Ground,
                    0x1b | 0x7f => {}
                    0x00..=0x1f => {}
                    _ => self.st = St::Ground,
                },
                St::EscInter => match b {
                    0x20..=0x2f | 0x7f => {}
                    0x07 => emit(offset, Signal::Bell),
                    0x1b => self.st = St::Esc,
                    0x18 | 0x1a => self.st = St::Ground,
                    0x00..=0x1f => {}
                    _ => self.st = St::Ground,
                },
                St::Csi => match b {
                    0x40..=0x7e => self.st = St::Ground,
                    0x07 => emit(offset, Signal::Bell),
                    0x1b => self.st = St::Esc,
                    0x18 | 0x1a => self.st = St::Ground,
                    0x00..=0x3f | 0x7f => {}
                    _ => self.st = St::Ground,
                },
                St::Str => match b {
                    0x1b => self.st = St::Esc,
                    0x18 | 0x1a => self.st = St::Ground,
                    _ => {}
                },
                St::OscId | St::OscPayload | St::OscIgnore => match b {
                    0x07 => { self.end(offset, &mut emit); self.st = St::Ground; }
                    0x1b => { self.end(offset, &mut emit); self.st = St::Esc; }
                    0x18 | 0x1a => self.st = St::Ground,
                    0x00..=0x1f => {}
                    _ => self.put(b),
                },
            }
        }
    }

    fn put(&mut self, b: u8) {
        match self.st {
            St::OscId => match b {
                b'0'..=b'9' => {
                    let digit = u32::from(b - b'0');
                    self.id = Some(self.id.unwrap_or(0).saturating_mul(10).saturating_add(digit));
                }
                b';' => {
                    self.osc = match self.id { Some(7501) => Some(Osc::Status), Some(9) => Some(Osc::Nine), Some(777) => Some(Osc::SevenSeventySeven), _ => None };
                    self.st = if self.osc.is_some() { St::OscPayload } else { St::OscIgnore };
                }
                // xterm aborts the command: nothing is dispatched at its end.
                _ => { self.id = None; self.st = St::OscIgnore; }
            },
            St::OscPayload => {
                if self.overflow { return; }
                if self.len == MAX_PAYLOAD { self.overflow = true; self.len = 0; return; }
                self.buf[self.len] = b;
                self.len += 1;
            }
            _ => {}
        }
    }

    fn end(&mut self, offset: usize, emit: &mut impl FnMut(usize, Signal)) {
        // An identifier without ';' still dispatches with an empty payload.
        let osc = match self.st {
            St::OscId => match self.id { Some(7501) => Some(Osc::Status), Some(9) => Some(Osc::Nine), Some(777) => Some(Osc::SevenSeventySeven), _ => None },
            St::OscPayload if !self.overflow => self.osc,
            _ => None,
        };
        let payload = if self.st == St::OscPayload { &self.buf[..self.len] } else { &[][..] };
        let signal = match osc {
            Some(Osc::Status) => match parse_program_status(payload) {
                Some(Some(state)) => Some(Signal::State(state)),
                Some(None) => Some(Signal::Clear),
                None => None,
            },
            Some(Osc::Nine) => (!numeric_subprotocol(payload)).then_some(Signal::Notify),
            Some(Osc::SevenSeventySeven) => payload.starts_with(b"notify;").then_some(Signal::Notify),
            None => None,
        };
        // Forget the payload immediately: nothing of it survives the sequence.
        self.len = 0;
        self.overflow = false;
        self.osc = None;
        self.id = None;
        if let Some(signal) = signal { emit(offset, signal); }
    }
}

/// `/^\d+;/` on the payload (ASCII digits, as in JavaScript).
fn numeric_subprotocol(payload: &[u8]) -> bool {
    let digits = payload.iter().take_while(|b| b.is_ascii_digit()).count();
    digits > 0 && payload.get(digits) == Some(&b';')
}

/// Mirrors `parseProgramStatus`. `None` rejects the record, `Some(None)` is a
/// valid `state=clear`, `Some(Some(state))` a declared state.
pub fn parse_program_status(raw: &[u8]) -> Option<Option<Declared>> {
    if raw.is_empty() || raw.len() > MAX_PAYLOAD { return None; }
    // xterm's decoder drops invalid UTF-8 sequences before the handler sees
    // the string. Decode the same way, into a bounded stack buffer.
    let mut text = [0u8; MAX_PAYLOAD];
    let mut len = 0;
    let mut rest = raw;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(valid) => { text[len..len + valid.len()].copy_from_slice(valid.as_bytes()); len += valid.len(); break; }
            Err(error) => {
                let good = error.valid_up_to();
                text[len..len + good].copy_from_slice(&rest[..good]);
                len += good;
                let skip = good + error.error_len().unwrap_or(rest.len() - good);
                rest = &rest[skip..];
            }
        }
    }
    let data = std::str::from_utf8(&text[..len]).ok()?;
    if data.is_empty() { return None; }
    if data.chars().any(|c| (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32))) { return None; }
    let mut state = None;
    let mut found = false;
    for field in data.split(':') {
        let eq = field.find('=')?;
        if eq == 0 { return None; }
        let (key, value) = (&field[..eq], &field[eq + 1..]);
        if key.contains('?') || value == "?" { return None; }
        let lower = key.to_lowercase();
        if lower == "id" { return None; }
        if lower == "state" {
            if key != "state" || found { return None; }
            found = true;
            state = match value { "clear" => None, other => Some(Declared::parse(other)?) };
        }
    }
    found.then_some(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use serde_json::Value;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../desktop/tests/fixtures/program-status-vectors.json");
        serde_json::from_slice(&std::fs::read(path).expect("shared vectors")).unwrap()
    }

    fn name(signal: Signal) -> Value {
        match signal {
            Signal::State(s) => serde_json::json!({"kind":"state","state":s.as_str()}),
            Signal::Clear => serde_json::json!({"kind":"clear"}),
            Signal::Bell => serde_json::json!({"kind":"bell"}),
            Signal::Notify => serde_json::json!({"kind":"notify"}),
        }
    }

    fn run(input: &[u8], cuts: &[usize]) -> Vec<(usize, Signal)> {
        let mut scanner = Scanner::new();
        let mut events = Vec::new();
        let mut start = 0;
        for &cut in cuts.iter().chain(std::iter::once(&input.len())) {
            scanner.feed(&input[start..cut], |offset, signal| events.push((start + offset, signal)));
            start = cut;
        }
        events
    }

    #[test]
    fn shared_payload_vectors_match_parse_program_status() {
        let vectors = vectors();
        let payloads = vectors["payloads"].as_array().unwrap();
        assert!(payloads.len() >= 20);
        for case in payloads {
            let payload = match case.get("payloadBase64") {
                Some(b64) => STANDARD.decode(b64.as_str().unwrap()).unwrap(),
                None => case["payload"].as_str().unwrap().as_bytes().to_vec(),
            };
            let expected = &case["expect"];
            let actual = match parse_program_status(&payload) {
                None => Value::Null,
                Some(None) => Value::from("clear"),
                Some(Some(s)) => Value::from(s.as_str()),
            };
            assert_eq!(&actual, expected, "payload case {}", case["name"]);
        }
    }

    #[test]
    fn shared_stream_vectors_survive_every_cut() {
        let vectors = vectors();
        let streams = vectors["streams"].as_array().unwrap();
        assert!(streams.len() >= 20);
        for case in streams {
            let input = STANDARD.decode(case["input"].as_str().unwrap()).unwrap();
            let expected: Vec<Value> = case["expect"].as_array().unwrap().clone();
            let check = |events: Vec<(usize, Signal)>, how: &str| {
                let actual: Vec<Value> = events.into_iter().map(|(at, s)| { let mut v = name(s); v["at"] = at.into(); v }).collect();
                assert_eq!(actual, expected, "stream case {} ({how})", case["name"]);
            };
            check(run(&input, &[]), "whole");
            for cut in 1..input.len() { check(run(&input, &[cut]), &format!("cut at {cut}")); }
            let every: Vec<usize> = (1..input.len()).collect();
            check(run(&input, &every), "byte by byte");
        }
    }

    #[test]
    fn payload_never_leaves_the_scanner() {
        let mut scanner = Scanner::new();
        let mut seen = Vec::new();
        scanner.feed(b"\x1b]7501;state=working:title=SENTINEL-OSC-TITLE\x07\x1b]9;SENTINEL-NOTE\x07", |_, s| seen.push(format!("{s:?}")));
        assert_eq!(seen, ["State(Working)", "Notify"]);
        assert!(scanner.buf[..scanner.len].is_empty());
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    }

    #[test]
    fn random_bytes_never_panic_and_partitions_agree() {
        // Bias toward the bytes that drive the state machine.
        let alphabet: &[u8] = b"\x1b\x07\x18\x1a]\\[P_X^;:=0123456789stateworkingdone7501notify\x9d\x9c\xc2\xff";
        for seed in 1..=24u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            let input: Vec<u8> = (0..64 * 1024).map(|_| {
                let r = rng.next();
                if r % 3 == 0 { (r >> 8) as u8 } else { alphabet[(r >> 8) as usize % alphabet.len()] }
            }).collect();
            let whole = run(&input, &[]);
            let mut cuts = Vec::new();
            let mut at = 0;
            loop { at += 1 + (rng.next() % 4096) as usize; if at >= input.len() { break; } cuts.push(at); }
            assert_eq!(run(&input, &cuts), whole, "seed {seed}");
        }
        // The scanner is a fixed-size value: no growth regardless of input.
        assert!(std::mem::size_of::<Scanner>() <= MAX_PAYLOAD + 64);
    }

    #[test]
    fn scanning_cost_is_linear_and_small() {
        let mut input = Vec::new();
        while input.len() < 8 * 1024 * 1024 {
            input.extend_from_slice(b"\x1b[32mcompiling crate \x1b[0m 42%\r\n\x1b]7501;state=working\x07");
        }
        let mut scanner = Scanner::new();
        let mut count = 0usize;
        let start = std::time::Instant::now();
        for chunk in input.chunks(12 * 1024) { scanner.feed(chunk, |_, _| count += 1); }
        let elapsed = start.elapsed();
        assert!(count > 100_000);
        eprintln!("agent_signals: scanned {} MiB in {:?}", input.len() >> 20, elapsed);
        // Generous bound for debug builds on CI; release is far faster.
        assert!(elapsed < std::time::Duration::from_secs(5));
    }
}
