use nunjitsu_engine::{RenderedValue, render_template};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityDocument {
    schema_version: u32,
    cases: Vec<CompatibilityCase>,
}

#[derive(Deserialize)]
struct CompatibilityCase {
    id: String,
    template: String,
    context: Map<String, Value>,
    autoescape: bool,
    expected: String,
}

#[test]
fn renders_shared_compatibility_cases_natively() {
    let document: CompatibilityDocument =
        serde_json::from_str(include_str!("../../tests/compat/cases.json")).unwrap();
    assert_eq!(document.schema_version, 1);

    for case in document.cases {
        let mut output = vec![0; case.expected.len().saturating_mul(6).max(1024)];
        let written = render_template(
            case.template.as_bytes(),
            case.autoescape,
            |path| lookup(&case.context, path),
            &mut output,
        )
        .unwrap_or_else(|error| panic!("{} failed: {error:?}", case.id));
        assert_eq!(
            std::str::from_utf8(&output[..written]).unwrap(),
            case.expected,
            "{}",
            case.id,
        );
    }
}

fn lookup<'a>(context: &'a Map<String, Value>, path: &[u8]) -> Option<RenderedValue<'a>> {
    let path = std::str::from_utf8(path).ok()?;
    let (first, mut cursor) = next_segment(path, 0)?;
    let mut value = context.get(first)?;
    while cursor < path.len() {
        let (segment, next) = next_segment(path, cursor)?;
        value = value.as_object()?.get(segment)?;
        cursor = next;
    }
    match value {
        Value::String(value) => Some(RenderedValue {
            bytes: value.as_bytes(),
            safe: false,
        }),
        Value::Null => Some(RenderedValue {
            bytes: b"",
            safe: false,
        }),
        Value::Object(tagged)
            if tagged.get("$nunjitsu").and_then(Value::as_str) == Some("safe") =>
        {
            Some(RenderedValue {
                bytes: tagged.get("value")?.as_str()?.as_bytes(),
                safe: true,
            })
        }
        _ => None,
    }
}

fn next_segment(path: &str, cursor: usize) -> Option<(&str, usize)> {
    let bytes = path.as_bytes();
    let mut cursor = cursor;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'[') {
        let quote = *bytes.get(cursor + 1)?;
        if !matches!(quote, b'\'' | b'"') {
            return None;
        }
        let start = cursor + 2;
        let end = bytes[start..].iter().position(|byte| *byte == quote)? + start;
        if bytes.get(end + 1) != Some(&b']') {
            return None;
        }
        return Some((&path[start..end], end + 2));
    }
    let start = cursor;
    while bytes
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    {
        cursor += 1;
    }
    (cursor > start).then_some((&path[start..cursor], cursor))
}
