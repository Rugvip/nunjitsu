const ABI_VERSION: u32 = 29;
const MEMORY_LAYOUT_VERSION: u32 = 4;
const PAGE_SIZE: usize = 65_536;
const MEMORY_PREFIX_ALIGNMENT: u32 = 64;
const SLOT_LENGTH: u32 = 72;
const SOURCE_CODE_UNIT_LENGTH: u32 = 2;
const VALUE_CODE_UNIT_LENGTH: u32 = 2;
const MEMBER_LENGTH: u32 = 4;
const STRING_OPERATION_LENGTH: u32 = 32;
const STRING_QUERY_LENGTH: u32 = 32;
const OUTPUT_RANGE_LENGTH: u32 = 16;

const POOL_SLOTS: u32 = 1;
const POOL_SOURCES: u32 = 2;
const POOL_VALUES: u32 = 3;
const POOL_MEMBERS: u32 = 4;
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
const TAG_FILTER_BLOCK: u32 = 30;
const TAG_REGEX: u32 = 31;
const TAG_CYCLER: u32 = 32;
const TAG_JOINER: u32 = 33;
const TAG_LOAD_REQUEST: u32 = 34;
const TAG_EXPRESSION: u32 = 35;
const TAG_STRING_VALUE: u32 = 36;
const TAG_SAFE_STRING_VALUE: u32 = 37;

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn nunjitsu_random_index(upper_bound: u32) -> u32;
    fn nunjitsu_regex_replace(
        input_offset: u32,
        input_length: u32,
        regex_offset: u32,
        regex_length: u32,
        replacement_offset: u32,
        replacement_length: u32,
        output_offset: u32,
        output_capacity: u32,
    ) -> u32;
}

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

const RENDER_STATE_LENGTH: u32 = 172;
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
const STATE_CURRENT_FILTER_BLOCK: usize = 168;

const EXPRESSION_OUTPUT: u32 = 0;
const EXPRESSION_IF: u32 = 1;
const EXPRESSION_SET: u32 = 2;
const EXPRESSION_INCLUDE: u32 = 3;
const EXPRESSION_EXTENDS: u32 = 4;
const EXPRESSION_IMPORT: u32 = 5;
const EXPRESSION_SWITCH: u32 = 6;

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

const MACRO_DEFINITION_LENGTH: u32 = 40;
const MACRO_DEFINITION_PARENT: usize = 0;
const MACRO_DEFINITION_NAME: usize = 4;
const MACRO_DEFINITION_SOURCE: usize = 8;
const MACRO_DEFINITION_BODY_CURSOR: usize = 12;
const MACRO_DEFINITION_PARAMETERS: usize = 16;
const MACRO_DEFINITION_SCOPE: usize = 20;
const MACRO_DEFINITION_FRAME: usize = 24;
const MACRO_DEFINITION_SUPER: usize = 28;
const MACRO_DEFINITION_END_CURSOR: usize = 32;
const MACRO_DEFINITION_CANONICAL_NAME: usize = 36;

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

const FILTER_BLOCK_LENGTH: u32 = 12;
const FILTER_BLOCK_PARENT: usize = 0;
const FILTER_BLOCK_FRAME: usize = 4;
const FILTER_BLOCK_EXPRESSION: usize = 8;

const CYCLER_FIXED_LENGTH: u32 = 12;
const CYCLER_COUNT: usize = 0;
const CYCLER_NEXT_INDEX: usize = 4;
const CYCLER_CURRENT: usize = 8;

const JOINER_LENGTH: u32 = 8;
const JOINER_SEPARATOR: usize = 0;
const JOINER_USED: usize = 4;

const SCOPE_LENGTH: u32 = 12;
const SCOPE_PARENT: usize = 0;
const SCOPE_NAME: usize = 4;
const SCOPE_VALUE: usize = 8;
