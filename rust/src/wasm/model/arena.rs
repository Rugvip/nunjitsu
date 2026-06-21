fn allocate_record(tag: u32, payload_length: u32) -> Result<u32, u32> {
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
    let offset = allocate_record(tag, bytes.len() as u32)?;
    mutable_record_at(offset, tag)?.copy_from_slice(bytes);
    Ok(offset)
}

fn write_boolean(value: bool) -> Result<u32, u32> {
    let offset = allocate_record(TAG_BOOLEAN, 1)?;
    mutable_record_at(offset, TAG_BOOLEAN)?[0] = u8::from(value);
    Ok(offset)
}

fn write_number(source: &[u8]) -> Result<u32, u32> {
    let text = core::str::from_utf8(source).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    let value = text.parse::<f64>().map_err(|_| ERROR_INVALID_EXPRESSION)?;
    write_number_value(value, source)
}

fn write_computed_number(value: f64) -> Result<u32, u32> {
    let mut buffer = ryu_js::Buffer::new();
    let rendered = buffer.format(value);
    write_number_value(value, rendered.as_bytes())
}

fn write_number_value(value: f64, rendered: &[u8]) -> Result<u32, u32> {
    let payload_length = 8u32
        .checked_add(rendered.len() as u32)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_NUMBER, payload_length)?;
    let payload = mutable_record_at(offset, TAG_NUMBER)?;
    payload[..8].copy_from_slice(&value.to_le_bytes());
    payload[8..].copy_from_slice(rendered);
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
    write_number(&bytes[cursor..])
}

fn record_at(offset: u32, expected_tag: u32) -> Result<&'static [u8], u32> {
    let (tag, payload) = raw_record_at(offset)?;
    if tag != expected_tag {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(payload)
}

fn mutable_record_at(offset: u32, expected_tag: u32) -> Result<&'static mut [u8], u32> {
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
    let cursor = unsafe { ARENA_CURSOR };
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
    unsafe {
        ARENA_CURSOR = aligned_end;
    }
    Ok(start)
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
    let control = addr_of_mut!(CONTROL);
    unsafe {
        (*control).state = state;
        (*control).payload_offset = payload_offset;
        (*control).payload_length = payload_length;
        (*control).error_code = error_code;
    }
}
