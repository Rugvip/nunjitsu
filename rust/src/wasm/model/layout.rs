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
    pub fields: [u32; 15],
}

const _: () = assert!(size_of::<MemoryPrefix>() <= 256);
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

fn set_legacy_arena_cursor(value: u32) {
    unsafe {
        (*memory_prefix()).legacy_arena_cursor = value;
    }
}

fn reset_memory_cursors() {
    let prefix = memory_prefix();
    unsafe {
        (*prefix).active_render = 0;
        (*prefix).legacy_arena_cursor = nunjitsu_arena_base();
        (*prefix).render_epoch = (*prefix).render_epoch.wrapping_add(1);
        (*prefix).slots.cursor = 1;
        (*prefix).sources.cursor = 0;
        (*prefix).values.cursor = 0;
        (*prefix).members.cursor = 0;
        (*prefix).string_operations.cursor = 0;
        (*prefix).string_queries.cursor = 0;
        (*prefix).output_ranges.cursor = 0;
    }
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

    let prefix = memory_prefix();
    unsafe {
        (*prefix).layout_version = MEMORY_LAYOUT_VERSION;
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
