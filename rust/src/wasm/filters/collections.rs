fn reverse_value(value: Value) -> Result<u32, u32> {
    match value {
        Value::String(bytes) | Value::SafeString(bytes) => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let safe = matches!(value, Value::SafeString(_));
            let (_, output) = allocate_scratch(bytes.len() as u32)?;
            let mut cursor = 0usize;
            for character in text.chars().rev() {
                let mut encoded = [0u8; 4];
                let encoded = character.encode_utf8(&mut encoded).as_bytes();
                let end = cursor + encoded.len();
                output[cursor..end].copy_from_slice(encoded);
                cursor = end;
            }
            write_materialized_string_value(output, safe)
        }
        Value::Array(array) => {
            let payload_length = 4u32
                .checked_add(
                    (array.count as u32)
                        .checked_mul(4)
                        .ok_or(ERROR_RESOURCE_LIMIT)?,
                )
                .ok_or(ERROR_RESOURCE_LIMIT)?;
            let offset = allocate_record(TAG_ARRAY, payload_length)?;
            let output = mutable_record_at(offset, TAG_ARRAY)?;
            write_u32(output, 0, array.count as u32)?;
            for index in 0..array.count {
                write_u32(
                    output,
                    4 + index * 4,
                    read_u32(array.payload, 4 + (array.count - index - 1) * 4)?,
                )?;
            }
            Ok(offset)
        }
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn ascii_case_value(value_offset: u32, uppercase: bool, capitalize: bool) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let (_, output) = allocate_scratch(rendered.bytes.len() as u32)?;
    for (index, byte) in rendered.bytes.iter().copied().enumerate() {
        output[index] = if uppercase || (capitalize && index == 0) {
            byte.to_ascii_uppercase()
        } else {
            byte.to_ascii_lowercase()
        };
    }
    write_materialized_string_value(output, rendered.safe)
}

fn title_value(value_offset: u32) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let (_, output) = allocate_scratch(rendered.bytes.len() as u32)?;
    let mut word_start = true;
    for (index, byte) in rendered.bytes.iter().copied().enumerate() {
        output[index] = if byte.is_ascii_alphabetic() {
            let value = if word_start {
                byte.to_ascii_uppercase()
            } else {
                byte.to_ascii_lowercase()
            };
            word_start = false;
            value
        } else {
            word_start = true;
            byte
        };
    }
    write_materialized_string_value(output, rendered.safe)
}

fn numeric_usize(value_offset: u32) -> Result<usize, u32> {
    let number = Value::at(value_offset)?.as_number();
    if !number.is_finite() || number < 0.0 || number > usize::MAX as f64 {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    Ok(number as usize)
}

fn allocate_value_array(count: usize) -> Result<u32, u32> {
    let payload_length = 4u32
        .checked_add(
            u32::try_from(count)
                .map_err(|_| ERROR_RESOURCE_LIMIT)?
                .checked_mul(4)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_ARRAY, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_ARRAY)?, 0, count as u32)?;
    Ok(offset)
}

fn batch_value(value_offset: u32, size: usize, fill: Option<u32>) -> Result<u32, u32> {
    if size == 0 {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let Value::Array(array) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let group_count = array.count.div_ceil(size);
    let output_offset = allocate_value_array(group_count)?;
    for group_index in 0..group_count {
        let start = group_index * size;
        let available = (array.count - start).min(size);
        let group_length = if fill.is_some() { size } else { available };
        let group_offset = allocate_value_array(group_length)?;
        for index in 0..group_length {
            let item = if index < available {
                read_u32(array.payload, 4 + (start + index) * 4)?
            } else {
                fill.ok_or(ERROR_INVALID_STATE)?
            };
            write_u32(
                mutable_record_at(group_offset, TAG_ARRAY)?,
                4 + index * 4,
                item,
            )?;
        }
        write_u32(
            mutable_record_at(output_offset, TAG_ARRAY)?,
            4 + group_index * 4,
            group_offset,
        )?;
    }
    Ok(output_offset)
}

fn list_value(value_offset: u32) -> Result<u32, u32> {
    match Value::at(value_offset)? {
        Value::Array(array) => {
            let output = allocate_value_array(array.count)?;
            for index in 0..array.count {
                write_u32(
                    mutable_record_at(output, TAG_ARRAY)?,
                    4 + index * 4,
                    read_u32(array.payload, 4 + index * 4)?,
                )?;
            }
            Ok(output)
        }
        Value::String(bytes) | Value::SafeString(bytes) => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let output = allocate_value_array(text.chars().count())?;
            for (index, character) in text.chars().enumerate() {
                let mut encoded = [0u8; 4];
                let item =
                    write_string_value(character.encode_utf8(&mut encoded).as_bytes())?;
                write_u32(mutable_record_at(output, TAG_ARRAY)?, 4 + index * 4, item)?;
            }
            Ok(output)
        }
        Value::Record(record) => {
            let output = allocate_value_array(record.count)?;
            let key_name = write_identifier_bytes(b"key")?;
            let value_name = write_identifier_bytes(b"value")?;
            for index in 0..record.count {
                let pair = allocate_record(TAG_RECORD, 20)?;
                let pair_record = mutable_record_at(pair, TAG_RECORD)?;
                write_u32(pair_record, 0, 2)?;
                write_u32(pair_record, 4, key_name)?;
                write_u32(pair_record, 8, read_u32(record.payload, 4 + index * 8)?)?;
                write_u32(pair_record, 12, value_name)?;
                write_u32(pair_record, 16, read_u32(record.payload, 8 + index * 8)?)?;
                write_u32(mutable_record_at(output, TAG_ARRAY)?, 4 + index * 4, pair)?;
            }
            Ok(output)
        }
        Value::Undefined | Value::Null => allocate_value_array(0),
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn selection_source(value_offset: u32) -> Result<Array, u32> {
    match Value::at(value_offset)? {
        Value::Array(array) => Ok(array),
        Value::String(_) | Value::SafeString(_) | Value::Record(_) => {
            let listed = list_value(value_offset)?;
            let Value::Array(array) = Value::at(listed)? else {
                return Err(ERROR_INVALID_STATE);
            };
            Ok(array)
        }
        Value::Undefined | Value::Null => {
            let empty = allocate_value_array(0)?;
            let Value::Array(array) = Value::at(empty)? else {
                return Err(ERROR_INVALID_STATE);
            };
            Ok(array)
        }
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn selection_test_call<'a>(state_offset: u32, call: Call<'a>) -> Result<Call<'a>, u32> {
    let Some(argument) =
        next_macro_argument(call.arguments, 0).map_err(|_| ERROR_INVALID_EXPRESSION)?
    else {
        return Ok(Call {
            name: utf8_as_code_units(b"truthy")?,
            arguments: &call.arguments[..0],
        });
    };
    if argument.name.is_some() {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let name_offset = resolve_atom(state_offset, argument.value)?;
    let name = Value::at(name_offset)?
        .string_bytes()
        .ok_or(ERROR_INVALID_EXPRESSION)?;
    Ok(Call {
        name: utf8_as_code_units(name)?,
        arguments: &call.arguments[argument.next_cursor..],
    })
}

fn select_or_reject_value(
    state_offset: u32,
    value_offset: u32,
    call: Call<'_>,
    expected: bool,
) -> Result<u32, u32> {
    let array = selection_source(value_offset)?;
    let test_call = selection_test_call(state_offset, call)?;
    if resolve_capability(
        state_field(state_offset, STATE_TESTS)?,
        code_units_as_utf8(test_call.name)?,
    )?
    .is_some()
    {
        return Err(ERROR_UNKNOWN_CAPABILITY);
    }
    let mut count = 0usize;
    for index in 0..array.count {
        let item = read_u32(array.payload, 4 + index * 4)?;
        let result =
            apply_builtin_test(state_offset, test_call, item)?.ok_or(ERROR_UNKNOWN_CAPABILITY)?;
        if result == expected {
            count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
    }
    let output = allocate_value_array(count)?;
    let mut output_index = 0usize;
    for index in 0..array.count {
        let item = read_u32(array.payload, 4 + index * 4)?;
        let result =
            apply_builtin_test(state_offset, test_call, item)?.ok_or(ERROR_UNKNOWN_CAPABILITY)?;
        if result == expected {
            write_u32(
                mutable_record_at(output, TAG_ARRAY)?,
                4 + output_index * 4,
                item,
            )?;
            output_index += 1;
        }
    }
    Ok(output)
}

fn select_or_reject_attribute_value(
    value_offset: u32,
    attribute_offset: u32,
    expected: bool,
) -> Result<u32, u32> {
    let array = selection_source(value_offset)?;
    let path = rendered_value(attribute_offset)?.bytes;
    let mut count = 0usize;
    for index in 0..array.count {
        let item = read_u32(array.payload, 4 + index * 4)?;
        let selected = lookup_value_path(item, path)?;
        let result = selected.is_some_and(|offset| Value::at(offset).is_ok_and(Value::truthy));
        if result == expected {
            count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
    }
    let output = allocate_value_array(count)?;
    let mut output_index = 0usize;
    for index in 0..array.count {
        let item = read_u32(array.payload, 4 + index * 4)?;
        let selected = lookup_value_path(item, path)?;
        let result = selected.is_some_and(|offset| Value::at(offset).is_ok_and(Value::truthy));
        if result == expected {
            write_u32(
                mutable_record_at(output, TAG_ARRAY)?,
                4 + output_index * 4,
                item,
            )?;
            output_index += 1;
        }
    }
    Ok(output)
}

fn compare_filter_values(
    left_offset: u32,
    right_offset: u32,
    case_sensitive: bool,
) -> Result<core::cmp::Ordering, u32> {
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    if let (Value::Number { numeric: left, .. }, Value::Number { numeric: right, .. }) =
        (left, right)
    {
        return left.partial_cmp(&right).ok_or(ERROR_INVALID_EXPRESSION);
    }
    let left = rendered_value(left_offset)?.bytes;
    let right = rendered_value(right_offset)?.bytes;
    if case_sensitive {
        return Ok(left.cmp(right));
    }
    Ok(left
        .iter()
        .map(u8::to_ascii_lowercase)
        .cmp(right.iter().map(u8::to_ascii_lowercase)))
}

fn sorted_rank_index(
    values: &[u8],
    count: usize,
    requested_rank: usize,
    case_sensitive: bool,
    attribute: Option<&[u8]>,
    stride: usize,
    value_field: usize,
) -> Result<usize, u32> {
    for candidate in 0..count {
        let candidate_value = read_u32(values, value_field + candidate * stride)?;
        let candidate_selected = if let Some(path) = attribute {
            lookup_value_path(candidate_value, path)?.ok_or(ERROR_INVALID_EXPRESSION)?
        } else {
            candidate_value
        };
        let mut rank = 0usize;
        for other in 0..count {
            if other == candidate {
                continue;
            }
            let other_value = read_u32(values, value_field + other * stride)?;
            let other_selected = if let Some(path) = attribute {
                lookup_value_path(other_value, path)?.ok_or(ERROR_INVALID_EXPRESSION)?
            } else {
                other_value
            };
            let ordering =
                compare_filter_values(other_selected, candidate_selected, case_sensitive)?;
            if ordering == core::cmp::Ordering::Less
                || (ordering == core::cmp::Ordering::Equal && other < candidate)
            {
                rank += 1;
            }
        }
        if rank == requested_rank {
            return Ok(candidate);
        }
    }
    Err(ERROR_INVALID_STATE)
}

fn dictsort_value(value_offset: u32, case_sensitive: bool, by_value: bool) -> Result<u32, u32> {
    let Value::Record(record) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let output = allocate_value_array(record.count)?;
    for output_index in 0..record.count {
        let source_index = sorted_rank_index(
            record.payload,
            record.count,
            output_index,
            case_sensitive,
            None,
            8,
            if by_value { 8 } else { 4 },
        )?;
        let pair = allocate_value_array(2)?;
        write_u32(
            mutable_record_at(pair, TAG_ARRAY)?,
            4,
            read_u32(record.payload, 4 + source_index * 8)?,
        )?;
        write_u32(
            mutable_record_at(pair, TAG_ARRAY)?,
            8,
            read_u32(record.payload, 8 + source_index * 8)?,
        )?;
        write_u32(
            mutable_record_at(output, TAG_ARRAY)?,
            4 + output_index * 4,
            pair,
        )?;
    }
    Ok(output)
}

fn groupby_value(value_offset: u32, attribute_offset: u32) -> Result<u32, u32> {
    let Value::Array(array) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let path = rendered_value(attribute_offset)?.bytes;
    let keys_offset = allocate_value_array(array.count)?;
    for index in 0..array.count {
        let item = read_u32(array.payload, 4 + index * 4)?;
        let selected = if path.is_empty() {
            None
        } else {
            match lookup_value_path(item, path) {
                Ok(selected) => selected,
                Err(ERROR_INVALID_EXPRESSION) => None,
                Err(error) => return Err(error),
            }
        };
        let key = property_key_value(selected)?;
        write_u32(
            mutable_record_at(keys_offset, TAG_ARRAY)?,
            4 + index * 4,
            key,
        )?;
    }
    let Value::Array(keys) = Value::at(keys_offset)? else {
        return Err(ERROR_INVALID_STATE);
    };
    let mut group_count = 0usize;
    for index in 0..keys.count {
        if first_key_index(keys, index)? == index {
            group_count = group_count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
    }
    let output = allocate_value_array(group_count)?;
    for rank in 0..group_count {
        let key_index = group_key_index_at_rank(keys, rank)?.ok_or(ERROR_INVALID_STATE)?;
        let key = read_u32(keys.payload, 4 + key_index * 4)?;
        let key_bytes = rendered_value(key)?.bytes;
        let mut item_count = 0usize;
        for index in 0..keys.count {
            let candidate = read_u32(keys.payload, 4 + index * 4)?;
            if rendered_value(candidate)?.bytes == key_bytes {
                item_count = item_count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            }
        }
        let items = allocate_value_array(item_count)?;
        let mut item_index = 0usize;
        for index in 0..keys.count {
            let candidate = read_u32(keys.payload, 4 + index * 4)?;
            if rendered_value(candidate)?.bytes == key_bytes {
                write_u32(
                    mutable_record_at(items, TAG_ARRAY)?,
                    4 + item_index * 4,
                    read_u32(array.payload, 4 + index * 4)?,
                )?;
                item_index += 1;
            }
        }
        let pair = allocate_value_array(2)?;
        write_u32(mutable_record_at(pair, TAG_ARRAY)?, 4, key)?;
        write_u32(mutable_record_at(pair, TAG_ARRAY)?, 8, items)?;
        write_u32(mutable_record_at(output, TAG_ARRAY)?, 4 + rank * 4, pair)?;
    }
    Ok(output)
}

fn property_key_value(value_offset: Option<u32>) -> Result<u32, u32> {
    let Some(value_offset) = value_offset else {
        return write_string_value(b"undefined");
    };
    match Value::at(value_offset)? {
        Value::Undefined => write_string_value(b"undefined"),
        Value::Null => write_string_value(b"null"),
        _ => write_string_value(rendered_value(value_offset)?.bytes),
    }
}

fn first_key_index(keys: Array, candidate: usize) -> Result<usize, u32> {
    let key = rendered_value(read_u32(keys.payload, 4 + candidate * 4)?)?.bytes;
    for index in 0..candidate {
        let existing = rendered_value(read_u32(keys.payload, 4 + index * 4)?)?.bytes;
        if existing == key {
            return Ok(index);
        }
    }
    Ok(candidate)
}

fn group_key_index_at_rank(keys: Array, requested_rank: usize) -> Result<Option<usize>, u32> {
    for candidate in 0..keys.count {
        if first_key_index(keys, candidate)? != candidate {
            continue;
        }
        let key = rendered_value(read_u32(keys.payload, 4 + candidate * 4)?)?.bytes;
        let numeric = property_index(key);
        let mut rank = 0usize;
        for other in 0..keys.count {
            if first_key_index(keys, other)? != other || other == candidate {
                continue;
            }
            let other_key = rendered_value(read_u32(keys.payload, 4 + other * 4)?)?.bytes;
            let other_numeric = property_index(other_key);
            let precedes = match (numeric, other_numeric) {
                (Some(candidate), Some(other)) => other < candidate,
                (None, Some(_)) => true,
                (None, None) => other < candidate,
                (Some(_), None) => false,
            };
            if precedes {
                rank += 1;
            }
        }
        if rank == requested_rank {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn property_index(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || (bytes.len() > 1 && bytes[0] == b'0') {
        return None;
    }
    let mut value = 0u64;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((byte - b'0') as u64)?;
    }
    if value < u32::MAX as u64 {
        Some(value as u32)
    } else {
        None
    }
}

fn slice_value(value_offset: u32, slices: usize, fill: Option<u32>) -> Result<u32, u32> {
    if slices == 0 {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let Value::Array(array) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let output = allocate_value_array(slices)?;
    let base = array.count / slices;
    let extra = array.count % slices;
    let target_length = array.count.div_ceil(slices);
    let mut source_index = 0usize;
    for slice_index in 0..slices {
        let available = base + usize::from(slice_index < extra);
        let length = if fill.is_some() {
            target_length
        } else {
            available
        };
        let group = allocate_value_array(length)?;
        for index in 0..length {
            let item = if index < available {
                read_u32(array.payload, 4 + (source_index + index) * 4)?
            } else {
                fill.ok_or(ERROR_INVALID_STATE)?
            };
            write_u32(mutable_record_at(group, TAG_ARRAY)?, 4 + index * 4, item)?;
        }
        source_index += available;
        write_u32(
            mutable_record_at(output, TAG_ARRAY)?,
            4 + slice_index * 4,
            group,
        )?;
    }
    Ok(output)
}

fn sort_value(
    value_offset: u32,
    reverse: bool,
    case_sensitive: bool,
    attribute_offset: Option<u32>,
) -> Result<u32, u32> {
    let Value::Array(array) = Value::at(value_offset)? else {
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let attribute = if let Some(offset) = attribute_offset {
        Some(rendered_value(offset)?.bytes)
    } else {
        None
    };
    let output = allocate_value_array(array.count)?;
    for output_index in 0..array.count {
        let rank = if reverse {
            array.count - output_index - 1
        } else {
            output_index
        };
        let source_index = sorted_rank_index(
            array.payload,
            array.count,
            rank,
            case_sensitive,
            attribute,
            4,
            4,
        )?;
        write_u32(
            mutable_record_at(output, TAG_ARRAY)?,
            4 + output_index * 4,
            read_u32(array.payload, 4 + source_index * 4)?,
        )?;
    }
    Ok(output)
}

fn center_value(value_offset: u32, width: usize) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let padding = width.saturating_sub(rendered.bytes.len());
    let left = padding / 2;
    let length = rendered
        .bytes
        .len()
        .checked_add(padding)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    output.fill(b' ');
    output[left..left + rendered.bytes.len()].copy_from_slice(rendered.bytes);
    write_materialized_string_value(output, rendered.safe)
}

fn parse_integer(value_offset: u32, base: usize) -> Result<Option<i64>, u32> {
    if base == 10 {
        let number = Value::at(value_offset)?.as_number();
        return Ok(
            (number.is_finite() && number >= i64::MIN as f64 && number <= i64::MAX as f64)
                .then(|| libm::trunc(number) as i64),
        );
    }
    if !(2..=36).contains(&base) {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let rendered = rendered_value(value_offset)?;
    let mut bytes = trim_ascii_whitespace(rendered.bytes);
    let negative = bytes.first() == Some(&b'-');
    if matches!(bytes.first(), Some(b'-' | b'+')) {
        bytes = &bytes[1..];
    }
    if base == 16
        && bytes
            .get(..2)
            .is_some_and(|prefix| matches!(prefix, b"0x" | b"0X"))
    {
        bytes = &bytes[2..];
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    let mut value = 0i64;
    for byte in bytes.iter().copied() {
        let digit = match byte {
            b'0'..=b'9' => usize::from(byte - b'0'),
            b'a'..=b'z' => usize::from(byte - b'a') + 10,
            b'A'..=b'Z' => usize::from(byte - b'A') + 10,
            _ => return Ok(None),
        };
        if digit >= base {
            return Ok(None);
        }
        value = value
            .checked_mul(base as i64)
            .and_then(|current| current.checked_add(digit as i64))
            .ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    Ok(Some(if negative { -value } else { value }))
}

fn indent_value(value_offset: u32, width: usize, first: bool) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    if rendered.bytes.is_empty() {
        return write_materialized_string_value(b"", rendered.safe);
    }
    let line_count = rendered.bytes.iter().filter(|byte| **byte == b'\n').count();
    let indent_count = line_count + usize::from(first);
    let length = rendered
        .bytes
        .len()
        .checked_add(
            width
                .checked_mul(indent_count)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let mut output_cursor = 0usize;
    if first {
        output[..width].fill(b' ');
        output_cursor = width;
    }
    let mut input_cursor = 0usize;
    for (index, byte) in rendered.bytes.iter().copied().enumerate() {
        if byte != b'\n' {
            continue;
        }
        let segment = &rendered.bytes[input_cursor..=index];
        output[output_cursor..output_cursor + segment.len()].copy_from_slice(segment);
        output_cursor += segment.len();
        output[output_cursor..output_cursor + width].fill(b' ');
        output_cursor += width;
        input_cursor = index + 1;
    }
    output[output_cursor..].copy_from_slice(&rendered.bytes[input_cursor..]);
    write_materialized_string_value(output, rendered.safe)
}

fn join_value(
    value_offset: u32,
    separator_offset: Option<u32>,
    attribute_offset: Option<u32>,
) -> Result<u32, u32> {
    let Value::Array(array) = Value::at(value_offset)? else {
        if matches!(Value::at(value_offset)?, Value::Undefined | Value::Null) {
            return write_string_value(b"");
        }
        return Err(ERROR_INVALID_EXPRESSION);
    };
    let separator = if let Some(offset) = separator_offset {
        rendered_value(offset)?.bytes
    } else {
        b""
    };
    let attribute = if let Some(offset) = attribute_offset {
        Some(rendered_value(offset)?.bytes)
    } else {
        None
    };
    let mut length = separator
        .len()
        .checked_mul(array.count.saturating_sub(1))
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    for index in 0..array.count {
        let value = read_u32(array.payload, 4 + index * 4)?;
        let selected = if let Some(path) = attribute {
            lookup_value_path(value, path)?
        } else {
            Some(value)
        };
        if let Some(selected) = selected {
            length = length
                .checked_add(coerced_value_length(selected)?)
                .ok_or(ERROR_RESOURCE_LIMIT)?;
        }
    }
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let mut cursor = 0usize;
    for index in 0..array.count {
        if index != 0 {
            write_coerced_bytes(output, &mut cursor, separator)?;
        }
        let value = read_u32(array.payload, 4 + index * 4)?;
        let selected = if let Some(path) = attribute {
            lookup_value_path(value, path)?
        } else {
            Some(value)
        };
        if let Some(selected) = selected {
            write_coerced_value_into(selected, output, &mut cursor)?;
        }
    }
    write_string_value(output)
}

fn lookup_value_path(mut value_offset: u32, path: &[u8]) -> Result<Option<u32>, u32> {
    let path = utf8_as_code_units(path)?;
    let mut cursor = 0usize;
    while let Some((segment, next)) =
        next_lookup_segment(path, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let Some(next_offset) = Value::at(value_offset)?.get_offset(code_units_as_utf8(segment)?) else {
            return Ok(None);
        };
        value_offset = next_offset;
        cursor = next;
    }
    Ok(Some(value_offset))
}
