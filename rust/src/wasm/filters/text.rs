fn nl2br_value(value_offset: u32) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let mut line_breaks = 0usize;
    let mut cursor = 0usize;
    while cursor < rendered.bytes.len() {
        match rendered.bytes[cursor] {
            b'\r' if rendered.bytes.get(cursor + 1) == Some(&b'\n') => {
                line_breaks += 1;
                cursor += 2;
            }
            b'\r' | b'\n' => {
                line_breaks += 1;
                cursor += 1;
            }
            _ => cursor += 1,
        }
    }
    let length = rendered
        .bytes
        .len()
        .checked_add(line_breaks.checked_mul(6).ok_or(ERROR_RESOURCE_LIMIT)?)
        .and_then(|value| {
            value.checked_sub(
                rendered
                    .bytes
                    .windows(2)
                    .filter(|pair| *pair == b"\r\n")
                    .count(),
            )
        })
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let tag = if rendered.safe {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let mut input_cursor = 0usize;
    let mut output_cursor = 0usize;
    while input_cursor < rendered.bytes.len() {
        let line_width = match rendered.bytes[input_cursor] {
            b'\r' if rendered.bytes.get(input_cursor + 1) == Some(&b'\n') => 2,
            b'\r' | b'\n' => 1,
            _ => {
                output[output_cursor] = rendered.bytes[input_cursor];
                input_cursor += 1;
                output_cursor += 1;
                continue;
            }
        };
        output[output_cursor..output_cursor + 7].copy_from_slice(b"<br />\n");
        output_cursor += 7;
        input_cursor += line_width;
    }
    write_materialized_string_value(output, tag == TAG_SAFE_STRING)
}

fn sum_value(value_offset: u32, attribute_offset: Option<u32>, start: f64) -> Result<u32, u32> {
    let Value::Array(array) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let attribute = if let Some(offset) = attribute_offset {
        Some(rendered_value(offset)?.bytes)
    } else {
        None
    };
    let mut total = start;
    if total.is_nan() {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    for index in 0..array.count {
        let value = read_u32(array.payload, 4 + index * 4)?;
        let selected = if let Some(path) = attribute {
            lookup_value_path(value, path)?.ok_or(ERROR_INVALID_EXPRESSION)?
        } else {
            value
        };
        let number = Value::at(selected)?.as_number();
        if number.is_nan() {
            return Err(ERROR_INVALID_EXPRESSION);
        }
        total += number;
    }
    write_computed_number(total)
}

fn round_value(
    value_offset: u32,
    precision: usize,
    method_offset: Option<u32>,
) -> Result<u32, u32> {
    let number = Value::at(value_offset)?.as_number();
    if number.is_nan() || precision > 308 {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let factor = libm::pow(10.0, precision as f64);
    let scaled = number * factor;
    let rounded = if let Some(method_offset) = method_offset {
        match rendered_value(method_offset)?.bytes {
            b"floor" => libm::floor(scaled),
            b"ceil" => libm::ceil(scaled),
            b"common" => libm::round(scaled),
            _ => return Err(ERROR_INVALID_EXPRESSION),
        }
    } else {
        libm::round(scaled)
    } / factor;
    write_computed_number(rounded)
}

fn replace_value(
    input_offset: u32,
    from_offset: u32,
    to_offset: u32,
    limit: usize,
) -> Result<u32, u32> {
    if matches!(Value::at(from_offset)?, Value::Regex(_)) {
        return regex_replace_value(input_offset, from_offset, to_offset);
    }
    if !matches!(
        Value::at(input_offset)?,
        Value::String(_) | Value::SafeString(_) | Value::Number { .. }
    ) {
        return Ok(input_offset);
    }
    let input = rendered_value(input_offset)?;
    if !matches!(
        Value::at(from_offset)?,
        Value::String(_) | Value::SafeString(_) | Value::Number { .. }
    ) {
        return write_materialized_string_value(input.bytes, input.safe);
    }
    let from = rendered_value(from_offset)?.bytes;
    let to = rendered_value(to_offset)?.bytes;
    if limit == 0 || (from.is_empty() && to.is_empty()) {
        return write_materialized_string_value(input.bytes, input.safe);
    }
    if from.is_empty() {
        let insertion_count = input.bytes.len().saturating_add(1).min(limit);
        let added = insertion_count
            .checked_mul(to.len())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        let length = input
            .bytes
            .len()
            .checked_add(added)
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        let tag = if input.safe {
            TAG_SAFE_STRING
        } else {
            TAG_STRING
        };
        let (_, output) = allocate_scratch(
            u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
        )?;
        let mut output_cursor = 0usize;
        for index in 0..=input.bytes.len() {
            if index < insertion_count {
                output[output_cursor..output_cursor + to.len()].copy_from_slice(to);
                output_cursor += to.len();
            }
            if let Some(byte) = input.bytes.get(index) {
                output[output_cursor] = *byte;
                output_cursor += 1;
            }
        }
        return write_materialized_string_value(output, tag == TAG_SAFE_STRING);
    }
    let mut count = 0usize;
    let mut cursor = 0usize;
    while count < limit && cursor + from.len() <= input.bytes.len() {
        let Some(relative) = input.bytes[cursor..]
            .windows(from.len())
            .position(|window| window == from)
        else {
            break;
        };
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = cursor
            .checked_add(relative)
            .and_then(|value| value.checked_add(from.len()))
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    let removed = count.checked_mul(from.len()).ok_or(ERROR_RESOURCE_LIMIT)?;
    let added = count.checked_mul(to.len()).ok_or(ERROR_RESOURCE_LIMIT)?;
    let length = input
        .bytes
        .len()
        .checked_sub(removed)
        .and_then(|value| value.checked_add(added))
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let tag = if input.safe {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let mut input_cursor = 0usize;
    let mut output_cursor = 0usize;
    let mut replaced = 0usize;
    while replaced < count {
        let relative = input.bytes[input_cursor..]
            .windows(from.len())
            .position(|window| window == from)
            .ok_or(ERROR_INVALID_ARENA)?;
        let match_start = input_cursor + relative;
        let prefix = &input.bytes[input_cursor..match_start];
        output[output_cursor..output_cursor + prefix.len()].copy_from_slice(prefix);
        output_cursor += prefix.len();
        output[output_cursor..output_cursor + to.len()].copy_from_slice(to);
        output_cursor += to.len();
        input_cursor = match_start + from.len();
        replaced += 1;
    }
    output[output_cursor..].copy_from_slice(&input.bytes[input_cursor..]);
    write_materialized_string_value(output, tag == TAG_SAFE_STRING)
}

fn random_value(value_offset: u32) -> Result<u32, u32> {
    let listed_offset = match Value::at(value_offset)? {
        Value::Array(_) => value_offset,
        Value::String(_) | Value::SafeString(_) => list_value(value_offset)?,
        Value::Undefined | Value::Null => return allocate_record(TAG_UNDEFINED, 0),
        _ => return Err(ERROR_INVALID_EXPRESSION),
    };
    let Value::Array(array) = Value::at(listed_offset)? else {
        return Err(ERROR_INVALID_ARENA);
    };
    if array.count == 0 {
        return allocate_record(TAG_UNDEFINED, 0);
    }
    let count = u32::try_from(array.count).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    // The worker import receives only a validated non-zero bound and must return an index below it.
    let index = unsafe { nunjitsu_random_index(count) };
    if index >= count {
        return Err(ERROR_INVALID_ARENA);
    }
    read_u32(array.payload, 4 + index as usize * 4)
}

fn regex_replace_value(
    input_offset: u32,
    regex_offset: u32,
    replacement_offset: u32,
) -> Result<u32, u32> {
    let input = match Value::at(input_offset)? {
        Value::String(bytes) | Value::SafeString(bytes) => bytes,
        _ => return Err(ERROR_INVALID_EXPRESSION),
    };
    let regex = match Value::at(regex_offset)? {
        Value::Regex(bytes) => bytes,
        _ => return Err(ERROR_INVALID_RECORD),
    };
    let (regex_pointer, regex) = write_scratch(regex)?;
    let (input_pointer, input) = write_scratch(input)?;
    let (replacement_pointer, replacement) =
        write_scratch(javascript_string_bytes(replacement_offset)?)?;
    let input_length = u32::try_from(input.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let regex_length = u32::try_from(regex.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let replacement_length = u32::try_from(replacement.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    // The worker validates every range and returns either the exact UTF-8 length or an error sentinel.
    let output_length = unsafe {
        nunjitsu_regex_replace(
            input_pointer,
            input_length,
            regex_pointer,
            regex_length,
            replacement_pointer,
            replacement_length,
            0,
            0,
        )
    };
    if matches!(output_length, 0xffff_ffff | 0xffff_fffe) {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let tag = if matches!(Value::at(input_offset)?, Value::SafeString(_)) {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let (output_offset, output) = allocate_scratch(output_length)?;
    if output_length == 0 {
        return write_materialized_string_value(output, tag == TAG_SAFE_STRING);
    }
    // The second call writes into the newly allocated payload and must reproduce the sized result.
    let written = unsafe {
        nunjitsu_regex_replace(
            input_pointer,
            input_length,
            regex_pointer,
            regex_length,
            replacement_pointer,
            replacement_length,
            output_offset,
            output_length,
        )
    };
    if written != output_length {
        return Err(ERROR_INVALID_ARENA);
    }
    write_materialized_string_value(output, tag == TAG_SAFE_STRING)
}
