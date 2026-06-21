fn write_javascript_string_value(value_offset: u32) -> Result<u32, u32> {
    match Value::at(value_offset)? {
        Value::Undefined => write_bytes_record(TAG_STRING, b"undefined"),
        Value::Null => write_bytes_record(TAG_STRING, b"null"),
        _ => {
            let rendered = rendered_value(value_offset)?;
            write_bytes_record(TAG_STRING, rendered.bytes)
        }
    }
}

fn dump_value(value_offset: u32, spaces_offset: Option<u32>) -> Result<u32, u32> {
    if matches!(Value::at(value_offset)?, Value::Undefined | Value::Macro) {
        return allocate_record(TAG_UNDEFINED, 0);
    }
    let indent_offset = dump_indent(spaces_offset)?;
    let indent = record_at(indent_offset, TAG_STRING)?;
    let length = json_value_length(value_offset, indent, 0)?;
    let output_offset = allocate_record(
        TAG_STRING,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(output_offset, TAG_STRING)?;
    let mut cursor = 0usize;
    write_json_value(value_offset, indent, 0, output, &mut cursor)?;
    if cursor != output.len() {
        return Err(ERROR_INVALID_ARENA);
    }
    Ok(output_offset)
}

fn dump_indent(spaces_offset: Option<u32>) -> Result<u32, u32> {
    let Some(spaces_offset) = spaces_offset else {
        return write_bytes_record(TAG_STRING, b"");
    };
    match Value::at(spaces_offset)? {
        Value::Number { numeric, .. } => {
            let count = if numeric.is_nan() || numeric <= 0.0 {
                0
            } else {
                libm::trunc(numeric).min(10.0) as usize
            };
            let offset = allocate_record(TAG_STRING, count as u32)?;
            mutable_record_at(offset, TAG_STRING)?.fill(b' ');
            Ok(offset)
        }
        Value::String(bytes) | Value::SafeString(bytes) => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let end = text
                .char_indices()
                .nth(10)
                .map_or(bytes.len(), |(index, _)| index);
            write_bytes_record(TAG_STRING, &bytes[..end])
        }
        _ => write_bytes_record(TAG_STRING, b""),
    }
}

fn json_value_length(value_offset: u32, indent: &[u8], depth: usize) -> Result<usize, u32> {
    match Value::at(value_offset)? {
        Value::Undefined | Value::Null | Value::Cycler(_) | Value::Joiner(_) | Value::Macro => {
            Ok(4)
        }
        Value::Boolean(false) => Ok(5),
        Value::Boolean(true) => Ok(4),
        Value::Number { numeric, rendered } => {
            if numeric.is_finite() {
                Ok(rendered.len())
            } else {
                Ok(4)
            }
        }
        Value::String(bytes) | Value::SafeString(bytes) => json_string_length(bytes),
        Value::Regex(_) => Ok(2),
        Value::Array(array) => {
            if array.count == 0 {
                return Ok(2);
            }
            let pretty = !indent.is_empty();
            let mut length = 2usize
                .checked_add(array.count.saturating_sub(1))
                .ok_or(ERROR_RESOURCE_LIMIT)?;
            if pretty {
                length = length
                    .checked_add(json_pretty_overhead(indent.len(), depth, array.count)?)
                    .ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            let child_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            for index in 0..array.count {
                length = length
                    .checked_add(json_value_length(
                        read_u32(array.payload, 4 + index * 4)?,
                        indent,
                        child_depth,
                    )?)
                    .ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            Ok(length)
        }
        Value::Record(record) => {
            let included = json_record_entry_count(record)?;
            if included == 0 {
                return Ok(2);
            }
            let pretty = !indent.is_empty();
            let mut length = 2usize
                .checked_add(included.saturating_sub(1))
                .ok_or(ERROR_RESOURCE_LIMIT)?;
            if pretty {
                length = length
                    .checked_add(json_pretty_overhead(indent.len(), depth, included)?)
                    .ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            let child_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            for index in 0..record.count {
                let value = read_u32(record.payload, 8 + index * 8)?;
                if matches!(Value::at(value)?, Value::Undefined | Value::Macro) {
                    continue;
                }
                let key = record_at(read_u32(record.payload, 4 + index * 8)?, TAG_STRING)?;
                let value_length = json_value_length(value, indent, child_depth)?;
                length = length
                    .checked_add(json_string_length(key)?)
                    .and_then(|current| current.checked_add(if pretty { 2 } else { 1 }))
                    .and_then(|current| current.checked_add(value_length))
                    .ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            Ok(length)
        }
    }
}

fn json_pretty_overhead(indent_length: usize, depth: usize, entries: usize) -> Result<usize, u32> {
    let child_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
    let indentation = child_depth
        .checked_mul(entries)
        .and_then(|value| value.checked_add(depth))
        .and_then(|value| value.checked_mul(indent_length))
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    entries
        .checked_add(1)
        .and_then(|value| value.checked_add(indentation))
        .ok_or(ERROR_RESOURCE_LIMIT)
}

fn json_record_entry_count(record: Record) -> Result<usize, u32> {
    let mut count = 0usize;
    for index in 0..record.count {
        let value = read_u32(record.payload, 8 + index * 8)?;
        if !matches!(Value::at(value)?, Value::Undefined | Value::Macro) {
            count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
    }
    Ok(count)
}

fn json_string_length(bytes: &[u8]) -> Result<usize, u32> {
    let mut length = 2usize;
    for byte in bytes.iter().copied() {
        length = length
            .checked_add(match byte {
                b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
                0x00..=0x1f => 6,
                _ => 1,
            })
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    Ok(length)
}

fn write_json_value(
    value_offset: u32,
    indent: &[u8],
    depth: usize,
    output: &mut [u8],
    cursor: &mut usize,
) -> Result<(), u32> {
    match Value::at(value_offset)? {
        Value::Undefined | Value::Null | Value::Cycler(_) | Value::Joiner(_) | Value::Macro => {
            write_coerced_bytes(output, cursor, b"null")
        }
        Value::Boolean(false) => write_coerced_bytes(output, cursor, b"false"),
        Value::Boolean(true) => write_coerced_bytes(output, cursor, b"true"),
        Value::Number { numeric, rendered } => write_coerced_bytes(
            output,
            cursor,
            if numeric.is_finite() {
                rendered
            } else {
                b"null"
            },
        ),
        Value::String(bytes) | Value::SafeString(bytes) => write_json_string(bytes, output, cursor),
        Value::Regex(_) => write_coerced_bytes(output, cursor, b"{}"),
        Value::Array(array) => {
            let child_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            write_coerced_bytes(output, cursor, b"[")?;
            for index in 0..array.count {
                if index != 0 {
                    write_coerced_bytes(output, cursor, b",")?;
                }
                if !indent.is_empty() {
                    write_coerced_bytes(output, cursor, b"\n")?;
                    write_json_indent(output, cursor, indent, child_depth)?;
                }
                write_json_value(
                    read_u32(array.payload, 4 + index * 4)?,
                    indent,
                    child_depth,
                    output,
                    cursor,
                )?;
            }
            if array.count != 0 && !indent.is_empty() {
                write_coerced_bytes(output, cursor, b"\n")?;
                write_json_indent(output, cursor, indent, depth)?;
            }
            write_coerced_bytes(output, cursor, b"]")
        }
        Value::Record(record) => {
            let child_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            write_coerced_bytes(output, cursor, b"{")?;
            let mut written = 0usize;
            for index in 0..record.count {
                let value = read_u32(record.payload, 8 + index * 8)?;
                if matches!(Value::at(value)?, Value::Undefined | Value::Macro) {
                    continue;
                }
                if written != 0 {
                    write_coerced_bytes(output, cursor, b",")?;
                }
                if !indent.is_empty() {
                    write_coerced_bytes(output, cursor, b"\n")?;
                    write_json_indent(output, cursor, indent, child_depth)?;
                }
                let key = record_at(read_u32(record.payload, 4 + index * 8)?, TAG_STRING)?;
                write_json_string(key, output, cursor)?;
                write_coerced_bytes(output, cursor, if indent.is_empty() { b":" } else { b": " })?;
                write_json_value(value, indent, child_depth, output, cursor)?;
                written += 1;
            }
            if written != 0 && !indent.is_empty() {
                write_coerced_bytes(output, cursor, b"\n")?;
                write_json_indent(output, cursor, indent, depth)?;
            }
            write_coerced_bytes(output, cursor, b"}")
        }
    }
}

fn write_json_indent(
    output: &mut [u8],
    cursor: &mut usize,
    indent: &[u8],
    depth: usize,
) -> Result<(), u32> {
    for _ in 0..depth {
        write_coerced_bytes(output, cursor, indent)?;
    }
    Ok(())
}

fn write_json_string(bytes: &[u8], output: &mut [u8], cursor: &mut usize) -> Result<(), u32> {
    write_coerced_bytes(output, cursor, b"\"")?;
    for byte in bytes.iter().copied() {
        match byte {
            b'"' => write_coerced_bytes(output, cursor, b"\\\"")?,
            b'\\' => write_coerced_bytes(output, cursor, b"\\\\")?,
            0x08 => write_coerced_bytes(output, cursor, b"\\b")?,
            0x09 => write_coerced_bytes(output, cursor, b"\\t")?,
            0x0a => write_coerced_bytes(output, cursor, b"\\n")?,
            0x0c => write_coerced_bytes(output, cursor, b"\\f")?,
            0x0d => write_coerced_bytes(output, cursor, b"\\r")?,
            0x00..=0x1f => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let escaped = [
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    HEX[(byte >> 4) as usize],
                    HEX[(byte & 15) as usize],
                ];
                write_coerced_bytes(output, cursor, &escaped)?;
            }
            _ => write_coerced_bytes(output, cursor, &[byte])?,
        }
    }
    write_coerced_bytes(output, cursor, b"\"")
}
