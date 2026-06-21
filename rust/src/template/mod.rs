/// A failure detected while parsing or rendering a template.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    /// An interpolation was opened but not closed.
    UnclosedInterpolation,
    /// A block tag was opened but not closed.
    UnclosedBlockTag,
    /// A template comment was opened but not closed.
    UnclosedComment,
    /// A raw/verbatim region was opened but not closed.
    UnclosedRaw,
    /// A block tag is not implemented by the current evaluator.
    UnsupportedTag,
    /// An include tag did not contain a target expression.
    InvalidInclude,
    /// The rendered output length exceeded the addressable range.
    OutputTooLarge,
    /// The output buffer did not have the measured capacity.
    OutputBufferTooSmall,
}

/// A value resolved from the template context for interpolation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RenderedValue<'a> {
    /// UTF-8 bytes used for string coercion.
    pub bytes: &'a [u8],
    /// Whether the value explicitly bypasses autoescaping.
    pub safe: bool,
}

/// Whitespace behavior fixed for one template environment.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ParseOptions {
    /// Removes one LF or CRLF immediately after block tags.
    pub trim_blocks: bool,
    /// Removes indentation before block tags that begin on an otherwise blank line.
    pub lstrip_blocks: bool,
}

/// One parser event consumed by the streaming evaluator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TemplateItem<'a, T = u8> {
    /// Literal template source copied directly to output.
    Text(&'a [T]),
    /// A context expression between interpolation delimiters.
    Expression(&'a [T]),
    /// A template-name expression requested by an include tag.
    Include {
        /// Expression resolving to the requested template name.
        expression: &'a [T],
        /// Whether an absent template should produce no output.
        ignore_missing: bool,
    },
    /// A non-built-in block directive resolved against declarative tag schemas.
    Tag(&'a [T]),
    /// The parser reached the end of this source.
    End,
}

/// A branch boundary found while skipping an inactive conditional body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) enum ConditionalBoundary<'a, T = u8> {
    /// An unconditional else body begins after this cursor.
    Else(usize),
    /// An else-if condition and the cursor after its directive.
    ElseIf(&'a [T], usize),
    /// The conditional ends after this cursor.
    EndIf(usize),
}

/// Body boundaries for one `for` directive at the current nesting depth.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) struct LoopBoundaries {
    /// Cursor immediately after the optional loop `else` directive.
    pub else_cursor: Option<usize>,
    /// Cursor immediately after the matching `endfor` directive.
    pub end_cursor: usize,
}

/// Returns the next streaming parser event and its following source cursor.
pub fn next_item(source: &[u8], cursor: usize) -> Result<(TemplateItem<'_>, usize), RenderError> {
    next_item_with_options(source, cursor, ParseOptions::default())
}

/// Returns the next parser event using environment-level whitespace behavior.
pub fn next_item_with_options(
    source: &[u8],
    cursor: usize,
    options: ParseOptions,
) -> Result<(TemplateItem<'_>, usize), RenderError> {
    next_item_with_options_impl(source, cursor, options)
}

#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn next_item_utf16(
    source: &[u16],
    cursor: usize,
    options: ParseOptions,
) -> Result<(TemplateItem<'_, u16>, usize), RenderError> {
    next_item_with_options_impl(source, cursor, options)
}

fn next_item_with_options_impl<T: SourceCodeUnit>(
    source: &[T],
    cursor: usize,
    options: ParseOptions,
) -> Result<(TemplateItem<'_, T>, usize), RenderError> {
    if cursor >= source.len() {
        return Ok((TemplateItem::End, source.len()));
    }
    let Some((open, delimiter)) = find_next_tag(source, cursor) else {
        return Ok((TemplateItem::Text(&source[cursor..]), source.len()));
    };
    if open > cursor {
        let mut text_end = open;
        if source.get(open + 2).copied() == Some(T::from_ascii(b'-')) {
            while text_end > cursor && source[text_end - 1].is_ascii_whitespace() {
                text_end -= 1;
            }
        } else if options.lstrip_blocks && delimiter == Delimiter::Block {
            let line_start = source[..open]
                .iter()
                .rposition(|unit| *unit == T::from_ascii(b'\n'))
                .map_or(0, |index| index + 1);
            if line_start >= cursor
                && source[line_start..open]
                    .iter()
                    .all(|unit| unit.is_ascii_whitespace())
            {
                text_end = line_start;
            }
        }
        return Ok((TemplateItem::Text(&source[cursor..text_end]), open));
    }

    let left_trim = source.get(open + 2).copied() == Some(T::from_ascii(b'-'));
    let content_start = open + 2 + usize::from(left_trim);
    match delimiter {
        Delimiter::Expression => {
            let close = find_pair(&source[content_start..], b'}', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedInterpolation)?;
            let right_trim = close > content_start && source[close - 1] == T::from_ascii(b'-');
            let content_end = close - usize::from(right_trim);
            Ok((
                TemplateItem::Expression(trim_ascii_whitespace(
                    &source[content_start..content_end],
                )),
                following_cursor(source, close + 2, right_trim, false),
            ))
        }
        Delimiter::Block => {
            let close = find_pair(&source[content_start..], b'%', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedBlockTag)?;
            let right_trim = close > content_start && source[close - 1] == T::from_ascii(b'-');
            let content_end = close - usize::from(right_trim);
            let next_cursor = following_cursor(source, close + 2, right_trim, options.trim_blocks);
            let directive = trim_ascii_whitespace(&source[content_start..content_end]);
            if ascii_eq(directive, b"raw") || ascii_eq(directive, b"verbatim") {
                let end_name = if ascii_eq(directive, b"raw") {
                    b"endraw".as_slice()
                } else {
                    b"endverbatim".as_slice()
                };
                let body_start = next_cursor;
                let (body_end, next_cursor) = find_raw_end(source, body_start, end_name, options)?;
                return Ok((
                    TemplateItem::Text(&source[body_start..body_end]),
                    next_cursor,
                ));
            }
            if ascii_eq(directive, b"include") {
                Err(RenderError::InvalidInclude)
            } else if let Some(include) =
                strip_ascii_prefix(directive, b"include").filter(|remainder| {
                    remainder
                        .first()
                        .is_some_and(|unit| unit.is_ascii_whitespace())
                })
            {
                let (expression, ignore_missing) = parse_include(include)?;
                Ok((
                    TemplateItem::Include {
                        expression,
                        ignore_missing,
                    },
                    next_cursor,
                ))
            } else {
                Ok((TemplateItem::Tag(directive), next_cursor))
            }
        }
        Delimiter::Comment => {
            let close = find_pair(&source[content_start..], b'#', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedComment)?;
            let right_trim = close > content_start && source[close - 1] == T::from_ascii(b'-');
            Ok((
                TemplateItem::Text(&source[content_start..content_start]),
                following_cursor(source, close + 2, right_trim, false),
            ))
        }
    }
}

include!("boundaries.rs");
include!("render.rs");
include!("syntax.rs");
include!("tests.rs");
