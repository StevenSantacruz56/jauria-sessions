//! Exact native consent presentation. Cf intervals derived from Unicode 17.0.0
//! https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt (provenance in review).
//! Non-ASCII JSON is always escaped for a stable, unambiguous native display.
use serde_json::Value;
const FORMAT:&[(u32,u32)]=&[
    (0xAD,0xAD),
    (0x600,0x605),
    (0x61C,0x61C),
    (0x6DD,0x6DD),
    (0x70F,0x70F),
    (0x890,0x891),
    (0x8E2,0x8E2),
    (0x180E,0x180E),
    (0x200B,0x200F),
    (0x202A,0x202E),
    (0x2060,0x2064),
    (0x2066,0x206F),
    (0xFEFF,0xFEFF),
    (0xFFF9,0xFFFB),
    (0x110BD,0x110BD),
    (0x110CD,0x110CD),
    (0x13430,0x1343F),
    (0x1BCA0,0x1BCA3),
    (0x1D173,0x1D17A),
    (0xE0001,0xE0001),
    (0xE0020,0xE007F),
];
pub fn supported(text:&str)->bool {
    text.chars().all(|c|!c.is_control() && !FORMAT.iter().any(|(a,b)|(*a..=*b).contains(&(c as u32))))
}
pub fn visible_json(value:&Value)->Result<String,serde_json::Error>{
    let json=serde_json::to_string(value)?;let mut shown=String::new();
    for c in json.chars(){
        if c.is_ascii(){shown.push(c);}else{
            for unit in c.encode_utf16(&mut [0u16;2]) {use std::fmt::Write;write!(shown,"\\u{unit:04x}").expect("String formatting cannot fail");}
        }
    }
    Ok(shown)
}
/// Bound native consent presentation, not just unescaped wire bytes.
/// Large or padded commands remain rejectable without opening an approval.
/// Codex 0.167.1 identifies the verified local thread environment as "local".
/// Runtime boot verifies this ID's cwd/roots before admitting model turns.
pub fn local_environment(value:&Value)->bool {value.is_null() || value.as_str()==Some("local")}
pub fn compact_command(command:&str,cwd:&str)->Option<(String,String)>{
    if !supported(command)||!supported(cwd){return None;}
    if [command,cwd].iter().any(|s|s.as_bytes().windows(17).any(|w|w.iter().all(|c|*c==b' '))){return None;}
    let command=visible_json(&Value::String(command.to_owned())).ok()?;
    let cwd=visible_json(&Value::String(cwd.to_owned())).ok()?;
    if command.len()+cwd.len()>1024{return None;}Some((command,cwd))
}
#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    #[test]fn only_implicit_or_verified_local_environment_is_supported(){
        assert!(local_environment(&Value::Null));assert!(local_environment(&json!("local")));
        for value in [json!("remote"),json!("LOCAL"),json!("local-other"),json!(""),json!({"id":"local"}),json!(false)]{assert!(!local_environment(&value));}
    }
    #[test]fn consent_bounds_escaped_presentation_and_padding(){
        assert!(compact_command("pwd","/repo á").is_some());
        assert!(compact_command(&"x".repeat(1020),"/repo").is_none());
        assert!(compact_command(&"🐺".repeat(100),"/repo").is_none());
        assert!(compact_command("ls                 ; rm dangerous","/repo").is_none());
    }

    #[test]fn format_and_controls_cannot_be_approved(){
        for (a,b) in FORMAT{for code in *a..=*b{assert!(!supported(&char::from_u32(code).unwrap().to_string()));}}
        for c in ['\0','\n','\t','\u{0085}','\u{009b}','\u{202e}','\u{200b}','\u{feff}']{assert!(!supported(&format!("echo safe{c}; dangerous")));}
        assert!(supported("/repo con á/archivo 🐺"));
    }
    #[test]fn exact_ascii_json_roundtrips_accents_controls_and_supplementary_characters(){
        let value=json!(["/repo con á/🐺","safe\u{202e}bad\u{202c}","\n\t\u{0085}"]);
        let shown=visible_json(&value).unwrap();assert!(shown.is_ascii());assert!(shown.contains("\\u202e"));assert!(shown.contains("\\ud83d\\udc3a"));
        assert_eq!(serde_json::from_str::<Value>(&shown).unwrap(),value);
    }
}
