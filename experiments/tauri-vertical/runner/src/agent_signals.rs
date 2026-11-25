//! Passive scanner for the explicit attention protocol in raw PTY output.
//!
//! Pure: no I/O, no clock, no allocation after construction. One `Scanner`
//! per session sees every byte once, in order, possibly split at any byte
//! between reads. It recognises what the desktop client recognises through
//! xterm (`program-status.ts`, `terminal-attention.ts`):
//! - OSC 7501 program status (`state=working|blocked|error|done|idle|clear`),
//!   with the same root-subset validation as `parseProgramStatus`;
//! - BEL executed in ground, escape and CSI states;
//! - OSC 9 notifications, except numeric subprotocols such as `9;4` progress;
//! - OSC 777 only with the `notify;` prefix.
//!
//! The scanner never exposes any payload (titles, messages, text of 9/777):
//! callers receive enumerated `Signal`s and the offset of the byte that
//! completed the sequence. OSC 9/777 are decided from their first characters
//! and never stored. Only an OSC 7501 payload is buffered (fixed 1 KiB, as the
//! client's budget), and it is zeroed as soon as the sequence ends or is
//! dropped. A declared state is what the PTY output says, not the agent's
//! truth: any program, or `cat` of a file with a valid sequence, declares it.
//!
//! Model of xterm.js 5.5 (`common/input/TextDecoder.ts` Utf8ToUtf32, then
//! `common/parser/EscapeSequenceParser.ts` VT500_TRANSITION_TABLE and
//! `OscParser.ts`): bytes are first decoded to codepoints with the same
//! rules (invalid, overlong, surrogate and U+FEFF sequences are dropped), so
//! U+0080..U+009F (two bytes C2 80..C2 9F) act as C1 controls while a lone
//! 0x9D byte is not one. On codepoints:
//! - anywhere: CAN/SUB to ground (an OSC is dropped), ESC to escape (an OSC
//!   ends successfully, as in xterm, so `ESC \` is ST), U+009C ST (ends an
//!   OSC), U+009D OSC, U+0090 DCS, U+0098/U+009E/U+009F SOS/PM/APC, U+009B
//!   CSI, any other C1 to ground (an OSC is dropped);
//! - a codepoint >= U+00A0 ends ESC, CSI and DCS headers and SOS/PM/APC
//!   (xterm's ERROR to ground), and is data in OSC, CSI-ignore and DCS data;
//! - OSC payloads over xterm's 10,000,000 UTF-16 units are dropped.
//!   Remaining difference: that limit is counted on the payload only, as
//!   xterm does, but the identifier digits are not bounded.

pub const MAX_PAYLOAD: usize = 1024;
/// xterm's OSC PAYLOAD_LIMIT, in UTF-16 code units.
pub const OSC_LIMIT: u64 = 10_000_000;

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
enum St { Ground, Esc, EscInter, CsiEntry, CsiParam, CsiInter, CsiIgnore, OscId, OscPayload, OscIgnore, DcsEntry, DcsParam, DcsInter, DcsIgnore, DcsPass, Sos }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Osc { Status, Nine, SevenSeventySeven }

/// OSC 9 `/^\d+;/` and OSC 777 `startsWith("notify;")`, decided on the fly.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Prefix { Start, Digits, Matched(u8), Yes, No }

const NOTIFY: &[u8; 7] = b"notify;";

pub struct Scanner {
    st: St,
    // UTF-8 decoder (xterm Utf8ToUtf32).
    need: u8,
    have: u8,
    cp: u32,
    // OSC identifier: None until a digit arrives (xterm's -1).
    id: Option<u32>,
    osc: Option<Osc>,
    prefix: Prefix,
    units: u64,
    len: usize,
    overflow: bool,
    buf: [u8; MAX_PAYLOAD],
}

impl Default for Scanner { fn default() -> Self { Self::new() } }

fn is_osc(st: St) -> bool { matches!(st, St::OscId | St::OscPayload | St::OscIgnore) }

impl Scanner {
    pub fn new() -> Self {
        Self { st: St::Ground, need: 0, have: 0, cp: 0, id: None, osc: None, prefix: Prefix::Start, units: 0, len: 0, overflow: false, buf: [0; MAX_PAYLOAD] }
    }

    /// Feeds one chunk. `emit(offset, signal)` receives the offset, within this
    /// chunk, of the byte that completed the signal.
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(usize, Signal)) {
        for (offset, &b) in bytes.iter().enumerate() {
            if let Some(cp) = self.decode(b) { self.step(cp, offset, &mut emit); }
        }
    }

    fn decode(&mut self, b: u8) -> Option<u32> {
        if self.need > 0 {
            if b & 0xc0 == 0x80 {
                self.cp = (self.cp << 6) | u32::from(b & 0x3f);
                self.have += 1;
                if self.have < self.need { return None; }
                let (cp, need) = (self.cp, self.need);
                self.need = 0;
                let valid = match need {
                    2 => cp >= 0x80,
                    3 => cp >= 0x800 && !(0xd800..=0xdfff).contains(&cp) && cp != 0xfeff,
                    _ => (0x1_0000..=0x10_ffff).contains(&cp),
                };
                return valid.then_some(cp);
            }
            // Wrong continuation: drop the pending bytes, reprocess this one.
            self.need = 0;
        }
        let (need, bits) = match b {
            0x00..=0x7f => return Some(u32::from(b)),
            _ if b & 0xe0 == 0xc0 => (2, b & 0x1f),
            _ if b & 0xf0 == 0xe0 => (3, b & 0x0f),
            _ if b & 0xf8 == 0xf0 => (4, b & 0x07),
            _ => return None,
        };
        self.need = need;
        self.have = 1;
        self.cp = u32::from(bits);
        None
    }

    fn set(&mut self, st: St) {
        if is_osc(self.st) && (!is_osc(st) || st == St::OscId) { self.forget(); }
        if st == St::OscId { self.id = None; }
        self.st = st;
    }

    /// Zeroes the used part of the payload buffer and resets OSC state.
    fn forget(&mut self) {
        self.buf[..self.len].fill(0);
        self.len = 0;
        self.overflow = false;
        self.osc = None;
        self.id = None;
        self.prefix = Prefix::Start;
        self.units = 0;
    }

    fn step(&mut self, c: u32, offset: usize, emit: &mut impl FnMut(usize, Signal)) {
        let osc = is_osc(self.st);
        // Rules that apply in every state (xterm "anywhere"), with the OSC
        // and DCS-data overrides for ESC and ST.
        match c {
            0x18 | 0x1a => return self.set(St::Ground),
            0x1b => { if osc { self.end(offset, emit); } return self.set(St::Esc); }
            0x9c => { if osc { self.end(offset, emit); } return self.set(St::Ground); }
            0x9d => return self.set(St::OscId),
            0x90 => return self.set(St::DcsEntry),
            0x98 | 0x9e | 0x9f => return self.set(St::Sos),
            0x9b => return self.set(St::CsiEntry),
            0x80..=0x9f => return self.set(St::Ground),
            _ => {}
        }
        let wide = c >= 0xa0;
        let c0 = c < 0x20;
        let b = if wide { 0 } else { c as u8 };
        match self.st {
            St::Ground => if b == 0x07 && !wide { emit(offset, Signal::Bell) },
            St::Esc => match () {
                _ if wide => self.set(St::Ground),
                _ if c0 => if b == 0x07 { emit(offset, Signal::Bell) },
                _ => match b {
                    0x7f => {}
                    0x20..=0x2f => self.set(St::EscInter),
                    b'[' => self.set(St::CsiEntry),
                    b']' => self.set(St::OscId),
                    b'P' => self.set(St::DcsEntry),
                    b'X' | b'^' | b'_' => self.set(St::Sos),
                    _ => self.set(St::Ground),
                },
            },
            St::EscInter => match () {
                _ if wide => self.set(St::Ground),
                _ if c0 => if b == 0x07 { emit(offset, Signal::Bell) },
                _ => if (0x30..=0x7e).contains(&b) { self.set(St::Ground) },
            },
            St::CsiEntry | St::CsiParam | St::CsiInter | St::CsiIgnore => match () {
                _ if wide => if self.st != St::CsiIgnore { self.set(St::Ground) },
                _ if c0 => if b == 0x07 { emit(offset, Signal::Bell) },
                _ => match (self.st, b) {
                    (_, 0x7f) => {}
                    (_, 0x40..=0x7e) => self.set(St::Ground),
                    (St::CsiIgnore, _) => {}
                    (St::CsiEntry, 0x30..=0x3f) => self.set(St::CsiParam),
                    (St::CsiParam, 0x3c..=0x3f) | (St::CsiInter, 0x30..=0x3f) => self.set(St::CsiIgnore),
                    (_, 0x20..=0x2f) => self.set(St::CsiInter),
                    _ => {}
                },
            },
            St::DcsEntry | St::DcsParam | St::DcsInter => match () {
                _ if wide => self.set(St::Ground),
                _ if c0 => {}
                _ => match (self.st, b) {
                    (_, 0x7f) => {}
                    (_, 0x40..=0x7e) => self.set(St::DcsPass),
                    (St::DcsEntry, 0x30..=0x3f) => self.set(St::DcsParam),
                    (St::DcsParam, 0x3c..=0x3f) | (St::DcsInter, 0x30..=0x3f) => self.set(St::DcsIgnore),
                    (_, 0x20..=0x2f) => self.set(St::DcsInter),
                    _ => {}
                },
            },
            St::DcsIgnore | St::DcsPass => {}
            St::Sos => if wide { self.set(St::Ground) },
            St::OscId | St::OscPayload | St::OscIgnore => match () {
                _ if b == 0x07 && !wide => { self.end(offset, emit); self.set(St::Ground); }
                _ if c0 => {}
                _ => self.put(c),
            },
        }
    }

    fn put(&mut self, c: u32) {
        match self.st {
            St::OscId => match c {
                0x30..=0x39 => self.id = Some(self.id.unwrap_or(0).saturating_mul(10).saturating_add(c - 0x30)),
                0x3b => {
                    self.osc = match self.id { Some(7501) => Some(Osc::Status), Some(9) => Some(Osc::Nine), Some(777) => Some(Osc::SevenSeventySeven), _ => None };
                    self.st = if self.osc.is_some() { St::OscPayload } else { St::OscIgnore };
                }
                // xterm aborts the command: nothing is dispatched at its end.
                _ => { self.id = None; self.st = St::OscIgnore; }
            },
            St::OscPayload => {
                self.units += if c >= 0x1_0000 { 2 } else { 1 };
                if self.units > OSC_LIMIT { self.overflow = true; }
                match self.osc {
                    Some(Osc::Status) => {
                        if self.overflow { return; }
                        let mut tmp = [0u8; 4];
                        let encoded = char::from_u32(c).map_or(&[][..], |ch| ch.encode_utf8(&mut tmp).as_bytes());
                        if self.len + encoded.len() > MAX_PAYLOAD { self.overflow = true; return; }
                        self.buf[self.len..self.len + encoded.len()].copy_from_slice(encoded);
                        self.len += encoded.len();
                    }
                    Some(Osc::Nine) => self.prefix = match (self.prefix, c) {
                        (Prefix::Start | Prefix::Digits, 0x30..=0x39) => Prefix::Digits,
                        (Prefix::Digits, 0x3b) => Prefix::No,
                        (Prefix::Start | Prefix::Digits, _) => Prefix::Yes,
                        (done, _) => done,
                    },
                    Some(Osc::SevenSeventySeven) => self.prefix = match self.prefix {
                        Prefix::Start | Prefix::Matched(_) => {
                            let at = if let Prefix::Matched(n) = self.prefix { n } else { 0 };
                            if c == u32::from(NOTIFY[at as usize]) { if at + 1 == 7 { Prefix::Yes } else { Prefix::Matched(at + 1) } } else { Prefix::No }
                        }
                        done => done,
                    },
                    None => {}
                }
            }
            _ => {}
        }
    }

    fn end(&mut self, offset: usize, emit: &mut impl FnMut(usize, Signal)) {
        // An identifier without ';' still dispatches with an empty payload.
        let (osc, payload_state) = match self.st {
            St::OscId => (match self.id { Some(7501) => Some(Osc::Status), Some(9) => Some(Osc::Nine), Some(777) => Some(Osc::SevenSeventySeven), _ => None }, true),
            St::OscPayload if !self.overflow => (self.osc, false),
            _ => (None, false),
        };
        let signal = match osc {
            Some(Osc::Status) => {
                let payload = if payload_state { &[][..] } else { &self.buf[..self.len] };
                match parse_program_status(payload) {
                    Some(Some(state)) => Some(Signal::State(state)),
                    Some(None) => Some(Signal::Clear),
                    None => None,
                }
            }
            Some(Osc::Nine) => matches!(self.prefix, Prefix::Start | Prefix::Digits | Prefix::Yes).then_some(Signal::Notify),
            Some(Osc::SevenSeventySeven) => (self.prefix == Prefix::Yes).then_some(Signal::Notify),
            None => None,
        };
        // Nothing of the payload survives the sequence.
        self.forget();
        if let Some(signal) = signal { emit(offset, signal); }
    }
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
    #[test]
    fn repro_payload_bytes_are_erased() {
        let mut scanner = Scanner::new();
        scanner.feed(b"\x1b]7501;state=working:title=SENTINEL\x07\x1b]7501;title=ABORTED\x18", |_, _| {});
        assert!(scanner.buf.iter().all(|b| *b == 0), "payload bytes left in the buffer");
    }

    #[test]
    fn notifications_follow_xterm_payload_limit_without_storing_text() {
        for (len, expected) in [(OSC_LIMIT as usize, 1usize), (OSC_LIMIT as usize + 1, 0)] {
            let mut scanner = Scanner::new();
            let mut events = 0;
            scanner.feed(b"\x1b]9;", |_, _| events += 1);
            let chunk = vec![b'a'; 1 << 20];
            let mut left = len;
            while left > 0 { let n = left.min(chunk.len()); scanner.feed(&chunk[..n], |_, _| events += 1); left -= n; }
            scanner.feed(b"\x07", |_, _| events += 1);
            assert_eq!(events, expected, "payload of {len} units");
            assert!(scanner.buf.iter().all(|b| *b == 0));
        }
    }

}
