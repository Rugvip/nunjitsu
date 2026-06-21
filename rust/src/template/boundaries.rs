/// Finds the next branch at the current conditional nesting depth.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_conditional_boundary<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    include_else: bool,
    options: ParseOptions,
) -> Result<ConditionalBoundary<'_, T>, RenderError> {
    let mut depth = 0usize;
    let mut loop_depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"if").is_some() {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if ascii_eq(directive, b"endif") {
                if depth == 0 {
                    return Ok(ConditionalBoundary::EndIf(next_cursor));
                }
                depth -= 1;
            } else if is_loop_start(directive) {
                loop_depth = loop_depth
                    .checked_add(1)
                    .ok_or(RenderError::OutputTooLarge)?;
            } else if is_loop_end(directive) && loop_depth != 0 {
                loop_depth -= 1;
            } else if include_else
                && depth == 0
                && loop_depth == 0
                && ascii_eq(directive, b"else")
            {
                return Ok(ConditionalBoundary::Else(next_cursor));
            } else if include_else
                && depth == 0
                && loop_depth == 0
                && let Some(expression) = directive_keyword(directive, b"elif")
                    .or_else(|| directive_keyword(directive, b"elseif"))
            {
                return Ok(ConditionalBoundary::ElseIf(expression, next_cursor));
            }
        } else if item == TemplateItem::End {
            return Err(RenderError::UnclosedBlockTag);
        }
        cursor = next_cursor;
    }
}

/// Finds the optional `else` and required `endfor` for one loop body.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_loop_boundaries<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<LoopBoundaries, RenderError> {
    let mut loop_depth = 0usize;
    let mut conditional_depth = 0usize;
    let mut else_cursor = None;
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if is_loop_start(directive) {
                loop_depth = loop_depth
                    .checked_add(1)
                    .ok_or(RenderError::OutputTooLarge)?;
            } else if is_loop_end(directive) {
                if loop_depth == 0 && conditional_depth == 0 {
                    return Ok(LoopBoundaries {
                        else_cursor,
                        end_cursor: next_cursor,
                    });
                }
                loop_depth = loop_depth.saturating_sub(1);
            } else if directive_keyword(directive, b"if").is_some() {
                conditional_depth = conditional_depth
                    .checked_add(1)
                    .ok_or(RenderError::OutputTooLarge)?;
            } else if ascii_eq(directive, b"endif") && conditional_depth != 0 {
                conditional_depth -= 1;
            } else if ascii_eq(directive, b"else")
                && loop_depth == 0
                && conditional_depth == 0
                && else_cursor.is_none()
            {
                else_cursor = Some(next_cursor);
            }
        } else if item == TemplateItem::End {
            return Err(RenderError::UnclosedBlockTag);
        }
        cursor = next_cursor;
    }
}

/// Finds the cursor immediately after the matching `endmacro` tag.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_macro_end<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<usize, RenderError> {
    let mut depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"macro").is_some() {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if ascii_eq(directive, b"endmacro") {
                if depth == 0 {
                    return Ok(next_cursor);
                }
                depth -= 1;
            }
        } else if item == TemplateItem::End {
            return Err(RenderError::UnclosedBlockTag);
        }
        cursor = next_cursor;
    }
}

/// Finds the cursor immediately after the matching `endblock` tag.
#[cfg(test)]
pub(crate) fn find_block_end<T: SourceCodeUnit>(
    source: &[T],
    cursor: usize,
    options: ParseOptions,
    expected_name: &[T],
) -> Result<usize, RenderError> {
    find_block_end_impl(source, cursor, options, BlockName::Units(expected_name))
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn find_block_end_utf8(
    source: &[u16],
    cursor: usize,
    options: ParseOptions,
    expected_name: &[u8],
) -> Result<usize, RenderError> {
    find_block_end_impl(source, cursor, options, BlockName::Utf8(expected_name))
}

#[derive(Clone, Copy)]
#[cfg(any(target_arch = "wasm32", test))]
enum BlockName<'a, T> {
    Units(&'a [T]),
    #[cfg(target_arch = "wasm32")]
    Utf8(&'a [u8]),
}

#[cfg(any(target_arch = "wasm32", test))]
fn find_block_end_impl<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    options: ParseOptions,
    expected_name: BlockName<'_, T>,
) -> Result<usize, RenderError> {
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if let Some(nested_name) = directive_keyword(directive, b"block") {
                cursor = find_block_end_impl(
                    source,
                    next_cursor,
                    options,
                    BlockName::Units(nested_name),
                )?;
                continue;
            }
            if is_endblock(directive) {
                let Some(actual_name) = directive_keyword(directive, b"endblock") else {
                    return Ok(next_cursor);
                };
                let matches = match expected_name {
                    BlockName::Units(expected) => actual_name == expected,
                    #[cfg(target_arch = "wasm32")]
                    BlockName::Utf8(expected) => T::slice_eq_utf8(actual_name, expected),
                };
                if !matches {
                    return Err(RenderError::UnsupportedTag);
                }
                return Ok(next_cursor);
            }
        } else if item == TemplateItem::End {
            return Err(RenderError::UnclosedBlockTag);
        }
        cursor = next_cursor;
    }
}

/// Finds the cursor immediately after the matching `endcall` tag.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_call_end<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<usize, RenderError> {
    let mut depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"call").is_some()
                || strip_ascii_prefix(directive, b"call")
                    .is_some_and(|remainder| {
                        remainder.first().copied() == Some(T::from_ascii(b'('))
                    })
            {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if ascii_eq(directive, b"endcall") {
                if depth == 0 {
                    return Ok(next_cursor);
                }
                depth -= 1;
            }
        } else if item == TemplateItem::End {
            return Err(RenderError::UnclosedBlockTag);
        }
        cursor = next_cursor;
    }
}

/// Reports whether a source contains an inheritance directive outside raw text.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn contains_extends<T: SourceCodeUnit>(
    source: &[T],
    options: ParseOptions,
) -> Result<bool, RenderError> {
    let mut cursor = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options_impl(source, cursor, options)?;
        match item {
            TemplateItem::Tag(directive) if directive_keyword(directive, b"extends").is_some() => {
                return Ok(true);
            }
            TemplateItem::End => return Ok(false),
            _ => cursor = next_cursor,
        }
    }
}

/// Reports whether a directive closes a block, with an optional repeated name.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn is_endblock<T: SourceCodeUnit>(directive: &[T]) -> bool {
    ascii_eq(directive, b"endblock") || directive_keyword(directive, b"endblock").is_some()
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_loop_start<T: SourceCodeUnit>(directive: &[T]) -> bool {
    directive_keyword(directive, b"for").is_some()
        || directive_keyword(directive, b"asyncEach").is_some()
        || directive_keyword(directive, b"asyncAll").is_some()
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_loop_end<T: SourceCodeUnit>(directive: &[T]) -> bool {
    ascii_eq(directive, b"endfor")
        || ascii_eq(directive, b"endeach")
        || ascii_eq(directive, b"endall")
}

/// Returns a non-empty directive remainder after an exact keyword and whitespace.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn directive_keyword<'a, T: SourceCodeUnit>(
    directive: &'a [T],
    keyword: &[u8],
) -> Option<&'a [T]> {
    strip_ascii_prefix(directive, keyword)
        .filter(|remainder| {
            remainder
                .first()
                .is_some_and(|unit| unit.is_ascii_whitespace())
        })
        .map(trim_ascii_whitespace)
        .filter(|remainder| !remainder.is_empty())
}
