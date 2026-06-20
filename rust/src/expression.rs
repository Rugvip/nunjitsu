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
    /// A parenthesized expression evaluated as one operand.
    Group(&'a [u8]),
    /// An array literal's comma-separated element source.
    Array(&'a [u8]),
    /// An object literal's comma-separated entry source.
    Record(&'a [u8]),
}

/// One atom with an optional unary `not` operator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Operand<'a> {
    /// Directly resolvable operand value.
    pub atom: Atom<'a>,
    /// Whether truthiness is inverted before applying the next operation.
    pub negated: bool,
}

/// Supported comparison operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Comparison {
    Equal,
    StrictEqual,
    NotEqual,
    StrictNotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    In,
    NotIn,
}

/// One operation following an expression's base atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation<'a> {
    /// A `| filter(...)` operation.
    Filter(Call<'a>),
    /// An `is [not] test(...)` operation.
    Test { call: Call<'a>, negated: bool },
    /// A comparison against one following operand.
    Compare {
        operator: Comparison,
        operand: Operand<'a>,
    },
    /// A short-circuiting boolean `and` operation.
    And(Operand<'a>),
    /// A short-circuiting boolean `or` operation.
    Or(Operand<'a>),
}

/// A malformed or currently unsupported expression shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExpressionError;

/// Parsed variable binding and iterable expression for a `for` directive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForClause<'a> {
    /// First item or key binding.
    pub first: &'a [u8],
    /// Optional second binding used for destructuring or object values.
    pub second: Option<&'a [u8]>,
    /// Iterable expression after the `in` keyword.
    pub iterable: &'a [u8],
}

/// One parsed object-literal entry and the cursor of the following entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordEntry<'a> {
    /// UTF-8 key without quotes.
    pub key: &'a [u8],
    /// Parsed entry value.
    pub value: Atom<'a>,
    /// Cursor after this entry and its comma.
    pub next_cursor: usize,
}

/// Parses the base atom, its unary negation, and the following operation cursor.
pub fn parse_base(expression: &[u8]) -> Result<(Atom<'_>, usize, bool), ExpressionError> {
    let (operand, cursor) = parse_operand(expression, 0)?;
    Ok((operand.atom, cursor, operand.negated))
}

/// Returns each validated dotted or bracketed lookup segment in order.
pub fn next_lookup_segment(
    path: &[u8],
    cursor: usize,
) -> Result<Option<(&[u8], usize)>, ExpressionError> {
    if cursor == path.len() {
        return Ok(None);
    }
    let mut cursor = cursor;
    if cursor != 0 && path.get(cursor) == Some(&b'.') {
        cursor += 1;
    }
    if path.get(cursor) == Some(&b'[') {
        cursor = skip_whitespace(path, cursor + 1);
        let quote = path.get(cursor).copied();
        let (segment, next) = if matches!(quote, Some(b'\'' | b'"')) {
            let quote = quote.ok_or(ExpressionError)?;
            let start = cursor + 1;
            let mut end = start;
            while path.get(end).is_some_and(|byte| *byte != quote) {
                if path[end] == b'\\' {
                    return Err(ExpressionError);
                }
                end += 1;
            }
            if path.get(end) != Some(&quote) {
                return Err(ExpressionError);
            }
            (&path[start..end], end + 1)
        } else {
            let start = cursor;
            while path.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            if cursor == start {
                return Err(ExpressionError);
            }
            (&path[start..cursor], cursor)
        };
        let next = skip_whitespace(path, next);
        if path.get(next) != Some(&b']') {
            return Err(ExpressionError);
        }
        return Ok(Some((segment, next + 1)));
    }
    let start = cursor;
    let end = parse_path_segment(path, cursor)?;
    Ok(Some((&path[start..end], end)))
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
    if has_keyword(expression, cursor, b"not") {
        let next = skip_whitespace(expression, cursor + 3);
        if has_keyword(expression, next, b"in") {
            let (operand, cursor) = parse_operand(expression, next + 2)?;
            return Ok(Some((
                Operation::Compare {
                    operator: Comparison::NotIn,
                    operand,
                },
                cursor,
            )));
        }
    }
    if has_keyword(expression, cursor, b"in") {
        let (operand, cursor) = parse_operand(expression, cursor + 2)?;
        return Ok(Some((
            Operation::Compare {
                operator: Comparison::In,
                operand,
            },
            cursor,
        )));
    }
    if has_keyword(expression, cursor, b"and") {
        let (operand, cursor) = parse_operand(expression, cursor + 3)?;
        return Ok(Some((Operation::And(operand), cursor)));
    }
    if has_keyword(expression, cursor, b"or") {
        let (operand, cursor) = parse_operand(expression, cursor + 2)?;
        return Ok(Some((Operation::Or(operand), cursor)));
    }
    for (symbol, operator) in [
        (b"!==".as_slice(), Comparison::StrictNotEqual),
        (b"===".as_slice(), Comparison::StrictEqual),
        (b"!=".as_slice(), Comparison::NotEqual),
        (b"==".as_slice(), Comparison::Equal),
        (b"<=".as_slice(), Comparison::LessOrEqual),
        (b">=".as_slice(), Comparison::GreaterOrEqual),
        (b"<".as_slice(), Comparison::Less),
        (b">".as_slice(), Comparison::Greater),
    ] {
        if expression.get(cursor..cursor + symbol.len()) == Some(symbol) {
            let (operand, cursor) = parse_operand(expression, cursor + symbol.len())?;
            return Ok(Some((Operation::Compare { operator, operand }, cursor)));
        }
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

/// Parses one object-literal entry from a comma-separated entry slice.
pub fn next_record_entry(
    entries: &[u8],
    cursor: usize,
) -> Result<Option<RecordEntry<'_>>, ExpressionError> {
    let mut cursor = skip_whitespace(entries, cursor);
    if cursor == entries.len() {
        return Ok(None);
    }
    let (key, next) = if matches!(entries.get(cursor), Some(b'\'' | b'"')) {
        let quote = entries[cursor];
        let start = cursor + 1;
        let mut end = start;
        while entries.get(end).is_some_and(|byte| *byte != quote) {
            if entries[end] == b'\\' {
                return Err(ExpressionError);
            }
            end += 1;
        }
        if entries.get(end) != Some(&quote) {
            return Err(ExpressionError);
        }
        (&entries[start..end], end + 1)
    } else {
        let start = cursor;
        let end = parse_identifier(entries, cursor)?;
        (&entries[start..end], end)
    };
    cursor = skip_whitespace(entries, next);
    if entries.get(cursor) != Some(&b':') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(entries, cursor + 1);
    let (value, mut cursor) = parse_atom(entries, cursor)?;
    cursor = skip_whitespace(entries, cursor);
    if cursor == entries.len() {
        return Ok(Some(RecordEntry {
            key,
            value,
            next_cursor: cursor,
        }));
    }
    if entries.get(cursor) != Some(&b',') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(entries, cursor + 1);
    if cursor == entries.len() {
        return Err(ExpressionError);
    }
    Ok(Some(RecordEntry {
        key,
        value,
        next_cursor: cursor,
    }))
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

/// Parses `name [ , name ] in expression` without evaluating the iterable.
pub fn parse_for_clause(source: &[u8]) -> Result<ForClause<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let first_start = cursor;
    cursor = parse_identifier(source, cursor)?;
    let first = &source[first_start..cursor];
    cursor = skip_whitespace(source, cursor);
    let second = if source.get(cursor) == Some(&b',') {
        cursor = skip_whitespace(source, cursor + 1);
        let start = cursor;
        cursor = parse_identifier(source, cursor)?;
        let second = &source[start..cursor];
        cursor = skip_whitespace(source, cursor);
        Some(second)
    } else {
        None
    };
    if !has_keyword(source, cursor, b"in") {
        return Err(ExpressionError);
    }
    let iterable = &source[skip_whitespace(source, cursor + 2)..];
    if iterable.is_empty() {
        return Err(ExpressionError);
    }
    Ok(ForClause {
        first,
        second,
        iterable,
    })
}

fn parse_atom(bytes: &[u8], cursor: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let byte = *bytes.get(cursor).ok_or(ExpressionError)?;
    if byte == b'(' {
        let (expression, cursor) = parse_parenthesized(bytes, cursor)?;
        return Ok((Atom::Group(expression), cursor));
    }
    if byte == b'[' {
        let (elements, cursor) = parse_delimited(bytes, cursor, b'[', b']')?;
        return Ok((Atom::Array(elements), cursor));
    }
    if byte == b'{' {
        let (entries, cursor) = parse_delimited(bytes, cursor, b'{', b'}')?;
        return Ok((Atom::Record(entries), cursor));
    }
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
    while matches!(bytes.get(cursor), Some(b'.' | b'[')) {
        let Some((_, next)) = next_lookup_segment(&bytes[start..], cursor - start)? else {
            return Err(ExpressionError);
        };
        cursor = start + next;
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

fn parse_operand(bytes: &[u8], cursor: usize) -> Result<(Operand<'_>, usize), ExpressionError> {
    let mut cursor = skip_whitespace(bytes, cursor);
    let negated = has_keyword(bytes, cursor, b"not");
    if negated {
        cursor = skip_whitespace(bytes, cursor + 3);
    }
    let (atom, cursor) = parse_atom(bytes, cursor)?;
    Ok((Operand { atom, negated }, skip_whitespace(bytes, cursor)))
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
    parse_delimited(bytes, open, b'(', b')')
}

fn parse_delimited(
    bytes: &[u8],
    open: usize,
    expected_open: u8,
    expected_close: u8,
) -> Result<(&[u8], usize), ExpressionError> {
    if bytes.get(open) != Some(&expected_open) {
        return Err(ExpressionError);
    }
    let start = open + 1;
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = usize::from(expected_open == b'(');
    let mut brackets = usize::from(expected_open == b'[');
    let mut braces = usize::from(expected_open == b'{');
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
            parentheses += 1;
        } else if byte == b'[' {
            brackets += 1;
        } else if byte == b'{' {
            braces += 1;
        } else if byte == b')' {
            parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == b']' {
            brackets = brackets.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == b'}' {
            braces = braces.checked_sub(1).ok_or(ExpressionError)?;
        }
        if byte == expected_close && parentheses == 0 && brackets == 0 && braces == 0 {
            return Ok((&bytes[start..cursor], cursor + 1));
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
        let (base, cursor, negated) = parse_base(expression).unwrap();
        assert!(!negated);
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
        let (_, cursor, _) = parse_base(b"value + 1").unwrap();
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
        assert_eq!(
            parse_base(br#"not user["profile"].flags[0]"#),
            Ok((Atom::Lookup(br#"user["profile"].flags[0]"#), 28, true)),
        );
        let path = br#"user["profile"].flags[0]"#;
        let mut cursor = 0;
        let mut segments = Vec::new();
        while let Some((segment, next)) = next_lookup_segment(path, cursor).unwrap() {
            segments.push(segment);
            cursor = next;
        }
        assert_eq!(
            segments,
            [
                b"user".as_slice(),
                b"profile".as_slice(),
                b"flags".as_slice(),
                b"0".as_slice(),
            ],
        );
    }

    #[test]
    fn parses_boolean_and_comparison_operations() {
        let expression = br#"(hungry or pizza) and not anchovies or food == "salad""#;
        let (base, cursor, negated) = parse_base(expression).unwrap();
        assert_eq!(base, Atom::Group(b"hungry or pizza"));
        assert!(!negated);
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::And(Operand {
                atom: Atom::Lookup(b"anchovies"),
                negated: true,
            }),
        );
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::Or(Operand {
                atom: Atom::Lookup(b"food"),
                negated: false,
            }),
        );
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::Compare {
                operator: Comparison::Equal,
                operand: Operand {
                    atom: Atom::String(b"salad"),
                    negated: false,
                },
            },
        );
        assert_eq!(next_operation(expression, cursor), Ok(None));
        assert_eq!(
            parse_for_clause(b" key, value in items | entries "),
            Ok(ForClause {
                first: b"key",
                second: Some(b"value"),
                iterable: b"items | entries ",
            }),
        );

        let (array, cursor, _) = parse_base(br#"[1, "two", { three: 3 }]"#).unwrap();
        assert_eq!(array, Atom::Array(br#"1, "two", { three: 3 }"#),);
        assert_eq!(cursor, 24);
        let Atom::Array(elements) = array else {
            panic!("expected array");
        };
        let (_, cursor) = next_argument(elements, 0).unwrap().unwrap();
        let (_, cursor) = next_argument(elements, cursor).unwrap().unwrap();
        let (record, cursor) = next_argument(elements, cursor).unwrap().unwrap();
        assert_eq!(next_argument(elements, cursor), Ok(None));
        let Atom::Record(entries) = record else {
            panic!("expected record");
        };
        assert_eq!(
            next_record_entry(entries, 0),
            Ok(Some(RecordEntry {
                key: b"three",
                value: Atom::Number(b"3"),
                next_cursor: entries.len(),
            })),
        );
    }
}
