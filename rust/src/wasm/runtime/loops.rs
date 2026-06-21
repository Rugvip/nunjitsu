fn start_for(state_offset: u32, source: &[u8]) -> Result<(), u32> {
    let clause = parse_for_clause(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let body_cursor = read_u32(frame, FRAME_CURSOR)?;
    let template = record_at(source_offset, TAG_SOURCE)?;
    let boundaries =
        find_loop_boundaries(template, body_cursor as usize, parse_options(state_offset)?)
            .map_err(render_error_code)?;
    let iterable_offset = evaluate_sync_expression(state_offset, clause.iterable)?;
    let length = iterable_length(iterable_offset)?;
    if length == 0 && boundaries.else_cursor.is_none() {
        set_frame_field(frame_offset, FRAME_CURSOR, boundaries.end_cursor as u32)?;
        return Ok(());
    }

    let bindings = write_bindings(clause.bindings)?;
    let loop_offset = allocate_record(TAG_LOOP_STATE, LOOP_STATE_LENGTH)?;
    let parent = state_field(state_offset, STATE_CURRENT_LOOP)?;
    let scope_base = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    let loop_state = mutable_record_at(loop_offset, TAG_LOOP_STATE)?;
    write_u32(loop_state, LOOP_PARENT, parent)?;
    write_u32(loop_state, LOOP_FRAME, frame_offset)?;
    write_u32(loop_state, LOOP_BODY_CURSOR, body_cursor)?;
    write_u32(
        loop_state,
        LOOP_ELSE_CURSOR,
        boundaries.else_cursor.unwrap_or(0) as u32,
    )?;
    write_u32(loop_state, LOOP_END_CURSOR, boundaries.end_cursor as u32)?;
    write_u32(loop_state, LOOP_ITERABLE, iterable_offset)?;
    write_u32(loop_state, LOOP_INDEX, 0)?;
    write_u32(loop_state, LOOP_LENGTH, length)?;
    write_u32(loop_state, LOOP_BINDINGS, bindings)?;
    write_u32(loop_state, LOOP_OUTER_SCOPE, scope_base)?;
    write_u32(loop_state, LOOP_SCOPE_BASE, scope_base)?;
    set_state_field(state_offset, STATE_CURRENT_LOOP, loop_offset)?;
    if length == 0 {
        set_frame_field(
            frame_offset,
            FRAME_CURSOR,
            boundaries.else_cursor.ok_or(ERROR_INVALID_ARENA)? as u32,
        )?;
    }
    Ok(())
}

fn write_bindings(bindings: &[u8]) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some((_, next)) = next_binding(bindings, cursor).map_err(|_| ERROR_UNSUPPORTED_TAG)? {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = next;
    }
    if count == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(4).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_BINDINGS, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_BINDINGS)?, 0, count as u32)?;
    cursor = 0;
    let mut index = 0usize;
    while let Some((name, next)) =
        next_binding(bindings, cursor).map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        let name_offset = write_bytes_record(TAG_STRING, name)?;
        write_u32(
            mutable_record_at(offset, TAG_BINDINGS)?,
            4 + index * 4,
            name_offset,
        )?;
        index += 1;
        cursor = next;
    }
    Ok(offset)
}

fn assign_bindings(state_offset: u32, bindings_offset: u32, value_offset: u32) -> Result<(), u32> {
    let bindings = record_at(bindings_offset, TAG_BINDINGS)?;
    let count = collection_count(bindings, 4)?;
    for index in 0..count {
        assign_scope(
            state_offset,
            read_u32(bindings, 4 + index * 4)?,
            value_offset,
        )?;
    }
    Ok(())
}

fn begin_capture(state_offset: u32, bindings_offset: u32) -> Result<(), u32> {
    if bindings_offset != 0 {
        record_at(bindings_offset, TAG_BINDINGS)?;
    }
    let capture_offset = allocate_record(TAG_CAPTURE, CAPTURE_LENGTH)?;
    let capture = mutable_record_at(capture_offset, TAG_CAPTURE)?;
    write_u32(
        capture,
        CAPTURE_PARENT,
        state_field(state_offset, STATE_CURRENT_CAPTURE)?,
    )?;
    write_u32(
        capture,
        CAPTURE_FRAME,
        state_field(state_offset, STATE_CURRENT_FRAME)?,
    )?;
    write_u32(capture, CAPTURE_BINDINGS, bindings_offset)?;
    write_u32(
        capture,
        CAPTURE_FIRST_CHUNK,
        state_field(state_offset, STATE_FIRST_CHUNK)?,
    )?;
    write_u32(
        capture,
        CAPTURE_LAST_CHUNK,
        state_field(state_offset, STATE_LAST_CHUNK)?,
    )?;
    write_u32(
        capture,
        CAPTURE_OUTPUT_LENGTH,
        state_field(state_offset, STATE_OUTPUT_LENGTH)?,
    )?;
    write_u32(
        capture,
        CAPTURE_TOTAL_OUTPUT_LENGTH,
        state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH)?,
    )?;
    set_state_field(state_offset, STATE_CURRENT_CAPTURE, capture_offset)?;
    set_state_field(state_offset, STATE_FIRST_CHUNK, 0)?;
    set_state_field(state_offset, STATE_LAST_CHUNK, 0)?;
    set_state_field(state_offset, STATE_OUTPUT_LENGTH, 0)?;
    set_state_field(state_offset, STATE_TOTAL_OUTPUT_LENGTH, 0)
}

fn finish_capture(state_offset: u32) -> Result<(), u32> {
    let capture_offset = state_field(state_offset, STATE_CURRENT_CAPTURE)?;
    if capture_offset == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let bindings = capture_field(capture_offset, CAPTURE_BINDINGS)?;
    if bindings == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let value_offset = finish_output_capture(state_offset, TAG_STRING)?;
    assign_bindings(state_offset, bindings, value_offset)
}

fn finish_output_capture(state_offset: u32, tag: u32) -> Result<u32, u32> {
    let capture_offset = state_field(state_offset, STATE_CURRENT_CAPTURE)?;
    if capture_offset == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let capture = record_at(capture_offset, TAG_CAPTURE)?;
    if capture.len() != CAPTURE_LENGTH as usize
        || read_u32(capture, CAPTURE_FRAME)? != state_field(state_offset, STATE_CURRENT_FRAME)?
    {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let value_offset = materialize_output_as(state_offset, tag)?.0;
    set_state_field(
        state_offset,
        STATE_FIRST_CHUNK,
        read_u32(capture, CAPTURE_FIRST_CHUNK)?,
    )?;
    set_state_field(
        state_offset,
        STATE_LAST_CHUNK,
        read_u32(capture, CAPTURE_LAST_CHUNK)?,
    )?;
    set_state_field(
        state_offset,
        STATE_OUTPUT_LENGTH,
        read_u32(capture, CAPTURE_OUTPUT_LENGTH)?,
    )?;
    set_state_field(
        state_offset,
        STATE_TOTAL_OUTPUT_LENGTH,
        read_u32(capture, CAPTURE_TOTAL_OUTPUT_LENGTH)?,
    )?;
    set_state_field(
        state_offset,
        STATE_CURRENT_CAPTURE,
        read_u32(capture, CAPTURE_PARENT)?,
    )?;
    Ok(value_offset)
}

fn discard_extends_output(state_offset: u32) -> Result<(), u32> {
    let capture_offset = state_field(state_offset, STATE_EXTENDS_CAPTURE)?;
    if capture_offset == 0 {
        return Ok(());
    }
    if capture_offset != state_field(state_offset, STATE_CURRENT_CAPTURE)? {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let capture = record_at(capture_offset, TAG_CAPTURE)?;
    if capture.len() != CAPTURE_LENGTH as usize
        || read_u32(capture, CAPTURE_FRAME)? != state_field(state_offset, STATE_CURRENT_FRAME)?
    {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    set_state_field(
        state_offset,
        STATE_FIRST_CHUNK,
        read_u32(capture, CAPTURE_FIRST_CHUNK)?,
    )?;
    set_state_field(
        state_offset,
        STATE_LAST_CHUNK,
        read_u32(capture, CAPTURE_LAST_CHUNK)?,
    )?;
    set_state_field(
        state_offset,
        STATE_OUTPUT_LENGTH,
        read_u32(capture, CAPTURE_OUTPUT_LENGTH)?,
    )?;
    set_state_field(
        state_offset,
        STATE_TOTAL_OUTPUT_LENGTH,
        read_u32(capture, CAPTURE_TOTAL_OUTPUT_LENGTH)?,
    )?;
    set_state_field(
        state_offset,
        STATE_CURRENT_CAPTURE,
        read_u32(capture, CAPTURE_PARENT)?,
    )?;
    set_state_field(state_offset, STATE_EXTENDS_CAPTURE, 0)
}

fn advance_for(state_offset: u32) -> Result<(), u32> {
    let loop_offset = state_field(state_offset, STATE_CURRENT_LOOP)?;
    if loop_offset == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    if loop_field(loop_offset, LOOP_FRAME)? != frame_offset {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let cursor = read_u32(frame, FRAME_CURSOR)?;
    let else_cursor = loop_field(loop_offset, LOOP_ELSE_CURSOR)?;
    let end_cursor = loop_field(loop_offset, LOOP_END_CURSOR)?;
    if cursor != end_cursor && (else_cursor == 0 || cursor != else_cursor) {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let index = loop_field(loop_offset, LOOP_INDEX)?;
    let length = loop_field(loop_offset, LOOP_LENGTH)?;
    if index + 1 < length {
        set_state_field(
            state_offset,
            STATE_CURRENT_SCOPE,
            loop_field(loop_offset, LOOP_SCOPE_BASE)?,
        )?;
        set_loop_field(loop_offset, LOOP_INDEX, index + 1)?;
        set_frame_field(
            frame_offset,
            FRAME_CURSOR,
            loop_field(loop_offset, LOOP_BODY_CURSOR)?,
        )
    } else {
        set_state_field(
            state_offset,
            STATE_CURRENT_SCOPE,
            loop_field(loop_offset, LOOP_OUTER_SCOPE)?,
        )?;
        if cursor == else_cursor {
            set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)?;
        }
        pop_for(state_offset, loop_offset)
    }
}

fn is_current_loop_else(state_offset: u32) -> Result<bool, u32> {
    let loop_offset = state_field(state_offset, STATE_CURRENT_LOOP)?;
    if loop_offset == 0 {
        return Ok(false);
    }
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    Ok(loop_field(loop_offset, LOOP_FRAME)? == frame_offset
        && loop_field(loop_offset, LOOP_ELSE_CURSOR)? != 0
        && loop_field(loop_offset, LOOP_ELSE_CURSOR)? == read_u32(frame, FRAME_CURSOR)?)
}

fn pop_for(state_offset: u32, loop_offset: u32) -> Result<(), u32> {
    set_state_field(
        state_offset,
        STATE_CURRENT_LOOP,
        loop_field(loop_offset, LOOP_PARENT)?,
    )
}

fn assign_scope(state_offset: u32, name_offset: u32, value_offset: u32) -> Result<(), u32> {
    record_at(name_offset, TAG_STRING)?;
    Value::at(value_offset)?;
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let boundary = read_u32(frame, FRAME_SCOPE_BASE)?;
    let mut existing = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    while existing != 0 && existing != boundary {
        let scope = record_at(existing, TAG_SCOPE)?;
        if scope.len() != SCOPE_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        if record_at(read_u32(scope, SCOPE_NAME)?, TAG_STRING)?
            == record_at(name_offset, TAG_STRING)?
        {
            write_u32(
                mutable_record_at(existing, TAG_SCOPE)?,
                SCOPE_VALUE,
                value_offset,
            )?;
            set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
            return Ok(());
        }
        existing = read_u32(scope, SCOPE_PARENT)?;
    }

    let parent = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    let scope_offset = allocate_record(TAG_SCOPE, SCOPE_LENGTH)?;
    let scope = mutable_record_at(scope_offset, TAG_SCOPE)?;
    write_u32(scope, SCOPE_PARENT, parent)?;
    write_u32(scope, SCOPE_NAME, name_offset)?;
    write_u32(scope, SCOPE_VALUE, value_offset)?;
    set_state_field(state_offset, STATE_CURRENT_SCOPE, scope_offset)?;
    let loop_offset = state_field(state_offset, STATE_CURRENT_LOOP)?;
    if loop_offset != 0 && loop_field(loop_offset, LOOP_FRAME)? == frame_offset {
        set_loop_field(loop_offset, LOOP_SCOPE_BASE, scope_offset)?;
    }
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })
}
