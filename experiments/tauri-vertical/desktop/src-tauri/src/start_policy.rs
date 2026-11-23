/// Applies only the window's smoke-mode guard; generic request validation remains separate.
pub fn validate_start_mode(
    op: &str,
    args: &serde_json::Value,
    smoke: bool,
) -> Result<(), String> {
    if op == "start"
        && !matches!(args["kind"].as_str(), Some("codex" | "claude" | "terminal"))
        && !smoke
    {
        return Err("Herramientas de prueba deshabilitadas en esta ventana".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_start_mode;
    use serde_json::json;

    #[test]
    fn test_tools_require_smoke_mode() {
        for kind in ["fixture", "shell", "claude_probe", "codex_probe"] {
            let args = json!({"kind": kind});
            assert_eq!(
                validate_start_mode("start", &args, false),
                Err("Herramientas de prueba deshabilitadas en esta ventana".into()),
                "kind={kind}"
            );
            assert_eq!(
                validate_start_mode("start", &args, true),
                Ok(()),
                "kind={kind}"
            );
        }
    }

    #[test]
    fn interactive_providers_are_allowed_in_both_modes() {
        for kind in ["codex", "claude", "terminal"] {
            for smoke in [false, true] {
                assert_eq!(
                    validate_start_mode("start", &json!({"kind": kind}), smoke),
                    Ok(()),
                    "kind={kind}, smoke={smoke}"
                );
            }
        }
    }

    #[test]
    fn unknown_or_missing_kinds_follow_the_same_guard() {
        for args in [
            json!({"kind": "unknown"}),
            json!({}),
            json!({"kind": null}),
            json!({"kind": 1}),
        ] {
            assert_eq!(
                validate_start_mode("start", &args, false),
                Err("Herramientas de prueba deshabilitadas en esta ventana".into()),
                "args={args}"
            );
            // Smoke mode bypasses only this guard, not generic validation.
            assert_eq!(
                validate_start_mode("start", &args, true),
                Ok(()),
                "args={args}"
            );
        }
    }

    #[test]
    fn other_operations_are_left_to_generic_validation() {
        for op in [
            "status", "input", "resize", "interrupt", "stop", "events", "unknown", "",
        ] {
            for smoke in [false, true] {
                for args in [json!({"kind": "fixture"}), json!({}), json!(null)] {
                    assert_eq!(
                        validate_start_mode(op, &args, smoke),
                        Ok(()),
                        "op={op}, args={args}, smoke={smoke}"
                    );
                }
            }
        }
    }
}
