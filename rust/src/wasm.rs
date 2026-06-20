use crate::expression::{
    Atom, Call, Operation, next_argument, next_lookup_segment, next_operation, parse_base,
    parse_tag_call,
};
use crate::template::{
    ConditionalBoundary, RenderError, RenderedValue, TemplateItem, directive_keyword, emit_escaped,
    find_conditional_boundary, next_item,
};
use core::arch::wasm32::{memory_grow, memory_size};
use core::mem::{align_of, size_of};
use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};
use core::slice;

const ABI_VERSION: u32 = 9;
const PAGE_SIZE: usize = 65_536;
const STREAM_CHUNK_BYTES: u32 = 64 * 1024;
const RECORD_ALIGNMENT: u32 = 8;
const RECORD_HEADER_LENGTH: usize = 8;

const TAG_SOURCE: u32 = 1;
const TAG_STRING: u32 = 2;
const TAG_REQUEST: u32 = 4;
const TAG_OUTPUT: u32 = 5;
const TAG_UNDEFINED: u32 = 6;
const TAG_NULL: u32 = 7;
const TAG_BOOLEAN: u32 = 8;
const TAG_NUMBER: u32 = 9;
const TAG_ARRAY: u32 = 10;
const TAG_RECORD: u32 = 11;
const TAG_SAFE_STRING: u32 = 12;
const TAG_RENDER_STATE: u32 = 13;
const TAG_FRAME: u32 = 14;
const TAG_OUTPUT_CHUNK: u32 = 15;
const TAG_CAPABILITY_REGISTRY: u32 = 16;
const TAG_CAPABILITY_REQUEST: u32 = 17;

const STATE_IDLE: u32 = 0;
const STATE_COMPLETE: u32 = 1;
const STATE_ERROR: u32 = 2;
const STATE_LOAD_TEMPLATE: u32 = 3;
const STATE_OUTPUT_AVAILABLE: u32 = 4;
const STATE_CALL_CAPABILITY: u32 = 5;

const ERROR_NONE: u32 = 0;
const ERROR_INVALID_ARENA: u32 = 1;
const ERROR_INVALID_RECORD: u32 = 2;
const ERROR_UNCLOSED_INTERPOLATION: u32 = 3;
const ERROR_OUTPUT_TOO_LARGE: u32 = 4;
const ERROR_UNSUPPORTED_TAG: u32 = 5;
const ERROR_INCLUDE_CYCLE: u32 = 6;
const ERROR_RESOURCE_LIMIT: u32 = 7;
const ERROR_UNKNOWN_CAPABILITY: u32 = 8;
const ERROR_INVALID_EXPRESSION: u32 = 9;

const RENDER_STATE_LENGTH: u32 = 116;
const STATE_CONTEXT: usize = 0;
const STATE_FLAGS: usize = 4;
const STATE_CURRENT_FRAME: usize = 8;
const STATE_FIRST_CHUNK: usize = 12;
const STATE_LAST_CHUNK: usize = 16;
const STATE_OUTPUT_LENGTH: usize = 20;
const STATE_PENDING_NAME: usize = 24;
const STATE_WORK_UNITS: usize = 28;
const STATE_LIMIT_WORK_UNITS: usize = 32;
const STATE_LIMIT_INCLUDE_DEPTH: usize = 36;
const STATE_LIMIT_OUTPUT_BYTES: usize = 40;
const STATE_LIMIT_ARENA_BYTES: usize = 44;
const STATE_LOADER_CALLS: usize = 48;
const STATE_LIMIT_LOADER_CALLS: usize = 52;
const STATE_INCLUDE_DEPTH: usize = 56;
const STATE_TRANSIENT_BASE: usize = 60;
const STATE_TOTAL_OUTPUT_LENGTH: usize = 64;
const STATE_MATERIALIZATION_BASE: usize = 68;
const STATE_FILTERS: usize = 72;
const STATE_TESTS: usize = 76;
const STATE_GLOBALS: usize = 80;
const STATE_CAPABILITY_CALLS: usize = 84;
const STATE_LIMIT_CAPABILITY_CALLS: usize = 88;
const STATE_PENDING_EXPRESSION: usize = 92;
const STATE_EXPRESSION_CURSOR: usize = 96;
const STATE_CURRENT_VALUE: usize = 100;
const STATE_NEGATE_RESULT: usize = 104;
const STATE_TAGS: usize = 108;
const STATE_EXPRESSION_ACTION: usize = 112;

const EXPRESSION_OUTPUT: u32 = 0;
const EXPRESSION_IF: u32 = 1;

const NEGATE_NONE: u32 = 0;
const NEGATE_BOOLEAN: u32 = 1;
const NEGATE_TRUTHINESS: u32 = 2;

const CAPABILITY_FILTER: u32 = 1;
const CAPABILITY_TEST: u32 = 2;
const CAPABILITY_GLOBAL: u32 = 3;
const CAPABILITY_TAG: u32 = 4;

const FRAME_LENGTH: u32 = 16;
const FRAME_PARENT: usize = 0;
const FRAME_SOURCE: usize = 4;
const FRAME_CURSOR: usize = 8;
const FRAME_CANONICAL_NAME: usize = 12;

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
    set_control(STATE_IDLE, 0, 0, ERROR_NONE);
    match resume_include(source_offset, canonical_offset).and_then(|()| run_active_render()) {
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
    if flags & !3 != 0 {
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
    validate_capability_registry(tags_offset)?;
    if limit_include_depth == 0 {
        return Err(ERROR_RESOURCE_LIMIT);
    }

    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(frame_offset, 0, source_offset, 0, canonical_offset)?;
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
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
    enforce_arena_limit(state_offset, unsafe { ARENA_CURSOR })?;
    Ok(())
}

fn resume_include(source_offset: u32, canonical_offset: u32) -> Result<(), u32> {
    let state_offset = active_state()?;
    let pending_name = state_field(state_offset, STATE_PENDING_NAME)?;
    if pending_name == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    record_at(source_offset, TAG_SOURCE)?;
    record_at(canonical_offset, TAG_STRING)?;
    let parent = state_field(state_offset, STATE_CURRENT_FRAME)?;
    if include_cycle(parent, canonical_offset)? {
        return Err(ERROR_INCLUDE_CYCLE);
    }
    let depth = state_field(state_offset, STATE_INCLUDE_DEPTH)?;
    let next_depth = depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
    enforce_limit(
        next_depth,
        state_field(state_offset, STATE_LIMIT_INCLUDE_DEPTH)?,
    )?;
    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(frame_offset, parent, source_offset, 0, canonical_offset)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, frame_offset)?;
    set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
    set_state_field(state_offset, STATE_INCLUDE_DEPTH, next_depth)?;
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
    Ok(())
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
    if is_streaming(state_offset)? && state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0 {
        return yield_output(state_offset);
    }
    if state_field(state_offset, STATE_PENDING_EXPRESSION)? != 0 {
        if state_field(state_offset, STATE_CURRENT_VALUE)? == 0 {
            return Err(ERROR_INVALID_ARENA);
        }
        if let Some(state) = continue_expression(state_offset)? {
            return Ok(state);
        }
        if is_streaming(state_offset)? && state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0 {
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
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) = next_item(source, cursor).map_err(render_error_code)?;
        let work = match item {
            TemplateItem::Text(bytes)
            | TemplateItem::Expression(bytes)
            | TemplateItem::Include(bytes)
            | TemplateItem::Tag(bytes) => 1u32
                .checked_add(bytes.len() as u32)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
            TemplateItem::End => 1,
        };
        charge_counter(state_offset, STATE_WORK_UNITS, STATE_LIMIT_WORK_UNITS, work)?;
        set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)?;

        match item {
            TemplateItem::Text(text) => {
                append_output(state_offset, text)?;
                if is_streaming(state_offset)? && !text.is_empty() {
                    return yield_output(state_offset);
                }
            }
            TemplateItem::Expression(expression) => {
                if let Some(state) = start_expression(state_offset, expression, EXPRESSION_OUTPUT)?
                {
                    return Ok(state);
                }
                if is_streaming(state_offset)?
                    && state_field(state_offset, STATE_OUTPUT_LENGTH)? != 0
                {
                    return yield_output(state_offset);
                }
            }
            TemplateItem::Include(name) => {
                charge_counter(
                    state_offset,
                    STATE_LOADER_CALLS,
                    STATE_LIMIT_LOADER_CALLS,
                    1,
                )?;
                let name_offset = write_bytes_record(TAG_STRING, name)?;
                set_state_field(state_offset, STATE_PENDING_NAME, name_offset)?;
                set_control(
                    STATE_LOAD_TEMPLATE,
                    name_offset,
                    name.len() as u32,
                    ERROR_NONE,
                );
                return Ok(STATE_LOAD_TEMPLATE);
            }
            TemplateItem::Tag(directive) => {
                if let Some(state) = handle_tag(state_offset, directive)? {
                    return Ok(state);
                }
            }
            TemplateItem::End => {
                set_state_field(state_offset, STATE_CURRENT_FRAME, parent)?;
                let depth = state_field(state_offset, STATE_INCLUDE_DEPTH)?;
                set_state_field(state_offset, STATE_INCLUDE_DEPTH, depth.saturating_sub(1))?;
            }
        }
    }
}

fn start_expression(state_offset: u32, expression: &[u8], action: u32) -> Result<Option<u32>, u32> {
    let expression_offset = write_bytes_record(TAG_STRING, expression)?;
    let (base, cursor, negated) = parse_base(expression).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, cursor as u32)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, action)?;

    if let Atom::Call(call) = base {
        return issue_capability(
            state_offset,
            CAPABILITY_GLOBAL,
            call,
            None,
            cursor,
            if negated {
                NEGATE_TRUTHINESS
            } else {
                NEGATE_NONE
            },
        )
        .map(Some);
    }
    let mut value_offset = resolve_atom(state_offset, base)?;
    if negated {
        value_offset = write_boolean(!Value::at(value_offset)?.truthy())?;
    }
    set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
    continue_expression(state_offset)
}

fn handle_tag(state_offset: u32, directive: &[u8]) -> Result<Option<u32>, u32> {
    if let Some(condition) = directive_keyword(directive, b"if") {
        return start_expression(state_offset, condition, EXPRESSION_IF);
    }
    if directive == b"else"
        || directive_keyword(directive, b"elif").is_some()
        || directive_keyword(directive, b"elseif").is_some()
    {
        skip_active_conditional(state_offset)?;
        return Ok(None);
    }
    if directive == b"endif" {
        return Ok(None);
    }
    start_tag(state_offset, directive).map(Some)
}

fn start_tag(state_offset: u32, directive: &[u8]) -> Result<u32, u32> {
    let call = parse_tag_call(directive).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let directive_offset = write_bytes_record(TAG_STRING, directive)?;
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
}

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
            _ => return Err(ERROR_INVALID_ARENA),
        };
        if next_state.is_none()
            && state_field(state_offset, STATE_PENDING_EXPRESSION)? == 0
            && is_streaming(state_offset)?
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
    let (kind, call, negate_mode) = match operation {
        Operation::Filter(call) => (CAPABILITY_FILTER, call, NEGATE_NONE),
        Operation::Test { call, negated } => (
            CAPABILITY_TEST,
            call,
            if negated { NEGATE_BOOLEAN } else { NEGATE_NONE },
        ),
    };
    issue_capability(
        state_offset,
        kind,
        call,
        Some(input),
        next_cursor,
        negate_mode,
    )
    .map(Some)
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
    match find_conditional_boundary(source, cursor, true).map_err(render_error_code)? {
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

fn skip_active_conditional(state_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let cursor = read_u32(frame, FRAME_CURSOR)? as usize;
    let source = record_at(source_offset, TAG_SOURCE)?;
    let ConditionalBoundary::EndIf(next_cursor) =
        find_conditional_boundary(source, cursor, false).map_err(render_error_code)?
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
    let capability_id =
        resolve_capability(registry_offset, call.name)?.ok_or(if kind == CAPABILITY_TAG {
            ERROR_UNSUPPORTED_TAG
        } else {
            ERROR_UNKNOWN_CAPABILITY
        })?;

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

fn resolve_atom(state_offset: u32, atom: Atom<'_>) -> Result<u32, u32> {
    match atom {
        Atom::Lookup(path) => {
            let context_offset = state_field(state_offset, STATE_CONTEXT)?;
            let context = Context::new(record_at(context_offset, TAG_RECORD)?)?;
            context
                .lookup_offset(path)
                .map_or_else(|| allocate_record(TAG_UNDEFINED, 0), Ok)
        }
        Atom::String(value) => write_bytes_record(TAG_STRING, value),
        Atom::Number(value) => write_number(value),
        Atom::Boolean(value) => write_boolean(value),
        Atom::Null => allocate_record(TAG_NULL, 0),
        Atom::Undefined => allocate_record(TAG_UNDEFINED, 0),
        Atom::Call(_) => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn emit_value(state_offset: u32, value_offset: u32) -> Result<(), u32> {
    let value = Value::at(value_offset)?
        .rendered()
        .ok_or(ERROR_INVALID_EXPRESSION)?;
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

fn yield_output(state_offset: u32) -> Result<u32, u32> {
    set_state_field(state_offset, STATE_MATERIALIZATION_BASE, unsafe {
        ARENA_CURSOR
    })?;
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
    let output_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let output_offset = allocate_record(TAG_OUTPUT, output_length)?;
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

fn validate_capability_registry(offset: u32) -> Result<(), u32> {
    let registry = record_at(offset, TAG_CAPABILITY_REGISTRY)?;
    let count = collection_count(registry, 8)?;
    for index in 0..count {
        let entry = 4 + index * 8;
        if read_u32(registry, entry)? == 0 {
            return Err(ERROR_INVALID_RECORD);
        }
        record_at(read_u32(registry, entry + 4)?, TAG_STRING)?;
    }
    Ok(())
}

fn resolve_capability(registry_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let registry = record_at(registry_offset, TAG_CAPABILITY_REGISTRY)?;
    let count = collection_count(registry, 8)?;
    for index in 0..count {
        let entry = 4 + index * 8;
        let capability_id = read_u32(registry, entry)?;
        let registered_name = record_at(read_u32(registry, entry + 4)?, TAG_STRING)?;
        if registered_name == name {
            return Ok(Some(capability_id));
        }
    }
    Ok(None)
}

fn include_cycle(mut frame_offset: u32, canonical_offset: u32) -> Result<bool, u32> {
    let canonical = record_at(canonical_offset, TAG_STRING)?;
    while frame_offset != 0 {
        let frame = record_at(frame_offset, TAG_FRAME)?;
        if frame.len() != FRAME_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        let existing_offset = read_u32(frame, FRAME_CANONICAL_NAME)?;
        if existing_offset != 0 && record_at(existing_offset, TAG_STRING)? == canonical {
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
) -> Result<(), u32> {
    let frame = mutable_record_at(offset, TAG_FRAME)?;
    write_u32(frame, FRAME_PARENT, parent)?;
    write_u32(frame, FRAME_SOURCE, source)?;
    write_u32(frame, FRAME_CURSOR, cursor)?;
    write_u32(frame, FRAME_CANONICAL_NAME, canonical)
}

fn set_frame_field(offset: u32, field: usize, value: u32) -> Result<(), u32> {
    let frame = mutable_record_at(offset, TAG_FRAME)?;
    if frame.len() != FRAME_LENGTH as usize {
        return Err(ERROR_INVALID_RECORD);
    }
    write_u32(frame, field, value)
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
    let offset = unsafe { ACTIVE_RENDER };
    if offset == 0 {
        return Err(ERROR_INVALID_ARENA);
    }
    Ok(offset)
}

fn active_limit(field: usize) -> Result<u32, u32> {
    let state_offset = unsafe { ACTIVE_RENDER };
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

struct Context {
    root: Record,
}

impl Context {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        Ok(Self {
            root: Record::new(payload)?,
        })
    }

    fn lookup_offset(&self, path: &[u8]) -> Option<u32> {
        let (first, mut cursor) = next_lookup_segment(path, 0).ok()??;
        let mut offset = self.root.get_offset(first)?;
        while let Some((segment, next)) = next_lookup_segment(path, cursor).ok()? {
            offset = Value::at(offset).ok()?.get_offset(segment)?;
            cursor = next;
        }
        Some(offset)
    }
}

#[derive(Clone, Copy)]
struct Record {
    payload: &'static [u8],
    count: usize,
}

impl Record {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        let count = collection_count(payload, 8)?;
        Ok(Self { payload, count })
    }

    fn get_offset(&self, name: &[u8]) -> Option<u32> {
        for index in 0..self.count {
            let entry_offset = 4 + index * 8;
            let key_offset = read_u32(self.payload, entry_offset).ok()?;
            let value_offset = read_u32(self.payload, entry_offset + 4).ok()?;
            let key = record_at(key_offset, TAG_STRING).ok()?;
            if key == name {
                return Some(value_offset);
            }
        }
        None
    }
}

#[derive(Clone, Copy)]
struct Array {
    payload: &'static [u8],
    count: usize,
}

impl Array {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        let count = collection_count(payload, 4)?;
        Ok(Self { payload, count })
    }

    fn get_offset(&self, name: &[u8]) -> Option<u32> {
        let index = parse_index(name)?;
        if index >= self.count {
            return None;
        }
        let value_offset = read_u32(self.payload, 4 + index * 4).ok()?;
        Some(value_offset)
    }
}

#[derive(Clone, Copy)]
enum Value {
    Undefined,
    Null,
    Boolean(bool),
    Number {
        numeric: f64,
        rendered: &'static [u8],
    },
    String(&'static [u8]),
    SafeString(&'static [u8]),
    Array(Array),
    Record(Record),
}

impl Value {
    fn at(offset: u32) -> Result<Self, u32> {
        let (tag, payload) = raw_record_at(offset)?;
        match tag {
            TAG_UNDEFINED if payload.is_empty() => Ok(Self::Undefined),
            TAG_NULL if payload.is_empty() => Ok(Self::Null),
            TAG_BOOLEAN if payload.len() == 1 => match payload[0] {
                0 => Ok(Self::Boolean(false)),
                1 => Ok(Self::Boolean(true)),
                _ => Err(ERROR_INVALID_RECORD),
            },
            TAG_NUMBER if payload.len() >= 8 => {
                let numeric =
                    f64::from_le_bytes(payload[..8].try_into().map_err(|_| ERROR_INVALID_RECORD)?);
                Ok(Self::Number {
                    numeric,
                    rendered: &payload[8..],
                })
            }
            TAG_STRING => Ok(Self::String(payload)),
            TAG_SAFE_STRING => Ok(Self::SafeString(payload)),
            TAG_ARRAY => Ok(Self::Array(Array::new(payload)?)),
            TAG_RECORD => Ok(Self::Record(Record::new(payload)?)),
            _ => Err(ERROR_INVALID_RECORD),
        }
    }

    fn get_offset(self, name: &[u8]) -> Option<u32> {
        match self {
            Self::Array(array) => array.get_offset(name),
            Self::Record(record) => record.get_offset(name),
            _ => None,
        }
    }

    fn rendered(self) -> Option<RenderedValue<'static>> {
        match self {
            Self::Undefined | Self::Null => Some(RenderedValue {
                bytes: b"",
                safe: false,
            }),
            Self::Boolean(false) => Some(RenderedValue {
                bytes: b"false",
                safe: false,
            }),
            Self::Boolean(true) => Some(RenderedValue {
                bytes: b"true",
                safe: false,
            }),
            Self::Number { rendered, .. } => Some(RenderedValue {
                bytes: rendered,
                safe: false,
            }),
            Self::String(value) => Some(RenderedValue {
                bytes: value,
                safe: false,
            }),
            Self::SafeString(value) => Some(RenderedValue {
                bytes: value,
                safe: true,
            }),
            Self::Array(_) | Self::Record(_) => Some(RenderedValue {
                bytes: b"",
                safe: false,
            }),
        }
    }

    fn truthy(self) -> bool {
        match self {
            Self::Undefined | Self::Null | Self::Boolean(false) => false,
            Self::Boolean(true) | Self::Array(_) | Self::Record(_) => true,
            Self::Number { numeric, .. } => numeric != 0.0 && !numeric.is_nan(),
            Self::String(value) | Self::SafeString(value) => !value.is_empty(),
        }
    }
}

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
    let payload_length = 8u32
        .checked_add(source.len() as u32)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_NUMBER, payload_length)?;
    let payload = mutable_record_at(offset, TAG_NUMBER)?;
    payload[..8].copy_from_slice(&value.to_le_bytes());
    payload[8..].copy_from_slice(source);
    Ok(offset)
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
    let current_length = linear_memory_length();
    if required_length <= current_length {
        return Ok(());
    }
    let additional_bytes = required_length
        .checked_sub(current_length)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let additional_pages = additional_bytes.div_ceil(PAGE_SIZE);
    let previous_pages = memory_grow::<0>(additional_pages);
    if previous_pages == usize::MAX {
        return Err(ERROR_OUTPUT_TOO_LARGE);
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
