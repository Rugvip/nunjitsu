#[repr(C)]
struct Control {
    state: u32,
    payload_offset: u32,
    payload_length: u32,
    error_code: u32,
}

static mut CONTROL: Control = Control {
    state: STATE_IDLE,
    payload_offset: 0,
    payload_length: 0,
    error_code: ERROR_NONE,
};

static mut ARENA_CURSOR: u32 = 0;
static mut ACTIVE_RENDER: u32 = 0;

unsafe extern "C" {
    static __heap_base: u8;
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_control_offset() -> u32 {
    addr_of!(CONTROL) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_arena_base() -> u32 {
    align_up(addr_of!(__heap_base) as u32, RECORD_ALIGNMENT).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_arena_cursor() -> u32 {
    unsafe { ARENA_CURSOR }
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_arena_reset() {
    unsafe {
        ARENA_CURSOR = nunjitsu_arena_base();
        ACTIVE_RENDER = 0;
    }
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_arena_set_cursor(cursor: u32) -> u32 {
    let base = nunjitsu_arena_base();
    let memory_length = linear_memory_length();
    if cursor < base || cursor as usize > memory_length || !cursor.is_multiple_of(RECORD_ALIGNMENT)
    {
        return 0;
    }
    if let Ok(limit) = active_limit(STATE_LIMIT_ARENA_BYTES)
        && limit != u32::MAX
        && cursor.saturating_sub(base) > limit
    {
        return 2;
    }
    unsafe {
        ARENA_CURSOR = cursor;
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_render(request_offset: u32) -> u32 {
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    if unsafe { ACTIVE_RENDER } != 0 {
        return fail(ERROR_INVALID_ARENA);
    }
    match start_render(request_offset).and_then(|()| run_active_render()) {
        Ok(state) => state,
        Err(error) => fail(error),
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_resume_include(source_offset: u32, canonical_offset: u32) -> u32 {
    if !matches!(
        unsafe { CONTROL.state },
        STATE_LOAD_TEMPLATE | STATE_LOAD_OPTIONAL_TEMPLATE
    ) {
        return fail(ERROR_INVALID_ARENA);
    }
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    match resume_include(source_offset, canonical_offset).and_then(|()| run_active_render()) {
        Ok(state) => state,
        Err(error) => fail(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_resume_include_missing() -> u32 {
    if unsafe { CONTROL.state } != STATE_LOAD_OPTIONAL_TEMPLATE {
        return fail(ERROR_INVALID_ARENA);
    }
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    match resume_include_missing().and_then(|()| run_active_render()) {
        Ok(state) => state,
        Err(error) => fail(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_resume_output() -> u32 {
    if unsafe { CONTROL.state } != STATE_OUTPUT_AVAILABLE {
        return fail(ERROR_INVALID_ARENA);
    }
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    match resume_output().and_then(|()| run_active_render()) {
        Ok(state) => state,
        Err(error) => fail(error),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_resume_capability(value_offset: u32) -> u32 {
    if unsafe { CONTROL.state } != STATE_CALL_CAPABILITY {
        return fail(ERROR_INVALID_ARENA);
    }
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    match resume_capability(value_offset).and_then(|()| run_active_render()) {
        Ok(state) => state,
        Err(error) => fail(error),
    }
}

fn start_render(request_offset: u32) -> Result<(), u32> {
    let request = record_at(request_offset, TAG_REQUEST)?;
    if request.len() != 56 {
        return Err(ERROR_INVALID_RECORD);
    }
    let source_offset = read_u32(request, 0)?;
    let context_offset = read_u32(request, 4)?;
    let flags = read_u32(request, 8)?;
    let canonical_offset = read_u32(request, 12)?;
    let limit_work_units = read_u32(request, 16)?;
    let limit_include_depth = read_u32(request, 20)?;
    let limit_output_bytes = read_u32(request, 24)?;
    let limit_arena_bytes = read_u32(request, 28)?;
    let limit_loader_calls = read_u32(request, 32)?;
    let filters_offset = read_u32(request, 36)?;
    let tests_offset = read_u32(request, 40)?;
    let globals_offset = read_u32(request, 44)?;
    let limit_capability_calls = read_u32(request, 48)?;
    let tags_offset = read_u32(request, 52)?;
    if flags & !15 != 0 {
        return Err(ERROR_INVALID_RECORD);
    }
    record_at(source_offset, TAG_SOURCE)?;
    record_at(context_offset, TAG_RECORD)?;
    if canonical_offset != 0 {
        record_at(canonical_offset, TAG_STRING)?;
    }
    validate_capability_registry(filters_offset)?;
    validate_capability_registry(tests_offset)?;
    validate_capability_registry(globals_offset)?;
    validate_tag_registry(tags_offset)?;
    if limit_include_depth == 0 {
        return Err(ERROR_RESOURCE_LIMIT);
    }

    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(frame_offset, 0, source_offset, 0, canonical_offset, 0, 0)?;
    let state_offset = allocate_record(TAG_RENDER_STATE, RENDER_STATE_LENGTH)?;
    set_state_field(state_offset, STATE_CONTEXT, context_offset)?;
    set_state_field(state_offset, STATE_FLAGS, flags)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, frame_offset)?;
    set_state_field(state_offset, STATE_LIMIT_WORK_UNITS, limit_work_units)?;
    set_state_field(state_offset, STATE_LIMIT_INCLUDE_DEPTH, limit_include_depth)?;
    set_state_field(state_offset, STATE_LIMIT_OUTPUT_BYTES, limit_output_bytes)?;
    set_state_field(state_offset, STATE_LIMIT_ARENA_BYTES, limit_arena_bytes)?;
    set_state_field(state_offset, STATE_LIMIT_LOADER_CALLS, limit_loader_calls)?;
    set_state_field(state_offset, STATE_INCLUDE_DEPTH, 1)?;
    set_state_field(state_offset, STATE_FILTERS, filters_offset)?;
    set_state_field(state_offset, STATE_TESTS, tests_offset)?;
    set_state_field(state_offset, STATE_GLOBALS, globals_offset)?;
    set_state_field(state_offset, STATE_TAGS, tags_offset)?;
    set_state_field(
        state_offset,
        STATE_LIMIT_CAPABILITY_CALLS,
        limit_capability_calls,
    )?;
    unsafe {
        ACTIVE_RENDER = state_offset;
    }
    if matches!(
        contains_extends(
            record_at(source_offset, TAG_SOURCE)?,
            parse_options(state_offset)?,
        ),
        Ok(true)
    ) {
        begin_capture(state_offset, 0)?;
        set_state_field(
            state_offset,
            STATE_EXTENDS_CAPTURE,
            state_field(state_offset, STATE_CURRENT_CAPTURE)?,
        )?;
    }
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
    enforce_arena_limit(state_offset, unsafe { ARENA_CURSOR })?;
    Ok(())
}

fn resume_include(source_offset: u32, canonical_offset: u32) -> Result<(), u32> {
    let state_offset = active_state()?;
    let pending_name = state_field(state_offset, STATE_PENDING_NAME)?;
    let load_kind = state_field(state_offset, STATE_PENDING_LOAD_KIND)?;
    if pending_name == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    record_at(source_offset, TAG_SOURCE)?;
    record_at(canonical_offset, TAG_STRING)?;
    let parent = state_field(state_offset, STATE_CURRENT_FRAME)?;
    if include_cycle(parent, canonical_offset)? {
        return Err(ERROR_INCLUDE_CYCLE);
    }
    if load_kind == LOAD_IMPORT {
        let alias = state_field(state_offset, STATE_PENDING_IMPORT_ALIAS)?;
        let bindings = state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS)?;
        if (alias == 0) == (bindings == 0)
            || state_field(state_offset, STATE_IMPORT_WITH_CONTEXT)? > 1
        {
            return Err(ERROR_INVALID_ARENA);
        }
        let namespace =
            write_import_namespace(state_offset, source_offset, canonical_offset, parent)?;
        if alias != 0 {
            assign_scope(state_offset, alias, namespace)?;
        } else {
            assign_import_bindings(state_offset, bindings, namespace)?;
        }
        set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_INCLUDE)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, 0)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, 0)?;
        set_state_field(state_offset, STATE_IMPORT_WITH_CONTEXT, 0)?;
        set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
        return Ok(());
    }
    let depth = state_field(state_offset, STATE_INCLUDE_DEPTH)?;
    let next_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
    enforce_limit(
        next_depth,
        state_field(state_offset, STATE_LIMIT_INCLUDE_DEPTH)?,
    )?;
    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(
        frame_offset,
        parent,
        source_offset,
        0,
        canonical_offset,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
        0,
    )?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, frame_offset)?;
    set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
    set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_INCLUDE)?;
    set_state_field(state_offset, STATE_INCLUDE_DEPTH, next_depth)?;
    if load_kind == LOAD_EXTENDS
        && matches!(
            contains_extends(
                record_at(source_offset, TAG_SOURCE)?,
                parse_options(state_offset)?,
            ),
            Ok(true)
        )
    {
        begin_capture(state_offset, 0)?;
        set_state_field(
            state_offset,
            STATE_EXTENDS_CAPTURE,
            state_field(state_offset, STATE_CURRENT_CAPTURE)?,
        )?;
    }
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
    Ok(())
}

fn resume_include_missing() -> Result<(), u32> {
    let state_offset = active_state()?;
    if state_field(state_offset, STATE_PENDING_NAME)? == 0
        || state_field(state_offset, STATE_PENDING_LOAD_KIND)? != LOAD_INCLUDE_OPTIONAL
    {
        return Err(ERROR_INVALID_ARENA);
    }
    set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
    set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_INCLUDE)
}

fn resume_output() -> Result<(), u32> {
    let state_offset = active_state()?;
    if !is_streaming(state_offset)? {
        return Err(ERROR_INVALID_ARENA);
    }
    let materialization_base = state_field(state_offset, STATE_MATERIALIZATION_BASE)?;
    if materialization_base < nunjitsu_arena_base()
        || materialization_base > unsafe { ARENA_CURSOR }
    {
        return Err(ERROR_INVALID_ARENA);
    }
    unsafe {
        ARENA_CURSOR = materialization_base;
    }
    if state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0 {
        return Ok(());
    }

    let transient_base = state_field(state_offset, STATE_TRANSIENT_BASE)?;
    if transient_base > materialization_base {
        return Err(ERROR_INVALID_ARENA);
    }
    unsafe {
        ARENA_CURSOR = transient_base;
    }
    set_state_field(state_offset, STATE_FIRST_CHUNK, 0)?;
    set_state_field(state_offset, STATE_LAST_CHUNK, 0)?;
    set_state_field(state_offset, STATE_MATERIALIZATION_BASE, 0)
}

fn resume_capability(value_offset: u32) -> Result<(), u32> {
    let state_offset = active_state()?;
    if state_field(state_offset, STATE_PENDING_EXPRESSION)? == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    let value = Value::at(value_offset)?;
    let negate = state_field(state_offset, STATE_NEGATE_RESULT)?;
    let current = match negate {
        NEGATE_NONE => value_offset,
        NEGATE_BOOLEAN => {
            let Value::Boolean(result) = value else {
                return Err(ERROR_INVALID_EXPRESSION);
            };
            write_boolean(!result)?
        }
        NEGATE_TRUTHINESS => write_boolean(!value.truthy())?,
        _ => return Err(ERROR_INVALID_ARENA),
    };
    set_state_field(state_offset, STATE_NEGATE_RESULT, NEGATE_NONE)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, current)?;
    Ok(())
}

fn run_active_render() -> Result<u32, u32> {
    let state_offset = active_state()?;
    if should_yield_output(state_offset)? {
        return yield_output(state_offset);
    }
    if state_field(state_offset, STATE_PENDING_EXPRESSION)? != 0 {
        if state_field(state_offset, STATE_CURRENT_VALUE)? == 0 {
            return Err(ERROR_INVALID_ARENA);
        }
        if let Some(state) = continue_expression(state_offset)? {
            return Ok(state);
        }
        if should_yield_output(state_offset)? {
            return yield_output(state_offset);
        }
    }
    loop {
        let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
        if frame_offset == 0 {
            return complete_render(state_offset);
        }

        let frame = record_at(frame_offset, TAG_FRAME)?;
        if frame.len() != FRAME_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        let parent = read_u32(frame, FRAME_PARENT)?;
        let source_offset = read_u32(frame, FRAME_SOURCE)?;
        let cursor = read_u32(frame, FRAME_CURSOR)? as usize;
        let end_cursor = read_u32(frame, FRAME_END_CURSOR)? as usize;
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) = if end_cursor != 0 && cursor >= end_cursor {
            (TemplateItem::End, cursor)
        } else {
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?
        };
        let work = match item {
            TemplateItem::Text(bytes)
            | TemplateItem::Expression(bytes)
            | TemplateItem::Tag(bytes) => 1u32
                .checked_add(bytes.len() as u32)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
            TemplateItem::Include { expression, .. } => 1u32
                .checked_add(expression.len() as u32)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
            TemplateItem::End => 1,
        };
        charge_counter(state_offset, STATE_WORK_UNITS, STATE_LIMIT_WORK_UNITS, work)?;
        set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)?;

        match item {
            TemplateItem::Text(text) => {
                append_output(state_offset, text)?;
                if should_yield_output(state_offset)? {
                    return yield_output(state_offset);
                }
            }
            TemplateItem::Expression(expression) => {
                if let Some(state) = start_expression(state_offset, expression, EXPRESSION_OUTPUT)?
                {
                    return Ok(state);
                }
                if should_yield_output(state_offset)? {
                    return yield_output(state_offset);
                }
            }
            TemplateItem::Include {
                expression,
                ignore_missing,
            } => {
                set_state_field(
                    state_offset,
                    STATE_PENDING_LOAD_KIND,
                    if ignore_missing {
                        LOAD_INCLUDE_OPTIONAL
                    } else {
                        LOAD_INCLUDE
                    },
                )?;
                if let Some(state) = start_expression(state_offset, expression, EXPRESSION_INCLUDE)?
                {
                    return Ok(state);
                }
            }
            TemplateItem::Tag(directive) => {
                if let Some(state) = handle_tag(state_offset, directive)? {
                    return Ok(state);
                }
            }
            TemplateItem::End => {
                let tag_call = state_field(state_offset, STATE_CURRENT_TAG_CALL)?;
                if tag_call != 0 && tag_call_field(tag_call, TAG_CALL_BODY_FRAME)? == frame_offset {
                    if let Some(state) = finish_tag_segment(state_offset)? {
                        return Ok(state);
                    }
                    continue;
                }
                let macro_call = state_field(state_offset, STATE_CURRENT_MACRO_CALL)?;
                if macro_call != 0
                    && macro_call_field(macro_call, MACRO_CALL_FRAME)? == frame_offset
                {
                    if let Some(state) = finish_macro_call(state_offset)? {
                        return Ok(state);
                    }
                    if should_yield_output(state_offset)? {
                        return yield_output(state_offset);
                    }
                    continue;
                }
                let extends_capture = state_field(state_offset, STATE_EXTENDS_CAPTURE)?;
                if extends_capture != 0
                    && extends_capture == state_field(state_offset, STATE_CURRENT_CAPTURE)?
                    && capture_field(extends_capture, CAPTURE_FRAME)? == frame_offset
                {
                    let output = finish_output_capture(state_offset, TAG_SAFE_STRING)?;
                    set_state_field(state_offset, STATE_EXTENDS_CAPTURE, 0)?;
                    emit_value(state_offset, output)?;
                }
                let capture_offset = state_field(state_offset, STATE_CURRENT_CAPTURE)?;
                if capture_offset != 0
                    && capture_field(capture_offset, CAPTURE_FRAME)? == frame_offset
                {
                    return Err(ERROR_UNSUPPORTED_TAG);
                }
                set_state_field(
                    state_offset,
                    STATE_CURRENT_SCOPE,
                    read_u32(frame, FRAME_SCOPE_BASE)?,
                )?;
                set_state_field(state_offset, STATE_CURRENT_FRAME, parent)?;
                if end_cursor == 0 {
                    let depth = state_field(state_offset, STATE_INCLUDE_DEPTH)?;
                    set_state_field(state_offset, STATE_INCLUDE_DEPTH, depth.saturating_sub(1))?;
                }
            }
        }
    }
}
