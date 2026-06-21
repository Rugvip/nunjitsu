fn continue_expression(state_offset: u32) -> Result<Option<u32>, u32> {
    let expression_offset = state_field(state_offset, STATE_PENDING_EXPRESSION)?;
    let expression = record_at(expression_offset, TAG_STRING)?;
    let cursor = state_field(state_offset, STATE_EXPRESSION_CURSOR)? as usize;
    let Some((operation, next_cursor)) =
        next_operation(expression, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    else {
        let value_offset = state_field(state_offset, STATE_CURRENT_VALUE)?;
        let action = state_field(state_offset, STATE_EXPRESSION_ACTION)?;
        set_state_field(state_offset, STATE_PENDING_EXPRESSION, 0)?;
        set_state_field(state_offset, STATE_EXPRESSION_CURSOR, 0)?;
        set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
        set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
        let next_state = match action {
            EXPRESSION_OUTPUT => {
                emit_value(state_offset, value_offset)?;
                None
            }
            EXPRESSION_IF => apply_if_condition(state_offset, value_offset)?,
            EXPRESSION_SWITCH => {
                apply_switch_condition(state_offset, value_offset)?;
                None
            }
            EXPRESSION_SET => {
                let bindings = state_field(state_offset, STATE_PENDING_SET_BINDINGS)?;
                assign_bindings(state_offset, bindings, value_offset)?;
                set_state_field(state_offset, STATE_PENDING_SET_BINDINGS, 0)?;
                None
            }
            EXPRESSION_INCLUDE | EXPRESSION_EXTENDS | EXPRESSION_IMPORT => {
                Some(issue_include(state_offset, value_offset)?)
            }
            _ => return Err(ERROR_INVALID_ARENA),
        };
        if next_state.is_none()
            && state_field(state_offset, STATE_PENDING_EXPRESSION)? == 0
            && is_streaming(state_offset)?
            && state_field(state_offset, STATE_CURRENT_CAPTURE)? == 0
            && state_field(state_offset, STATE_OUTPUT_LENGTH)? == 0
        {
            let transient_base = state_field(state_offset, STATE_TRANSIENT_BASE)?;
            if transient_base > unsafe { ARENA_CURSOR } {
                return Err(ERROR_INVALID_ARENA);
            }
            unsafe {
                ARENA_CURSOR = transient_base;
            }
        }
        return Ok(next_state);
    };

    let input = state_field(state_offset, STATE_CURRENT_VALUE)?;
    match operation {
        Operation::Filter(call) => {
            let registered =
                resolve_capability(state_field(state_offset, STATE_FILTERS)?, call.name)?.is_some();
            if !registered
                && let Some(value_offset) = apply_builtin_filter(state_offset, call, input)?
            {
                set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
                set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
                continue_expression(state_offset)
            } else {
                issue_capability(
                    state_offset,
                    CAPABILITY_FILTER,
                    call,
                    Some(input),
                    next_cursor,
                    NEGATE_NONE,
                )
                .map(Some)
            }
        }
        Operation::Test { call, negated } => {
            let registered =
                resolve_capability(state_field(state_offset, STATE_TESTS)?, call.name)?.is_some();
            if !registered && let Some(result) = apply_builtin_test(state_offset, call, input)? {
                let value_offset = write_boolean(if negated { !result } else { result })?;
                set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
                set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
                continue_expression(state_offset)
            } else {
                issue_capability(
                    state_offset,
                    CAPABILITY_TEST,
                    call,
                    Some(input),
                    next_cursor,
                    if negated { NEGATE_BOOLEAN } else { NEGATE_NONE },
                )
                .map(Some)
            }
        }
        Operation::Compare { operator, operand } => {
            let right = resolve_operand(state_offset, operand)?;
            let value_offset = write_boolean(compare_values(input, operator, right)?)?;
            set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
            set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
            continue_expression(state_offset)
        }
        Operation::And(operand) => {
            let value_offset = if Value::at(input)?.truthy() {
                resolve_operand(state_offset, operand)?
            } else {
                input
            };
            set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
            set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
            continue_expression(state_offset)
        }
        Operation::Or(operand) => {
            if Value::at(input)?.truthy() {
                set_state_field(
                    state_offset,
                    STATE_EXPRESSION_CURSOR,
                    expression.len() as u32,
                )?;
            } else {
                let value_offset = resolve_operand(state_offset, operand)?;
                set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
                set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
            }
            continue_expression(state_offset)
        }
    }
}
fn issue_include(state_offset: u32, value_offset: u32) -> Result<u32, u32> {
    let name = match Value::at(value_offset)? {
        Value::String(name) | Value::SafeString(name) if !name.is_empty() => name,
        _ => return Err(ERROR_INVALID_EXPRESSION),
    };
    if name.contains(&0) {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    charge_counter(
        state_offset,
        STATE_LOADER_CALLS,
        STATE_LIMIT_LOADER_CALLS,
        1,
    )?;
    let name_offset = write_bytes_record(TAG_STRING, name)?;
    set_state_field(state_offset, STATE_PENDING_NAME, name_offset)?;
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let canonical_offset = read_u32(frame, FRAME_CANONICAL_NAME)?;
    if canonical_offset != 0 {
        record_at(canonical_offset, TAG_STRING)?;
    }
    let request_offset = allocate_record(TAG_LOAD_REQUEST, 8)?;
    let request = mutable_record_at(request_offset, TAG_LOAD_REQUEST)?;
    write_u32(request, 0, name_offset)?;
    write_u32(request, 4, canonical_offset)?;
    let state = if state_field(state_offset, STATE_PENDING_LOAD_KIND)? == LOAD_INCLUDE_OPTIONAL {
        STATE_LOAD_OPTIONAL_TEMPLATE
    } else {
        STATE_LOAD_TEMPLATE
    };
    set_control(state, request_offset, 8, ERROR_NONE);
    Ok(state)
}

fn apply_if_condition(state_offset: u32, value_offset: u32) -> Result<Option<u32>, u32> {
    if Value::at(value_offset)?.truthy() {
        return Ok(None);
    }
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let cursor = read_u32(frame, FRAME_CURSOR)? as usize;
    let source = record_at(source_offset, TAG_SOURCE)?;
    match find_conditional_boundary(source, cursor, true, parse_options(state_offset)?)
        .map_err(render_error_code)?
    {
        ConditionalBoundary::Else(next_cursor) | ConditionalBoundary::EndIf(next_cursor) => {
            set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)?;
            Ok(None)
        }
        ConditionalBoundary::ElseIf(condition, next_cursor) => {
            set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)?;
            start_expression(state_offset, condition, EXPRESSION_IF)
        }
    }
}

fn apply_switch_condition(state_offset: u32, value_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let mut cursor = read_u32(frame, FRAME_CURSOR)? as usize;
    let mut depth = 0usize;
    let mut default_cursor = None;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"switch").is_some() {
                depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            } else if directive == b"endswitch" {
                if depth == 0 {
                    set_frame_field(
                        frame_offset,
                        FRAME_CURSOR,
                        default_cursor.unwrap_or(next_cursor) as u32,
                    )?;
                    return Ok(());
                }
                depth -= 1;
            } else if depth == 0 {
                if let Some(expression) = directive_keyword(directive, b"case") {
                    let candidate = evaluate_sync_expression(state_offset, expression)?;
                    if values_equal(value_offset, candidate, false)? {
                        let branch_cursor =
                            switch_branch_cursor(state_offset, source_offset, next_cursor)?;
                        set_frame_field(frame_offset, FRAME_CURSOR, branch_cursor as u32)?;
                        return Ok(());
                    }
                } else if directive == b"default" && default_cursor.is_none() {
                    default_cursor = Some(next_cursor);
                }
            }
        } else if item == TemplateItem::End {
            return Err(ERROR_UNSUPPORTED_TAG);
        }
        cursor = next_cursor;
    }
}

fn switch_branch_cursor(
    state_offset: u32,
    source_offset: u32,
    mut cursor: usize,
) -> Result<usize, u32> {
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive)
                if directive_keyword(directive, b"case").is_some() || directive == b"default" =>
            {
                cursor = next_cursor;
            }
            _ => return Ok(cursor),
        }
    }
}

fn skip_active_switch(state_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let mut cursor = read_u32(frame, FRAME_CURSOR)? as usize;
    let mut depth = 0usize;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"switch").is_some() {
                depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            } else if directive == b"endswitch" {
                if depth == 0 {
                    return set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32);
                }
                depth -= 1;
            }
        } else if item == TemplateItem::End {
            return Err(ERROR_UNSUPPORTED_TAG);
        }
        cursor = next_cursor;
    }
}

fn skip_active_conditional(state_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let cursor = read_u32(frame, FRAME_CURSOR)? as usize;
    let source = record_at(source_offset, TAG_SOURCE)?;
    let ConditionalBoundary::EndIf(next_cursor) =
        find_conditional_boundary(source, cursor, false, parse_options(state_offset)?)
            .map_err(render_error_code)?
    else {
        return Err(ERROR_INVALID_ARENA);
    };
    set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)
}

fn issue_capability(
    state_offset: u32,
    kind: u32,
    call: Call<'_>,
    input: Option<u32>,
    next_cursor: usize,
    negate_mode: u32,
) -> Result<u32, u32> {
    let registry_field = match kind {
        CAPABILITY_FILTER => STATE_FILTERS,
        CAPABILITY_TEST => STATE_TESTS,
        CAPABILITY_GLOBAL => STATE_GLOBALS,
        CAPABILITY_TAG => STATE_TAGS,
        _ => return Err(ERROR_INVALID_EXPRESSION),
    };
    let registry_offset = state_field(state_offset, registry_field)?;
    let capability_id = if kind == CAPABILITY_TAG {
        resolve_tag(registry_offset, call.name)?
            .map(|schema| schema.capability_id)
            .ok_or(ERROR_UNSUPPORTED_TAG)?
    } else {
        resolve_capability(registry_offset, call.name)?.ok_or(ERROR_UNKNOWN_CAPABILITY)?
    };

    let mut argument_count = usize::from(input.is_some());
    let mut argument_cursor = 0usize;
    while let Some((atom, next)) =
        next_argument(call.arguments, argument_cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if matches!(atom, Atom::Call(_)) {
            return Err(ERROR_INVALID_EXPRESSION);
        }
        argument_count = argument_count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        argument_cursor = next;
    }
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
        write_u32(request, 0, kind)?;
        write_u32(request, 4, capability_id)?;
        write_u32(request, 8, argument_count as u32)?;
        if let Some(input) = input {
            write_u32(request, 12, input)?;
        }
    }

    let mut index = usize::from(input.is_some());
    argument_cursor = 0;
    while let Some((atom, next)) =
        next_argument(call.arguments, argument_cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let value_offset = resolve_atom(state_offset, atom)?;
        let request = mutable_record_at(request_offset, TAG_CAPABILITY_REQUEST)?;
        write_u32(request, 12 + index * 4, value_offset)?;
        index += 1;
        argument_cursor = next;
    }

    charge_counter(
        state_offset,
        STATE_CAPABILITY_CALLS,
        STATE_LIMIT_CAPABILITY_CALLS,
        1,
    )?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, next_cursor as u32)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_NEGATE_RESULT, negate_mode)?;
    set_control(
        STATE_CALL_CAPABILITY,
        request_offset,
        payload_length,
        ERROR_NONE,
    );
    Ok(STATE_CALL_CAPABILITY)
}

fn resolve_operand(state_offset: u32, operand: Operand<'_>) -> Result<u32, u32> {
    let mut value_offset = resolve_atom(state_offset, operand.atom)?;
    if operand.negated {
        value_offset = write_boolean(!Value::at(value_offset)?.truthy())?;
    }
    Ok(value_offset)
}

fn apply_builtin_call(state_offset: u32, call: Call<'_>) -> Result<Option<u32>, u32> {
    let context_offset = state_field(state_offset, STATE_CONTEXT)?;
    let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
    if let Some(value_offset) = context.lookup_offset(call.name) {
        if matches!(Value::at(value_offset)?, Value::Joiner(_)) {
            return call_joiner(value_offset, call).map(Some);
        }
        return Ok(None);
    }
    for (suffix, reset) in [(b".next".as_slice(), false), (b".reset".as_slice(), true)] {
        if let Some(owner) = call.name.strip_suffix(suffix)
            && let Some(value_offset) = context.lookup_offset(owner)
            && matches!(Value::at(value_offset)?, Value::Cycler(_))
        {
            return call_cycler(value_offset, call, reset).map(Some);
        }
    }
    match call.name {
        b"range" => range_value(state_offset, call).map(Some),
        b"cycler" => create_cycler(state_offset, call).map(Some),
        b"joiner" => create_joiner(state_offset, call).map(Some),
        _ => Ok(None),
    }
}

fn range_value(state_offset: u32, call: Call<'_>) -> Result<u32, u32> {
    let count = argument_count(call)?;
    if !(1..=3).contains(&count) {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let first = call_positional_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
    let (start, stop) = if count == 1 {
        (0.0, Value::at(first)?.as_number())
    } else {
        let stop =
            call_positional_argument(state_offset, call, 1)?.ok_or(ERROR_INVALID_EXPRESSION)?;
        (Value::at(first)?.as_number(), Value::at(stop)?.as_number())
    };
    let step = if count == 3 {
        let step =
            call_positional_argument(state_offset, call, 2)?.ok_or(ERROR_INVALID_EXPRESSION)?;
        let step_value = Value::at(step)?;
        if step_value.truthy() {
            step_value.as_number()
        } else {
            1.0
        }
    } else {
        1.0
    };
    if !start.is_finite() || !stop.is_finite() || !step.is_finite() {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let count = if step > 0.0 && start < stop {
        libm::ceil((stop - start) / step)
    } else if step < 0.0 && start > stop {
        libm::ceil((start - stop) / -step)
    } else {
        0.0
    };
    if count > u32::MAX as f64 {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    let count = count as usize;
    charge_counter(
        state_offset,
        STATE_WORK_UNITS,
        STATE_LIMIT_WORK_UNITS,
        u32::try_from(count).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = allocate_value_array(count)?;
    let mut value = start;
    for index in 0..count {
        let item = write_computed_number(value)?;
        write_u32(mutable_record_at(output, TAG_ARRAY)?, 4 + index * 4, item)?;
        value += step;
    }
    Ok(output)
}

fn create_cycler(state_offset: u32, call: Call<'_>) -> Result<u32, u32> {
    let count = argument_count(call)?;
    let payload_length = CYCLER_FIXED_LENGTH
        .checked_add(
            u32::try_from(count)
                .map_err(|_| ERROR_RESOURCE_LIMIT)?
                .checked_mul(4)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_CYCLER, payload_length)?;
    let current = allocate_record(TAG_NULL, 0)?;
    let cycler = mutable_record_at(offset, TAG_CYCLER)?;
    write_u32(cycler, CYCLER_COUNT, count as u32)?;
    write_u32(cycler, CYCLER_NEXT_INDEX, 0)?;
    write_u32(cycler, CYCLER_CURRENT, current)?;
    for index in 0..count {
        let value =
            call_positional_argument(state_offset, call, index)?.ok_or(ERROR_INVALID_EXPRESSION)?;
        write_u32(
            mutable_record_at(offset, TAG_CYCLER)?,
            CYCLER_FIXED_LENGTH as usize + index * 4,
            value,
        )?;
    }
    Ok(offset)
}

fn call_cycler(value_offset: u32, call: Call<'_>, reset: bool) -> Result<u32, u32> {
    require_argument_count(call, 0)?;
    if reset {
        let current = allocate_record(TAG_NULL, 0)?;
        let cycler = mutable_record_at(value_offset, TAG_CYCLER)?;
        write_u32(cycler, CYCLER_NEXT_INDEX, 0)?;
        write_u32(cycler, CYCLER_CURRENT, current)?;
        return allocate_record(TAG_UNDEFINED, 0);
    }
    let cycler = record_at(value_offset, TAG_CYCLER)?;
    let count = read_u32(cycler, CYCLER_COUNT)? as usize;
    if count == 0 {
        let current = allocate_record(TAG_UNDEFINED, 0)?;
        write_u32(
            mutable_record_at(value_offset, TAG_CYCLER)?,
            CYCLER_CURRENT,
            current,
        )?;
        return Ok(current);
    }
    let index = read_u32(cycler, CYCLER_NEXT_INDEX)? as usize;
    if index >= count {
        return Err(ERROR_INVALID_RECORD);
    }
    let current = read_u32(cycler, CYCLER_FIXED_LENGTH as usize + index * 4)?;
    let next = (index + 1) % count;
    let cycler = mutable_record_at(value_offset, TAG_CYCLER)?;
    write_u32(cycler, CYCLER_NEXT_INDEX, next as u32)?;
    write_u32(cycler, CYCLER_CURRENT, current)?;
    Ok(current)
}

fn create_joiner(state_offset: u32, call: Call<'_>) -> Result<u32, u32> {
    if argument_count(call)? > 1 {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let separator = if let Some(value) = call_positional_argument(state_offset, call, 0)? {
        if Value::at(value)?.truthy() {
            value
        } else {
            write_bytes_record(TAG_STRING, b",")?
        }
    } else {
        write_bytes_record(TAG_STRING, b",")?
    };
    let offset = allocate_record(TAG_JOINER, JOINER_LENGTH)?;
    let joiner = mutable_record_at(offset, TAG_JOINER)?;
    write_u32(joiner, JOINER_SEPARATOR, separator)?;
    write_u32(joiner, JOINER_USED, 0)?;
    Ok(offset)
}

fn call_joiner(value_offset: u32, call: Call<'_>) -> Result<u32, u32> {
    require_argument_count(call, 0)?;
    let joiner = mutable_record_at(value_offset, TAG_JOINER)?;
    let used = read_u32(joiner, JOINER_USED)?;
    write_u32(joiner, JOINER_USED, 1)?;
    if used == 0 {
        write_bytes_record(TAG_STRING, b"")
    } else {
        read_u32(joiner, JOINER_SEPARATOR)
    }
}
