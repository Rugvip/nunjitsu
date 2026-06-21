fn start_tag(state_offset: u32, directive: &[u16]) -> Result<Option<u32>, u32> {
    let call = parse_tag_call(directive).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let schema = resolve_tag(
        state_field(state_offset, STATE_TAGS)?,
        code_units_as_utf8(call.name)?,
    )?
        .ok_or(ERROR_UNSUPPORTED_TAG)?;
    if schema.kind == 1 {
        start_body_tag(state_offset, call, schema)?;
        return Ok(None);
    }
    let directive_offset = write_expression(directive)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, directive_offset)?;
    set_state_field(
        state_offset,
        STATE_EXPRESSION_CURSOR,
        directive.len() as u32,
    )?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
    issue_capability(
        state_offset,
        CAPABILITY_TAG,
        call,
        None,
        directive.len(),
        NEGATE_NONE,
    )
    .map(Some)
}

fn start_body_tag(state_offset: u32, call: Call<'_>, schema: TagSchema) -> Result<(), u32> {
    let caller_frame = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let caller = record_at(caller_frame, TAG_FRAME)?;
    let source_offset = read_u32(caller, FRAME_SOURCE)?;
    let body_cursor = read_u32(caller, FRAME_CURSOR)? as usize;
    let canonical_offset = read_u32(caller, FRAME_CANONICAL_NAME)?;
    let arguments_offset = write_tag_arguments(state_offset, call.arguments)?;
    let (boundaries_offset, end_cursor) = find_tag_boundaries(
        state_offset,
        source_offset,
        body_cursor,
        schema.name_offset,
        schema.end_tag_offset,
        schema.intermediate_tags_offset,
    )?;
    let boundaries = record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?;
    let segment_count = collection_count(boundaries, 12)?;
    let results_length = 4u32
        .checked_add(
            (segment_count as u32)
                .checked_mul(4)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let results_offset = allocate_record(TAG_ARRAY, results_length)?;
    write_u32(
        mutable_record_at(results_offset, TAG_ARRAY)?,
        0,
        segment_count as u32,
    )?;
    for index in 0..segment_count {
        let undefined_offset = allocate_record(TAG_UNDEFINED, 0)?;
        write_u32(
            mutable_record_at(results_offset, TAG_ARRAY)?,
            4 + index * 4,
            undefined_offset,
        )?;
    }

    let body_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    let scope_base = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    let (segment_start, segment_end) =
        tag_segment(boundaries_offset, 0)?.ok_or(ERROR_INVALID_ARENA)?;
    write_frame(
        body_frame,
        caller_frame,
        source_offset,
        segment_start,
        canonical_offset,
        scope_base,
        segment_end,
    )?;
    let tag_call_offset = allocate_record(TAG_TAG_CALL, TAG_CALL_LENGTH)?;
    let tag_call = mutable_record_at(tag_call_offset, TAG_TAG_CALL)?;
    write_u32(
        tag_call,
        TAG_CALL_PARENT,
        state_field(state_offset, STATE_CURRENT_TAG_CALL)?,
    )?;
    write_u32(tag_call, TAG_CALL_CALLER_FRAME, caller_frame)?;
    write_u32(tag_call, TAG_CALL_BODY_FRAME, body_frame)?;
    write_u32(tag_call, TAG_CALL_CAPABILITY_ID, schema.capability_id)?;
    write_u32(tag_call, TAG_CALL_ARGUMENTS, arguments_offset)?;
    write_u32(tag_call, TAG_CALL_BOUNDARIES, boundaries_offset)?;
    write_u32(tag_call, TAG_CALL_SEGMENT_INDEX, 0)?;
    write_u32(tag_call, TAG_CALL_RESULTS, results_offset)?;

    set_frame_field(caller_frame, FRAME_CURSOR, end_cursor as u32)?;
    set_state_field(state_offset, STATE_CURRENT_TAG_CALL, tag_call_offset)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, body_frame)?;
    begin_capture(state_offset, 0)
}

fn write_tag_arguments(state_offset: u32, arguments: &[u16]) -> Result<u32, u32> {
    let mut positional_count = 0usize;
    let mut keyword_count = 0usize;
    let mut cursor = 0usize;
    while let Some(argument) =
        next_macro_argument(arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if argument.name.is_some() {
            keyword_count = keyword_count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        } else {
            if keyword_count != 0 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            positional_count = positional_count
                .checked_add(1)
                .ok_or(ERROR_RESOURCE_LIMIT)?;
        }
        cursor = argument.next_cursor;
    }

    let positional_length = 4u32
        .checked_add(
            (positional_count as u32)
                .checked_mul(4)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let positional_offset = allocate_record(TAG_ARRAY, positional_length)?;
    write_u32(
        mutable_record_at(positional_offset, TAG_ARRAY)?,
        0,
        positional_count as u32,
    )?;
    let keyword_length = 4u32
        .checked_add(
            (keyword_count as u32)
                .checked_mul(8)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let keyword_offset = allocate_record(TAG_RECORD, keyword_length)?;
    write_u32(
        mutable_record_at(keyword_offset, TAG_RECORD)?,
        0,
        keyword_count as u32,
    )?;

    let mut positional_index = 0usize;
    let mut keyword_index = 0usize;
    cursor = 0;
    while let Some(argument) =
        next_macro_argument(arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let value_offset = resolve_atom(state_offset, argument.value)?;
        if let Some(name) = argument.name {
            let name_offset = write_identifier(name)?;
            let keywords = mutable_record_at(keyword_offset, TAG_RECORD)?;
            write_u32(keywords, 4 + keyword_index * 8, name_offset)?;
            write_u32(keywords, 8 + keyword_index * 8, value_offset)?;
            keyword_index += 1;
        } else {
            write_u32(
                mutable_record_at(positional_offset, TAG_ARRAY)?,
                4 + positional_index * 4,
                value_offset,
            )?;
            positional_index += 1;
        }
        cursor = argument.next_cursor;
    }
    let tag_arguments = allocate_record(TAG_TAG_ARGUMENTS, TAG_ARGUMENTS_LENGTH)?;
    let output = mutable_record_at(tag_arguments, TAG_TAG_ARGUMENTS)?;
    write_u32(output, TAG_ARGUMENTS_POSITIONAL, positional_offset)?;
    write_u32(output, TAG_ARGUMENTS_KEYWORD, keyword_offset)?;
    Ok(tag_arguments)
}

fn find_tag_boundaries(
    state_offset: u32,
    source_offset: u32,
    body_cursor: usize,
    opening_name_offset: u32,
    end_name_offset: u32,
    intermediate_tags_offset: u32,
) -> Result<(u32, usize), u32> {
    let intermediate_tags = record_at(intermediate_tags_offset, TAG_ARRAY)?;
    let intermediate_count = collection_count(intermediate_tags, 4)?;
    let segment_count = intermediate_count
        .checked_add(1)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let payload_length = 4u32
        .checked_add(
            (segment_count as u32)
                .checked_mul(12)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let boundaries_offset = allocate_record(TAG_TAG_BOUNDARIES, payload_length)?;
    write_u32(
        mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?,
        0,
        segment_count as u32,
    )?;
    write_u32(
        mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?,
        4,
        1,
    )?;
    write_u32(
        mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?,
        8,
        body_cursor as u32,
    )?;

    let mut cursor = body_cursor;
    let mut depth = 0usize;
    let mut active_segment = 0usize;
    loop {
        let item_cursor = cursor;
        let source = source_at(source_offset)?;
        let (item, next_cursor) =
            next_item_utf16(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let Ok(name) = parse_tag_name(directive) else {
                    cursor = next_cursor;
                    continue;
                };
                let opening_name = record_at(opening_name_offset, TAG_STRING)?;
                let end_name = record_at(end_name_offset, TAG_STRING)?;
                let name = code_units_as_utf8(name)?;
                if name == opening_name {
                    depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if name == end_name {
                    if depth == 0 {
                        write_u32(
                            mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?,
                            12 + active_segment * 12,
                            item_cursor as u32,
                        )?;
                        return Ok((boundaries_offset, next_cursor));
                    }
                    depth -= 1;
                } else if depth == 0
                    && let Some(index) = tag_name_index(intermediate_tags_offset, name)?
                {
                    let next_segment = index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                    if next_segment <= active_segment {
                        return Err(ERROR_UNSUPPORTED_TAG);
                    }
                    write_u32(
                        mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?,
                        12 + active_segment * 12,
                        item_cursor as u32,
                    )?;
                    active_segment = next_segment;
                    let entry = 4 + active_segment * 12;
                    let boundaries = mutable_record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?;
                    write_u32(boundaries, entry, 1)?;
                    write_u32(boundaries, entry + 4, next_cursor as u32)?;
                }
            }
            TemplateItem::End => return Err(ERROR_UNSUPPORTED_TAG),
            _ => {}
        }
        cursor = next_cursor;
    }
}

fn tag_name_index(intermediate_tags_offset: u32, name: &[u8]) -> Result<Option<usize>, u32> {
    let intermediate_tags = record_at(intermediate_tags_offset, TAG_ARRAY)?;
    let count = collection_count(intermediate_tags, 4)?;
    for index in 0..count {
        let registered = record_at(read_u32(intermediate_tags, 4 + index * 4)?, TAG_STRING)?;
        if registered == name {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn tag_segment(boundaries_offset: u32, index: usize) -> Result<Option<(u32, u32)>, u32> {
    let boundaries = record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?;
    let count = collection_count(boundaries, 12)?;
    if index >= count {
        return Ok(None);
    }
    let entry = 4 + index * 12;
    if read_u32(boundaries, entry)? == 0 {
        return Ok(None);
    }
    Ok(Some((
        read_u32(boundaries, entry + 4)?,
        read_u32(boundaries, entry + 8)?,
    )))
}

fn finish_tag_segment(state_offset: u32) -> Result<Option<u32>, u32> {
    let call_offset = state_field(state_offset, STATE_CURRENT_TAG_CALL)?;
    let frame_offset = tag_call_field(call_offset, TAG_CALL_BODY_FRAME)?;
    if frame_offset != state_field(state_offset, STATE_CURRENT_FRAME)? {
        return Err(ERROR_INVALID_ARENA);
    }
    let segment_index = tag_call_field(call_offset, TAG_CALL_SEGMENT_INDEX)? as usize;
    let value_offset = finish_output_capture(state_offset, TAG_STRING)?;
    let results_offset = tag_call_field(call_offset, TAG_CALL_RESULTS)?;
    write_u32(
        mutable_record_at(results_offset, TAG_ARRAY)?,
        4 + segment_index * 4,
        value_offset,
    )?;

    let boundaries_offset = tag_call_field(call_offset, TAG_CALL_BOUNDARIES)?;
    let boundaries = record_at(boundaries_offset, TAG_TAG_BOUNDARIES)?;
    let segment_count = collection_count(boundaries, 12)?;
    let mut next_index = segment_index + 1;
    while next_index < segment_count {
        if let Some((start, end)) = tag_segment(boundaries_offset, next_index)? {
            write_u32(
                mutable_record_at(call_offset, TAG_TAG_CALL)?,
                TAG_CALL_SEGMENT_INDEX,
                next_index as u32,
            )?;
            set_frame_field(frame_offset, FRAME_CURSOR, start)?;
            set_frame_field(frame_offset, FRAME_END_CURSOR, end)?;
            let scope_base = read_u32(record_at(frame_offset, TAG_FRAME)?, FRAME_SCOPE_BASE)?;
            set_state_field(state_offset, STATE_CURRENT_SCOPE, scope_base)?;
            begin_capture(state_offset, 0)?;
            return Ok(None);
        }
        next_index += 1;
    }

    let caller_frame = tag_call_field(call_offset, TAG_CALL_CALLER_FRAME)?;
    let scope_base = read_u32(record_at(frame_offset, TAG_FRAME)?, FRAME_SCOPE_BASE)?;
    set_state_field(state_offset, STATE_CURRENT_SCOPE, scope_base)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, caller_frame)?;
    set_state_field(
        state_offset,
        STATE_CURRENT_TAG_CALL,
        tag_call_field(call_offset, TAG_CALL_PARENT)?,
    )?;
    issue_body_tag(state_offset, call_offset).map(Some)
}

fn issue_body_tag(state_offset: u32, call_offset: u32) -> Result<u32, u32> {
    let arguments_offset = tag_call_field(call_offset, TAG_CALL_ARGUMENTS)?;
    let arguments = record_at(arguments_offset, TAG_TAG_ARGUMENTS)?;
    if arguments.len() != TAG_ARGUMENTS_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    let positional_offset = read_u32(arguments, TAG_ARGUMENTS_POSITIONAL)?;
    let keyword_offset = read_u32(arguments, TAG_ARGUMENTS_KEYWORD)?;
    let positional = record_at(positional_offset, TAG_ARRAY)?;
    let positional_count = collection_count(positional, 4)?;
    let results_offset = tag_call_field(call_offset, TAG_CALL_RESULTS)?;
    let results = record_at(results_offset, TAG_ARRAY)?;
    let result_count = collection_count(results, 4)?;
    let argument_count = positional_count
        .checked_add(result_count)
        .and_then(|count| count.checked_add(1))
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let payload_length = 12u32
        .checked_add(
            (argument_count as u32)
                .checked_mul(4)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let request_offset = allocate_record(TAG_CAPABILITY_REQUEST, payload_length)?;
    {
        let request = mutable_record_at(request_offset, TAG_CAPABILITY_REQUEST)?;
        write_u32(request, 0, CAPABILITY_TAG)?;
        write_u32(
            request,
            4,
            tag_call_field(call_offset, TAG_CALL_CAPABILITY_ID)?,
        )?;
        write_u32(request, 8, argument_count as u32)?;
        for index in 0..positional_count {
            write_u32(
                request,
                12 + index * 4,
                read_u32(positional, 4 + index * 4)?,
            )?;
        }
        write_u32(request, 12 + positional_count * 4, keyword_offset)?;
        for index in 0..result_count {
            write_u32(
                request,
                16 + (positional_count + index) * 4,
                read_u32(results, 4 + index * 4)?,
            )?;
        }
    }

    let expression_offset = write_expression(&[])?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, 0)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
    set_state_field(state_offset, STATE_NEGATE_RESULT, NEGATE_NONE)?;
    charge_counter(
        state_offset,
        STATE_CAPABILITY_CALLS,
        STATE_LIMIT_CAPABILITY_CALLS,
        1,
    )?;
    set_control(
        STATE_CALL_CAPABILITY,
        request_offset,
        payload_length,
        ERROR_NONE,
    );
    Ok(STATE_CALL_CAPABILITY)
}
