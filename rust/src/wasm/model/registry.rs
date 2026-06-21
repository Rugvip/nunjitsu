fn validate_capability_registry(offset: u32) -> Result<(), u32> {
    let registry = record_at(offset, TAG_CAPABILITY_REGISTRY)?;
    let count = collection_count(registry, 8)?;
    for index in 0..count {
        let entry = 4 + index * 8;
        if read_u32(registry, entry)? == 0 {
            return Err(ERROR_INVALID_RECORD);
        }
        validate_name(read_u32(registry, entry + 4)?)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct TagSchema {
    capability_id: u32,
    name_offset: u32,
    kind: u32,
    end_tag_offset: u32,
    intermediate_tags_offset: u32,
}

fn validate_tag_registry(offset: u32) -> Result<(), u32> {
    let registry = record_at(offset, TAG_TAG_REGISTRY)?;
    let count = collection_count(registry, 20)?;
    for index in 0..count {
        let entry = 4 + index * 20;
        if read_u32(registry, entry)? == 0 {
            return Err(ERROR_INVALID_RECORD);
        }
        validate_name(read_u32(registry, entry + 4)?)?;
        let kind = read_u32(registry, entry + 8)?;
        let end_tag_offset = read_u32(registry, entry + 12)?;
        let intermediate_tags = record_at(read_u32(registry, entry + 16)?, TAG_ARRAY)?;
        let intermediate_count = collection_count(intermediate_tags, 4)?;
        for intermediate_index in 0..intermediate_count {
            validate_name(read_u32(intermediate_tags, 4 + intermediate_index * 4)?)?;
        }
        match kind {
            0 if end_tag_offset == 0 && intermediate_count == 0 => {}
            1 if end_tag_offset != 0 => {
                validate_name(end_tag_offset)?;
            }
            _ => return Err(ERROR_INVALID_RECORD),
        }
    }
    Ok(())
}

fn resolve_tag(registry_offset: u32, name: &[u8]) -> Result<Option<TagSchema>, u32> {
    let registry = record_at(registry_offset, TAG_TAG_REGISTRY)?;
    let count = collection_count(registry, 20)?;
    for index in 0..count {
        let entry = 4 + index * 20;
        if name_eq_bytes(read_u32(registry, entry + 4)?, name)? {
            return Ok(Some(TagSchema {
                capability_id: read_u32(registry, entry)?,
                name_offset: read_u32(registry, entry + 4)?,
                kind: read_u32(registry, entry + 8)?,
                end_tag_offset: read_u32(registry, entry + 12)?,
                intermediate_tags_offset: read_u32(registry, entry + 16)?,
            }));
        }
    }
    Ok(None)
}

fn resolve_capability(registry_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let registry = record_at(registry_offset, TAG_CAPABILITY_REGISTRY)?;
    let count = collection_count(registry, 8)?;
    for index in 0..count {
        let entry = 4 + index * 8;
        let capability_id = read_u32(registry, entry)?;
        if name_eq_bytes(read_u32(registry, entry + 4)?, name)? {
            return Ok(Some(capability_id));
        }
    }
    Ok(None)
}

fn include_cycle(mut frame_offset: u32, canonical_offset: u32) -> Result<bool, u32> {
    validate_name(canonical_offset)?;
    while frame_offset != 0 {
        let frame = record_at(frame_offset, TAG_FRAME)?;
        if frame.len() != FRAME_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        let existing_offset = read_u32(frame, FRAME_CANONICAL_NAME)?;
        if existing_offset != 0 && names_equal(existing_offset, canonical_offset)? {
            return Ok(true);
        }
        frame_offset = read_u32(frame, FRAME_PARENT)?;
    }
    Ok(false)
}

fn write_frame(
    offset: u32,
    parent: u32,
    source: u32,
    cursor: u32,
    canonical: u32,
    scope_base: u32,
    end_cursor: u32,
) -> Result<(), u32> {
    let frame = mutable_record_at(offset, TAG_FRAME)?;
    write_u32(frame, FRAME_PARENT, parent)?;
    write_u32(frame, FRAME_SOURCE, source)?;
    write_u32(frame, FRAME_CURSOR, cursor)?;
    write_u32(frame, FRAME_CANONICAL_NAME, canonical)?;
    write_u32(frame, FRAME_SCOPE_BASE, scope_base)?;
    write_u32(frame, FRAME_END_CURSOR, end_cursor)
}

fn set_frame_field(offset: u32, field: usize, value: u32) -> Result<(), u32> {
    let frame = mutable_record_at(offset, TAG_FRAME)?;
    if frame.len() != FRAME_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    write_u32(frame, field, value)
}

fn frame_canonical_name(offset: u32) -> Result<u32, u32> {
    let frame = record_at(offset, TAG_FRAME)?;
    if frame.len() != FRAME_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    let canonical_offset = read_u32(frame, FRAME_CANONICAL_NAME)?;
    if canonical_offset != 0 {
        validate_name(canonical_offset)?;
    }
    Ok(canonical_offset)
}

fn loop_field(offset: u32, field: usize) -> Result<u32, u32> {
    let state = record_at(offset, TAG_LOOP_STATE)?;
    if state.len() != LOOP_STATE_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(state, field)
}

fn set_loop_field(offset: u32, field: usize, value: u32) -> Result<(), u32> {
    let state = mutable_record_at(offset, TAG_LOOP_STATE)?;
    if state.len() != LOOP_STATE_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    write_u32(state, field, value)
}

fn capture_field(offset: u32, field: usize) -> Result<u32, u32> {
    let capture = record_at(offset, TAG_CAPTURE)?;
    if capture.len() != CAPTURE_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(capture, field)
}

fn macro_definition_field(offset: u32, field: usize) -> Result<u32, u32> {
    let definition = record_at(offset, TAG_MACRO_DEFINITION)?;
    if definition.len() != MACRO_DEFINITION_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(definition, field)
}

fn macro_call_field(offset: u32, field: usize) -> Result<u32, u32> {
    let call = record_at(offset, TAG_MACRO_CALL)?;
    if call.len() != MACRO_CALL_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(call, field)
}

fn tag_call_field(offset: u32, field: usize) -> Result<u32, u32> {
    let call = record_at(offset, TAG_TAG_CALL)?;
    if call.len() != TAG_CALL_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(call, field)
}

fn block_definition_field(offset: u32, field: usize) -> Result<u32, u32> {
    let definition = record_at(offset, TAG_BLOCK_DEFINITION)?;
    if definition.len() != BLOCK_DEFINITION_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(definition, field)
}

fn iterable_length(offset: u32) -> Result<u32, u32> {
    match Value::at(offset)? {
        Value::Undefined | Value::Null => Ok(0),
        Value::Array(array) => Ok(array.count as u32),
        Value::Record(record) => Ok(record.count as u32),
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn state_field(offset: u32, field: usize) -> Result<u32, u32> {
    let state = record_at(offset, TAG_RENDER_STATE)?;
    if state.len() != RENDER_STATE_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    read_u32(state, field)
}

fn set_state_field(offset: u32, field: usize, value: u32) -> Result<(), u32> {
    let state = mutable_record_at(offset, TAG_RENDER_STATE)?;
    if state.len() != RENDER_STATE_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    write_u32(state, field, value)
}

fn active_state() -> Result<u32, u32> {
    let offset = active_render();
    if offset == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    Ok(offset)
}

fn active_limit(field: usize) -> Result<u32, u32> {
    let state_offset = active_render();
    if state_offset == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    state_field(state_offset, field)
}

fn charge_counter(
    state_offset: u32,
    counter_field: usize,
    limit_field: usize,
    amount: u32,
) -> Result<(), u32> {
    let value = state_field(state_offset, counter_field)?;
    let next = value.checked_add(amount).ok_or(ERROR_RESOURCE_LIMIT)?;
    enforce_limit(next, state_field(state_offset, limit_field)?)?;
    set_state_field(state_offset, counter_field, next)
}

fn enforce_limit(value: u32, limit: u32) -> Result<(), u32> {
    if limit != u32::MAX && value > limit {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    Ok(())
}

fn enforce_arena_limit(state_offset: u32, cursor: u32) -> Result<(), u32> {
    let used = cursor
        .checked_sub(nunjitsu_arena_base())
        .ok_or(ERROR_INVALID_ARENA)?;
    enforce_limit(used, state_field(state_offset, STATE_LIMIT_ARENA_BYTES)?)
}

fn fail(error: u32) -> u32 {
    set_control(STATE_ERROR, 0, 0, error);
    STATE_ERROR
}
