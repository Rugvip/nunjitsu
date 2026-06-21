fn parse_atom(bytes: &[u8], cursor: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let byte = *bytes.get(cursor).ok_or(ExpressionError)?;
    if byte == b'r' && bytes.get(cursor + 1) == Some(&b'/') {
        return parse_regex(bytes, cursor);
    }
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
        if bytes.get(cursor) == Some(&b'[')
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
    if bytes.get(following) == Some(&b'(') {
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

type SliceFields<'a> = (Option<&'a [u8]>, Option<&'a [u8]>, Option<&'a [u8]>);

fn parse_slice(
    bytes: &[u8],
    open: usize,
) -> Result<Option<(SliceFields<'_>, usize)>, ExpressionError> {
    let (content, end) = parse_delimited(bytes, open, b'[', b']')?;
    let mut positions = [None, None];
    let mut count = 0usize;
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = content.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
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
            b'\'' | b'"' => quote = Some(byte),
            b'(' => parentheses += 1,
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b'[' => brackets += 1,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'{' => braces += 1,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            b':' if parentheses == 0 && brackets == 0 && braces == 0 => {
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

fn optional_slice_field(bytes: &[u8]) -> Option<&[u8]> {
    let value = trim_whitespace(bytes);
    (!value.is_empty()).then_some(value)
}

fn parse_regex(bytes: &[u8], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start + 2;
    loop {
        match bytes.get(cursor).copied() {
            Some(b'\\') => {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
            }
            Some(b'/') => {
                cursor += 1;
                while bytes
                    .get(cursor)
                    .is_some_and(|flag| matches!(flag, b'g' | b'i' | b'm' | b'y'))
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

fn parse_operand(bytes: &[u8], cursor: usize) -> Result<(Operand<'_>, usize), ExpressionError> {
    let mut cursor = skip_whitespace(bytes, cursor);
    let negated = has_keyword(bytes, cursor, b"not");
    if negated {
        cursor = skip_whitespace(bytes, cursor + 3);
    }
    let end = arithmetic_operand_end(bytes, cursor)?;
    let arithmetic = trim_whitespace(&bytes[cursor..end]);
    let is_regex = bytes.get(cursor) == Some(&b'r') && bytes.get(cursor + 1) == Some(&b'/');
    let (atom, cursor) = if !is_regex && split_binary_expression(arithmetic)?.is_some() {
        (Atom::Arithmetic(arithmetic), end)
    } else {
        parse_atom(bytes, cursor)?
    };
    Ok((Operand { atom, negated }, skip_whitespace(bytes, cursor)))
}

fn arithmetic_operand_end(bytes: &[u8], start: usize) -> Result<usize, ExpressionError> {
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            b'(' => parentheses += 1,
            b'[' => brackets += 1,
            b'{' => braces += 1,
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            _ => {}
        }
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && (matches!(byte, b'=' | b'!' | b'<' | b'>')
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

fn keyword_boundary(bytes: &[u8], start: usize, cursor: usize, keyword: &[u8]) -> bool {
    (cursor == start
        || bytes[cursor - 1].is_ascii_whitespace()
        || bytes[start..cursor].ends_with("\u{a0}".as_bytes()))
        && bytes.get(cursor..cursor + keyword.len()) == Some(keyword)
        && whitespace_width(bytes, cursor + keyword.len()) != 0
}

fn is_unary_sign(bytes: &[u8], cursor: usize) -> bool {
    let Some(previous) = trim_whitespace(&bytes[..cursor]).last().copied() else {
        return true;
    };
    matches!(
        previous,
        b'~' | b'+'
            | b'-'
            | b'*'
            | b'/'
            | b'%'
            | b'('
            | b'['
            | b'{'
            | b','
            | b':'
            | b'='
            | b'!'
            | b'<'
            | b'>'
    )
}

fn trim_whitespace(bytes: &[u8]) -> &[u8] {
    let start = skip_whitespace(bytes, 0);
    let mut end = bytes.len();
    while end > start {
        if bytes[end - 1].is_ascii_whitespace() {
            end -= 1;
        } else if bytes[start..end].ends_with("\u{a0}".as_bytes()) {
            end -= "\u{a0}".len();
        } else {
            break;
        }
    }
    &bytes[start..end]
}

fn parse_named_call(bytes: &[u8], cursor: usize) -> Result<(Call<'_>, usize), ExpressionError> {
    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while bytes.get(cursor) == Some(&b'.') {
        cursor = parse_identifier(bytes, cursor + 1)?;
    }
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
        && (cursor + keyword.len() == bytes.len()
            || whitespace_width(bytes, cursor + keyword.len()) != 0)
}

fn find_top_level_keyword(
    bytes: &[u8],
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
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            b'(' => parentheses += 1,
            b'[' => brackets += 1,
            b'{' => braces += 1,
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
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

fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    loop {
        let width = whitespace_width(bytes, cursor);
        if width == 0 {
            return cursor;
        }
        cursor += width;
    }
}

fn whitespace_width(bytes: &[u8], cursor: usize) -> usize {
    if bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        1
    } else if bytes.get(cursor..cursor + "\u{a0}".len()) == Some("\u{a0}".as_bytes()) {
        "\u{a0}".len()
    } else {
        0
    }
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}
