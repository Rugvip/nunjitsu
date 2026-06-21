/// Parses one comma-separated call argument from a raw call argument slice.
pub fn next_argument(
    arguments: &[u16],
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
    if arguments[cursor] != CU_COMMA {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(arguments, cursor + 1);
    if cursor == arguments.len() {
        return Err(ExpressionError);
    }
    Ok(Some((atom, cursor)))
}

/// Parses one macro definition parameter from a comma-separated signature.
pub fn next_macro_parameter(
    parameters: &[u16],
    cursor: usize,
) -> Result<Option<MacroParameter<'_>>, ExpressionError> {
    let cursor = skip_whitespace(parameters, cursor);
    if cursor == parameters.len() {
        return Ok(None);
    }
    let start = cursor;
    let mut cursor = parse_identifier(parameters, cursor)?;
    let name = &parameters[start..cursor];
    cursor = skip_whitespace(parameters, cursor);
    let default =
        if parameters.get(cursor) == Some(&CU_EQUALS) && parameters.get(cursor + 1) != Some(&CU_EQUALS) {
            cursor = skip_whitespace(parameters, cursor + 1);
            let (default, next) = parse_atom(parameters, cursor)?;
            cursor = skip_whitespace(parameters, next);
            Some(default)
        } else {
            None
        };
    let next_cursor = next_list_cursor(parameters, cursor)?;
    Ok(Some(MacroParameter {
        name,
        default,
        next_cursor,
    }))
}

/// Parses one positional or keyword macro call argument.
pub fn next_macro_argument(
    arguments: &[u16],
    cursor: usize,
) -> Result<Option<MacroArgument<'_>>, ExpressionError> {
    let cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(None);
    }
    let mut value_cursor = cursor;
    let name = if arguments
        .get(cursor)
        .copied()
        .is_some_and(is_identifier_start)
    {
        let end = parse_identifier(arguments, cursor)?;
        let following = skip_whitespace(arguments, end);
        if arguments.get(following) == Some(&CU_EQUALS) && arguments.get(following + 1) != Some(&CU_EQUALS) {
            value_cursor = skip_whitespace(arguments, following + 1);
            Some(&arguments[cursor..end])
        } else {
            None
        }
    } else {
        None
    };
    let (value, cursor) = parse_atom(arguments, value_cursor)?;
    let cursor = skip_whitespace(arguments, cursor);
    let next_cursor = next_list_cursor(arguments, cursor)?;
    Ok(Some(MacroArgument {
        name,
        value,
        next_cursor,
    }))
}

fn next_list_cursor(bytes: &[u16], cursor: usize) -> Result<usize, ExpressionError> {
    if cursor == bytes.len() {
        return Ok(cursor);
    }
    if bytes.get(cursor) != Some(&CU_COMMA) {
        return Err(ExpressionError);
    }
    let cursor = skip_whitespace(bytes, cursor + 1);
    if cursor == bytes.len() {
        return Err(ExpressionError);
    }
    Ok(cursor)
}

/// Parses one object-literal entry from a comma-separated entry slice.
pub fn next_record_entry(
    entries: &[u16],
    cursor: usize,
) -> Result<Option<RecordEntry<'_>>, ExpressionError> {
    let mut cursor = skip_whitespace(entries, cursor);
    if cursor == entries.len() {
        return Ok(None);
    }
    let (key, next) = if matches!(
        entries.get(cursor).copied(),
        Some(CU_APOSTROPHE | CU_QUOTE)
    ) {
        let quote = entries[cursor];
        let start = cursor + 1;
        let mut end = start;
        while entries.get(end).is_some_and(|byte| *byte != quote) {
            if entries[end] == CU_BACKSLASH {
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
    if entries.get(cursor) != Some(&CU_COLON) {
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
    if entries.get(cursor) != Some(&CU_COMMA) {
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
