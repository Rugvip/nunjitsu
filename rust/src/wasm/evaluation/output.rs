fn rendered_value(value_offset: u32) -> Result<RenderedValue<'static>, u32> {
    let value = Value::at(value_offset)?;
    if matches!(value, Value::Array(_) | Value::Record(_)) {
        let coerced_offset = write_coerced_value(value_offset)?;
        return Value::at(coerced_offset)?
            .rendered()
            .ok_or(ERROR_INVALID_EXPRESSION);
    }
    value.rendered().ok_or(ERROR_INVALID_EXPRESSION)
}

fn write_coerced_value(value_offset: u32) -> Result<u32, u32> {
    let length = coerced_value_length(value_offset)?;
    let length = u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_STRING, length)?;
    let output = mutable_record_at(offset, TAG_STRING)?;
    let mut cursor = 0usize;
    write_coerced_value_into(value_offset, output, &mut cursor)?;
    if cursor != output.len() {
        return Err(ERROR_INVALID_ARENA);
    }
    Ok(offset)
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
        value => Ok(value
            .rendered()
            .ok_or(ERROR_INVALID_EXPRESSION)?
            .bytes
            .len()),
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
        value => write_coerced_bytes(
            output,
            cursor,
            value.rendered().ok_or(ERROR_INVALID_EXPRESSION)?.bytes,
        ),
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
    let value = rendered_value(value_offset)?;
    let autoescape = state_field(state_offset, STATE_FLAGS)? & 1 == 1;
    if autoescape && !value.safe {
        emit_escaped(value.bytes, &mut |segment| {
            append_output(state_offset, segment).map_err(|_| RenderError::OutputTooLarge)
        })
        .map_err(render_error_code)
    } else {
        append_output(state_offset, value.bytes)
    }
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
    let (output_offset, output_length) = materialize_output(state_offset)?;
    set_control(STATE_COMPLETE, output_offset, output_length, ERROR_NONE);
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
    let (output_offset, output_length) = materialize_stream_output(state_offset)?;
    if output_length == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    set_control(
        STATE_OUTPUT_AVAILABLE,
        output_offset,
        output_length,
        ERROR_NONE,
    );
    Ok(STATE_OUTPUT_AVAILABLE)
}

fn materialize_stream_output(state_offset: u32) -> Result<(u32, u32), u32> {
    let pending_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let mut output_length = 0u32;
    let mut chunk_offset = state_field(state_offset, STATE_FIRST_CHUNK)?;
    let mut next_first = chunk_offset;
    while chunk_offset != 0 {
        let chunk = record_at(chunk_offset, TAG_OUTPUT_CHUNK)?;
        if chunk.len() < 4 {
            return Err(ERROR_INVALID_RECORD);
        }
        let data_length = (chunk.len() - 4) as u32;
        if output_length != 0 && output_length.saturating_add(data_length) > STREAM_CHUNK_BYTES {
            break;
        }
        output_length = output_length
            .checked_add(data_length)
            .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
        next_first = read_u32(chunk, 0)?;
        chunk_offset = next_first;
    }
    if output_length == 0 || output_length > pending_length {
        return Err(ERROR_INVALID_RECORD);
    }

    let output_offset = allocate_record(TAG_OUTPUT, output_length)?;
    let output_payload_offset = output_offset
        .checked_add(RECORD_HEADER_LENGTH as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let output = mutable_memory(output_payload_offset, output_length)?;
    let mut output_cursor = 0usize;
    chunk_offset = state_field(state_offset, STATE_FIRST_CHUNK)?;
    while chunk_offset != next_first {
        let chunk = record_at(chunk_offset, TAG_OUTPUT_CHUNK)?;
        let next = read_u32(chunk, 0)?;
        let data = &chunk[4..];
        let end = output_cursor
            .checked_add(data.len())
            .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
        output[output_cursor..end].copy_from_slice(data);
        output_cursor = end;
        chunk_offset = next;
    }
    if output_cursor != output.len() {
        return Err(ERROR_INVALID_RECORD);
    }
    set_state_field(state_offset, STATE_FIRST_CHUNK, next_first)?;
    if next_first == 0 {
        set_state_field(state_offset, STATE_LAST_CHUNK, 0)?;
    }
    set_state_field(
        state_offset,
        STATE_OUTPUT_LENGTH,
        pending_length - output_length,
    )?;
    Ok((output_offset, output_length))
}

fn materialize_output(state_offset: u32) -> Result<(u32, u32), u32> {
    materialize_output_as(state_offset, TAG_OUTPUT)
}

fn materialize_output_as(state_offset: u32, tag: u32) -> Result<(u32, u32), u32> {
    let output_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let output_offset = allocate_record(tag, output_length)?;
    let output_payload_offset = output_offset
        .checked_add(RECORD_HEADER_LENGTH as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let output = mutable_memory(output_payload_offset, output_length)?;
    let mut output_cursor = 0usize;
    let mut chunk_offset = state_field(state_offset, STATE_FIRST_CHUNK)?;
    while chunk_offset != 0 {
        let chunk = record_at(chunk_offset, TAG_OUTPUT_CHUNK)?;
        if chunk.len() < 4 {
            return Err(ERROR_INVALID_RECORD);
        }
        let next = read_u32(chunk, 0)?;
        let data = &chunk[4..];
        let end = output_cursor
            .checked_add(data.len())
            .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
        if end > output.len() {
            return Err(ERROR_INVALID_RECORD);
        }
        output[output_cursor..end].copy_from_slice(data);
        output_cursor = end;
        chunk_offset = next;
    }
    if output_cursor != output.len() {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok((output_offset, output_length))
}

fn append_output(state_offset: u32, bytes: &[u8]) -> Result<(), u32> {
    if bytes.is_empty() {
        return Ok(());
    }
    let pending_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let next_pending_length = pending_length
        .checked_add(bytes.len() as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let total_length = state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH)?;
    let next_total_length = total_length
        .checked_add(bytes.len() as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    enforce_limit(
        next_total_length,
        state_field(state_offset, STATE_LIMIT_OUTPUT_BYTES)?,
    )?;
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        let end = utf8_chunk_end(bytes, cursor);
        append_output_chunk(state_offset, &bytes[cursor..end])?;
        cursor = end;
    }
    set_state_field(state_offset, STATE_OUTPUT_LENGTH, next_pending_length)?;
    set_state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH, next_total_length)
}

fn append_output_chunk(state_offset: u32, bytes: &[u8]) -> Result<(), u32> {
    let chunk_offset = allocate_record(
        TAG_OUTPUT_CHUNK,
        4u32.checked_add(bytes.len() as u32)
            .ok_or(ERROR_OUTPUT_TOO_LARGE)?,
    )?;
    let chunk = mutable_record_at(chunk_offset, TAG_OUTPUT_CHUNK)?;
    write_u32(chunk, 0, 0)?;
    chunk[4..].copy_from_slice(bytes);

    let last_chunk = state_field(state_offset, STATE_LAST_CHUNK)?;
    if last_chunk == 0 {
        set_state_field(state_offset, STATE_FIRST_CHUNK, chunk_offset)?;
    } else {
        let previous = mutable_record_at(last_chunk, TAG_OUTPUT_CHUNK)?;
        write_u32(previous, 0, chunk_offset)?;
    }
    set_state_field(state_offset, STATE_LAST_CHUNK, chunk_offset)
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
