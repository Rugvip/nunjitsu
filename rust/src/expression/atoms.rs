fn parse_atom(bytes: &[u16], cursor: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let byte = *bytes.get(cursor).ok_or(ExpressionError)?;
    if byte == CU_R && bytes.get(cursor + 1) == Some(&CU_SLASH) {
        return parse_regex(bytes, cursor);
    }
    if byte == CU_OPEN_PAREN {
        let (expression, cursor) = parse_parenthesized(bytes, cursor)?;
        return Ok((Atom::Group(expression), cursor));
    }
    if byte == CU_OPEN_BRACKET {
        let (elements, cursor) = parse_delimited(bytes, cursor, CU_OPEN_BRACKET, CU_CLOSE_BRACKET)?;
        return Ok((Atom::Array(elements), cursor));
    }
    if byte == CU_OPEN_BRACE {
        let (entries, cursor) = parse_delimited(bytes, cursor, CU_OPEN_BRACE, CU_CLOSE_BRACE)?;
        return Ok((Atom::Record(entries), cursor));
    }
    if matches!(byte, CU_APOSTROPHE | CU_QUOTE) {
        return parse_string(bytes, cursor, byte);
    }
    if is_ascii_digit(byte)
        || ((byte == CU_MINUS || byte == CU_PLUS)
            && bytes.get(cursor + 1).is_some_and(|unit| is_ascii_digit(*unit)))
    {
        return parse_number(bytes, cursor);
    }
    if !is_identifier_start(byte) {
        return Err(ExpressionError);
    }

    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while matches!(bytes.get(cursor).copied(), Some(CU_DOT | CU_OPEN_BRACKET)) {
        if bytes.get(cursor) == Some(&CU_OPEN_BRACKET)
            && let Some((slice, end)) = parse_slice(bytes, cursor)?
        {
            return Ok((
                Atom::Slice {
                    target: &bytes[start..cursor],
                    start: slice.0,
                    stop: slice.1,
                    step: slice.2,
                },
                end,
            ));
        }
        let Some((_, next)) = next_lookup_segment(&bytes[start..], cursor - start)? else {
            return Err(ExpressionError);
        };
        cursor = start + next;
    }
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&CU_OPEN_PAREN) {
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        return Ok((Atom::Call(Call { name, arguments }), end));
    }
    let atom = if ascii_eq(name, b"true") {
        Atom::Boolean(true)
    } else if ascii_eq(name, b"false") {
        Atom::Boolean(false)
    } else if ascii_eq(name, b"none") || ascii_eq(name, b"null") {
        Atom::Null
    } else if ascii_eq(name, b"undefined") {
        Atom::Undefined
    } else {
        Atom::Lookup(name)
    };
    Ok((atom, cursor))
}

type SliceFields<'a> = (Option<&'a [u16]>, Option<&'a [u16]>, Option<&'a [u16]>);

fn parse_slice(
    bytes: &[u16],
    open: usize,
) -> Result<Option<(SliceFields<'_>, usize)>, ExpressionError> {
    let (content, end) = parse_delimited(bytes, open, CU_OPEN_BRACKET, CU_CLOSE_BRACKET)?;
    let mut positions = [None, None];
    let mut count = 0usize;
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = content.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == CU_BACKSLASH {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        match byte {
            CU_APOSTROPHE | CU_QUOTE => quote = Some(byte),
            CU_OPEN_PAREN => parentheses += 1,
            CU_CLOSE_PAREN => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            CU_OPEN_BRACKET => brackets += 1,
            CU_CLOSE_BRACKET => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            CU_OPEN_BRACE => braces += 1,
            CU_CLOSE_BRACE => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            CU_COLON if parentheses == 0 && brackets == 0 && braces == 0 => {
                if count == positions.len() {
                    return Err(ExpressionError);
                }
                positions[count] = Some(cursor);
                count += 1;
            }
            _ => {}
        }
        cursor += 1;
    }
    if count == 0 {
        return Ok(None);
    }
    let first = positions[0].ok_or(ExpressionError)?;
    let second = positions[1];
    let start = optional_slice_field(&content[..first]);
    let stop_end = second.unwrap_or(content.len());
    let stop = optional_slice_field(&content[first + 1..stop_end]);
    let step = second.and_then(|position| optional_slice_field(&content[position + 1..]));
    Ok(Some(((start, stop, step), end)))
}

fn optional_slice_field(bytes: &[u16]) -> Option<&[u16]> {
    let value = trim_whitespace(bytes);
    (!value.is_empty()).then_some(value)
}

fn parse_regex(bytes: &[u16], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start + 2;
    loop {
        match bytes.get(cursor).copied() {
            Some(CU_BACKSLASH) => {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
            }
            Some(CU_SLASH) => {
                cursor += 1;
                while bytes
                    .get(cursor)
                    .is_some_and(|flag| matches!(*flag, CU_G | CU_I | CU_M | CU_Y))
                {
                    cursor += 1;
                }
                return Ok((Atom::Regex(&bytes[start + 1..cursor]), cursor));
            }
            Some(_) => cursor += 1,
            None => return Err(ExpressionError),
        }
    }
}

fn parse_operand(bytes: &[u16], cursor: usize) -> Result<(Operand<'_>, usize), ExpressionError> {
    let mut cursor = skip_whitespace(bytes, cursor);
    let negated = has_keyword(bytes, cursor, b"not");
    if negated {
        cursor = skip_whitespace(bytes, cursor + 3);
    }
    let end = arithmetic_operand_end(bytes, cursor)?;
    let arithmetic = trim_whitespace(&bytes[cursor..end]);
    let is_regex = bytes.get(cursor) == Some(&CU_R) && bytes.get(cursor + 1) == Some(&CU_SLASH);
    let (atom, cursor) = if !is_regex && split_binary_expression(arithmetic)?.is_some() {
        (Atom::Arithmetic(arithmetic), end)
    } else {
        parse_atom(bytes, cursor)?
    };
    Ok((Operand { atom, negated }, skip_whitespace(bytes, cursor)))
}

fn arithmetic_operand_end(bytes: &[u16], start: usize) -> Result<usize, ExpressionError> {
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == CU_BACKSLASH {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, CU_APOSTROPHE | CU_QUOTE) {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            CU_OPEN_PAREN => parentheses += 1,
            CU_OPEN_BRACKET => brackets += 1,
            CU_OPEN_BRACE => braces += 1,
            CU_CLOSE_PAREN => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACKET => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACE => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            _ => {}
        }
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && (matches!(byte, CU_EQUALS | CU_BANG | CU_LESS | CU_GREATER)
                || keyword_boundary(bytes, start, cursor, b"is")
                || keyword_boundary(bytes, start, cursor, b"in")
                || keyword_boundary(bytes, start, cursor, b"and")
                || keyword_boundary(bytes, start, cursor, b"or")
                || keyword_boundary(bytes, start, cursor, b"not"))
        {
            return Ok(cursor);
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(ExpressionError);
    }
    Ok(bytes.len())
}

fn keyword_boundary(bytes: &[u16], start: usize, cursor: usize, keyword: &[u8]) -> bool {
    (cursor == start
        || is_ascii_whitespace(bytes[cursor - 1])
        || bytes[start..cursor].ends_with(&[0x00a0]))
        && bytes
            .get(cursor..cursor + keyword.len())
            .is_some_and(|units| ascii_eq(units, keyword))
        && whitespace_width(bytes, cursor + keyword.len()) != 0
}

fn is_unary_sign(bytes: &[u16], cursor: usize) -> bool {
    let Some(previous) = trim_whitespace(&bytes[..cursor]).last().copied() else {
        return true;
    };
    matches!(
        previous,
        CU_TILDE | CU_PLUS
            | CU_MINUS
            | CU_STAR
            | CU_SLASH
            | CU_PERCENT
            | CU_OPEN_PAREN
            | CU_OPEN_BRACKET
            | CU_OPEN_BRACE
            | CU_COMMA
            | CU_COLON
            | CU_EQUALS
            | CU_BANG
            | CU_LESS
            | CU_GREATER
    )
}

fn trim_whitespace(bytes: &[u16]) -> &[u16] {
    let start = skip_whitespace(bytes, 0);
    let mut end = bytes.len();
    while end > start {
        if is_ascii_whitespace(bytes[end - 1]) || bytes[end - 1] == 0x00a0 {
            end -= 1;
        } else {
            break;
        }
    }
    &bytes[start..end]
}

fn parse_named_call(bytes: &[u16], cursor: usize) -> Result<(Call<'_>, usize), ExpressionError> {
    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while bytes.get(cursor) == Some(&CU_DOT) {
        cursor = parse_identifier(bytes, cursor + 1)?;
    }
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&CU_OPEN_PAREN) {
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        Ok((Call { name, arguments }, end))
    } else {
        Ok((
            Call {
                name,
                arguments: &bytes[0..0],
            },
            cursor,
        ))
    }
}

fn parse_string(
    bytes: &[u16],
    cursor: usize,
    quote: u16,
) -> Result<(Atom<'_>, usize), ExpressionError> {
    let start = cursor + 1;
    let mut cursor = start;
    while let Some(byte) = bytes.get(cursor) {
        if *byte == quote {
            return Ok((Atom::String(&bytes[start..cursor]), cursor + 1));
        }
        if *byte == CU_BACKSLASH {
            cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
            if cursor > bytes.len() {
                return Err(ExpressionError);
            }
            continue;
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_number(bytes: &[u16], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start;
    if matches!(bytes.get(cursor).copied(), Some(CU_MINUS | CU_PLUS)) {
        cursor += 1;
    }
    let integer_start = cursor;
    while bytes.get(cursor).is_some_and(|unit| is_ascii_digit(*unit)) {
        cursor += 1;
    }
    if cursor == integer_start {
        return Err(ExpressionError);
    }
    if bytes.get(cursor) == Some(&CU_DOT) {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(|unit| is_ascii_digit(*unit)) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return Err(ExpressionError);
        }
    }
    Ok((Atom::Number(&bytes[start..cursor]), cursor))
}

fn parse_parenthesized(bytes: &[u16], open: usize) -> Result<(&[u16], usize), ExpressionError> {
    parse_delimited(bytes, open, CU_OPEN_PAREN, CU_CLOSE_PAREN)
}

fn parse_delimited(
    bytes: &[u16],
    open: usize,
    expected_open: u16,
    expected_close: u16,
) -> Result<(&[u16], usize), ExpressionError> {
    if bytes.get(open) != Some(&expected_open) {
        return Err(ExpressionError);
    }
    let start = open + 1;
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = usize::from(expected_open == CU_OPEN_PAREN);
    let mut brackets = usize::from(expected_open == CU_OPEN_BRACKET);
    let mut braces = usize::from(expected_open == CU_OPEN_BRACE);
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == CU_BACKSLASH {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
        } else if matches!(byte, CU_APOSTROPHE | CU_QUOTE) {
            quote = Some(byte);
        } else if byte == CU_OPEN_PAREN {
            parentheses += 1;
        } else if byte == CU_OPEN_BRACKET {
            brackets += 1;
        } else if byte == CU_OPEN_BRACE {
            braces += 1;
        } else if byte == CU_CLOSE_PAREN {
            parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == CU_CLOSE_BRACKET {
            brackets = brackets.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == CU_CLOSE_BRACE {
            braces = braces.checked_sub(1).ok_or(ExpressionError)?;
        }
        if byte == expected_close && parentheses == 0 && brackets == 0 && braces == 0 {
            return Ok((&bytes[start..cursor], cursor + 1));
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_identifier(bytes: &[u16], cursor: usize) -> Result<usize, ExpressionError> {
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

fn parse_path_segment(bytes: &[u16], cursor: usize) -> Result<usize, ExpressionError> {
    if bytes.get(cursor).is_some_and(|unit| is_ascii_digit(*unit)) {
        let mut cursor = cursor + 1;
        while bytes.get(cursor).is_some_and(|unit| is_ascii_digit(*unit)) {
            cursor += 1;
        }
        Ok(cursor)
    } else {
        parse_identifier(bytes, cursor)
    }
}

fn has_keyword(bytes: &[u16], cursor: usize, keyword: &[u8]) -> bool {
    bytes
        .get(cursor..cursor + keyword.len())
        .is_some_and(|units| ascii_eq(units, keyword))
        && (cursor + keyword.len() == bytes.len()
            || whitespace_width(bytes, cursor + keyword.len()) != 0)
}

fn find_top_level_keyword(
    bytes: &[u16],
    start: usize,
    keyword: &[u8],
) -> Result<usize, ExpressionError> {
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == CU_BACKSLASH {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, CU_APOSTROPHE | CU_QUOTE) {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            CU_OPEN_PAREN => parentheses += 1,
            CU_OPEN_BRACKET => brackets += 1,
            CU_OPEN_BRACE => braces += 1,
            CU_CLOSE_PAREN => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACKET => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACE => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            _ => {}
        }
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && keyword_boundary(bytes, start, cursor, keyword)
        {
            return Ok(cursor);
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn skip_whitespace(bytes: &[u16], mut cursor: usize) -> usize {
    loop {
        let width = whitespace_width(bytes, cursor);
        if width == 0 {
            return cursor;
        }
        cursor += width;
    }
}

fn whitespace_width(bytes: &[u16], cursor: usize) -> usize {
    if bytes
        .get(cursor)
        .is_some_and(|unit| is_ascii_whitespace(*unit) || *unit == 0x00a0)
    {
        1
    } else {
        0
    }
}

fn is_identifier_start(byte: u16) -> bool {
    is_ascii_alphabetic(byte) || byte == CU_UNDERSCORE
}

fn is_identifier_continue(byte: u16) -> bool {
    is_identifier_start(byte) || is_ascii_digit(byte)
}
