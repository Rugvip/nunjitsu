#[repr(C)]
struct Control {
    state: u32,
    payload_offset: u32,
    payload_length: u32,
    error_code: u32,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct PoolState {
    offset: u32,
    capacity: u32,
    cursor: u32,
}

#[repr(C)]
struct RenderState {
    fields: [u32; RENDER_STATE_LENGTH as usize / size_of::<u32>()],
}

impl PoolState {
    const EMPTY: Self = Self {
        offset: 0,
        capacity: 0,
        cursor: 0,
    };
}

#[repr(C, align(64))]
struct MemoryPrefix {
    control: Control,
    active_render: u32,
    legacy_arena_cursor: u32,
    render_epoch: u32,
    layout_version: u32,
    legacy_arena_base: u32,
    reserved: u32,
    render_state: RenderState,
    slots: PoolState,
    sources: PoolState,
    values: PoolState,
    members: PoolState,
    string_operations: PoolState,
    string_queries: PoolState,
    output_ranges: PoolState,
}

impl MemoryPrefix {
    const EMPTY: Self = Self {
        control: Control {
            state: STATE_IDLE,
            payload_offset: 0,
            payload_length: 0,
            error_code: ERROR_NONE,
        },
        active_render: 0,
        legacy_arena_cursor: 0,
        render_epoch: 0,
        layout_version: 0,
        legacy_arena_base: 0,
        reserved: 0,
        render_state: RenderState {
            fields: [0; RENDER_STATE_LENGTH as usize / size_of::<u32>()],
        },
        slots: PoolState::EMPTY,
        sources: PoolState::EMPTY,
        values: PoolState::EMPTY,
        members: PoolState::EMPTY,
        string_operations: PoolState::EMPTY,
        string_queries: PoolState::EMPTY,
        output_ranges: PoolState::EMPTY,
    };
}

#[repr(C, align(8))]
pub struct Slot {
    pub header: u32,
    pub fields: [u32; 16],
}

const _: () = assert!(size_of::<MemoryPrefix>() <= 512);
const _: () = assert!(size_of::<Slot>() == SLOT_LENGTH as usize);

static mut MEMORY_PREFIX: MemoryPrefix = MemoryPrefix::EMPTY;

unsafe extern "C" {
    static __heap_base: u8;
}

fn memory_prefix() -> *mut MemoryPrefix {
    addr_of_mut!(MEMORY_PREFIX)
}

fn control_state() -> u32 {
    unsafe { (*memory_prefix()).control.state }
}

fn set_control_fields(state: u32, payload_offset: u32, payload_length: u32, error_code: u32) {
    let prefix = memory_prefix();
    unsafe {
        (*prefix).control.state = state;
        (*prefix).control.payload_offset = payload_offset;
        (*prefix).control.payload_length = payload_length;
        (*prefix).control.error_code = error_code;
    }
}

fn active_render() -> u32 {
    unsafe { (*memory_prefix()).active_render }
}

fn set_active_render(value: u32) {
    unsafe {
        (*memory_prefix()).active_render = value;
    }
}

fn legacy_arena_cursor() -> u32 {
    unsafe { (*memory_prefix()).legacy_arena_cursor }
}

fn legacy_arena_base() -> u32 {
    unsafe { (*memory_prefix()).legacy_arena_base }
}

fn set_legacy_arena_cursor(value: u32) {
    unsafe {
        (*memory_prefix()).legacy_arena_cursor = value;
    }
}

fn render_state_offset() -> u32 {
    let prefix = memory_prefix();
    unsafe { addr_of!((*prefix).render_state) as u32 }
}

fn render_state_bytes() -> &'static [u8] {
    unsafe {
        slice::from_raw_parts(
            render_state_offset() as *const u8,
            RENDER_STATE_LENGTH as usize,
        )
    }
}

fn mutable_render_state_bytes() -> &'static mut [u8] {
    unsafe {
        slice::from_raw_parts_mut(
            render_state_offset() as *mut u8,
            RENDER_STATE_LENGTH as usize,
        )
    }
}

fn clear_render_state() {
    mutable_render_state_bytes().fill(0);
}

fn reset_memory_cursors() {
    let prefix = memory_prefix();
    unsafe {
        (*prefix).active_render = 0;
        (*prefix).legacy_arena_cursor = (*prefix).legacy_arena_base;
        (*prefix).render_epoch = (*prefix).render_epoch.wrapping_add(1);
        (*prefix).slots.cursor = 1;
        (*prefix).sources.cursor = 0;
        (*prefix).values.cursor = 0;
        (*prefix).members.cursor = 0;
        (*prefix).string_operations.cursor = 0;
        (*prefix).string_queries.cursor = 0;
        (*prefix).output_ranges.cursor = 0;
    }
    clear_render_state();
}

fn configure_pool(cursor: &mut u32, capacity: u32, width: u32) -> Option<PoolState> {
    if capacity == 0 {
        return None;
    }
    *cursor = align_up(*cursor, MEMORY_PREFIX_ALIGNMENT)?;
    let offset = *cursor;
    *cursor = offset.checked_add(capacity.checked_mul(width)?)?;
    Some(PoolState {
        offset,
        capacity,
        cursor: 0,
    })
}

fn slot_payload_length(tag: u32) -> Option<u32> {
    match tag {
        TAG_SOURCE => Some(8),
        TAG_UNDEFINED | TAG_NULL => Some(0),
        TAG_BOOLEAN => Some(1),
        TAG_NUMBER => Some(8),
        TAG_FRAME => Some(FRAME_LENGTH),
        TAG_LOOP_STATE => Some(LOOP_STATE_LENGTH),
        TAG_SCOPE => Some(SCOPE_LENGTH),
        TAG_CAPTURE => Some(CAPTURE_LENGTH),
        TAG_MACRO_DEFINITION => Some(MACRO_DEFINITION_LENGTH),
        TAG_MACRO_CALL => Some(MACRO_CALL_LENGTH),
        TAG_BLOCK_DEFINITION => Some(BLOCK_DEFINITION_LENGTH),
        TAG_TAG_CALL => Some(TAG_CALL_LENGTH),
        TAG_TAG_ARGUMENTS => Some(TAG_ARGUMENTS_LENGTH),
        TAG_FILTER_BLOCK => Some(FILTER_BLOCK_LENGTH),
        TAG_JOINER => Some(JOINER_LENGTH),
        _ => None,
    }
}

fn member_backed_tag(tag: u32) -> bool {
    matches!(
        tag,
        TAG_ARRAY
            | TAG_RECORD
            | TAG_BINDINGS
            | TAG_MACRO_ARGUMENTS
            | TAG_TAG_BOUNDARIES
    )
}

fn slot_category_mask(tag: u32) -> u32 {
    match tag {
        TAG_SOURCE => 16,
        TAG_UNDEFINED
        | TAG_NULL
        | TAG_BOOLEAN
        | TAG_NUMBER
        | TAG_ARRAY
        | TAG_RECORD
        | TAG_JOINER => 1,
        TAG_FRAME | TAG_LOOP_STATE | TAG_CAPTURE | TAG_MACRO_CALL | TAG_TAG_CALL => 2,
        TAG_SCOPE | TAG_MACRO_DEFINITION | TAG_BLOCK_DEFINITION => 4,
        TAG_TAG_ARGUMENTS
        | TAG_FILTER_BLOCK
        | TAG_BINDINGS
        | TAG_MACRO_ARGUMENTS
        | TAG_TAG_BOUNDARIES => 8,
        _ => 0,
    }
}

fn source_at(index: u32) -> Result<&'static [u16], u32> {
    let (tag, payload) = slot_record(index)?.ok_or(ERROR_INVALID_RECORD)?;
    if tag != TAG_SOURCE || payload.len() != 8 {
        return Err(ERROR_INVALID_RECORD);
    }
    let start = read_u32(payload, 0)?;
    let length = read_u32(payload, 4)?;
    let pool = unsafe { (*memory_prefix()).sources };
    let end = start.checked_add(length).ok_or(ERROR_INVALID_RECORD)?;
    if end > pool.cursor {
        return Err(ERROR_INVALID_RECORD);
    }
    let offset = pool
        .offset
        .checked_add(
            start
                .checked_mul(SOURCE_CODE_UNIT_LENGTH)
                .ok_or(ERROR_INVALID_RECORD)?,
        )
        .ok_or(ERROR_INVALID_RECORD)?;
    let bytes = memory(
        offset,
        length
            .checked_mul(SOURCE_CODE_UNIT_LENGTH)
            .ok_or(ERROR_INVALID_RECORD)?,
    )?;
    Ok(unsafe { slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), length as usize) })
}

fn allocate_slot(tag: u32, payload_length: u32) -> Result<u32, u32> {
    let expected_length = slot_payload_length(tag).ok_or(ERROR_INVALID_RECORD)?;
    if payload_length != expected_length || tag > u8::MAX as u32 {
        return Err(ERROR_INVALID_RECORD);
    }
    let prefix = memory_prefix();
    let (pool, index) = unsafe { ((*prefix).slots, (*prefix).slots.cursor) };
    if index == 0 || index > pool.capacity {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    let offset = pool
        .offset
        .checked_add(index.checked_mul(SLOT_LENGTH).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let bytes = mutable_memory(offset, SLOT_LENGTH)?;
    bytes.fill(0);
    let header = tag | (slot_category_mask(tag) << 8);
    write_u32(bytes, 0, header)?;
    unsafe {
        (*prefix).slots.cursor = index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
    }
    Ok(index)
}

fn allocate_member_record(tag: u32, payload_length: u32) -> Result<u32, u32> {
    if !member_backed_tag(tag) || !payload_length.is_multiple_of(MEMBER_LENGTH) {
        return Err(ERROR_INVALID_RECORD);
    }
    let prefix = memory_prefix();
    let (slot_pool, slot_index, member_pool, member_start) = unsafe {
        (
            (*prefix).slots,
            (*prefix).slots.cursor,
            (*prefix).members,
            (*prefix).members.cursor,
        )
    };
    if slot_index == 0 || slot_index > slot_pool.capacity {
        return Err(ERROR_RESOURCE_LIMIT);
    }
    let member_count = payload_length / MEMBER_LENGTH;
    let member_end = member_start
        .checked_add(member_count)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    if member_end > member_pool.capacity {
        return Err(ERROR_RESOURCE_LIMIT);
    }

    let slot_offset = slot_pool
        .offset
        .checked_add(
            slot_index
                .checked_mul(SLOT_LENGTH)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let slot = mutable_memory(slot_offset, SLOT_LENGTH)?;
    slot.fill(0);
    write_u32(slot, 0, tag | (slot_category_mask(tag) << 8))?;
    write_u32(slot, 4, member_start)?;
    write_u32(slot, 8, payload_length)?;

    let member_offset = member_pool
        .offset
        .checked_add(
            member_start
                .checked_mul(MEMBER_LENGTH)
                .ok_or(ERROR_RESOURCE_LIMIT)?,
        )
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    mutable_memory(member_offset, payload_length)?.fill(0);
    unsafe {
        (*prefix).slots.cursor = slot_index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        (*prefix).members.cursor = member_end;
    }
    Ok(slot_index)
}

fn member_record(bytes: &[u8]) -> Result<&'static [u8], u32> {
    let prefix = memory_prefix();
    let pool = unsafe { (*prefix).members };
    let start = read_u32(bytes, 4)?;
    let length = read_u32(bytes, 8)?;
    let count = length
        .checked_div(MEMBER_LENGTH)
        .ok_or(ERROR_INVALID_RECORD)?;
    if !length.is_multiple_of(MEMBER_LENGTH)
        || start.checked_add(count).ok_or(ERROR_INVALID_RECORD)? > pool.cursor
    {
        return Err(ERROR_INVALID_RECORD);
    }
    let offset = pool
        .offset
        .checked_add(start.checked_mul(MEMBER_LENGTH).ok_or(ERROR_INVALID_RECORD)?)
        .ok_or(ERROR_INVALID_RECORD)?;
    memory(offset, length)
}

fn mutable_member_record(bytes: &[u8]) -> Result<&'static mut [u8], u32> {
    let prefix = memory_prefix();
    let pool = unsafe { (*prefix).members };
    let start = read_u32(bytes, 4)?;
    let length = read_u32(bytes, 8)?;
    let count = length
        .checked_div(MEMBER_LENGTH)
        .ok_or(ERROR_INVALID_RECORD)?;
    if !length.is_multiple_of(MEMBER_LENGTH)
        || start.checked_add(count).ok_or(ERROR_INVALID_RECORD)? > pool.cursor
    {
        return Err(ERROR_INVALID_RECORD);
    }
    let offset = pool
        .offset
        .checked_add(start.checked_mul(MEMBER_LENGTH).ok_or(ERROR_INVALID_RECORD)?)
        .ok_or(ERROR_INVALID_RECORD)?;
    mutable_memory(offset, length)
}

fn slot_record(index: u32) -> Result<Option<(u32, &'static [u8])>, u32> {
    let prefix = memory_prefix();
    let pool = unsafe { (*prefix).slots };
    if index == 0 || index >= pool.cursor {
        return Ok(None);
    }
    let offset = pool
        .offset
        .checked_add(index.checked_mul(SLOT_LENGTH).ok_or(ERROR_INVALID_RECORD)?)
        .ok_or(ERROR_INVALID_RECORD)?;
    let bytes = memory(offset, SLOT_LENGTH)?;
    let header = read_u32(bytes, 0)?;
    let tag = header & 0xff;
    if member_backed_tag(tag) {
        return Ok(Some((tag, member_record(bytes)?)));
    }
    let length = slot_payload_length(tag).ok_or(ERROR_INVALID_RECORD)? as usize;
    Ok(Some((tag, &bytes[4..4 + length])))
}

fn mutable_slot_record(index: u32, expected_tag: u32) -> Result<Option<&'static mut [u8]>, u32> {
    let prefix = memory_prefix();
    let pool = unsafe { (*prefix).slots };
    if index == 0 || index >= pool.cursor {
        return Ok(None);
    }
    let offset = pool
        .offset
        .checked_add(index.checked_mul(SLOT_LENGTH).ok_or(ERROR_INVALID_RECORD)?)
        .ok_or(ERROR_INVALID_RECORD)?;
    let bytes = mutable_memory(offset, SLOT_LENGTH)?;
    let tag = read_u32(bytes, 0)? & 0xff;
    if tag != expected_tag {
        return Err(ERROR_INVALID_RECORD);
    }
    if member_backed_tag(tag) {
        return Ok(Some(mutable_member_record(bytes)?));
    }
    let length = slot_payload_length(tag).ok_or(ERROR_INVALID_RECORD)? as usize;
    Ok(Some(&mut bytes[4..4 + length]))
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_layout_version() -> u32 {
    MEMORY_LAYOUT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_memory_prefix_offset() -> u32 {
    memory_prefix() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_slot_size() -> u32 {
    size_of::<Slot>() as u32
}

fn selected_pool(kind: u32) -> Option<PoolState> {
    let prefix = memory_prefix();
    unsafe {
        match kind {
            POOL_SLOTS => Some((*prefix).slots),
            POOL_SOURCES => Some((*prefix).sources),
            POOL_VALUES => Some((*prefix).values),
            POOL_MEMBERS => Some((*prefix).members),
            _ => None,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_pool_offset(kind: u32) -> u32 {
    selected_pool(kind).map_or(0, |pool| pool.offset)
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_pool_capacity(kind: u32) -> u32 {
    selected_pool(kind).map_or(0, |pool| pool.capacity)
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_pool_cursor(kind: u32) -> u32 {
    selected_pool(kind).map_or(0, |pool| pool.cursor)
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_accept_host_cursors(
    slots: u32,
    sources: u32,
    values: u32,
    members: u32,
) -> u32 {
    let prefix = memory_prefix();
    let current = unsafe {
        (
            (*prefix).slots,
            (*prefix).sources,
            (*prefix).values,
            (*prefix).members,
        )
    };
    if slots < current.0.cursor
        || slots > current.0.capacity.saturating_add(1)
        || sources < current.1.cursor
        || sources > current.1.capacity
        || values < current.2.cursor
        || values > current.2.capacity
        || members < current.3.cursor
        || members > current.3.capacity
    {
        return 0;
    }
    unsafe {
        (*prefix).slots.cursor = slots;
        (*prefix).sources.cursor = sources;
        (*prefix).values.cursor = values;
        (*prefix).members.cursor = members;
    }
    1
}

#[unsafe(no_mangle)]
pub extern "C" fn nunjitsu_configure_layout(
    slots: u32,
    source_code_units: u32,
    value_code_units: u32,
    members: u32,
    string_operations: u32,
    string_queries: u32,
    output_ranges: u32,
) -> u32 {
    let Some(slot_count) = slots.checked_add(1) else {
        return 0;
    };
    let Some(mut cursor) = align_up(
        addr_of!(__heap_base) as u32,
        MEMORY_PREFIX_ALIGNMENT,
    ) else {
        return 0;
    };
    let Some(slot_pool) = configure_pool(&mut cursor, slot_count, SLOT_LENGTH) else {
        return 0;
    };
    let Some(source_pool) = configure_pool(
        &mut cursor,
        source_code_units,
        SOURCE_CODE_UNIT_LENGTH,
    ) else {
        return 0;
    };
    let Some(value_pool) = configure_pool(
        &mut cursor,
        value_code_units,
        VALUE_CODE_UNIT_LENGTH,
    ) else {
        return 0;
    };
    let Some(member_pool) = configure_pool(&mut cursor, members, MEMBER_LENGTH) else {
        return 0;
    };
    let Some(operation_pool) = configure_pool(
        &mut cursor,
        string_operations,
        STRING_OPERATION_LENGTH,
    ) else {
        return 0;
    };
    let Some(query_pool) =
        configure_pool(&mut cursor, string_queries, STRING_QUERY_LENGTH)
    else {
        return 0;
    };
    let Some(output_pool) = configure_pool(&mut cursor, output_ranges, OUTPUT_RANGE_LENGTH) else {
        return 0;
    };
    if cursor as usize > linear_memory_length() {
        return 0;
    }
    let Some(legacy_arena_base) = align_up(cursor, RECORD_ALIGNMENT) else {
        return 0;
    };

    let prefix = memory_prefix();
    unsafe {
        (*prefix).layout_version = MEMORY_LAYOUT_VERSION;
        (*prefix).legacy_arena_base = legacy_arena_base;
        (*prefix).slots = slot_pool;
        (*prefix).slots.capacity = slots;
        (*prefix).sources = source_pool;
        (*prefix).values = value_pool;
        (*prefix).members = member_pool;
        (*prefix).string_operations = operation_pool;
        (*prefix).string_queries = query_pool;
        (*prefix).output_ranges = output_pool;
    }
    reset_memory_cursors();
    1
}
