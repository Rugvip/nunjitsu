/// Finds the next branch at the current conditional nesting depth.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_conditional_boundary(
    source: &[u8],
    mut cursor: usize,
    include_else: bool,
    options: ParseOptions,
) -> Result<ConditionalBoundary<'_>, RenderError> {
    let mut depth = 0usize;
    let mut loop_depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"if").is_some() {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if directive == b"endif" {
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
            } else if include_else && depth == 0 && loop_depth == 0 && directive == b"else" {
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
pub(crate) fn find_loop_boundaries(
    source: &[u8],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<LoopBoundaries, RenderError> {
    let mut loop_depth = 0usize;
    let mut conditional_depth = 0usize;
    let mut else_cursor = None;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
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
            } else if directive == b"endif" && conditional_depth != 0 {
                conditional_depth -= 1;
            } else if directive == b"else"
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
pub(crate) fn find_macro_end(
    source: &[u8],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<usize, RenderError> {
    let mut depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"macro").is_some() {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if directive == b"endmacro" {
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
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_block_end(
    source: &[u8],
    mut cursor: usize,
    options: ParseOptions,
    expected_name: &[u8],
) -> Result<usize, RenderError> {
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if let Some(nested_name) = directive_keyword(directive, b"block") {
                cursor = find_block_end(source, next_cursor, options, nested_name)?;
                continue;
            }
            if is_endblock(directive) {
                let Some(actual_name) = directive_keyword(directive, b"endblock") else {
                    return Ok(next_cursor);
                };
                if actual_name != expected_name {
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
pub(crate) fn find_call_end(
    source: &[u8],
    mut cursor: usize,
    options: ParseOptions,
) -> Result<usize, RenderError> {
    let mut depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"call").is_some()
                || directive
                    .strip_prefix(b"call")
                    .is_some_and(|remainder| remainder.first() == Some(&b'('))
            {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if directive == b"endcall" {
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
pub(crate) fn contains_extends(source: &[u8], options: ParseOptions) -> Result<bool, RenderError> {
    let mut cursor = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
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
pub(crate) fn is_endblock(directive: &[u8]) -> bool {
    directive == b"endblock" || directive_keyword(directive, b"endblock").is_some()
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_loop_start(directive: &[u8]) -> bool {
    directive_keyword(directive, b"for").is_some()
        || directive_keyword(directive, b"asyncEach").is_some()
        || directive_keyword(directive, b"asyncAll").is_some()
}

#[cfg(any(target_arch = "wasm32", test))]
fn is_loop_end(directive: &[u8]) -> bool {
    matches!(directive, b"endfor" | b"endeach" | b"endall")
}

/// Returns a non-empty directive remainder after an exact keyword and whitespace.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn directive_keyword<'a>(directive: &'a [u8], keyword: &[u8]) -> Option<&'a [u8]> {
    directive
        .strip_prefix(keyword)
        .filter(|remainder| remainder.first().is_some_and(u8::is_ascii_whitespace))
        .map(trim_ascii_whitespace)
        .filter(|remainder| !remainder.is_empty())
}
