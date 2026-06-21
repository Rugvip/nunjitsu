fn striptags_value(value_offset: u32, preserve_linebreaks: bool) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let mut stripped_length = 0usize;
    strip_tags_emit(rendered.bytes, &mut |segment| {
        stripped_length = stripped_length
            .checked_add(segment.len())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        Ok(())
    })?;
    let stripped_offset = allocate_record(
        TAG_STRING,
        u32::try_from(stripped_length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let stripped = mutable_record_at(stripped_offset, TAG_STRING)?;
    let mut stripped_cursor = 0usize;
    strip_tags_emit(rendered.bytes, &mut |segment| {
        write_coerced_bytes(stripped, &mut stripped_cursor, segment)
    })?;
    let stripped = trim_ascii_whitespace(record_at(stripped_offset, TAG_STRING)?);
    let mut length = 0usize;
    normalize_stripped_emit(stripped, preserve_linebreaks, &mut |segment| {
        length = length
            .checked_add(segment.len())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        Ok(())
    })?;
    let tag = if rendered.safe {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let output_offset = allocate_record(
        tag,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, tag)?;
    let mut cursor = 0usize;
    normalize_stripped_emit(stripped, preserve_linebreaks, &mut |segment| {
        write_coerced_bytes(output, &mut cursor, segment)
    })?;
    finish_string_record(output_offset, tag)
}

fn strip_tags_emit(
    input: &[u8],
    emit: &mut impl FnMut(&[u8]) -> Result<(), u32>,
) -> Result<(), u32> {
    let mut cursor = 0usize;
    while cursor < input.len() {
        let Some(relative) = input[cursor..].iter().position(|byte| *byte == b'<') else {
            emit(&input[cursor..])?;
            break;
        };
        let tag_start = cursor + relative;
        emit(&input[cursor..tag_start])?;
        if let Some(end) = html_tag_end(input, tag_start) {
            cursor = end;
        } else {
            emit(&input[tag_start..tag_start + 1])?;
            cursor = tag_start + 1;
        }
    }
    Ok(())
}

fn html_tag_end(input: &[u8], start: usize) -> Option<usize> {
    if input.get(start..start + 4) == Some(b"<!--") {
        let relative = input[start + 4..]
            .windows(3)
            .position(|window| window == b"-->")?;
        return Some(start + 4 + relative + 3);
    }
    let mut cursor = start + 1;
    if input.get(cursor) == Some(&b'/') {
        cursor += 1;
    }
    if !input.get(cursor).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }
    cursor += 1;
    while input.get(cursor).is_some_and(u8::is_ascii_alphanumeric) {
        cursor += 1;
    }
    if input
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    {
        return None;
    }
    input[cursor..]
        .iter()
        .position(|byte| *byte == b'>')
        .map(|relative| cursor + relative + 1)
}

fn normalize_stripped_emit(
    input: &[u8],
    preserve_linebreaks: bool,
    emit: &mut impl FnMut(&[u8]) -> Result<(), u32>,
) -> Result<(), u32> {
    if !preserve_linebreaks {
        let mut cursor = 0usize;
        while cursor < input.len() {
            if input[cursor].is_ascii_whitespace() {
                while cursor < input.len() && input[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor < input.len() {
                    emit(b" ")?;
                }
            } else {
                let start = cursor;
                while cursor < input.len() && !input[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                emit(&input[start..cursor])?;
            }
        }
        return Ok(());
    }
    let mut cursor = 0usize;
    let mut pending_newlines = 0usize;
    let mut line_start = true;
    while cursor < input.len() {
        let newline_width = if input[cursor] == b'\n' {
            1
        } else if input[cursor] == b'\r' && input.get(cursor + 1) == Some(&b'\n') {
            2
        } else {
            0
        };
        if newline_width != 0 {
            pending_newlines = pending_newlines.saturating_add(1);
            line_start = true;
            cursor += newline_width;
            continue;
        }
        if input[cursor] == b' ' {
            while cursor < input.len() && input[cursor] == b' ' {
                cursor += 1;
            }
            let followed_by_newline = input.get(cursor) == Some(&b'\n')
                || (input.get(cursor) == Some(&b'\r') && input.get(cursor + 1) == Some(&b'\n'));
            if !line_start && cursor < input.len() && !followed_by_newline {
                emit(b" ")?;
            }
            continue;
        }
        for _ in 0..pending_newlines.min(2) {
            emit(b"\n")?;
        }
        pending_newlines = 0;
        line_start = false;
        let start = cursor;
        while cursor < input.len()
            && input[cursor] != b' '
            && input[cursor] != b'\n'
            && !(input[cursor] == b'\r' && input.get(cursor + 1) == Some(&b'\n'))
        {
            cursor += 1;
        }
        emit(&input[start..cursor])?;
    }
    Ok(())
}

fn truncate_value(
    value_offset: u32,
    length_offset: Option<u32>,
    killwords_offset: Option<u32>,
    end_offset: Option<u32>,
) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let text = core::str::from_utf8(rendered.bytes).map_err(|_| ERROR_INVALID_RECORD)?;
    let requested = if let Some(length_offset) = length_offset {
        let number = Value::at(length_offset)?.as_number();
        if number.is_nan() || number == 0.0 {
            255
        } else if number < 0.0 {
            0
        } else {
            libm::trunc(number).min(usize::MAX as f64) as usize
        }
    } else {
        255
    };
    if text.chars().count() <= requested {
        return write_materialized_string_value(rendered.bytes, rendered.safe);
    }
    let killwords =
        killwords_offset.is_some_and(|offset| Value::at(offset).is_ok_and(Value::truthy));
    let mut end = utf8_prefix_length(text, requested);
    if !killwords {
        let mut last_space = None;
        for (character, (index, value)) in text.char_indices().enumerate() {
            if character > requested {
                break;
            }
            if value == ' ' {
                last_space = Some(index);
            }
        }
        if let Some(space) = last_space {
            end = space;
        }
    }
    let suffix = match end_offset {
        Some(offset) if !matches!(Value::at(offset)?, Value::Undefined | Value::Null) => {
            rendered_value(offset)?.bytes
        }
        _ => b"...",
    };
    let length = end.checked_add(suffix.len()).ok_or(ERROR_RESOURCE_LIMIT)?;
    let tag = if rendered.safe {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let output_offset = allocate_record(
        tag,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, tag)?;
    output[..end].copy_from_slice(&rendered.bytes[..end]);
    output[end..].copy_from_slice(suffix);
    finish_string_record(output_offset, tag)
}

fn utf8_prefix_length(text: &str, characters: usize) -> usize {
    text.char_indices()
        .nth(characters)
        .map_or(text.len(), |(index, _)| index)
}

fn urlencode_value(value_offset: u32) -> Result<u32, u32> {
    match Value::at(value_offset)? {
        Value::String(bytes) | Value::SafeString(bytes) => encode_url_component(bytes),
        Value::Array(array) => urlencode_array(array),
        Value::Record(record) => urlencode_record(record),
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}
fn urlencode_array(array: Array) -> Result<u32, u32> {
    let mut length = array.count.saturating_sub(1);
    for index in 0..array.count {
        let pair_offset = read_u32(array.payload, 4 + index * 4)?;
        let Value::Array(pair) = Value::at(pair_offset)? else {
            return Err(ERROR_INVALID_EXPRESSION);
        };
        if pair.count < 2 {
            return Err(ERROR_INVALID_EXPRESSION);
        }
        let key_length = encoded_value_length(read_u32(pair.payload, 4)?)?;
        let value_length = encoded_value_length(read_u32(pair.payload, 8)?)?;
        length = length
            .checked_add(key_length)
            .and_then(|value| value.checked_add(1))
            .and_then(|value| value.checked_add(value_length))
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    let output_offset = allocate_record(
        TAG_STRING,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, TAG_STRING)?;
    let mut cursor = 0usize;
    for index in 0..array.count {
        if index != 0 {
            write_coerced_bytes(output, &mut cursor, b"&")?;
        }
        let pair_offset = read_u32(array.payload, 4 + index * 4)?;
        let Value::Array(pair) = Value::at(pair_offset)? else {
            return Err(ERROR_INVALID_EXPRESSION);
        };
        write_encoded_value(read_u32(pair.payload, 4)?, output, &mut cursor)?;
        write_coerced_bytes(output, &mut cursor, b"=")?;
        write_encoded_value(read_u32(pair.payload, 8)?, output, &mut cursor)?;
    }
    finish_string_record(output_offset, TAG_STRING)
}

fn urlencode_record(record: Record) -> Result<u32, u32> {
    let mut length = record.count.saturating_sub(1);
    for index in 0..record.count {
        let key = rendered_value(read_u32(record.payload, 4 + index * 8)?)?.bytes;
        let value_length = encoded_value_length(read_u32(record.payload, 8 + index * 8)?)?;
        length = length
            .checked_add(encoded_bytes_length(key)?)
            .and_then(|value| value.checked_add(1))
            .and_then(|value| value.checked_add(value_length))
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    let output_offset = allocate_record(
        TAG_STRING,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, TAG_STRING)?;
    let mut cursor = 0usize;
    for index in 0..record.count {
        if index != 0 {
            write_coerced_bytes(output, &mut cursor, b"&")?;
        }
        let key = rendered_value(read_u32(record.payload, 4 + index * 8)?)?.bytes;
        write_encoded_bytes(key, output, &mut cursor)?;
        write_coerced_bytes(output, &mut cursor, b"=")?;
        write_encoded_value(
            read_u32(record.payload, 8 + index * 8)?,
            output,
            &mut cursor,
        )?;
    }
    finish_string_record(output_offset, TAG_STRING)
}

fn encode_url_component(bytes: &[u8]) -> Result<u32, u32> {
    let length = encoded_bytes_length(bytes)?;
    let output_offset = allocate_record(
        TAG_STRING,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, TAG_STRING)?;
    let mut cursor = 0usize;
    write_encoded_bytes(bytes, output, &mut cursor)?;
    finish_string_record(output_offset, TAG_STRING)
}

fn encoded_value_length(value_offset: u32) -> Result<usize, u32> {
    encoded_bytes_length(url_value_bytes(value_offset)?)
}

fn write_encoded_value(
    value_offset: u32,
    output: &mut [u8],
    cursor: &mut usize,
) -> Result<(), u32> {
    write_encoded_bytes(url_value_bytes(value_offset)?, output, cursor)
}

fn url_value_bytes(value_offset: u32) -> Result<&'static [u8], u32> {
    match Value::at(value_offset)? {
        Value::Undefined => Ok(b"undefined"),
        Value::Null => Ok(b"null"),
        _ => Ok(rendered_value(value_offset)?.bytes),
    }
}

fn encoded_bytes_length(bytes: &[u8]) -> Result<usize, u32> {
    let mut length = 0usize;
    for byte in bytes.iter().copied() {
        length = length
            .checked_add(if url_component_unescaped(byte) { 1 } else { 3 })
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    Ok(length)
}

fn write_encoded_bytes(bytes: &[u8], output: &mut [u8], cursor: &mut usize) -> Result<(), u32> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in bytes.iter().copied() {
        if url_component_unescaped(byte) {
            write_coerced_bytes(output, cursor, &[byte])?;
        } else {
            let encoded = [b'%', HEX[(byte >> 4) as usize], HEX[(byte & 15) as usize]];
            write_coerced_bytes(output, cursor, &encoded)?;
        }
    }
    Ok(())
}

fn url_component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

fn urlize_value(value_offset: u32, length: usize, nofollow: bool) -> Result<u32, u32> {
    let value = Value::at(value_offset)?;
    let Some(input) = value.string_bytes() else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let mut output_length = 0usize;
    urlize_emit(input, length, nofollow, &mut |segment| {
        output_length = output_length
            .checked_add(segment.len())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        Ok(())
    })?;
    let output_offset = allocate_record(
        TAG_STRING,
        u32::try_from(output_length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, TAG_STRING)?;
    let mut cursor = 0usize;
    urlize_emit(input, length, nofollow, &mut |segment| {
        write_coerced_bytes(output, &mut cursor, segment)
    })?;
    finish_string_record(output_offset, TAG_STRING)
}

fn urlize_emit(
    input: &[u8],
    length: usize,
    nofollow: bool,
    emit: &mut impl FnMut(&[u8]) -> Result<(), u32>,
) -> Result<(), u32> {
    let mut cursor = 0usize;
    while cursor < input.len() {
        let whitespace = input[cursor].is_ascii_whitespace();
        let start = cursor;
        while cursor < input.len() && input[cursor].is_ascii_whitespace() == whitespace {
            cursor += 1;
        }
        let word = &input[start..cursor];
        if whitespace {
            emit(word)?;
        } else {
            urlize_word_emit(word, length, nofollow, emit)?;
        }
    }
    Ok(())
}

fn urlize_word_emit(
    word: &[u8],
    length: usize,
    nofollow: bool,
    emit: &mut impl FnMut(&[u8]) -> Result<(), u32>,
) -> Result<(), u32> {
    let mut possible = word;
    if possible.starts_with(b"&lt;") {
        possible = &possible[4..];
    } else if matches!(possible.first(), Some(b'(' | b'<')) {
        possible = &possible[1..];
    }
    if possible.ends_with(b"&gt;") {
        possible = &possible[..possible.len() - 4];
    } else if matches!(possible.last(), Some(b'.' | b',' | b')' | b'\n')) {
        possible = &possible[..possible.len() - 1];
    }
    let text = core::str::from_utf8(possible).map_err(|_| ERROR_INVALID_RECORD)?;
    let short_length = utf8_prefix_length(text, length);
    let short = &possible[..short_length];
    let http = possible.starts_with(b"http://") || possible.starts_with(b"https://");
    let www = possible.starts_with(b"www.");
    if http || www || has_linkable_tld(possible) && !is_email(possible) {
        emit(b"<a href=\"")?;
        if !http {
            emit(b"http://")?;
        }
        emit(possible)?;
        emit(b"\"")?;
        if nofollow {
            emit(b" rel=\"nofollow\"")?;
        }
        emit(b">")?;
        emit(short)?;
        emit(b"</a>")?;
    } else if is_email(possible) {
        emit(b"<a href=\"mailto:")?;
        emit(possible)?;
        emit(b"\">")?;
        emit(possible)?;
        emit(b"</a>")?;
    } else {
        emit(word)?;
    }
    Ok(())
}

fn has_linkable_tld(value: &[u8]) -> bool {
    for tld in [b".org".as_slice(), b".net".as_slice(), b".com".as_slice()] {
        for index in 0..=value.len().saturating_sub(tld.len()) {
            if value.get(index..index + tld.len()) != Some(tld) {
                continue;
            }
            let following = value.get(index + tld.len());
            if following.is_none() || matches!(following, Some(b':' | b'/')) {
                return true;
            }
        }
    }
    false
}

fn is_email(value: &[u8]) -> bool {
    let Some(at) = value.iter().position(|byte| *byte == b'@') else {
        return false;
    };
    if at == 0 || value[at + 1..].contains(&b'@') {
        return false;
    }
    if !value[..at].iter().copied().all(email_local_byte) {
        return false;
    }
    let domain = &value[at + 1..];
    let mut labels = 0usize;
    for label in domain.split(|byte| *byte == b'.') {
        if label.is_empty()
            || !label
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
        {
            return false;
        }
        labels += 1;
    }
    labels >= 2
}

fn email_local_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'_' | b'.'
                | b'!'
                | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'/'
                | b'='
                | b'?'
                | b'^'
                | b'`'
                | b'{'
                | b'|'
                | b'}'
                | b'~'
        )
}

fn edge_value(value: Value, last: bool) -> Result<u32, u32> {
    match value {
        Value::Array(array) if array.count != 0 => {
            let index = if last { array.count - 1 } else { 0 };
            read_u32(array.payload, 4 + index * 4)
        }
        Value::String(bytes) | Value::SafeString(bytes) if !bytes.is_empty() => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let character = if last {
                text.chars().next_back()
            } else {
                text.chars().next()
            }
            .ok_or(ERROR_INVALID_EXPRESSION)?;
            let start = if last {
                bytes.len() - character.len_utf8()
            } else {
                0
            };
            write_materialized_string_value(
                &bytes[start..start + character.len_utf8()],
                matches!(value, Value::SafeString(_)),
            )
        }
        Value::Undefined | Value::Null | Value::Array(_) => allocate_record(TAG_UNDEFINED, 0),
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}
