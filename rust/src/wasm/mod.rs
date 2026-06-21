use crate::expression::{
    Atom, BinaryOperator, Call, Comparison, Operand, Operation, has_top_level_comma, next_argument,
    next_binding, next_import_binding, next_lookup_segment, next_macro_argument,
    next_macro_parameter, next_operation, next_record_entry, parse_base, parse_call_block,
    parse_for_clause, parse_from_import_clause, parse_import_clause, parse_set_clause,
    parse_tag_call, parse_tag_name, split_binary_expression,
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

include!("constants.rs");
include!("runtime/abi.rs");
include!("runtime/templates.rs");
include!("runtime/macros.rs");
include!("runtime/loops.rs");
include!("runtime/tags.rs");
include!("evaluation/continuations.rs");
include!("filters/builtins.rs");
include!("filters/collections.rs");
include!("filters/text.rs");
include!("filters/json.rs");
include!("filters/web.rs");
include!("evaluation/expressions.rs");
include!("evaluation/output.rs");
include!("model/registry.rs");
include!("model/values.rs");
include!("model/arena.rs");
