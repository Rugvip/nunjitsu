/// Parses a complete custom-tag directive using parenthesized or legacy arguments.
pub fn parse_tag_call(directive: &[u8]) -> Result<Call<'_>, ExpressionError> {
    let cursor = skip_whitespace(directive, 0);
    let name_start = cursor;
    let name_end = parse_identifier(directive, cursor)?;
    let name = &directive[name_start..name_end];
    let cursor = skip_whitespace(directive, name_end);
    if directive.get(cursor) == Some(&b'(') {
        let (arguments, cursor) = parse_parenthesized(directive, cursor)?;
        if skip_whitespace(directive, cursor) != directive.len() {
            return Err(ExpressionError);
        }
        return Ok(Call { name, arguments });
    }
    Ok(Call {
        name,
        arguments: trim_whitespace(&directive[cursor..]),
    })
}

/// Returns the leading identifier of a custom-tag directive.
#[cfg(target_arch = "wasm32")]
pub fn parse_tag_name(directive: &[u8]) -> Result<&[u8], ExpressionError> {
    let start = skip_whitespace(directive, 0);
    let end = parse_identifier(directive, start)?;
    Ok(&directive[start..end])
}

/// Parses `(optional, bindings) macro(arguments)` call-block syntax.
pub fn parse_call_block(source: &[u8]) -> Result<CallBlock<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let bindings = if source.get(cursor) == Some(&b'(') {
        let (bindings, next) = parse_parenthesized(source, cursor)?;
        let mut binding_cursor = 0usize;
        while let Some((_, next)) = next_binding(bindings, binding_cursor)? {
            binding_cursor = next;
        }
        cursor = skip_whitespace(source, next);
        bindings
    } else {
        b""
    };
    let (call, cursor) = parse_named_call(source, cursor)?;
    if skip_whitespace(source, cursor) != source.len() {
        return Err(ExpressionError);
    }
    Ok(CallBlock { bindings, call })
}

/// Parses `template-expression as namespace [with|without context]`.
pub fn parse_import_clause(source: &[u8]) -> Result<ImportClause<'_>, ExpressionError> {
    let start = skip_whitespace(source, 0);
    let expression_end = find_top_level_keyword(source, start, b"as")?;
    let template = trim_whitespace(&source[start..expression_end]);
    if template.is_empty() {
        return Err(ExpressionError);
    }
    let mut cursor = skip_whitespace(source, expression_end + 2);
    let alias_start = cursor;
    cursor = parse_identifier(source, cursor)?;
    let alias = &source[alias_start..cursor];
    cursor = skip_whitespace(source, cursor);
    let with_context = if cursor == source.len() {
        false
    } else if has_keyword(source, cursor, b"with") {
        cursor = skip_whitespace(source, cursor + 4);
        if !has_keyword(source, cursor, b"context") {
            return Err(ExpressionError);
        }
        cursor = skip_whitespace(source, cursor + 7);
        true
    } else if has_keyword(source, cursor, b"without") {
        cursor = skip_whitespace(source, cursor + 7);
        if !has_keyword(source, cursor, b"context") {
            return Err(ExpressionError);
        }
        cursor = skip_whitespace(source, cursor + 7);
        false
    } else {
        return Err(ExpressionError);
    };
    if cursor != source.len() {
        return Err(ExpressionError);
    }
    Ok(ImportClause {
        template,
        alias,
        with_context,
    })
}

/// Parses `template-expression import names [with|without context]`.
pub fn parse_from_import_clause(source: &[u8]) -> Result<FromImportClause<'_>, ExpressionError> {
    let start = skip_whitespace(source, 0);
    let expression_end = find_top_level_keyword(source, start, b"import")?;
    let template = trim_whitespace(&source[start..expression_end]);
    if template.is_empty() {
        return Err(ExpressionError);
    }
    let mut cursor = skip_whitespace(source, expression_end + 6);
    let bindings_start = cursor;
    let first = next_import_binding(source, cursor)?.ok_or(ExpressionError)?;
    let mut bindings_end = first.next_cursor;
    cursor = skip_whitespace(source, first.next_cursor);
    while cursor != source.len()
        && !has_keyword(source, cursor, b"with")
        && !has_keyword(source, cursor, b"without")
    {
        let binding = next_import_binding(source, cursor)?.ok_or(ExpressionError)?;
        bindings_end = binding.next_cursor;
        cursor = skip_whitespace(source, binding.next_cursor);
    }
    if cursor == source.len() {
        return Ok(FromImportClause {
            template,
            bindings: trim_whitespace(&source[bindings_start..bindings_end]),
            with_context: false,
        });
    }
    let with_context = has_keyword(source, cursor, b"with");
    cursor = skip_whitespace(source, cursor + if with_context { 4 } else { 7 });
    if !has_keyword(source, cursor, b"context") {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(source, cursor + 7);
    if cursor != source.len() {
        return Err(ExpressionError);
    }
    Ok(FromImportClause {
        template,
        bindings: trim_whitespace(&source[bindings_start..bindings_end]),
        with_context,
    })
}

/// Parses one `name [as alias]` entry from an import binding list.
pub fn next_import_binding(
    bindings: &[u8],
    cursor: usize,
) -> Result<Option<ImportBinding<'_>>, ExpressionError> {
    let cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(None);
    }
    let name_start = cursor;
    let mut cursor = parse_identifier(bindings, cursor)?;
    let name = &bindings[name_start..cursor];
    if name.starts_with(b"_") {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(bindings, cursor);
    let alias = if has_keyword(bindings, cursor, b"as") {
        cursor = skip_whitespace(bindings, cursor + 2);
        let alias_start = cursor;
        cursor = parse_identifier(bindings, cursor)?;
        &bindings[alias_start..cursor]
    } else {
        name
    };
    cursor = skip_whitespace(bindings, cursor);
    let next_cursor = if cursor == bindings.len()
        || has_keyword(bindings, cursor, b"with")
        || has_keyword(bindings, cursor, b"without")
    {
        cursor
    } else {
        if bindings.get(cursor) != Some(&b',') {
            return Err(ExpressionError);
        }
        let next = skip_whitespace(bindings, cursor + 1);
        if next == bindings.len() {
            return Err(ExpressionError);
        }
        next
    };
    Ok(Some(ImportBinding {
        name,
        alias,
        next_cursor,
    }))
}

/// Parses one identifier from a validated comma-separated binding list.
pub fn next_binding(
    bindings: &[u8],
    cursor: usize,
) -> Result<Option<(&[u8], usize)>, ExpressionError> {
    let cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(None);
    }
    let start = cursor;
    let mut cursor = parse_identifier(bindings, cursor)?;
    let name = &bindings[start..cursor];
    cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(Some((name, cursor)));
    }
    if bindings.get(cursor) != Some(&b',') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(bindings, cursor + 1);
    if cursor == bindings.len() {
        return Err(ExpressionError);
    }
    Ok(Some((name, cursor)))
}

/// Parses `name [ , name ... ] in expression` without evaluating the iterable.
pub fn parse_for_clause(source: &[u8]) -> Result<ForClause<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let bindings_start = cursor;
    loop {
        cursor = parse_identifier(source, cursor)?;
        cursor = skip_whitespace(source, cursor);
        if source.get(cursor) != Some(&b',') {
            break;
        }
        cursor = skip_whitespace(source, cursor + 1);
    }
    let bindings = trim_whitespace(&source[bindings_start..cursor]);
    if !has_keyword(source, cursor, b"in") {
        return Err(ExpressionError);
    }
    let iterable = &source[skip_whitespace(source, cursor + 2)..];
    if iterable.is_empty() {
        return Err(ExpressionError);
    }
    Ok(ForClause { bindings, iterable })
}

/// Parses `name [ , name ... ] [ = expression ]` for assignment or capture.
pub fn parse_set_clause(source: &[u8]) -> Result<SetClause<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let targets_start = cursor;
    loop {
        cursor = parse_identifier(source, cursor)?;
        cursor = skip_whitespace(source, cursor);
        if source.get(cursor) != Some(&b',') {
            break;
        }
        cursor = skip_whitespace(source, cursor + 1);
    }
    let targets = trim_whitespace(&source[targets_start..cursor]);
    if cursor == source.len() {
        return Ok(SetClause {
            targets,
            expression: None,
        });
    }
    if source.get(cursor) != Some(&b'=') || source.get(cursor + 1) == Some(&b'=') {
        return Err(ExpressionError);
    }
    let expression = trim_whitespace(&source[cursor + 1..]);
    if expression.is_empty() {
        return Err(ExpressionError);
    }
    Ok(SetClause {
        targets,
        expression: Some(expression),
    })
}
