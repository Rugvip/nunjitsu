use crate::template::{RenderError, RenderedValue, TemplateItem, emit_escaped, next_item};
use core::arch::wasm32::{memory_grow, memory_size};
use core::mem::{align_of, size_of};
use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};
use core::slice;

const ABI_VERSION: u32 = 4;
const PAGE_SIZE: usize = 65_536;
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

const STATE_IDLE: u32 = 0;
const STATE_COMPLETE: u32 = 1;
const STATE_ERROR: u32 = 2;
const STATE_LOAD_TEMPLATE: u32 = 3;

const ERROR_NONE: u32 = 0;
const ERROR_INVALID_ARENA: u32 = 1;
const ERROR_INVALID_RECORD: u32 = 2;
const ERROR_UNCLOSED_INTERPOLATION: u32 = 3;
const ERROR_OUTPUT_TOO_LARGE: u32 = 4;
const ERROR_UNSUPPORTED_TAG: u32 = 5;
const ERROR_INCLUDE_CYCLE: u32 = 6;

const RENDER_STATE_LENGTH: u32 = 28;
const STATE_CONTEXT: usize = 0;
const STATE_FLAGS: usize = 4;
const STATE_CURRENT_FRAME: usize = 8;
const STATE_FIRST_CHUNK: usize = 12;
const STATE_LAST_CHUNK: usize = 16;
const STATE_OUTPUT_LENGTH: usize = 20;
const STATE_PENDING_NAME: usize = 24;

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

fn start_render(request_offset: u32) -> Result<(), u32> {
    let request = record_at(request_offset, TAG_REQUEST)?;
    if request.len() != 16 {
        return Err(ERROR_INVALID_RECORD);
    }
    let source_offset = read_u32(request, 0)?;
    let context_offset = read_u32(request, 4)?;
    let flags = read_u32(request, 8)?;
    let canonical_offset = read_u32(request, 12)?;
    if flags & !1 != 0 {
        return Err(ERROR_INVALID_RECORD);
    }
    record_at(source_offset, TAG_SOURCE)?;
    record_at(context_offset, TAG_RECORD)?;
    if canonical_offset != 0 {
        record_at(canonical_offset, TAG_STRING)?;
    }

    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(frame_offset, 0, source_offset, 0, canonical_offset)?;
    let state_offset = allocate_record(TAG_RENDER_STATE, RENDER_STATE_LENGTH)?;
    set_state_field(state_offset, STATE_CONTEXT, context_offset)?;
    set_state_field(state_offset, STATE_FLAGS, flags)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, frame_offset)?;
    unsafe {
        ACTIVE_RENDER = state_offset;
    }
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
    let frame_offset = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(frame_offset, parent, source_offset, 0, canonical_offset)?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, frame_offset)?;
    set_state_field(state_offset, STATE_PENDING_NAME, 0)?;
    Ok(())
}

fn run_active_render() -> Result<u32, u32> {
    let state_offset = active_state()?;
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
        set_frame_field(frame_offset, FRAME_CURSOR, next_cursor as u32)?;

        match item {
            TemplateItem::Text(text) => append_output(state_offset, text)?,
            TemplateItem::Expression(expression) => {
                let context_offset = state_field(state_offset, STATE_CONTEXT)?;
                let context = Context::new(record_at(context_offset, TAG_RECORD)?)?;
                if let Some(value) = context.lookup(expression) {
                    let autoescape = state_field(state_offset, STATE_FLAGS)? & 1 == 1;
                    if autoescape && !value.safe {
                        emit_escaped(value.bytes, &mut |segment| {
                            append_output(state_offset, segment)
                                .map_err(|_| RenderError::OutputTooLarge)
                        })
                        .map_err(render_error_code)?;
                    } else {
                        append_output(state_offset, value.bytes)?;
                    }
                }
            }
            TemplateItem::Include(name) => {
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
            TemplateItem::End => {
                set_state_field(state_offset, STATE_CURRENT_FRAME, parent)?;
            }
        }
    }
}

fn complete_render(state_offset: u32) -> Result<u32, u32> {
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
    set_control(STATE_COMPLETE, output_offset, output_length, ERROR_NONE);
    Ok(STATE_COMPLETE)
}

fn append_output(state_offset: u32, bytes: &[u8]) -> Result<(), u32> {
    if bytes.is_empty() {
        return Ok(());
    }
    let output_length = state_field(state_offset, STATE_OUTPUT_LENGTH)?;
    let next_length = output_length
        .checked_add(bytes.len() as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
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
    set_state_field(state_offset, STATE_LAST_CHUNK, chunk_offset)?;
    set_state_field(state_offset, STATE_OUTPUT_LENGTH, next_length)
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

    fn lookup(&self, path: &[u8]) -> Option<RenderedValue<'static>> {
        let mut segments = path.split(|byte| *byte == b'.');
        let first = trim_ascii_whitespace(segments.next()?);
        if first.is_empty() {
            return None;
        }
        let mut value = self.root.get(first)?;
        for segment in segments {
            value = value.get(trim_ascii_whitespace(segment))?;
        }
        value.rendered()
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

    fn get(&self, name: &[u8]) -> Option<Value> {
        for index in 0..self.count {
            let entry_offset = 4 + index * 8;
            let key_offset = read_u32(self.payload, entry_offset).ok()?;
            let value_offset = read_u32(self.payload, entry_offset + 4).ok()?;
            let key = record_at(key_offset, TAG_STRING).ok()?;
            if key == name {
                return Value::at(value_offset).ok();
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

    fn get(&self, name: &[u8]) -> Option<Value> {
        let index = parse_index(name)?;
        if index >= self.count {
            return None;
        }
        let value_offset = read_u32(self.payload, 4 + index * 4).ok()?;
        Value::at(value_offset).ok()
    }
}

#[derive(Clone, Copy)]
enum Value {
    Undefined,
    Null,
    Boolean(bool),
    Number(&'static [u8]),
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
            TAG_NUMBER if payload.len() >= 8 => Ok(Self::Number(&payload[8..])),
            TAG_STRING => Ok(Self::String(payload)),
            TAG_SAFE_STRING => Ok(Self::SafeString(payload)),
            TAG_ARRAY => Ok(Self::Array(Array::new(payload)?)),
            TAG_RECORD => Ok(Self::Record(Record::new(payload)?)),
            _ => Err(ERROR_INVALID_RECORD),
        }
    }

    fn get(self, name: &[u8]) -> Option<Self> {
        match self {
            Self::Array(array) => array.get(name),
            Self::Record(record) => record.get(name),
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
            Self::Number(value) | Self::String(value) => Some(RenderedValue {
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
