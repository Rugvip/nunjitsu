use crate::expression::{
    Atom, BinaryOperator, Call, Comparison, Operand, Operation, next_argument, next_binding,
    next_import_binding, next_lookup_segment, next_macro_argument, next_macro_parameter,
    next_operation, next_record_entry, parse_base, parse_call_block, parse_for_clause,
    parse_from_import_clause, parse_import_clause, parse_set_clause, parse_tag_call,
    parse_tag_name, split_binary_expression,
};
use crate::template::{
    ConditionalBoundary, ParseOptions, RenderError, RenderedValue, TemplateItem, contains_extends,
    directive_keyword, emit_escaped, find_block_end, find_call_end, find_conditional_boundary,
    find_loop_boundaries, find_macro_end, is_endblock, next_item_with_options,
};
use core::arch::wasm32::{memory_grow, memory_size};
use core::mem::{align_of, size_of};
use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};
use core::slice;

const ABI_VERSION: u32 = 21;
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
const TAG_LOOP_STATE: u32 = 18;
const TAG_SCOPE: u32 = 19;
const TAG_BINDINGS: u32 = 20;
const TAG_CAPTURE: u32 = 21;
const TAG_MACRO_DEFINITION: u32 = 22;
const TAG_MACRO_CALL: u32 = 23;
const TAG_MACRO_ARGUMENTS: u32 = 24;
const TAG_BLOCK_DEFINITION: u32 = 25;
const TAG_TAG_REGISTRY: u32 = 26;
const TAG_TAG_CALL: u32 = 27;
const TAG_TAG_BOUNDARIES: u32 = 28;
const TAG_TAG_ARGUMENTS: u32 = 29;

const STATE_IDLE: u32 = 0;
const STATE_COMPLETE: u32 = 1;
const STATE_ERROR: u32 = 2;
const STATE_LOAD_TEMPLATE: u32 = 3;
const STATE_OUTPUT_AVAILABLE: u32 = 4;
const STATE_CALL_CAPABILITY: u32 = 5;
const STATE_LOAD_OPTIONAL_TEMPLATE: u32 = 6;

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

const RENDER_STATE_LENGTH: u32 = 168;
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
const STATE_CURRENT_LOOP: usize = 116;
const STATE_CURRENT_SCOPE: usize = 120;
const STATE_PENDING_SET_BINDINGS: usize = 124;
const STATE_PENDING_LOAD_KIND: usize = 128;
const STATE_CURRENT_CAPTURE: usize = 132;
const STATE_CURRENT_MACRO_DEFINITION: usize = 136;
const STATE_CURRENT_MACRO_CALL: usize = 140;
const STATE_CURRENT_BLOCK_DEFINITION: usize = 144;
const STATE_PENDING_IMPORT_ALIAS: usize = 148;
const STATE_IMPORT_WITH_CONTEXT: usize = 152;
const STATE_PENDING_IMPORT_BINDINGS: usize = 156;
const STATE_EXTENDS_CAPTURE: usize = 160;
const STATE_CURRENT_TAG_CALL: usize = 164;

const EXPRESSION_OUTPUT: u32 = 0;
const EXPRESSION_IF: u32 = 1;
const EXPRESSION_SET: u32 = 2;
const EXPRESSION_INCLUDE: u32 = 3;
const EXPRESSION_EXTENDS: u32 = 4;
const EXPRESSION_IMPORT: u32 = 5;

const LOAD_INCLUDE: u32 = 0;
const LOAD_INCLUDE_OPTIONAL: u32 = 1;
const LOAD_EXTENDS: u32 = 2;
const LOAD_IMPORT: u32 = 3;

const NEGATE_NONE: u32 = 0;
const NEGATE_BOOLEAN: u32 = 1;
const NEGATE_TRUTHINESS: u32 = 2;

const CAPABILITY_FILTER: u32 = 1;
const CAPABILITY_TEST: u32 = 2;
const CAPABILITY_GLOBAL: u32 = 3;
const CAPABILITY_TAG: u32 = 4;

const FRAME_LENGTH: u32 = 24;
const FRAME_PARENT: usize = 0;
const FRAME_SOURCE: usize = 4;
const FRAME_CURSOR: usize = 8;
const FRAME_CANONICAL_NAME: usize = 12;
const FRAME_SCOPE_BASE: usize = 16;
const FRAME_END_CURSOR: usize = 20;

const LOOP_STATE_LENGTH: u32 = 44;
const LOOP_PARENT: usize = 0;
const LOOP_FRAME: usize = 4;
const LOOP_BODY_CURSOR: usize = 8;
const LOOP_ELSE_CURSOR: usize = 12;
const LOOP_END_CURSOR: usize = 16;
const LOOP_ITERABLE: usize = 20;
const LOOP_INDEX: usize = 24;
const LOOP_LENGTH: usize = 28;
const LOOP_BINDINGS: usize = 32;
const LOOP_OUTER_SCOPE: usize = 36;
const LOOP_SCOPE_BASE: usize = 40;

const CAPTURE_LENGTH: u32 = 28;
const CAPTURE_PARENT: usize = 0;
const CAPTURE_FRAME: usize = 4;
const CAPTURE_BINDINGS: usize = 8;
const CAPTURE_FIRST_CHUNK: usize = 12;
const CAPTURE_LAST_CHUNK: usize = 16;
const CAPTURE_OUTPUT_LENGTH: usize = 20;
const CAPTURE_TOTAL_OUTPUT_LENGTH: usize = 24;

const MACRO_DEFINITION_LENGTH: u32 = 36;
const MACRO_DEFINITION_PARENT: usize = 0;
const MACRO_DEFINITION_NAME: usize = 4;
const MACRO_DEFINITION_SOURCE: usize = 8;
const MACRO_DEFINITION_BODY_CURSOR: usize = 12;
const MACRO_DEFINITION_PARAMETERS: usize = 16;
const MACRO_DEFINITION_SCOPE: usize = 20;
const MACRO_DEFINITION_FRAME: usize = 24;
const MACRO_DEFINITION_SUPER: usize = 28;
const MACRO_DEFINITION_END_CURSOR: usize = 32;

const MACRO_CALL_LENGTH: u32 = 64;
const MACRO_CALL_PARENT: usize = 0;
const MACRO_CALL_FRAME: usize = 4;
const MACRO_CALL_PENDING_EXPRESSION: usize = 8;
const MACRO_CALL_EXPRESSION_CURSOR: usize = 12;
const MACRO_CALL_EXPRESSION_ACTION: usize = 16;
const MACRO_CALL_CURRENT_VALUE: usize = 20;
const MACRO_CALL_PENDING_SET_BINDINGS: usize = 24;
const MACRO_CALL_PENDING_LOAD_KIND: usize = 28;
const MACRO_CALL_PENDING_NAME: usize = 32;
const MACRO_CALL_NEGATE_RESULT: usize = 36;
const MACRO_CALL_SCOPE: usize = 40;
const MACRO_CALL_LOOP: usize = 44;
const MACRO_CALL_TRANSIENT_BASE: usize = 48;
const MACRO_CALL_PENDING_IMPORT_ALIAS: usize = 52;
const MACRO_CALL_IMPORT_WITH_CONTEXT: usize = 56;
const MACRO_CALL_PENDING_IMPORT_BINDINGS: usize = 60;

const BLOCK_DEFINITION_LENGTH: u32 = 28;
const BLOCK_DEFINITION_PARENT: usize = 0;
const BLOCK_DEFINITION_NAME: usize = 4;
const BLOCK_DEFINITION_SOURCE: usize = 8;
const BLOCK_DEFINITION_BODY_CURSOR: usize = 12;
const BLOCK_DEFINITION_END_CURSOR: usize = 16;
const BLOCK_DEFINITION_SCOPE: usize = 20;
const BLOCK_DEFINITION_FRAME: usize = 24;

const TAG_CALL_LENGTH: u32 = 32;
const TAG_CALL_PARENT: usize = 0;
const TAG_CALL_CALLER_FRAME: usize = 4;
const TAG_CALL_BODY_FRAME: usize = 8;
const TAG_CALL_CAPABILITY_ID: usize = 12;
const TAG_CALL_ARGUMENTS: usize = 16;
const TAG_CALL_BOUNDARIES: usize = 20;
const TAG_CALL_SEGMENT_INDEX: usize = 24;
const TAG_CALL_RESULTS: usize = 28;

const TAG_ARGUMENTS_LENGTH: u32 = 8;
const TAG_ARGUMENTS_POSITIONAL: usize = 0;
const TAG_ARGUMENTS_KEYWORD: usize = 4;

const SCOPE_LENGTH: u32 = 12;
const SCOPE_PARENT: usize = 0;
const SCOPE_NAME: usize = 4;
const SCOPE_VALUE: usize = 8;

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
        let namespace = write_import_namespace(state_offset, source_offset, parent)?;
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

fn start_expression(state_offset: u32, expression: &[u8], action: u32) -> Result<Option<u32>, u32> {
    let expression_offset = write_bytes_record(TAG_STRING, expression)?;
    let (base, cursor, negated) = parse_base(expression).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, cursor as u32)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, action)?;

    if let Atom::Call(call) = base {
        let context_offset = state_field(state_offset, STATE_CONTEXT)?;
        let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
        if let Some(definition_offset) = context.lookup_offset(call.name)
            && matches!(Value::at(definition_offset)?, Value::Macro)
        {
            start_macro_call(state_offset, definition_offset, call, negated, 0)?;
            return Ok(None);
        }
        if let Some(definition_offset) = resolve_macro(state_offset, call.name)? {
            start_macro_call(state_offset, definition_offset, call, negated, 0)?;
            return Ok(None);
        }
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
    if let Some(source) = directive_keyword(directive, b"from") {
        let clause = parse_from_import_clause(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let bindings = write_bytes_record(TAG_STRING, clause.bindings)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, 0)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, bindings)?;
        set_state_field(
            state_offset,
            STATE_IMPORT_WITH_CONTEXT,
            u32::from(clause.with_context),
        )?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_IMPORT)?;
        return start_expression(state_offset, clause.template, EXPRESSION_IMPORT);
    }
    if let Some(source) = directive_keyword(directive, b"import") {
        let clause = parse_import_clause(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let alias = write_bytes_record(TAG_STRING, clause.alias)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, alias)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, 0)?;
        set_state_field(
            state_offset,
            STATE_IMPORT_WITH_CONTEXT,
            u32::from(clause.with_context),
        )?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_IMPORT)?;
        return start_expression(state_offset, clause.template, EXPRESSION_IMPORT);
    }
    if let Some(expression) = directive_keyword(directive, b"extends") {
        discard_extends_output(state_offset)?;
        prepare_extending_template(state_offset)?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_EXTENDS)?;
        return start_expression(state_offset, expression, EXPRESSION_EXTENDS);
    }
    if let Some(name) = directive_keyword(directive, b"block") {
        start_block(state_offset, name)?;
        return Ok(None);
    }
    if is_endblock(directive) {
        return Ok(None);
    }
    if let Some(clause) = directive_keyword(directive, b"call").or_else(|| {
        directive
            .strip_prefix(b"call")
            .filter(|remainder| remainder.first() == Some(&b'('))
    }) {
        start_call_block(state_offset, clause)?;
        return Ok(None);
    }
    if directive == b"endcall" {
        return finish_macro_call(state_offset);
    }
    if let Some(signature) = directive_keyword(directive, b"macro") {
        define_macro(state_offset, signature)?;
        return Ok(None);
    }
    if directive == b"endmacro" {
        return finish_macro_call(state_offset);
    }
    if let Some(condition) = directive_keyword(directive, b"if") {
        return start_expression(state_offset, condition, EXPRESSION_IF);
    }
    if let Some(clause) = directive_keyword(directive, b"for") {
        start_for(state_offset, clause)?;
        return Ok(None);
    }
    if let Some(clause) = directive_keyword(directive, b"set") {
        let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let bindings = write_bindings(clause.targets)?;
        if let Some(expression) = clause.expression {
            set_state_field(state_offset, STATE_PENDING_SET_BINDINGS, bindings)?;
            return start_expression(state_offset, expression, EXPRESSION_SET);
        }
        begin_capture(state_offset, bindings)?;
        return Ok(None);
    }
    if directive == b"endset" {
        finish_capture(state_offset)?;
        return Ok(None);
    }
    if directive == b"endfor" {
        advance_for(state_offset)?;
        return Ok(None);
    }
    if directive == b"else"
        || directive_keyword(directive, b"elif").is_some()
        || directive_keyword(directive, b"elseif").is_some()
    {
        if directive == b"else" && is_current_loop_else(state_offset)? {
            advance_for(state_offset)?;
        } else {
            skip_active_conditional(state_offset)?;
        }
        return Ok(None);
    }
    if directive == b"endif" {
        return Ok(None);
    }
    start_tag(state_offset, directive)
}

fn prepare_extending_template(state_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    if read_u32(frame, FRAME_END_CURSOR)? != 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let source_length = record_at(source_offset, TAG_SOURCE)?.len();
    let mut cursor = 0usize;
    let mut block_depth = 0usize;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                if let Some(name) = directive_keyword(directive, b"block") {
                    register_block_definition(
                        state_offset,
                        name,
                        frame_offset,
                        source_offset,
                        next_cursor as u32,
                    )?;
                    block_depth = block_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) {
                    block_depth = block_depth.saturating_sub(1);
                } else if let Some(signature) = directive_keyword(directive, b"macro") {
                    let end_cursor = if block_depth == 0 {
                        register_macro_definition(
                            state_offset,
                            signature,
                            frame_offset,
                            source_offset,
                            next_cursor as u32,
                        )? as usize
                    } else {
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?
                    };
                    cursor = end_cursor;
                    continue;
                } else if block_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if let Some(expression) = clause.expression {
                        let bindings = write_bindings(clause.targets)?;
                        let value = evaluate_sync_expression(state_offset, expression)?;
                        assign_bindings(state_offset, bindings, value)?;
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    set_frame_field(frame_offset, FRAME_CURSOR, source_length as u32)
}

fn write_import_namespace(
    state_offset: u32,
    source_offset: u32,
    owner_frame: u32,
) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    let mut nested_depth = 0usize;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if directive_keyword(directive, b"macro").is_some() {
                    let end_cursor =
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?;
                    if nested_depth == 0 {
                        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                    }
                    cursor = end_cursor;
                    continue;
                } else if nested_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if clause.expression.is_some() {
                        let mut binding_cursor = 0usize;
                        while let Some((name, next)) = next_binding(clause.targets, binding_cursor)
                            .map_err(|_| ERROR_UNSUPPORTED_TAG)?
                        {
                            if !name.starts_with(b"_") {
                                count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                            }
                            binding_cursor = next;
                        }
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }

    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(8).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let namespace = allocate_record(TAG_RECORD, payload_length)?;
    write_u32(mutable_record_at(namespace, TAG_RECORD)?, 0, count as u32)?;
    let outer_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    let with_context = state_field(state_offset, STATE_IMPORT_WITH_CONTEXT)? == 1;
    let mut caller_scope = outer_scope;
    let mut imported_scope = if with_context { outer_scope } else { 0 };
    cursor = 0;
    nested_depth = 0;
    let mut index = 0usize;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if directive_keyword(directive, b"macro").is_some() {
                    cursor = find_macro_end(source, next_cursor, parse_options(state_offset)?)
                        .map_err(render_error_code)?;
                    continue;
                } else if nested_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if let Some(expression) = clause.expression {
                        set_state_field(state_offset, STATE_CURRENT_SCOPE, imported_scope)?;
                        let value = evaluate_sync_expression(state_offset, expression);
                        set_state_field(state_offset, STATE_CURRENT_SCOPE, caller_scope)?;
                        let value = value?;
                        let mut binding_cursor = 0usize;
                        while let Some((name, next)) = next_binding(clause.targets, binding_cursor)
                            .map_err(|_| ERROR_UNSUPPORTED_TAG)?
                        {
                            if !name.starts_with(b"_") {
                                let name_offset = write_bytes_record(TAG_STRING, name)?;
                                if with_context {
                                    set_state_field(
                                        state_offset,
                                        STATE_CURRENT_SCOPE,
                                        caller_scope,
                                    )?;
                                    assign_scope(state_offset, name_offset, value)?;
                                    caller_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;
                                    imported_scope = caller_scope;
                                } else {
                                    let scope = allocate_record(TAG_SCOPE, SCOPE_LENGTH)?;
                                    let scope_record = mutable_record_at(scope, TAG_SCOPE)?;
                                    write_u32(scope_record, SCOPE_PARENT, imported_scope)?;
                                    write_u32(scope_record, SCOPE_NAME, name_offset)?;
                                    write_u32(scope_record, SCOPE_VALUE, value)?;
                                    imported_scope = scope;
                                }
                                let record = mutable_record_at(namespace, TAG_RECORD)?;
                                write_u32(record, 4 + index * 8, name_offset)?;
                                write_u32(record, 8 + index * 8, value)?;
                                index += 1;
                            }
                            binding_cursor = next;
                        }
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    set_state_field(state_offset, STATE_CURRENT_SCOPE, caller_scope)?;

    cursor = 0;
    nested_depth = 0;
    loop {
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if let Some(signature) = directive_keyword(directive, b"macro") {
                    let end_cursor =
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?;
                    if nested_depth == 0 {
                        let definition = write_imported_macro_definition(
                            signature,
                            owner_frame,
                            source_offset,
                            next_cursor as u32,
                            imported_scope,
                        )?;
                        let name = macro_definition_field(definition, MACRO_DEFINITION_NAME)?;
                        let record = mutable_record_at(namespace, TAG_RECORD)?;
                        write_u32(record, 4 + index * 8, name)?;
                        write_u32(record, 8 + index * 8, definition)?;
                        index += 1;
                    }
                    cursor = end_cursor;
                    continue;
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    Ok(namespace)
}

fn assign_import_bindings(
    state_offset: u32,
    bindings_offset: u32,
    namespace_offset: u32,
) -> Result<(), u32> {
    let bindings = record_at(bindings_offset, TAG_STRING)?;
    let namespace = Record::new(record_at(namespace_offset, TAG_RECORD)?)?;
    let mut cursor = 0usize;
    while let Some(binding) =
        next_import_binding(bindings, cursor).map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        let value = namespace
            .get_offset(binding.name)
            .ok_or(ERROR_INVALID_EXPRESSION)?;
        let alias = write_bytes_record(TAG_STRING, binding.alias)?;
        assign_scope(state_offset, alias, value)?;
        cursor = binding.next_cursor;
    }
    Ok(())
}

fn write_imported_macro_definition(
    signature: &[u8],
    owner_frame: u32,
    source_offset: u32,
    body_cursor: u32,
    scope: u32,
) -> Result<u32, u32> {
    let macro_signature = parse_tag_call(signature).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let mut parameter_cursor = 0usize;
    while let Some(parameter) = next_macro_parameter(macro_signature.arguments, parameter_cursor)
        .map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        parameter_cursor = parameter.next_cursor;
    }
    let name = write_bytes_record(TAG_STRING, macro_signature.name)?;
    let parameters = write_bytes_record(TAG_STRING, macro_signature.arguments)?;
    let definition_offset = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_MACRO_DEFINITION)?;
    write_u32(definition, MACRO_DEFINITION_PARENT, 0)?;
    write_u32(definition, MACRO_DEFINITION_NAME, name)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters)?;
    write_u32(definition, MACRO_DEFINITION_SCOPE, scope)?;
    write_u32(definition, MACRO_DEFINITION_FRAME, owner_frame)?;
    Ok(definition_offset)
}

fn register_block_definition(
    state_offset: u32,
    name: &[u8],
    frame_offset: u32,
    source_offset: u32,
    body_cursor: u32,
) -> Result<u32, u32> {
    let block = parse_tag_call(name).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    if !block.arguments.is_empty() {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let end_cursor = find_block_end(
        record_at(source_offset, TAG_SOURCE)?,
        body_cursor as usize,
        parse_options(state_offset)?,
    )
    .map_err(render_error_code)? as u32;
    let mut existing_definition = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    while existing_definition != 0 {
        if block_definition_field(existing_definition, BLOCK_DEFINITION_FRAME)? == frame_offset
            && record_at(
                block_definition_field(existing_definition, BLOCK_DEFINITION_NAME)?,
                TAG_STRING,
            )? == block.name
        {
            return Err(ERROR_UNSUPPORTED_TAG);
        }
        existing_definition = block_definition_field(existing_definition, BLOCK_DEFINITION_PARENT)?;
    }
    let name_offset = write_bytes_record(TAG_STRING, block.name)?;
    let definition_offset = allocate_record(TAG_BLOCK_DEFINITION, BLOCK_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_BLOCK_DEFINITION)?;
    write_u32(definition, BLOCK_DEFINITION_PARENT, 0)?;
    write_u32(definition, BLOCK_DEFINITION_NAME, name_offset)?;
    write_u32(definition, BLOCK_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, BLOCK_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, BLOCK_DEFINITION_END_CURSOR, end_cursor)?;
    write_u32(
        definition,
        BLOCK_DEFINITION_SCOPE,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
    )?;
    write_u32(definition, BLOCK_DEFINITION_FRAME, frame_offset)?;
    let first_definition = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    if first_definition == 0 {
        set_state_field(
            state_offset,
            STATE_CURRENT_BLOCK_DEFINITION,
            definition_offset,
        )?;
    } else {
        let mut last_definition = first_definition;
        loop {
            let next = block_definition_field(last_definition, BLOCK_DEFINITION_PARENT)?;
            if next == 0 {
                break;
            }
            last_definition = next;
        }
        write_u32(
            mutable_record_at(last_definition, TAG_BLOCK_DEFINITION)?,
            BLOCK_DEFINITION_PARENT,
            definition_offset,
        )?;
    }
    Ok(end_cursor)
}

fn resolve_block(state_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let mut definition_offset = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    while definition_offset != 0 {
        let definition = record_at(definition_offset, TAG_BLOCK_DEFINITION)?;
        if definition.len() != BLOCK_DEFINITION_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        if record_at(read_u32(definition, BLOCK_DEFINITION_NAME)?, TAG_STRING)? == name {
            return Ok(Some(definition_offset));
        }
        definition_offset = read_u32(definition, BLOCK_DEFINITION_PARENT)?;
    }
    Ok(None)
}

fn write_super_definition(
    source_offset: u32,
    body_cursor: u32,
    end_cursor: u32,
    scope: u32,
    owner_frame: u32,
    next_super: u32,
) -> Result<u32, u32> {
    let name = write_bytes_record(TAG_STRING, b"super")?;
    let parameters = write_bytes_record(TAG_STRING, b"")?;
    let definition_offset = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_MACRO_DEFINITION)?;
    write_u32(definition, MACRO_DEFINITION_PARENT, 0)?;
    write_u32(definition, MACRO_DEFINITION_NAME, name)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters)?;
    write_u32(definition, MACRO_DEFINITION_SCOPE, scope)?;
    write_u32(definition, MACRO_DEFINITION_FRAME, owner_frame)?;
    write_u32(definition, MACRO_DEFINITION_SUPER, next_super)?;
    write_u32(definition, MACRO_DEFINITION_END_CURSOR, end_cursor)?;
    Ok(definition_offset)
}

fn write_super_chain(
    definition_offset: u32,
    name: &[u8],
    fallback: u32,
    scope: u32,
) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut candidate = block_definition_field(definition_offset, BLOCK_DEFINITION_PARENT)?;
    while candidate != 0 {
        if record_at(
            block_definition_field(candidate, BLOCK_DEFINITION_NAME)?,
            TAG_STRING,
        )? == name
        {
            count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
        candidate = block_definition_field(candidate, BLOCK_DEFINITION_PARENT)?;
    }

    let mut chain = fallback;
    for requested in (0..count).rev() {
        candidate = block_definition_field(definition_offset, BLOCK_DEFINITION_PARENT)?;
        let mut index = 0usize;
        let selected = loop {
            if candidate == 0 {
                return Err(ERROR_INVALID_ARENA);
            }
            if record_at(
                block_definition_field(candidate, BLOCK_DEFINITION_NAME)?,
                TAG_STRING,
            )? == name
            {
                if index == requested {
                    break candidate;
                }
                index = index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            candidate = block_definition_field(candidate, BLOCK_DEFINITION_PARENT)?;
        };
        chain = write_super_definition(
            block_definition_field(selected, BLOCK_DEFINITION_SOURCE)?,
            block_definition_field(selected, BLOCK_DEFINITION_BODY_CURSOR)?,
            block_definition_field(selected, BLOCK_DEFINITION_END_CURSOR)?,
            scope,
            block_definition_field(selected, BLOCK_DEFINITION_FRAME)?,
            chain,
        )?;
    }
    Ok(chain)
}

fn start_block(state_offset: u32, name: &[u8]) -> Result<(), u32> {
    let block = parse_tag_call(name).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    if !block.arguments.is_empty() {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let body_cursor = read_u32(frame, FRAME_CURSOR)?;
    let end_cursor = find_block_end(
        record_at(source_offset, TAG_SOURCE)?,
        body_cursor as usize,
        parse_options(state_offset)?,
    )
    .map_err(render_error_code)? as u32;
    set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)?;
    let current_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;

    let definition_offset = resolve_block(state_offset, block.name)?;
    let is_override = if let Some(definition_offset) = definition_offset {
        block_definition_field(definition_offset, BLOCK_DEFINITION_SOURCE)? != source_offset
    } else {
        false
    };
    if !is_override {
        let block_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
        write_frame(
            block_frame,
            frame_offset,
            source_offset,
            body_cursor,
            0,
            current_scope,
            end_cursor,
        )?;
        set_state_field(state_offset, STATE_CURRENT_FRAME, block_frame)?;
        set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
        return Ok(());
    }
    let definition_offset = definition_offset.ok_or(ERROR_INVALID_ARENA)?;
    let override_source = block_definition_field(definition_offset, BLOCK_DEFINITION_SOURCE)?;
    let base_super = write_super_definition(
        source_offset,
        body_cursor,
        end_cursor,
        current_scope,
        frame_offset,
        0,
    )?;
    let super_definition =
        write_super_chain(definition_offset, block.name, base_super, current_scope)?;

    let block_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(
        block_frame,
        frame_offset,
        override_source,
        block_definition_field(definition_offset, BLOCK_DEFINITION_BODY_CURSOR)?,
        0,
        current_scope,
        block_definition_field(definition_offset, BLOCK_DEFINITION_END_CURSOR)?,
    )?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, block_frame)?;
    set_state_field(state_offset, STATE_TRANSIENT_BASE, unsafe { ARENA_CURSOR })?;
    let super_name = write_bytes_record(TAG_STRING, b"super")?;
    assign_scope(state_offset, super_name, super_definition)
}

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
        body_cursor,
    )?;
    set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)
}

fn register_macro_definition(
    state_offset: u32,
    signature: &[u8],
    frame_offset: u32,
    source_offset: u32,
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
        0,
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

fn start_tag(state_offset: u32, directive: &[u8]) -> Result<Option<u32>, u32> {
    let call = parse_tag_call(directive).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let schema = resolve_tag(state_field(state_offset, STATE_TAGS)?, call.name)?
        .ok_or(ERROR_UNSUPPORTED_TAG)?;
    if schema.kind == 1 {
        start_body_tag(state_offset, call, schema)?;
        return Ok(None);
    }
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
    let (segment_start, segment_end) = tag_segment(boundaries_offset, 0)?
        .ok_or(ERROR_INVALID_ARENA)?;
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

fn write_tag_arguments(state_offset: u32, arguments: &[u8]) -> Result<u32, u32> {
    let mut positional_count = 0usize;
    let mut keyword_count = 0usize;
    let mut cursor = 0usize;
    while let Some(argument) =
        next_macro_argument(arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if argument.name.is_some() {
            keyword_count = keyword_count
                .checked_add(1)
                .ok_or(ERROR_RESOURCE_LIMIT)?;
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
            let name_offset = write_bytes_record(TAG_STRING, name)?;
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
        let source = record_at(source_offset, TAG_SOURCE)?;
        let (item, next_cursor) =
            next_item_with_options(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let Ok(name) = parse_tag_name(directive) else {
                    cursor = next_cursor;
                    continue;
                };
                let opening_name = record_at(opening_name_offset, TAG_STRING)?;
                let end_name = record_at(end_name_offset, TAG_STRING)?;
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

    let expression_offset = allocate_record(TAG_STRING, 0)?;
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
    let state = if state_field(state_offset, STATE_PENDING_LOAD_KIND)? == LOAD_INCLUDE_OPTIONAL {
        STATE_LOAD_OPTIONAL_TEMPLATE
    } else {
        STATE_LOAD_TEMPLATE
    };
    set_control(state, name_offset, name.len() as u32, ERROR_NONE);
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

fn apply_builtin_filter(
    state_offset: u32,
    call: Call<'_>,
    input_offset: u32,
) -> Result<Option<u32>, u32> {
    let input = Value::at(input_offset)?;
    let output = match call.name {
        b"safe" => {
            require_argument_count(call, 0)?;
            let rendered = rendered_value(input_offset)?;
            write_bytes_record(TAG_SAFE_STRING, rendered.bytes)?
        }
        b"escape" | b"e" => {
            require_argument_count(call, 0)?;
            if matches!(input, Value::SafeString(_)) {
                input_offset
            } else {
                write_escaped_string(rendered_value(input_offset)?.bytes)?
            }
        }
        b"forceescape" => {
            require_argument_count(call, 0)?;
            write_escaped_string(rendered_value(input_offset)?.bytes)?
        }
        b"default" | b"d" => {
            let count = argument_count(call)?;
            if !(1..=2).contains(&count) {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let use_falsy = if count == 2 {
                Value::at(call_argument(state_offset, call, 1)?.ok_or(ERROR_INVALID_EXPRESSION)?)?
                    .truthy()
            } else {
                false
            };
            if matches!(input, Value::Undefined) || (use_falsy && !input.truthy()) {
                call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?
            } else {
                input_offset
            }
        }
        b"reverse" => {
            require_argument_count(call, 0)?;
            reverse_value(input)?
        }
        b"upper" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, true, false)?
        }
        b"lower" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, false, false)?
        }
        b"capitalize" | b"title" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, false, true)?
        }
        b"length" => {
            require_argument_count(call, 0)?;
            let length = match input {
                Value::Undefined | Value::Null => 0,
                Value::String(value) | Value::SafeString(value) => core::str::from_utf8(value)
                    .map_err(|_| ERROR_INVALID_RECORD)?
                    .chars()
                    .count()
                    as u32,
                Value::Array(array) => array.count as u32,
                Value::Record(record) => record.count as u32,
                _ => 0,
            };
            write_u32_number(length)?
        }
        b"first" => {
            require_argument_count(call, 0)?;
            edge_value(input, false)?
        }
        b"last" => {
            require_argument_count(call, 0)?;
            edge_value(input, true)?
        }
        _ => return Ok(None),
    };
    Ok(Some(output))
}

fn apply_builtin_test(
    state_offset: u32,
    call: Call<'_>,
    input_offset: u32,
) -> Result<Option<bool>, u32> {
    let input = Value::at(input_offset)?;
    let result = match call.name {
        b"defined" => {
            require_argument_count(call, 0)?;
            !matches!(input, Value::Undefined)
        }
        b"undefined" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Undefined)
        }
        b"none" | b"null" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Null)
        }
        b"truthy" => {
            require_argument_count(call, 0)?;
            input.truthy()
        }
        b"falsy" => {
            require_argument_count(call, 0)?;
            !input.truthy()
        }
        b"boolean" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Boolean(_))
        }
        b"number" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Number { .. })
        }
        b"string" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::String(_) | Value::SafeString(_))
        }
        b"mapping" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Record(_))
        }
        b"iterable" => {
            require_argument_count(call, 0)?;
            matches!(
                input,
                Value::Array(_) | Value::String(_) | Value::SafeString(_)
            )
        }
        b"escaped" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::SafeString(_))
        }
        b"even" | b"odd" => {
            require_argument_count(call, 0)?;
            let number = input.as_number();
            let even = number.is_finite() && number % 2.0 == 0.0;
            if call.name == b"even" {
                even
            } else {
                !even && number.is_finite()
            }
        }
        b"divisibleby" => {
            require_argument_count(call, 1)?;
            let divisor =
                Value::at(call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?)?
                    .as_number();
            divisor != 0.0 && input.as_number() % divisor == 0.0
        }
        b"sameas" => {
            require_argument_count(call, 1)?;
            values_equal(
                input_offset,
                call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?,
                true,
            )?
        }
        b"eq" | b"equalto" | b"ne" | b"lt" | b"lessthan" | b"le" | b"lteq" | b"gt"
        | b"greaterthan" | b"ge" | b"gteq" => {
            require_argument_count(call, 1)?;
            let right = call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            let operator = match call.name {
                b"eq" | b"equalto" => Comparison::Equal,
                b"ne" => Comparison::NotEqual,
                b"lt" | b"lessthan" => Comparison::Less,
                b"le" | b"lteq" => Comparison::LessOrEqual,
                b"gt" | b"greaterthan" => Comparison::Greater,
                _ => Comparison::GreaterOrEqual,
            };
            compare_values(input_offset, operator, right)?
        }
        b"lower" | b"upper" => {
            require_argument_count(call, 0)?;
            let Some(value) = input.string_bytes() else {
                return Ok(Some(false));
            };
            let has_cased = value.iter().any(u8::is_ascii_alphabetic);
            has_cased
                && if call.name == b"lower" {
                    !value.iter().any(u8::is_ascii_uppercase)
                } else {
                    !value.iter().any(u8::is_ascii_lowercase)
                }
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

fn argument_count(call: Call<'_>) -> Result<usize, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some((_, next)) =
        next_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = next;
    }
    Ok(count)
}

fn require_argument_count(call: Call<'_>, expected: usize) -> Result<(), u32> {
    if argument_count(call)? == expected {
        Ok(())
    } else {
        Err(ERROR_INVALID_EXPRESSION)
    }
}

fn call_argument(state_offset: u32, call: Call<'_>, requested: usize) -> Result<Option<u32>, u32> {
    let mut index = 0usize;
    let mut cursor = 0usize;
    while let Some((atom, next)) =
        next_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if index == requested {
            return resolve_atom(state_offset, atom).map(Some);
        }
        index += 1;
        cursor = next;
    }
    Ok(None)
}

fn write_escaped_string(value: &[u8]) -> Result<u32, u32> {
    let mut length = 0usize;
    emit_escaped(value, &mut |segment| {
        length = length
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        Ok(())
    })
    .map_err(render_error_code)?;
    let offset = allocate_record(TAG_SAFE_STRING, length as u32)?;
    let output = mutable_record_at(offset, TAG_SAFE_STRING)?;
    let mut cursor = 0usize;
    emit_escaped(value, &mut |segment| {
        let end = cursor
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        output[cursor..end].copy_from_slice(segment);
        cursor = end;
        Ok(())
    })
    .map_err(render_error_code)?;
    Ok(offset)
}

fn reverse_value(value: Value) -> Result<u32, u32> {
    match value {
        Value::String(bytes) | Value::SafeString(bytes) => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let tag = if matches!(value, Value::SafeString(_)) {
                TAG_SAFE_STRING
            } else {
                TAG_STRING
            };
            let offset = allocate_record(tag, bytes.len() as u32)?;
            let output = mutable_record_at(offset, tag)?;
            let mut cursor = 0usize;
            for character in text.chars().rev() {
                let mut encoded = [0u8; 4];
                let encoded = character.encode_utf8(&mut encoded).as_bytes();
                let end = cursor + encoded.len();
                output[cursor..end].copy_from_slice(encoded);
                cursor = end;
            }
            Ok(offset)
        }
        Value::Array(array) => {
            let payload_length = 4u32
                .checked_add(
                    (array.count as u32)
                        .checked_mul(4)
                        .ok_or(ERROR_RESOURCE_LIMIT)?,
                )
                .ok_or(ERROR_RESOURCE_LIMIT)?;
            let offset = allocate_record(TAG_ARRAY, payload_length)?;
            let output = mutable_record_at(offset, TAG_ARRAY)?;
            write_u32(output, 0, array.count as u32)?;
            for index in 0..array.count {
                write_u32(
                    output,
                    4 + index * 4,
                    read_u32(array.payload, 4 + (array.count - index - 1) * 4)?,
                )?;
            }
            Ok(offset)
        }
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn ascii_case_value(value_offset: u32, uppercase: bool, capitalize: bool) -> Result<u32, u32> {
    let rendered = rendered_value(value_offset)?;
    let tag = if rendered.safe {
        TAG_SAFE_STRING
    } else {
        TAG_STRING
    };
    let offset = allocate_record(tag, rendered.bytes.len() as u32)?;
    let output = mutable_record_at(offset, tag)?;
    for (index, byte) in rendered.bytes.iter().copied().enumerate() {
        output[index] = if uppercase || (capitalize && index == 0) {
            byte.to_ascii_uppercase()
        } else {
            byte.to_ascii_lowercase()
        };
    }
    Ok(offset)
}

fn edge_value(value: Value, last: bool) -> Result<u32, u32> {
    match value {
        Value::Array(array) if array.count != 0 => {
            let index = if last { array.count - 1 } else { 0 };
            read_u32(array.payload, 4 + index * 4)
        }
        Value::String(bytes) | Value::SafeString(bytes) if !bytes.is_empty() => {
            let text = core::str::from_utf8(bytes).map_err(|_| ERROR_INVALID_RECORD)?;
            let character = if last {
                text.chars().next_back()
            } else {
                text.chars().next()
            }
            .ok_or(ERROR_INVALID_EXPRESSION)?;
            let start = if last {
                bytes.len() - character.len_utf8()
            } else {
                0
            };
            let tag = if matches!(value, Value::SafeString(_)) {
                TAG_SAFE_STRING
            } else {
                TAG_STRING
            };
            write_bytes_record(tag, &bytes[start..start + character.len_utf8()])
        }
        Value::Undefined | Value::Null | Value::Array(_) => allocate_record(TAG_UNDEFINED, 0),
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn evaluate_sync_expression(state_offset: u32, expression: &[u8]) -> Result<u32, u32> {
    let (atom, mut cursor, negated) =
        parse_base(expression).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    if matches!(atom, Atom::Call(_)) {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let mut current = resolve_operand(state_offset, Operand { atom, negated })?;
    while let Some((operation, next_cursor)) =
        next_operation(expression, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        current = match operation {
            Operation::Compare { operator, operand } => {
                let right = resolve_operand(state_offset, operand)?;
                write_boolean(compare_values(current, operator, right)?)?
            }
            Operation::And(operand) => {
                if Value::at(current)?.truthy() {
                    resolve_operand(state_offset, operand)?
                } else {
                    current
                }
            }
            Operation::Or(operand) => {
                if Value::at(current)?.truthy() {
                    return Ok(current);
                }
                resolve_operand(state_offset, operand)?
            }
            Operation::Filter(call) => apply_builtin_filter(state_offset, call, current)?
                .ok_or(ERROR_INVALID_EXPRESSION)?,
            Operation::Test { call, negated } => {
                let result = apply_builtin_test(state_offset, call, current)?
                    .ok_or(ERROR_INVALID_EXPRESSION)?;
                write_boolean(if negated { !result } else { result })?
            }
        };
        cursor = next_cursor;
    }
    Ok(current)
}

fn evaluate_binary_expression(state_offset: u32, expression: &[u8]) -> Result<u32, u32> {
    let binary = split_binary_expression(expression)
        .map_err(|_| ERROR_INVALID_EXPRESSION)?
        .ok_or(ERROR_INVALID_EXPRESSION)?;
    let left = evaluate_sync_expression(state_offset, binary.left)?;
    let right = evaluate_sync_expression(state_offset, binary.right)?;
    apply_binary_operator(left, binary.operator, right)
}

fn apply_binary_operator(
    left_offset: u32,
    operator: BinaryOperator,
    right_offset: u32,
) -> Result<u32, u32> {
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    if operator == BinaryOperator::Concat
        || (operator == BinaryOperator::Add
            && (left.string_bytes().is_some() || right.string_bytes().is_some()))
    {
        return concatenate_values(left_offset, right_offset);
    }
    let left = left.as_number();
    let right = right.as_number();
    let result = match operator {
        BinaryOperator::Add => left + right,
        BinaryOperator::Subtract => left - right,
        BinaryOperator::Multiply => left * right,
        BinaryOperator::Divide => left / right,
        BinaryOperator::FloorDivide => libm::floor(left / right),
        BinaryOperator::Remainder => left % right,
        BinaryOperator::Power => libm::pow(left, right),
        BinaryOperator::Concat => return Err(ERROR_INVALID_EXPRESSION),
    };
    write_computed_number(result)
}

fn concatenate_values(left_offset: u32, right_offset: u32) -> Result<u32, u32> {
    let left = rendered_value(left_offset)?.bytes;
    let right = rendered_value(right_offset)?.bytes;
    let length = left
        .len()
        .checked_add(right.len())
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_STRING, length as u32)?;
    let output = mutable_record_at(offset, TAG_STRING)?;
    output[..left.len()].copy_from_slice(left);
    output[left.len()..].copy_from_slice(right);
    Ok(offset)
}

fn compare_values(left_offset: u32, operator: Comparison, right_offset: u32) -> Result<bool, u32> {
    let result = match operator {
        Comparison::Equal => values_equal(left_offset, right_offset, false)?,
        Comparison::StrictEqual => values_equal(left_offset, right_offset, true)?,
        Comparison::NotEqual => !values_equal(left_offset, right_offset, false)?,
        Comparison::StrictNotEqual => !values_equal(left_offset, right_offset, true)?,
        Comparison::Less => values_order(left_offset, right_offset)? == core::cmp::Ordering::Less,
        Comparison::LessOrEqual => {
            values_order(left_offset, right_offset)? != core::cmp::Ordering::Greater
        }
        Comparison::Greater => {
            values_order(left_offset, right_offset)? == core::cmp::Ordering::Greater
        }
        Comparison::GreaterOrEqual => {
            values_order(left_offset, right_offset)? != core::cmp::Ordering::Less
        }
        Comparison::In => value_contains(right_offset, left_offset)?,
        Comparison::NotIn => !value_contains(right_offset, left_offset)?,
    };
    Ok(result)
}

fn values_equal(left_offset: u32, right_offset: u32, strict: bool) -> Result<bool, u32> {
    if left_offset == right_offset {
        return Ok(true);
    }
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    let result = match (left, right) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Undefined, Value::Null) | (Value::Null, Value::Undefined) => !strict,
        (Value::Boolean(left), Value::Boolean(right)) => left == right,
        (Value::Number { numeric: left, .. }, Value::Number { numeric: right, .. }) => {
            left == right
        }
        (
            Value::String(left) | Value::SafeString(left),
            Value::String(right) | Value::SafeString(right),
        ) => left == right,
        (Value::Array(_), Value::Array(_)) | (Value::Record(_), Value::Record(_)) => false,
        (left, right) if !strict => left.as_number() == right.as_number(),
        _ => false,
    };
    Ok(result)
}

fn values_order(left_offset: u32, right_offset: u32) -> Result<core::cmp::Ordering, u32> {
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    if let (Some(left), Some(right)) = (left.string_bytes(), right.string_bytes()) {
        return Ok(left.cmp(right));
    }
    left.as_number()
        .partial_cmp(&right.as_number())
        .ok_or(ERROR_INVALID_EXPRESSION)
}

fn value_contains(container_offset: u32, needle_offset: u32) -> Result<bool, u32> {
    let container = Value::at(container_offset)?;
    match container {
        Value::String(value) | Value::SafeString(value) => {
            let rendered = rendered_value(needle_offset)?.bytes;
            if rendered.is_empty() {
                return Ok(true);
            }
            Ok(value
                .windows(rendered.len())
                .any(|window| window == rendered))
        }
        Value::Array(array) => {
            for index in 0..array.count {
                let value_offset = read_u32(array.payload, 4 + index * 4)?;
                if values_equal(value_offset, needle_offset, false)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Value::Record(record) => {
            let key = rendered_value(needle_offset)?.bytes;
            Ok(record.get_offset(key).is_some())
        }
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn resolve_atom(state_offset: u32, atom: Atom<'_>) -> Result<u32, u32> {
    match atom {
        Atom::Lookup(path) => {
            let context_offset = state_field(state_offset, STATE_CONTEXT)?;
            let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
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
        Atom::Group(expression) => evaluate_sync_expression(state_offset, expression),
        Atom::Array(elements) => write_array_literal(state_offset, elements),
        Atom::Record(entries) => write_record_literal(state_offset, entries),
        Atom::Arithmetic(expression) => evaluate_binary_expression(state_offset, expression),
        Atom::InlineIf {
            body,
            condition,
            alternative,
        } => {
            let condition = evaluate_sync_expression(state_offset, condition)?;
            if Value::at(condition)?.truthy() {
                evaluate_sync_expression(state_offset, body)
            } else if let Some(alternative) = alternative {
                evaluate_sync_expression(state_offset, alternative)
            } else {
                allocate_record(TAG_UNDEFINED, 0)
            }
        }
    }
}

fn write_array_literal(state_offset: u32, elements: &[u8]) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some((_, next)) =
        next_argument(elements, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = next;
    }
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(4).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_ARRAY, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_ARRAY)?, 0, count as u32)?;
    cursor = 0;
    let mut index = 0usize;
    while let Some((atom, next)) =
        next_argument(elements, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let value_offset = resolve_atom(state_offset, atom)?;
        write_u32(
            mutable_record_at(offset, TAG_ARRAY)?,
            4 + index * 4,
            value_offset,
        )?;
        index += 1;
        cursor = next;
    }
    Ok(offset)
}

fn write_record_literal(state_offset: u32, entries: &[u8]) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some(entry) =
        next_record_entry(entries, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = entry.next_cursor;
    }
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(8).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_RECORD, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_RECORD)?, 0, count as u32)?;
    cursor = 0;
    let mut index = 0usize;
    while let Some(entry) =
        next_record_entry(entries, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let key_offset = write_bytes_record(TAG_STRING, entry.key)?;
        let value_offset = resolve_atom(state_offset, entry.value)?;
        let record = mutable_record_at(offset, TAG_RECORD)?;
        write_u32(record, 4 + index * 8, key_offset)?;
        write_u32(record, 8 + index * 8, value_offset)?;
        index += 1;
        cursor = entry.next_cursor;
    }
    Ok(offset)
}

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
                    .checked_add(coerced_value_length(read_u32(array.payload, 4 + index * 4)?)?)
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
                write_coerced_value_into(
                    read_u32(array.payload, 4 + index * 4)?,
                    output,
                    cursor,
                )?;
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

fn write_coerced_bytes(
    output: &mut [u8],
    cursor: &mut usize,
    bytes: &[u8],
) -> Result<(), u32> {
    let end = cursor
        .checked_add(bytes.len())
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let destination = output
        .get_mut(*cursor..end)
        .ok_or(ERROR_INVALID_ARENA)?;
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
        record_at(read_u32(registry, entry + 4)?, TAG_STRING)?;
        let kind = read_u32(registry, entry + 8)?;
        let end_tag_offset = read_u32(registry, entry + 12)?;
        let intermediate_tags = record_at(read_u32(registry, entry + 16)?, TAG_ARRAY)?;
        let intermediate_count = collection_count(intermediate_tags, 4)?;
        for intermediate_index in 0..intermediate_count {
            record_at(
                read_u32(intermediate_tags, 4 + intermediate_index * 4)?,
                TAG_STRING,
            )?;
        }
        match kind {
            0 if end_tag_offset == 0 && intermediate_count == 0 => {}
            1 if end_tag_offset != 0 => {
                record_at(end_tag_offset, TAG_STRING)?;
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
        let registered_name = record_at(read_u32(registry, entry + 4)?, TAG_STRING)?;
        if registered_name == name {
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
    state_offset: u32,
}

impl Context {
    fn new(payload: &'static [u8], state_offset: u32) -> Result<Self, u32> {
        Ok(Self {
            root: Record::new(payload)?,
            state_offset,
        })
    }

    fn lookup_offset(&self, path: &[u8]) -> Option<u32> {
        let (first, mut cursor) = next_lookup_segment(path, 0).ok()??;
        if first == b"loop" {
            let (metadata, next) = next_lookup_segment(path, cursor).ok()??;
            let mut offset = loop_metadata_offset(self.state_offset, metadata)
                .ok()
                .flatten()?;
            cursor = next;
            while let Some((segment, next)) = next_lookup_segment(path, cursor).ok()? {
                offset = Value::at(offset).ok()?.get_offset(segment)?;
                cursor = next;
            }
            return Some(offset);
        }
        let mut offset = self
            .lookup_scope(first)
            .or_else(|| self.lookup_local(first))
            .or_else(|| self.root.get_offset(first))?;
        while let Some((segment, next)) = next_lookup_segment(path, cursor).ok()? {
            offset = Value::at(offset).ok()?.get_offset(segment)?;
            cursor = next;
        }
        Some(offset)
    }

    fn lookup_scope(&self, name: &[u8]) -> Option<u32> {
        let mut scope_offset = state_field(self.state_offset, STATE_CURRENT_SCOPE).ok()?;
        while scope_offset != 0 {
            let scope = record_at(scope_offset, TAG_SCOPE).ok()?;
            if scope.len() != SCOPE_LENGTH as usize {
                return None;
            }
            let name_offset = read_u32(scope, SCOPE_NAME).ok()?;
            if record_at(name_offset, TAG_STRING).ok()? == name {
                return read_u32(scope, SCOPE_VALUE).ok();
            }
            scope_offset = read_u32(scope, SCOPE_PARENT).ok()?;
        }
        None
    }

    fn lookup_local(&self, name: &[u8]) -> Option<u32> {
        let mut loop_offset = state_field(self.state_offset, STATE_CURRENT_LOOP).ok()?;
        while loop_offset != 0 {
            let bindings =
                record_at(loop_field(loop_offset, LOOP_BINDINGS).ok()?, TAG_BINDINGS).ok()?;
            let count = collection_count(bindings, 4).ok()?;
            for index in 0..count {
                let name_offset = read_u32(bindings, 4 + index * 4).ok()?;
                if record_at(name_offset, TAG_STRING).ok()? == name {
                    return loop_binding(loop_offset, index, count).ok();
                }
            }
            loop_offset = loop_field(loop_offset, LOOP_PARENT).ok()?;
        }
        None
    }
}

fn loop_metadata_offset(state_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let loop_offset = state_field(state_offset, STATE_CURRENT_LOOP)?;
    if loop_offset == 0 {
        return Ok(None);
    }
    let index = loop_field(loop_offset, LOOP_INDEX)?;
    let length = loop_field(loop_offset, LOOP_LENGTH)?;
    let value = match name {
        b"index" => write_u32_number(index + 1)?,
        b"index0" => write_u32_number(index)?,
        b"revindex" => write_u32_number(length - index)?,
        b"revindex0" => write_u32_number(length - index - 1)?,
        b"first" => write_boolean(index == 0)?,
        b"last" => write_boolean(index + 1 == length)?,
        b"length" => write_u32_number(length)?,
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn loop_binding(loop_offset: u32, binding_index: usize, binding_count: usize) -> Result<u32, u32> {
    let iterable = Value::at(loop_field(loop_offset, LOOP_ITERABLE)?)?;
    let index = loop_field(loop_offset, LOOP_INDEX)? as usize;
    match iterable {
        Value::Array(array) => {
            let element_offset = read_u32(array.payload, 4 + index * 4)?;
            if binding_count == 1 {
                return Ok(element_offset);
            }
            let Value::Array(element) = Value::at(element_offset)? else {
                return allocate_record(TAG_UNDEFINED, 0);
            };
            if binding_index >= element.count {
                allocate_record(TAG_UNDEFINED, 0)
            } else {
                read_u32(element.payload, 4 + binding_index * 4)
            }
        }
        Value::Record(record) => {
            let entry = 4 + index * 8;
            if binding_index < 2 {
                read_u32(record.payload, entry + binding_index * 4)
            } else {
                allocate_record(TAG_UNDEFINED, 0)
            }
        }
        _ => allocate_record(TAG_UNDEFINED, 0),
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
    Macro,
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
            TAG_MACRO_DEFINITION if payload.len() == MACRO_DEFINITION_LENGTH as usize => {
                Ok(Self::Macro)
            }
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
            Self::Array(_) | Self::Record(_) | Self::Macro => Some(RenderedValue {
                bytes: b"",
                safe: false,
            }),
        }
    }

    fn truthy(self) -> bool {
        match self {
            Self::Undefined | Self::Null | Self::Boolean(false) => false,
            Self::Boolean(true) | Self::Array(_) | Self::Record(_) | Self::Macro => true,
            Self::Number { numeric, .. } => numeric != 0.0 && !numeric.is_nan(),
            Self::String(value) | Self::SafeString(value) => !value.is_empty(),
        }
    }

    fn string_bytes(self) -> Option<&'static [u8]> {
        match self {
            Self::String(value) | Self::SafeString(value) => Some(value),
            _ => None,
        }
    }

    fn as_number(self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Boolean(false) => 0.0,
            Self::Boolean(true) => 1.0,
            Self::Number { numeric, .. } => numeric,
            Self::String(value) | Self::SafeString(value) => {
                let value = trim_ascii_whitespace(value);
                if value.is_empty() {
                    0.0
                } else {
                    core::str::from_utf8(value)
                        .ok()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(f64::NAN)
                }
            }
            Self::Undefined | Self::Array(_) | Self::Record(_) | Self::Macro => f64::NAN,
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
