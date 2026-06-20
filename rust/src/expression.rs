/// One host-call syntax node with raw argument source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Call<'a> {
    /// Template-visible capability name.
    pub name: &'a [u8],
    /// Comma-separated argument source without parentheses.
    pub arguments: &'a [u8],
}

/// One directly resolvable expression atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Atom<'a> {
    /// A dotted lookup into the copied render context.
    Lookup(&'a [u8]),
    /// A UTF-8 string literal without its quotes.
    String(&'a [u8]),
    /// A decimal numeric literal retained in source form.
    Number(&'a [u8]),
    /// A boolean literal.
    Boolean(bool),
    /// The null/none literal.
    Null,
    /// The undefined literal.
    Undefined,
    /// A callable global expression.
    Call(Call<'a>),
}

/// One operation following an expression's base atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation<'a> {
    /// A `| filter(...)` operation.
    Filter(Call<'a>),
    /// An `is [not] test(...)` operation.
    Test { call: Call<'a>, negated: bool },
}

/// A malformed or currently unsupported expression shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExpressionError;

/// Parses the base atom and returns the cursor at its first following operation.
pub fn parse_base(expression: &[u8]) -> Result<(Atom<'_>, usize), ExpressionError> {
    let cursor = skip_whitespace(expression, 0);
    let (atom, cursor) = parse_atom(expression, cursor)?;
    Ok((atom, skip_whitespace(expression, cursor)))
}

/// Parses the next filter or test operation from a previously returned cursor.
pub fn next_operation(
    expression: &[u8],
    cursor: usize,
) -> Result<Option<(Operation<'_>, usize)>, ExpressionError> {
    let mut cursor = skip_whitespace(expression, cursor);
    if cursor == expression.len() {
        return Ok(None);
    }
    if expression[cursor] == b'|' {
        cursor = skip_whitespace(expression, cursor + 1);
        let (call, cursor) = parse_named_call(expression, cursor)?;
        return Ok(Some((
            Operation::Filter(call),
            skip_whitespace(expression, cursor),
        )));
    }
    if has_keyword(expression, cursor, b"is") {
        cursor = skip_whitespace(expression, cursor + 2);
        let negated = has_keyword(expression, cursor, b"not");
        if negated {
            cursor = skip_whitespace(expression, cursor + 3);
        }
        let (call, cursor) = parse_named_call(expression, cursor)?;
        return Ok(Some((
            Operation::Test { call, negated },
            skip_whitespace(expression, cursor),
        )));
    }
    Err(ExpressionError)
}

/// Parses one comma-separated call argument from a raw call argument slice.
pub fn next_argument(
    arguments: &[u8],
    cursor: usize,
) -> Result<Option<(Atom<'_>, usize)>, ExpressionError> {
    let cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(None);
    }
    let (atom, mut cursor) = parse_atom(arguments, cursor)?;
    cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(Some((atom, cursor)));
    }
    if arguments[cursor] != b',' {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(arguments, cursor + 1);
    if cursor == arguments.len() {
        return Err(ExpressionError);
    }
    Ok(Some((atom, cursor)))
}

/// Parses a complete custom-tag directive using the inline call grammar.
pub fn parse_tag_call(directive: &[u8]) -> Result<Call<'_>, ExpressionError> {
    let cursor = skip_whitespace(directive, 0);
    let (call, cursor) = parse_named_call(directive, cursor)?;
    if skip_whitespace(directive, cursor) != directive.len() {
        return Err(ExpressionError);
    }
    Ok(call)
}

fn parse_atom(bytes: &[u8], cursor: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let byte = *bytes.get(cursor).ok_or(ExpressionError)?;
    if matches!(byte, b'\'' | b'"') {
        return parse_string(bytes, cursor, byte);
    }
    if byte.is_ascii_digit()
        || ((byte == b'-' || byte == b'+') && bytes.get(cursor + 1).is_some_and(u8::is_ascii_digit))
    {
        return parse_number(bytes, cursor);
    }
    if !is_identifier_start(byte) {
        return Err(ExpressionError);
    }

    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while bytes.get(cursor) == Some(&b'.') {
        cursor = parse_path_segment(bytes, cursor + 1)?;
    }
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&b'(') {
        if name.contains(&b'.') {
            return Err(ExpressionError);
        }
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        return Ok((Atom::Call(Call { name, arguments }), end));
    }
    let atom = match name {
        b"true" => Atom::Boolean(true),
        b"false" => Atom::Boolean(false),
        b"none" | b"null" => Atom::Null,
        b"undefined" => Atom::Undefined,
        _ => Atom::Lookup(name),
    };
    Ok((atom, cursor))
}

fn parse_named_call(bytes: &[u8], cursor: usize) -> Result<(Call<'_>, usize), ExpressionError> {
    let start = cursor;
    let cursor = parse_identifier(bytes, cursor)?;
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&b'(') {
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        Ok((Call { name, arguments }, end))
    } else {
        Ok((
            Call {
                name,
                arguments: b"",
            },
            cursor,
        ))
    }
}

fn parse_string(
    bytes: &[u8],
    cursor: usize,
    quote: u8,
) -> Result<(Atom<'_>, usize), ExpressionError> {
    let start = cursor + 1;
    let mut cursor = start;
    while let Some(byte) = bytes.get(cursor) {
        if *byte == quote {
            return Ok((Atom::String(&bytes[start..cursor]), cursor + 1));
        }
        if *byte == b'\\' {
            return Err(ExpressionError);
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_number(bytes: &[u8], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start;
    if matches!(bytes.get(cursor), Some(b'-' | b'+')) {
        cursor += 1;
    }
    let integer_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    if cursor == integer_start {
        return Err(ExpressionError);
    }
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return Err(ExpressionError);
        }
    }
    Ok((Atom::Number(&bytes[start..cursor]), cursor))
}

fn parse_parenthesized(bytes: &[u8], open: usize) -> Result<(&[u8], usize), ExpressionError> {
    let mut cursor = open + 1;
    let start = cursor;
    let mut quote = None;
    let mut depth = 1usize;
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
        } else if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
            if depth == 0 {
                return Ok((&bytes[start..cursor], cursor + 1));
            }
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_identifier(bytes: &[u8], cursor: usize) -> Result<usize, ExpressionError> {
    if !bytes.get(cursor).copied().is_some_and(is_identifier_start) {
        return Err(ExpressionError);
    }
    let mut cursor = cursor + 1;
    while bytes
        .get(cursor)
        .copied()
        .is_some_and(is_identifier_continue)
    {
        cursor += 1;
    }
    Ok(cursor)
}

fn parse_path_segment(bytes: &[u8], cursor: usize) -> Result<usize, ExpressionError> {
    if bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        let mut cursor = cursor + 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        Ok(cursor)
    } else {
        parse_identifier(bytes, cursor)
    }
}

fn has_keyword(bytes: &[u8], cursor: usize, keyword: &[u8]) -> bool {
    bytes.get(cursor..cursor + keyword.len()) == Some(keyword)
        && bytes
            .get(cursor + keyword.len())
            .is_none_or(|byte| byte.is_ascii_whitespace())
}

fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    cursor
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_globals_filters_tests_and_arguments() {
        let expression = br#"hello("World", user.name) | suffix("!") is not empty"#;
        let (base, cursor) = parse_base(expression).unwrap();
        assert_eq!(
            base,
            Atom::Call(Call {
                name: b"hello",
                arguments: br#""World", user.name"#,
            }),
        );
        let (first, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            first,
            Operation::Filter(Call {
                name: b"suffix",
                arguments: br#""!""#,
            }),
        );
        let (second, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            second,
            Operation::Test {
                call: Call {
                    name: b"empty",
                    arguments: b"",
                },
                negated: true,
            },
        );
        assert_eq!(next_operation(expression, cursor), Ok(None));

        let Atom::Call(call) = base else {
            panic!("expected call");
        };
        let (first, cursor) = next_argument(call.arguments, 0).unwrap().unwrap();
        assert_eq!(first, Atom::String(b"World"));
        let (second, cursor) = next_argument(call.arguments, cursor).unwrap().unwrap();
        assert_eq!(second, Atom::Lookup(b"user.name"));
        assert_eq!(next_argument(call.arguments, cursor), Ok(None));
    }

    #[test]
    fn rejects_trailing_arguments_and_unsupported_operators() {
        assert!(parse_base(b"value + 1").is_ok());
        let (_, cursor) = parse_base(b"value + 1").unwrap();
        assert_eq!(next_operation(b"value + 1", cursor), Err(ExpressionError));
        assert_eq!(next_argument(b"value,", 0), Err(ExpressionError));
        assert_eq!(parse_base(br#""escaped\"""#), Err(ExpressionError));
        assert_eq!(
            parse_tag_call(br#" badge("new", user.name) "#),
            Ok(Call {
                name: b"badge",
                arguments: br#""new", user.name"#,
            }),
        );
        assert_eq!(parse_tag_call(b"badge trailing"), Err(ExpressionError));
    }
}
