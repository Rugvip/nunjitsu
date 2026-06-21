struct ComputedOutputValue {
    handle: u32,
    start: u32,
    length: u32,
    byte_length: u32,
    safe: bool,
}

fn rendered_value(value_offset: u32) -> Result<RenderedValue<'static>, u32> {
    let value = Value::at(value_offset)?;
    if let Value::Number { numeric } = value {
        let mut buffer = ryu_js::Buffer::new();
        let bytes = buffer.format(numeric).as_bytes();
        let (_, output) = allocate_scratch(
            u32::try_from(bytes.len()).map_err(|_| ERROR_RESOURCE_LIMIT)?,
        )?;
        output.copy_from_slice(bytes);
        return Ok(RenderedValue {
            bytes: output,
            safe: false,
        });
    }
    if matches!(value, Value::Array(_) | Value::Record(_)) {
        return Ok(RenderedValue {
            bytes: write_coerced_value(value_offset)?,
            safe: false,
        });
    }
    value.rendered().ok_or(ERROR_INVALID_EXPRESSION)
}

fn write_coerced_value(value_offset: u32) -> Result<&'static [u8], u32> {
    let length = coerced_value_length(value_offset)?;
    let length = u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let (_, output) = allocate_scratch(length)?;
    let mut cursor = 0usize;
    write_coerced_value_into(value_offset, output, &mut cursor)?;
    if cursor != output.len() {
        return Err(ERROR_INVALID_ARENA);
    }
    Ok(output)
}

fn coerced_value_length(value_offset: u32) -> Result<usize, u32> {
    match Value::at(value_offset)? {
        Value::Array(array) => {
            let mut length = array.count.saturating_sub(1);
            for index in 0..array.count {
                length = length
                    .checked_add(coerced_value_length(read_u32(
                        array.payload,
                        4 + index * 4,
                    )?)?)
                    .ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            Ok(length)
        }
        Value::Record(_) => Ok(b"[object Object]".len()),
        Value::Number { numeric } => {
            let mut buffer = ryu_js::Buffer::new();
            Ok(buffer.format(numeric).len())
        }
        value => Ok(value.rendered().ok_or(ERROR_INVALID_EXPRESSION)?.bytes.len()),
    }
}

fn write_coerced_value_into(
    value_offset: u32,
    output: &mut [u8],
    cursor: &mut usize,
) -> Result<(), u32> {
    match Value::at(value_offset)? {
        Value::Array(array) => {
            for index in 0..array.count {
                if index != 0 {
                    write_coerced_bytes(output, cursor, b",")?;
                }
                write_coerced_value_into(read_u32(array.payload, 4 + index * 4)?, output, cursor)?;
            }
            Ok(())
        }
        Value::Record(_) => write_coerced_bytes(output, cursor, b"[object Object]"),
        Value::Number { numeric } => {
            let mut buffer = ryu_js::Buffer::new();
            write_coerced_bytes(output, cursor, buffer.format(numeric).as_bytes())
        }
        value => write_coerced_bytes(output, cursor, value.rendered().ok_or(
            ERROR_INVALID_EXPRESSION,
        )?.bytes),
    }
}

fn write_coerced_bytes(output: &mut [u8], cursor: &mut usize, bytes: &[u8]) -> Result<(), u32> {
    let end = cursor
        .checked_add(bytes.len())
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let destination = output.get_mut(*cursor..end).ok_or(ERROR_INVALID_ARENA)?;
    destination.copy_from_slice(bytes);
    *cursor = end;
    Ok(())
}

fn emit_value(state_offset: u32, value_offset: u32) -> Result<(), u32> {
    let autoescape = state_field(state_offset, STATE_FLAGS)? & 1 == 1;
    match computed_output_value(value_offset)? {
        Some(value)
            if (!autoescape || value.safe)
                && (!is_streaming(state_offset)?
                    || value.byte_length <= STREAM_CHUNK_BYTES) =>
        {
            return append_output_descriptor(
                state_offset,
                value.handle,
                value.start,
                value.length,
                value.byte_length,
            );
        }
        _ => {}
    }
    let value = rendered_value(value_offset)?;
    if autoescape && !value.safe {
        let mut append_error = None;
        let result = emit_escaped(value.bytes, &mut |segment| {
            append_output(state_offset, segment).map_err(|error| {
                append_error = Some(error);
                RenderError::OutputTooLarge
            })
        });
        if let Some(error) = append_error {
            Err(error)
        } else {
            result.map_err(render_error_code)
        }
    } else {
        append_output(state_offset, value.bytes)
    }
}

fn computed_output_value(value_offset: u32) -> Result<Option<ComputedOutputValue>, u32> {
    let (tag, payload) = raw_record_at(value_offset)?;
    if !matches!(tag, TAG_STRING_VALUE | TAG_SAFE_STRING_VALUE) || payload.len() != 12 {
        return Ok(None);
    }
    let handle = read_u32(payload, 0)?;
    if handle & COMPUTED_STRING_HANDLE_MASK == 0 {
        return Ok(None);
    }
    let start = read_u32(payload, 4)?;
    let length = read_u32(payload, 8)?;
    let (operation_length, byte_length) = string_operation_lengths(handle)?;
    if start != 0 || length != operation_length {
        return Ok(None);
    }
    Ok(Some(ComputedOutputValue {
        handle,
        start,
        length,
        byte_length,
        safe: tag == TAG_SAFE_STRING_VALUE,
    }))
}

fn complete_render(state_offset: u32) -> Result<u32, u32> {
    if state_field(state_offset, STATE_CURRENT_CAPTURE)? != 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    if is_streaming(state_offset)? {
        if state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0 {
            return yield_output(state_offset);
        }
        set_control(STATE_COMPLETE, 0, 0, ERROR_NONE);
        return Ok(STATE_COMPLETE);
    }
    let range_count = publish_pending_output(state_offset, u32::MAX)?;
    if state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0 {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    set_control(
        STATE_COMPLETE,
        unsafe { (*memory_prefix()).output_ranges.offset },
        range_count,
        ERROR_NONE,
    );
    Ok(STATE_COMPLETE)
}

fn should_yield_output(state_offset: u32) -> Result<bool, u32> {
    Ok(is_streaming(state_offset)?
        && state_field(state_offset, STATE_CURRENT_CAPTURE)? == 0
        && state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0)
}

fn yield_output(state_offset: u32) -> Result<u32, u32> {
    set_state_field(
        state_offset,
        STATE_MATERIALIZATION_BASE,
        legacy_arena_cursor(),
    )?;
    let range_count = publish_pending_output(state_offset, STREAM_CHUNK_BYTES)?;
    if range_count == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    set_control(
        STATE_OUTPUT_AVAILABLE,
        unsafe { (*memory_prefix()).output_ranges.offset },
        range_count,
        ERROR_NONE,
    );
    Ok(STATE_OUTPUT_AVAILABLE)
}

fn publish_pending_output(state_offset: u32, maximum_bytes: u32) -> Result<u32, u32> {
    let pending_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let mut published_bytes = 0u32;
    let mut descriptor_index = state_field(state_offset, STATE_FIRST_CHUNK)?;
    let mut published = 0u32;
    while descriptor_index != 0 {
        let output_pool = unsafe { (*memory_prefix()).output_ranges };
        if output_pool.cursor >= output_pool.capacity {
            break;
        }
        let descriptor = members_at(descriptor_index, 5)?;
        let byte_length = read_u32(descriptor, 16)?;
        if published_bytes != 0 && published_bytes.saturating_add(byte_length) > maximum_bytes {
            break;
        }
        publish_output_range(
            read_u32(descriptor, 4)?,
            read_u32(descriptor, 8)?,
            read_u32(descriptor, 12)?,
            byte_length,
        )?;
        published_bytes = published_bytes
            .checked_add(byte_length)
            .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
        published = published.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        descriptor_index = read_u32(descriptor, 0)?;
    }
    if published_bytes > pending_length {
        return Err(ERROR_INVALID_RECORD);
    }
    set_state_field(state_offset, STATE_FIRST_CHUNK, descriptor_index)?;
    if descriptor_index == 0 {
        set_state_field(state_offset, STATE_LAST_CHUNK, 0)?;
    }
    set_state_field(
        state_offset,
        STATE_OUTPUT_LENGTH,
        pending_length - published_bytes,
    )?;
    Ok(published)
}

fn materialize_output_value(state_offset: u32, tag: u32) -> Result<u32, u32> {
    let mut code_unit_length = 0u32;
    let mut descriptor_count = 0u32;
    let mut descriptor_index = state_field(state_offset, STATE_FIRST_CHUNK)?;
    while descriptor_index != 0 {
        let descriptor = members_at(descriptor_index, 5)?;
        code_unit_length = code_unit_length
            .checked_add(read_u32(descriptor, 12)?)
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        descriptor_count = descriptor_count
            .checked_add(1)
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        descriptor_index = read_u32(descriptor, 0)?;
    }
    let value_tag = match tag {
        TAG_STRING => TAG_STRING_VALUE,
        TAG_SAFE_STRING => TAG_SAFE_STRING_VALUE,
        _ => return Err(ERROR_INVALID_RECORD),
    };
    let handle = allocate_concat_string_operation(
        state_field(state_offset, STATE_FIRST_CHUNK)?,
        descriptor_count,
        code_unit_length,
        state_field(state_offset, STATE_OUTPUT_LENGTH)?,
    )?;
    let value_offset = allocate_slot(value_tag, 12)?;
    let payload = mutable_slot_record(value_offset, value_tag)?.ok_or(ERROR_INVALID_RECORD)?;
    write_u32(payload, 0, handle)?;
    write_u32(payload, 4, 0)?;
    write_u32(payload, 8, code_unit_length)?;
    Ok(value_offset)
}

fn append_output(state_offset: u32, bytes: &[u8]) -> Result<(), u32> {
    if bytes.is_empty() {
        return Ok(());
    }
    let byte_length = u32::try_from(bytes.len()).map_err(|_| ERROR_OUTPUT_TOO_LARGE)?;
    let (next_pending_length, next_total_length) = next_output_lengths(state_offset, byte_length)?;
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let end = utf8_chunk_end(bytes, cursor);
        append_output_chunk(state_offset, &bytes[cursor..end])?;
        cursor = end;
    }
    set_state_field(state_offset, STATE_OUTPUT_LENGTH, next_pending_length)?;
    set_state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH, next_total_length)
}

fn append_output_descriptor(
    state_offset: u32,
    handle: u32,
    start: u32,
    length: u32,
    byte_length: u32,
) -> Result<(), u32> {
    if byte_length == 0 {
        return Ok(());
    }
    let (next_pending_length, next_total_length) = next_output_lengths(state_offset, byte_length)?;
    append_range_descriptor(state_offset, handle, start, length, byte_length)?;
    set_state_field(state_offset, STATE_OUTPUT_LENGTH, next_pending_length)?;
    set_state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH, next_total_length)
}

fn next_output_lengths(state_offset: u32, byte_length: u32) -> Result<(u32, u32), u32> {
    let next_pending_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?
        .checked_add(byte_length)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let next_total_length = state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH)?
        .checked_add(byte_length)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    enforce_limit(
        next_total_length,
        state_field(state_offset, STATE_LIMIT_OUTPUT_BYTES)?,
    )?;
    Ok((next_pending_length, next_total_length))
}

fn append_output_chunk(state_offset: u32, bytes: &[u8]) -> Result<(), u32> {
    let (handle, length) = materialized_string_handle(bytes)?;
    append_range_descriptor(
        state_offset,
        handle,
        0,
        length,
        u32::try_from(bytes.len()).map_err(|_| ERROR_OUTPUT_TOO_LARGE)?,
    )
}

fn append_range_descriptor(
    state_offset: u32,
    handle: u32,
    start: u32,
    length: u32,
    byte_length: u32,
) -> Result<(), u32> {
    let (descriptor_index, descriptor) = allocate_members(5)?;
    write_u32(descriptor, 0, 0)?;
    write_u32(descriptor, 4, handle)?;
    write_u32(descriptor, 8, start)?;
    write_u32(descriptor, 12, length)?;
    write_u32(descriptor, 16, byte_length)?;

    let last_chunk = state_field(state_offset, STATE_LAST_CHUNK)?;
    if last_chunk == 0 {
        set_state_field(state_offset, STATE_FIRST_CHUNK, descriptor_index)?;
    } else {
        let previous = mutable_members_at(last_chunk, 5)?;
        write_u32(previous, 0, descriptor_index)?;
    }
    set_state_field(state_offset, STATE_LAST_CHUNK, descriptor_index)
}

fn utf8_chunk_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start
        .saturating_add(STREAM_CHUNK_BYTES as usize)
        .min(bytes.len());
    while end < bytes.len() && end > start && bytes[end] & 0b1100_0000 == 0b1000_0000 {
        end -= 1;
    }
    if end == start {
        bytes.len().min(start + 4)
    } else {
        end
    }
}

fn is_streaming(state_offset: u32) -> Result<bool, u32> {
    Ok(state_field(state_offset, STATE_FLAGS)? & 2 == 2)
}

fn parse_options(state_offset: u32) -> Result<ParseOptions, u32> {
    let flags = state_field(state_offset, STATE_FLAGS)?;
    Ok(ParseOptions {
        trim_blocks: flags & 4 == 4,
        lstrip_blocks: flags & 8 == 8,
    })
}
