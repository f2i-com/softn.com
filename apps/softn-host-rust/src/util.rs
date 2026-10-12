/// A name as the directory that is made from it is really called. Windows
/// drops the dots and spaces at the end of a directory's name: the data
/// directory of `Notes...` is `Notes` there, and a database path built from
/// the name as given (`Notes...\Notes....sqlite`) did not open. Elsewhere a
/// name is its directory's name, unchanged, so no data moves.
pub fn directory_name(name: &str) -> &str {
    if cfg!(windows) {
        name.trim_end_matches(['.', ' '])
    } else {
        name
    }
}

/// Maximum JSON nesting depth for untrusted input.
/// Prevents stack overflow from deeply nested payloads like `[[[[...]]]]`.
/// serde_json has a built-in limit (~128), but we enforce a tighter limit
/// for defense in depth against malicious payloads.
pub const MAX_JSON_DEPTH: usize = 64;

/// How deep a request body may nest: 62 objects and arrays, the body itself
/// the first. It is what a handler can be handed. The request carries the
/// body one level down, and the engine passes a script nothing below that
/// (it puts `null` there), so a body one level deeper used to be accepted
/// here and then fail on its way to the handler, a 500 for what is the
/// client's mistake. The PHP host has the same limit and the same 400.
pub const MAX_BODY_DEPTH: usize = 62;

/// Parse JSON with explicit depth protection against stack overflow.
/// Performs a fast O(n) linear pre-scan to reject payloads that exceed
/// `max_depth` nesting levels before handing off to serde_json.
pub fn parse_json_bounded(input: &str, max_depth: usize) -> Result<serde_json::Value, String> {
    // Quick depth scan — O(n) linear pass, no allocations.
    // Tracks nesting depth of arrays/objects, respecting JSON string boundaries.
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escape = false;
    for byte in input.bytes() {
        if escape {
            escape = false;
            continue;
        }
        match byte {
            b'\\' if in_string => escape = true,
            b'"' => in_string = !in_string,
            b'[' | b'{' if !in_string => {
                depth += 1;
                if depth > max_depth {
                    return Err(format!(
                        "JSON nesting exceeds maximum depth of {}",
                        max_depth
                    ));
                }
            }
            b']' | b'}' if !in_string => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    serde_json::from_str(input).map_err(|e| format!("Invalid JSON: {}", e))
}
