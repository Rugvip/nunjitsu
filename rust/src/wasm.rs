use crate::template::{RenderError, measure_template, render_template};
use core::arch::wasm32::{memory_grow, memory_size};
use core::mem::{align_of, size_of};
use core::ptr::{addr_of, addr_of_mut, read_unaligned, write_unaligned};
use core::slice;

const ABI_VERSION: u32 = 2;
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

const STATE_IDLE: u32 = 0;
const STATE_COMPLETE: u32 = 1;
const STATE_ERROR: u32 = 2;

const ERROR_NONE: u32 = 0;
const ERROR_INVALID_ARENA: u32 = 1;
const ERROR_INVALID_RECORD: u32 = 2;
const ERROR_UNCLOSED_INTERPOLATION: u32 = 3;
const ERROR_OUTPUT_TOO_LARGE: u32 = 4;

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
pub extern "C" fn nunjitsu_arena_reset() {
    unsafe {
        ARENA_CURSOR = nunjitsu_arena_base();
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
    match render(request_offset) {
        Ok((output_offset, output_length)) => {
            set_control(STATE_COMPLETE, output_offset, output_length, ERROR_NONE);
            STATE_COMPLETE
        }
        Err(error_code) => {
            set_control(STATE_ERROR, 0, 0, error_code);
            STATE_ERROR
        }
    }
}

fn render(request_offset: u32) -> Result<(u32, u32), u32> {
    let request = record_at(request_offset, TAG_REQUEST)?;
    if request.len() != 8 {
        return Err(ERROR_INVALID_RECORD);
    }
    let source_offset = read_u32(request, 0)?;
    let context_offset = read_u32(request, 4)?;
    let source = record_at(source_offset, TAG_SOURCE)?;
    let context = Context::new(record_at(context_offset, TAG_RECORD)?)?;

    let output_length =
        measure_template(source, |name| context.lookup(name)).map_err(render_error_code)?;
    let record_length = RECORD_HEADER_LENGTH
        .checked_add(output_length)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let output_offset = arena_alloc(record_length as u32, RECORD_ALIGNMENT)?;
    write_record_header(output_offset, TAG_OUTPUT, output_length as u32)?;
    let output_payload_offset = output_offset
        .checked_add(RECORD_HEADER_LENGTH as u32)
        .ok_or(ERROR_OUTPUT_TOO_LARGE)?;
    let output = mutable_memory(output_payload_offset, output_length as u32)?;
    let written =
        render_template(source, |name| context.lookup(name), output).map_err(render_error_code)?;

    Ok((output_offset, written as u32))
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

    fn lookup(&self, path: &[u8]) -> Option<&'static [u8]> {
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

    fn rendered(self) -> Option<&'static [u8]> {
        match self {
            Self::Undefined | Self::Null => Some(b""),
            Self::Boolean(false) => Some(b"false"),
            Self::Boolean(true) => Some(b"true"),
            Self::Number(value) | Self::String(value) => Some(value),
            Self::Array(_) | Self::Record(_) => Some(b""),
        }
    }
}

fn record_at(offset: u32, expected_tag: u32) -> Result<&'static [u8], u32> {
    let (tag, payload) = raw_record_at(offset)?;
    if tag != expected_tag {
        return Err(ERROR_INVALID_RECORD);
    }
    Ok(payload)
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
