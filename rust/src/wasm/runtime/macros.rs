fn start_call_block(state_offset: u32, source: &[u8]) -> Result<(), u32> {
    let clause = parse_call_block(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let body_cursor = read_u32(frame, FRAME_CURSOR)?;
    let end_cursor = find_call_end(
        record_at(source_offset, TAG_SOURCE)?,
        body_cursor as usize,
        parse_options(state_offset)?,
    )
    .map_err(render_error_code)? as u32;
    set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)?;

    let caller_name = write_bytes_record(TAG_STRING, b"caller")?;
    let parameters = write_bytes_record(TAG_STRING, clause.bindings)?;
    let caller_definition = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(caller_definition, TAG_MACRO_DEFINITION)?;
    write_u32(definition, MACRO_DEFINITION_PARENT, 0)?;
    write_u32(definition, MACRO_DEFINITION_NAME, caller_name)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters)?;
    write_u32(
        definition,
        MACRO_DEFINITION_SCOPE,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
    )?;
    write_u32(definition, MACRO_DEFINITION_FRAME, frame_offset)?;
    write_u32(
        definition,
        MACRO_DEFINITION_CANONICAL_NAME,
        frame_canonical_name(frame_offset)?,
    )?;

    let context_offset = state_field(state_offset, STATE_CONTEXT)?;
    let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
    let target_definition = if let Some(offset) = context.lookup_offset(clause.call.name)
        && matches!(Value::at(offset)?, Value::Macro)
    {
        offset
    } else {
        resolve_macro(state_offset, clause.call.name)?.ok_or(ERROR_INVALID_EXPRESSION)?
    };

    let pending_expression = write_bytes_record(TAG_STRING, b"")?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, pending_expression)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, 0)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
    start_macro_call(
        state_offset,
        target_definition,
        clause.call,
        false,
        caller_definition,
    )
}

fn define_macro(state_offset: u32, signature: &[u8]) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let body_cursor = read_u32(frame, FRAME_CURSOR)?;
    let canonical_offset = frame_canonical_name(frame_offset)?;
    let owner_frame = if read_u32(frame, FRAME_END_CURSOR)? != 0 {
        read_u32(frame, FRAME_PARENT)?
    } else {
        frame_offset
    };
    let end_cursor = register_macro_definition(
        state_offset,
        signature,
        owner_frame,
        source_offset,
        canonical_offset,
        body_cursor,
    )?;
    set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)
}

fn register_macro_definition(
    state_offset: u32,
    signature: &[u8],
    frame_offset: u32,
    source_offset: u32,
    canonical_offset: u32,
    body_cursor: u32,
) -> Result<u32, u32> {
    let macro_signature = parse_tag_call(signature).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let mut parameter_cursor = 0usize;
    while let Some(parameter) = next_macro_parameter(macro_signature.arguments, parameter_cursor)
        .map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        parameter_cursor = parameter.next_cursor;
    }

    let source = record_at(source_offset, TAG_SOURCE)?;
    let end_cursor = find_macro_end(source, body_cursor as usize, parse_options(state_offset)?)
        .map_err(render_error_code)?;

    let name_offset = write_bytes_record(TAG_STRING, macro_signature.name)?;
    let parameters_offset = write_bytes_record(TAG_STRING, macro_signature.arguments)?;
    let definition_offset = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_MACRO_DEFINITION)?;
    write_u32(
        definition,
        MACRO_DEFINITION_PARENT,
        state_field(state_offset, STATE_CURRENT_MACRO_DEFINITION)?,
    )?;
    write_u32(definition, MACRO_DEFINITION_NAME, name_offset)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters_offset)?;
    write_u32(
        definition,
        MACRO_DEFINITION_SCOPE,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
    )?;
    write_u32(definition, MACRO_DEFINITION_FRAME, frame_offset)?;
    write_u32(
        definition,
        MACRO_DEFINITION_CANONICAL_NAME,
        canonical_offset,
    )?;
    set_state_field(
        state_offset,
        STATE_CURRENT_MACRO_DEFINITION,
        definition_offset,
    )?;
    Ok(end_cursor as u32)
}

fn resolve_macro(state_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let current_frame = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let mut definition_offset = state_field(state_offset, STATE_CURRENT_MACRO_DEFINITION)?;
    while definition_offset != 0 {
        let definition = record_at(definition_offset, TAG_MACRO_DEFINITION)?;
        if definition.len() != MACRO_DEFINITION_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        if frame_is_ancestor(current_frame, read_u32(definition, MACRO_DEFINITION_FRAME)?)?
            && record_at(read_u32(definition, MACRO_DEFINITION_NAME)?, TAG_STRING)? == name
        {
            return Ok(Some(definition_offset));
        }
        definition_offset = read_u32(definition, MACRO_DEFINITION_PARENT)?;
    }
    Ok(None)
}

fn frame_is_ancestor(mut frame_offset: u32, expected: u32) -> Result<bool, u32> {
    while frame_offset != 0 {
        if frame_offset == expected {
            return Ok(true);
        }
        let frame = record_at(frame_offset, TAG_FRAME)?;
        if frame.len() != FRAME_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        frame_offset = read_u32(frame, FRAME_PARENT)?;
    }
    Ok(false)
}

fn write_macro_arguments(
    state_offset: u32,
    definition_offset: u32,
    call: Call<'_>,
) -> Result<u32, u32> {
    let parameters = record_at(
        macro_definition_field(definition_offset, MACRO_DEFINITION_PARAMETERS)?,
        TAG_STRING,
    )?;
    let mut count = 0usize;
    let mut parameter_cursor = 0usize;
    while let Some(parameter) =
        next_macro_parameter(parameters, parameter_cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        parameter_cursor = parameter.next_cursor;
    }
    validate_macro_arguments(parameters, call.arguments, count)?;
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(8).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let arguments_offset = allocate_record(TAG_MACRO_ARGUMENTS, payload_length)?;
    write_u32(
        mutable_record_at(arguments_offset, TAG_MACRO_ARGUMENTS)?,
        0,
        count as u32,
    )?;

    parameter_cursor = 0;
    let mut index = 0usize;
    while let Some(parameter) =
        next_macro_parameter(parameters, parameter_cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let value_offset = if let Some(argument) =
            macro_argument_for_parameter(call.arguments, index, parameter.name)?
        {
            resolve_atom(state_offset, argument)?
        } else {
            0
        };
        let name_offset = write_bytes_record(TAG_STRING, parameter.name)?;
        let arguments = mutable_record_at(arguments_offset, TAG_MACRO_ARGUMENTS)?;
        write_u32(arguments, 4 + index * 8, name_offset)?;
        write_u32(arguments, 8 + index * 8, value_offset)?;
        index += 1;
        parameter_cursor = parameter.next_cursor;
    }
    Ok(arguments_offset)
}

fn validate_macro_arguments(
    parameters: &[u8],
    arguments: &[u8],
    parameter_count: usize,
) -> Result<(), u32> {
    let mut cursor = 0usize;
    let mut positional_count = 0usize;
    let mut saw_keyword = false;
    while let Some(argument) =
        next_macro_argument(arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if let Some(name) = argument.name {
            saw_keyword = true;
            let parameter_index =
                macro_parameter_index(parameters, name)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            if parameter_index < positional_count {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let mut previous_cursor = 0usize;
            while previous_cursor < cursor {
                let previous = next_macro_argument(arguments, previous_cursor)
                    .map_err(|_| ERROR_INVALID_EXPRESSION)?
                    .ok_or(ERROR_INVALID_EXPRESSION)?;
                if previous.name == Some(name) {
                    return Err(ERROR_INVALID_EXPRESSION);
                }
                previous_cursor = previous.next_cursor;
            }
        } else {
            if saw_keyword {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            positional_count = positional_count
                .checked_add(1)
                .ok_or(ERROR_RESOURCE_LIMIT)?;
            if positional_count > parameter_count {
                return Err(ERROR_INVALID_EXPRESSION);
            }
        }
        cursor = argument.next_cursor;
    }
    Ok(())
}

fn macro_parameter_index(parameters: &[u8], name: &[u8]) -> Result<Option<usize>, u32> {
    let mut cursor = 0usize;
    let mut index = 0usize;
    while let Some(parameter) =
        next_macro_parameter(parameters, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if parameter.name == name {
            return Ok(Some(index));
        }
        index = index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = parameter.next_cursor;
    }
    Ok(None)
}

fn macro_argument_for_parameter<'a>(
    arguments: &'a [u8],
    parameter_index: usize,
    parameter_name: &[u8],
) -> Result<Option<Atom<'a>>, u32> {
    let mut cursor = 0usize;
    let mut positional_index = 0usize;
    while let Some(argument) =
        next_macro_argument(arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        match argument.name {
            Some(name) if name == parameter_name => return Ok(Some(argument.value)),
            None if positional_index == parameter_index => return Ok(Some(argument.value)),
            None => {
                positional_index = positional_index
                    .checked_add(1)
                    .ok_or(ERROR_RESOURCE_LIMIT)?
            }
            Some(_) => {}
        }
        cursor = argument.next_cursor;
    }
    Ok(None)
}

fn start_macro_call(
    state_offset: u32,
    definition_offset: u32,
    call: Call<'_>,
    negated: bool,
    caller_definition: u32,
) -> Result<(), u32> {
    let transient_base = state_field(state_offset, STATE_TRANSIENT_BASE)?;
    let arguments_offset = write_macro_arguments(state_offset, definition_offset, call)?;
    let caller_frame = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let macro_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(
        macro_frame,
        caller_frame,
        macro_definition_field(definition_offset, MACRO_DEFINITION_SOURCE)?,
        macro_definition_field(definition_offset, MACRO_DEFINITION_BODY_CURSOR)?,
        macro_definition_field(definition_offset, MACRO_DEFINITION_CANONICAL_NAME)?,
        macro_definition_field(definition_offset, MACRO_DEFINITION_SCOPE)?,
        macro_definition_field(definition_offset, MACRO_DEFINITION_END_CURSOR)?,
    )?;
    let call_offset = allocate_record(TAG_MACRO_CALL, MACRO_CALL_LENGTH)?;
    let call_record = mutable_record_at(call_offset, TAG_MACRO_CALL)?;
    write_u32(
        call_record,
        MACRO_CALL_PARENT,
        state_field(state_offset, STATE_CURRENT_MACRO_CALL)?,
    )?;
    write_u32(call_record, MACRO_CALL_FRAME, macro_frame)?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_EXPRESSION,
        state_field(state_offset, STATE_PENDING_EXPRESSION)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_EXPRESSION_CURSOR,
        state_field(state_offset, STATE_EXPRESSION_CURSOR)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_EXPRESSION_ACTION,
        state_field(state_offset, STATE_EXPRESSION_ACTION)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_CURRENT_VALUE,
        state_field(state_offset, STATE_CURRENT_VALUE)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_SET_BINDINGS,
        state_field(state_offset, STATE_PENDING_SET_BINDINGS)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_LOAD_KIND,
        state_field(state_offset, STATE_PENDING_LOAD_KIND)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_NAME,
        state_field(state_offset, STATE_PENDING_NAME)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_NEGATE_RESULT,
        if negated {
            NEGATE_TRUTHINESS
        } else {
            NEGATE_NONE
        },
    )?;
    write_u32(
        call_record,
        MACRO_CALL_SCOPE,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_LOOP,
        state_field(state_offset, STATE_CURRENT_LOOP)?,
    )?;
    write_u32(call_record, MACRO_CALL_TRANSIENT_BASE, transient_base)?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_IMPORT_ALIAS,
        state_field(state_offset, STATE_PENDING_IMPORT_ALIAS)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_IMPORT_WITH_CONTEXT,
        state_field(state_offset, STATE_IMPORT_WITH_CONTEXT)?,
    )?;
    write_u32(
        call_record,
        MACRO_CALL_PENDING_IMPORT_BINDINGS,
        state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS)?,
    )?;

    set_state_field(state_offset, STATE_CURRENT_MACRO_CALL, call_offset)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, macro_frame)?;
    set_state_field(
        state_offset,
        STATE_CURRENT_SCOPE,
        macro_definition_field(definition_offset, MACRO_DEFINITION_SCOPE)?,
    )?;
    set_state_field(state_offset, STATE_CURRENT_LOOP, 0)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, 0)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
    set_state_field(state_offset, STATE_PENDING_SET_BINDINGS, 0)?;
    set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_INCLUDE)?;
    set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
    set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, 0)?;
    set_state_field(state_offset, STATE_IMPORT_WITH_CONTEXT, 0)?;
    set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, 0)?;
    set_state_field(state_offset, STATE_NEGATE_RESULT, NEGATE_NONE)?;
    begin_capture(state_offset, 0)?;

    let count = collection_count(record_at(arguments_offset, TAG_MACRO_ARGUMENTS)?, 8)?;
    let parameters_offset = macro_definition_field(definition_offset, MACRO_DEFINITION_PARAMETERS)?;
    let mut parameter_cursor = 0usize;
    for index in 0..count {
        let parameter =
            next_macro_parameter(record_at(parameters_offset, TAG_STRING)?, parameter_cursor)
                .map_err(|_| ERROR_INVALID_EXPRESSION)?
                .ok_or(ERROR_INVALID_EXPRESSION)?;
        let arguments = record_at(arguments_offset, TAG_MACRO_ARGUMENTS)?;
        let name_offset = read_u32(arguments, 4 + index * 8)?;
        let supplied_value = read_u32(arguments, 8 + index * 8)?;
        let value_offset = if supplied_value != 0 {
            supplied_value
        } else if let Some(default) = parameter.default {
            resolve_atom(state_offset, default)?
        } else {
            allocate_record(TAG_UNDEFINED, 0)?
        };
        assign_scope(state_offset, name_offset, value_offset)?;
        parameter_cursor = parameter.next_cursor;
    }
    if caller_definition != 0 {
        let name_offset = write_bytes_record(TAG_STRING, b"caller")?;
        assign_scope(state_offset, name_offset, caller_definition)?;
    }
    let super_definition = macro_definition_field(definition_offset, MACRO_DEFINITION_SUPER)?;
    if super_definition != 0 {
        let name_offset = write_bytes_record(TAG_STRING, b"super")?;
        assign_scope(state_offset, name_offset, super_definition)?;
    }
    Ok(())
}

fn finish_macro_call(state_offset: u32) -> Result<Option<u32>, u32> {
    let call_offset = state_field(state_offset, STATE_CURRENT_MACRO_CALL)?;
    if call_offset == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let macro_frame = macro_call_field(call_offset, MACRO_CALL_FRAME)?;
    if macro_frame != state_field(state_offset, STATE_CURRENT_FRAME)? {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let capture_offset = state_field(state_offset, STATE_CURRENT_CAPTURE)?;
    if capture_field(capture_offset, CAPTURE_FRAME)? != macro_frame
        || capture_field(capture_offset, CAPTURE_BINDINGS)? != 0
    {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let result_offset = finish_output_capture(state_offset, TAG_SAFE_STRING)?;
    let macro_frame_record = record_at(macro_frame, TAG_FRAME)?;
    let caller_frame = read_u32(macro_frame_record, FRAME_PARENT)?;

    set_state_field(
        state_offset,
        STATE_CURRENT_MACRO_CALL,
        macro_call_field(call_offset, MACRO_CALL_PARENT)?,
    )?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, caller_frame)?;
    set_state_field(
        state_offset,
        STATE_CURRENT_SCOPE,
        macro_call_field(call_offset, MACRO_CALL_SCOPE)?,
    )?;
    set_state_field(
        state_offset,
        STATE_CURRENT_LOOP,
        macro_call_field(call_offset, MACRO_CALL_LOOP)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_EXPRESSION,
        macro_call_field(call_offset, MACRO_CALL_PENDING_EXPRESSION)?,
    )?;
    set_state_field(
        state_offset,
        STATE_EXPRESSION_CURSOR,
        macro_call_field(call_offset, MACRO_CALL_EXPRESSION_CURSOR)?,
    )?;
    set_state_field(
        state_offset,
        STATE_EXPRESSION_ACTION,
        macro_call_field(call_offset, MACRO_CALL_EXPRESSION_ACTION)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_SET_BINDINGS,
        macro_call_field(call_offset, MACRO_CALL_PENDING_SET_BINDINGS)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_LOAD_KIND,
        macro_call_field(call_offset, MACRO_CALL_PENDING_LOAD_KIND)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_NAME,
        macro_call_field(call_offset, MACRO_CALL_PENDING_NAME)?,
    )?;
    set_state_field(
        state_offset,
        STATE_TRANSIENT_BASE,
        macro_call_field(call_offset, MACRO_CALL_TRANSIENT_BASE)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_IMPORT_ALIAS,
        macro_call_field(call_offset, MACRO_CALL_PENDING_IMPORT_ALIAS)?,
    )?;
    set_state_field(
        state_offset,
        STATE_IMPORT_WITH_CONTEXT,
        macro_call_field(call_offset, MACRO_CALL_IMPORT_WITH_CONTEXT)?,
    )?;
    set_state_field(
        state_offset,
        STATE_PENDING_IMPORT_BINDINGS,
        macro_call_field(call_offset, MACRO_CALL_PENDING_IMPORT_BINDINGS)?,
    )?;
    let result_offset =
        if macro_call_field(call_offset, MACRO_CALL_NEGATE_RESULT)? == NEGATE_TRUTHINESS {
            write_boolean(!Value::at(result_offset)?.truthy())?
        } else {
            result_offset
        };
    set_state_field(state_offset, STATE_NEGATE_RESULT, NEGATE_NONE)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, result_offset)?;
    continue_expression(state_offset)
}
