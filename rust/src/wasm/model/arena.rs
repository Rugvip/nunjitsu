fn allocate_record(tag: u32, payload_length: u32) -> Result<u32, u32> {
    if slot_payload_length(tag).is_some() {
        return allocate_slot(tag, payload_length);
    }
    if member_backed_tag(tag) {
        return allocate_member_record(tag, payload_length);
    }
    let total_length = (RECORD_HEADER_LENGTH as u32)
        .checked_add(payload_length)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let offset = arena_alloc(total_length, RECORD_ALIGNMENT)?;
    write_record_header(offset, tag, payload_length)?;
    let payload = mutable_memory(offset + RECORD_HEADER_LENGTH as u32, payload_length)?;
    payload.fill(0);
    Ok(offset)
}

fn write_bytes_record(tag: u32, bytes: &[u8]) -> Result<u32, u32> {
    if tag == TAG_SAFE_STRING {
        return write_materialized_string_value(bytes, true);
    }
    let offset = allocate_record(tag, bytes.len() as u32)?;
    mutable_record_at(offset, tag)?.copy_from_slice(bytes);
    Ok(offset)
}

fn write_materialized_string_value(bytes: &[u8], safe: bool) -> Result<u32, u32> {
    let (handle, length) = materialized_string_handle(bytes)?;
    write_computed_string_value(handle, 0, length, safe)
}

fn write_string_value(bytes: &[u8]) -> Result<u32, u32> {
    write_materialized_string_value(bytes, false)
}

fn finish_string_record(offset: u32, tag: u32) -> Result<u32, u32> {
    let safe = tag == TAG_SAFE_STRING;
    if !safe && tag != TAG_STRING {
        return Err(ERROR_INVALID_RECORD);
    }
    write_materialized_string_value(record_at(offset, tag)?, safe)
}

fn write_materialized_code_unit_value(
    value_start: u32,
    code_unit_length: u32,
    byte_length: u32,
    safe: bool,
) -> Result<u32, u32> {
    let handle = allocate_materialized_string_operation(
        value_start,
        code_unit_length,
        byte_length,
    )?;
    write_computed_string_value(handle, 0, code_unit_length, safe)
}

fn write_computed_string_value(
    handle: u32,
    start: u32,
    length: u32,
    safe: bool,
) -> Result<u32, u32> {
    let tag = if safe {
        TAG_SAFE_STRING_VALUE
    } else {
        TAG_STRING_VALUE
    };
    let offset = allocate_slot(tag, 12)?;
    let payload = mutable_slot_record(offset, tag)?.ok_or(ERROR_INVALID_RECORD)?;
    write_u32(payload, 0, handle)?;
    write_u32(payload, 4, start)?;
    write_u32(payload, 8, length)?;
    Ok(offset)
}

fn write_code_units_scratch(code_units: &[u16]) -> Result<&'static [u8], u32> {
    let length = core::char::decode_utf16(code_units.iter().copied()).try_fold(
        0usize,
        |length, character| {
            length.checked_add(character.unwrap_or(char::REPLACEMENT_CHARACTER).len_utf8())
        },
    ).ok_or(ERROR_RESOURCE_LIMIT)?;
    let (_, output) = allocate_scratch(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let mut cursor = 0usize;
    for character in core::char::decode_utf16(code_units.iter().copied()) {
        let character = character.unwrap_or(char::REPLACEMENT_CHARACTER);
        let end = cursor
            .checked_add(character.len_utf8())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        character.encode_utf8(&mut output[cursor..end]);
        cursor = end;
    }
    Ok(output)
}

fn code_units_as_utf8(code_units: &[u16]) -> Result<&'static [u8], u32> {
    write_code_units_scratch(code_units)
}

fn write_identifier(code_units: &[u16]) -> Result<u32, u32> {
    let length = u32::try_from(code_units.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let (start, output) = allocate_value_code_units(length)?;
    output.copy_from_slice(code_units);
    let offset = allocate_slot(TAG_IDENTIFIER, 8)?;
    let payload = mutable_slot_record(offset, TAG_IDENTIFIER)?.ok_or(ERROR_INVALID_RECORD)?;
    write_u32(payload, 0, start)?;
    write_u32(payload, 4, length)?;
    Ok(offset)
}

fn write_regex(code_units: &[u16]) -> Result<u32, u32> {
    let length = u32::try_from(code_units.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let (start, output) = allocate_value_code_units(length)?;
    output.copy_from_slice(code_units);
    let offset = allocate_slot(TAG_REGEX, 8)?;
    let payload = mutable_slot_record(offset, TAG_REGEX)?.ok_or(ERROR_INVALID_RECORD)?;
    write_u32(payload, 0, start)?;
    write_u32(payload, 4, length)?;
    Ok(offset)
}

fn write_identifier_bytes(bytes: &[u8]) -> Result<u32, u32> {
    let value = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
    let length = value.encode_utf16().count();
    let (start, output) = allocate_value_code_units(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    for (destination, code_unit) in output.iter_mut().zip(value.encode_utf16()) {
        *destination = code_unit;
    }
    let offset = allocate_slot(TAG_IDENTIFIER, 8)?;
    let payload = mutable_slot_record(offset, TAG_IDENTIFIER)?.ok_or(ERROR_INVALID_RECORD)?;
    write_u32(payload, 0, start)?;
    write_u32(
        payload,
        4,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    Ok(offset)
}

fn identifier_code_units(offset: u32) -> Result<&'static [u16], u32> {
    let payload = record_at(offset, TAG_IDENTIFIER)?;
    if payload.len() != 8 {
        return Err(ERROR_INVALID_RECORD);
    }
    let start = read_u32(payload, 0)?;
    let length = read_u32(payload, 4)?;
    let pool = unsafe { (*memory_prefix()).values };
    let end = start.checked_add(length).ok_or(ERROR_INVALID_RECORD)?;
    if end > pool.cursor {
        return Err(ERROR_INVALID_RECORD);
    }
    let byte_offset = pool
        .offset
        .checked_add(
            start
                .checked_mul(VALUE_CODE_UNIT_LENGTH)
                .ok_or(ERROR_INVALID_RECORD)?,
        )
        .ok_or(ERROR_INVALID_RECORD)?;
    let bytes = memory(
        byte_offset,
        length
            .checked_mul(VALUE_CODE_UNIT_LENGTH)
            .ok_or(ERROR_INVALID_RECORD)?,
    )?;
    Ok(unsafe { slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), length as usize) })
}

fn regex_code_units(offset: u32) -> Result<&'static [u16], u32> {
    let payload = record_at(offset, TAG_REGEX)?;
    if payload.len() != 8 {
        return Err(ERROR_INVALID_RECORD);
    }
    let start = read_u32(payload, 0)?;
    let length = read_u32(payload, 4)?;
    let pool = unsafe { (*memory_prefix()).values };
    let end = start.checked_add(length).ok_or(ERROR_INVALID_RECORD)?;
    if end > pool.cursor {
        return Err(ERROR_INVALID_RECORD);
    }
    let byte_offset = pool
        .offset
        .checked_add(
            start
                .checked_mul(VALUE_CODE_UNIT_LENGTH)
                .ok_or(ERROR_INVALID_RECORD)?,
        )
        .ok_or(ERROR_INVALID_RECORD)?;
    let bytes = memory(
        byte_offset,
        length
            .checked_mul(VALUE_CODE_UNIT_LENGTH)
            .ok_or(ERROR_INVALID_RECORD)?,
    )?;
    Ok(unsafe { slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), length as usize) })
}

fn validate_name(offset: u32) -> Result<(), u32> {
    match raw_record_at(offset)?.0 {
        TAG_STRING => {
            record_at(offset, TAG_STRING)?;
            Ok(())
        }
        TAG_IDENTIFIER => {
            identifier_code_units(offset)?;
            Ok(())
        }
        _ => Err(ERROR_INVALID_RECORD),
    }
}

fn name_eq_bytes(offset: u32, bytes: &[u8]) -> Result<bool, u32> {
    match raw_record_at(offset)?.0 {
        TAG_STRING => Ok(record_at(offset, TAG_STRING)? == bytes),
        TAG_IDENTIFIER => {
            let value = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            Ok(identifier_code_units(offset)?
                .iter()
                .copied()
                .eq(value.encode_utf16()))
        }
        _ => Err(ERROR_INVALID_RECORD),
    }
}

fn names_equal(left: u32, right: u32) -> Result<bool, u32> {
    match (raw_record_at(left)?.0, raw_record_at(right)?.0) {
        (TAG_STRING, TAG_STRING) => Ok(record_at(left, TAG_STRING)? == record_at(right, TAG_STRING)?),
        (TAG_IDENTIFIER, TAG_IDENTIFIER) => {
            Ok(identifier_code_units(left)? == identifier_code_units(right)?)
        }
        (TAG_IDENTIFIER, TAG_STRING) => name_eq_bytes(left, record_at(right, TAG_STRING)?),
        (TAG_STRING, TAG_IDENTIFIER) => name_eq_bytes(right, record_at(left, TAG_STRING)?),
        _ => Err(ERROR_INVALID_RECORD),
    }
}

fn utf8_as_code_units(bytes: &[u8]) -> Result<&'static [u16], u32> {
    let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
    let length = text.encode_utf16().count();
    let (_, output) = allocate_value_code_units(
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    for (destination, code_unit) in output.iter_mut().zip(text.encode_utf16()) {
        *destination = code_unit;
    }
    Ok(output)
}

fn write_boolean(value: bool) -> Result<u32, u32> {
    let offset = allocate_record(TAG_BOOLEAN, 1)?;
    mutable_record_at(offset, TAG_BOOLEAN)?[0] = u8::from(value);
    Ok(offset)
}

fn write_number(source: &[u16]) -> Result<u32, u32> {
    let source = code_units_as_utf8(source)?;
    let text = core::str::from_utf8(source).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    let value = text.parse::<f64>().map_err(|_| ERROR_INVALID_EXPRESSION)?;
    write_number_value(value)
}

fn write_computed_number(value: f64) -> Result<u32, u32> {
    write_number_value(value)
}

fn write_number_value(value: f64) -> Result<u32, u32> {
    let offset = allocate_record(TAG_NUMBER, 8)?;
    let payload = mutable_record_at(offset, TAG_NUMBER)?;
    payload.copy_from_slice(&value.to_le_bytes());
    Ok(offset)
}

fn write_u32_number(value: u32) -> Result<u32, u32> {
    let mut bytes = [0u8; 10];
    let mut cursor = bytes.len();
    let mut remaining = value;
    loop {
        cursor -= 1;
        bytes[cursor] = b'0' + (remaining % 10) as u8;
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    write_computed_number(value as f64)
}

fn record_at(offset: u32, expected_tag: u32) -> Result<&'static [u8], u32> {
    if offset == render_state_offset() {
        if expected_tag != TAG_RENDER_STATE {
            return Err(ERROR_INVALID_RECORD);
        }
        return Ok(render_state_bytes());
    }
    let (tag, payload) = raw_record_at(offset)?;
    if tag != expected_tag {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(payload)
}

fn mutable_record_at(offset: u32, expected_tag: u32) -> Result<&'static mut [u8], u32> {
    if offset == render_state_offset() {
        if expected_tag != TAG_RENDER_STATE {
            return Err(ERROR_INVALID_RECORD);
        }
        return Ok(mutable_render_state_bytes());
    }
    if let Some(payload) = mutable_slot_record(offset, expected_tag)? {
        return Ok(payload);
    }
    let header = memory(offset, RECORD_HEADER_LENGTH as u32)?;
    let tag = read_u32(header, 0)?;
    let payload_length = read_u32(header, 4)?;
    if tag != expected_tag {
        return Err(ERROR_INVALID_RECORD);
    }
    let payload_offset = offset
        .checked_add(RECORD_HEADER_LENGTH as u32)
        .ok_or(ERROR_INVALID_RECORD)?;
    mutable_memory(payload_offset, payload_length)
}

fn raw_record_at(offset: u32) -> Result<(u32, &'static [u8]), u32> {
    if offset == render_state_offset() {
        return Ok((TAG_RENDER_STATE, render_state_bytes()));
    }
    if let Some(record) = slot_record(offset)? {
        return Ok(record);
    }
    let header = memory(offset, RECORD_HEADER_LENGTH as u32)?;
    let tag = read_u32(header, 0)?;
    let payload_length = read_u32(header, 4)?;
    let payload_offset = offset
        .checked_add(RECORD_HEADER_LENGTH as u32)
        .ok_or(ERROR_INVALID_RECORD)?;
    Ok((tag, memory(payload_offset, payload_length)?))
}

fn collection_count(payload: &[u8], entry_length: usize) -> Result<usize, u32> {
    if payload.len() < size_of::<u32>() {
        return Err(ERROR_INVALID_RECORD);
    }
    let count = read_u32(payload, 0)? as usize;
    let expected_length = size_of::<u32>()
        .checked_add(
            count
                .checked_mul(entry_length)
                .ok_or(ERROR_INVALID_RECORD)?,
        )
        .ok_or(ERROR_INVALID_RECORD)?;
    if payload.len() != expected_length {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(count)
}

fn parse_index(bytes: &[u8]) -> Option<usize> {
    if bytes.is_empty() {
        return None;
    }
    let mut value = 0usize;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add((byte - b'0') as usize)?;
    }
    Some(value)
}

fn trim_ascii_whitespace(mut bytes: &[u8]) -> &[u8] {
    while bytes.first().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[1..];
    }
    while bytes.last().is_some_and(u8::is_ascii_whitespace) {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}

fn write_record_header(offset: u32, tag: u32, payload_length: u32) -> Result<(), u32> {
    let header = mutable_memory(offset, RECORD_HEADER_LENGTH as u32)?;
    write_u32(header, 0, tag)?;
    write_u32(header, 4, payload_length)
}

fn memory(offset: u32, length: u32) -> Result<&'static [u8], u32> {
    let end = (offset as usize)
        .checked_add(length as usize)
        .ok_or(ERROR_INVALID_RECORD)?;
    if end > linear_memory_length() {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(unsafe { slice::from_raw_parts(offset as *const u8, length as usize) })
}

fn mutable_memory(offset: u32, length: u32) -> Result<&'static mut [u8], u32> {
    let end = (offset as usize)
        .checked_add(length as usize)
        .ok_or(ERROR_INVALID_RECORD)?;
    if end > linear_memory_length() {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(unsafe { slice::from_raw_parts_mut(offset as *mut u8, length as usize) })
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, u32> {
    let end = offset
        .checked_add(size_of::<u32>())
        .ok_or(ERROR_INVALID_RECORD)?;
    if end > bytes.len() {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(unsafe { read_unaligned(bytes.as_ptr().add(offset).cast::<u32>()) })
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) -> Result<(), u32> {
    let end = offset
        .checked_add(size_of::<u32>())
        .ok_or(ERROR_INVALID_RECORD)?;
    if end > bytes.len() {
        return Err(ERROR_INVALID_RECORD);
    }
    unsafe {
        write_unaligned(bytes.as_mut_ptr().add(offset).cast::<u32>(), value);
    }
    Ok(())
}

fn arena_alloc(length: u32, alignment: u32) -> Result<u32, u32> {
    if alignment == 0 || !alignment.is_power_of_two() || alignment as usize > align_of::<u128>() {
        return Err(ERROR_INVALID_ARENA);
    }
    let cursor = legacy_arena_cursor();
    let start = align_up(cursor, alignment).ok_or(ERROR_INVALID_ARENA)?;
    let end = start.checked_add(length).ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let aligned_end = align_up(end, RECORD_ALIGNMENT).ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    if let Ok(limit) = active_limit(STATE_LIMIT_ARENA_BYTES) {
        let used = aligned_end
            .checked_sub(nunjitsu_arena_base())
            .ok_or(ERROR_INVALID_ARENA)?;
        enforce_limit(used, limit)?;
    }
    ensure_memory(aligned_end as usize)?;
    set_legacy_arena_cursor(aligned_end);
    Ok(start)
}

fn allocate_scratch(length: u32) -> Result<(u32, &'static mut [u8]), u32> {
    let offset = arena_alloc(length, 1)?;
    Ok((offset, mutable_memory(offset, length)?))
}

fn ensure_memory(required_length: usize) -> Result<(), u32> {
    if required_length > linear_memory_length() {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    Ok(())
}

fn linear_memory_length() -> usize {
    memory_size::<0>() * PAGE_SIZE
}

fn align_up(value: u32, alignment: u32) -> Option<u32> {
    let mask = alignment.checked_sub(1)?;
    value.checked_add(mask).map(|aligned| aligned & !mask)
}

fn render_error_code(error: RenderError) -> u32 {
    match error {
        RenderError::UnclosedInterpolation => ERROR_UNCLOSED_INTERPOLATION,
        RenderError::OutputTooLarge | RenderError::OutputBufferTooSmall => ERROR_OUTPUT_TOO_LARGE,
        RenderError::UnclosedBlockTag
        | RenderError::UnclosedComment
        | RenderError::UnclosedRaw
        | RenderError::UnsupportedTag
        | RenderError::InvalidInclude => ERROR_UNSUPPORTED_TAG,
    }
}

fn set_control(state: u32, payload_offset: u32, payload_length: u32, error_code: u32) {
    set_control_fields(state, payload_offset, payload_length, error_code);
}
