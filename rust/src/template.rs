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
pub enum TemplateItem<'a> {
    /// Literal template source copied directly to output.
    Text(&'a [u8]),
    /// A context expression between interpolation delimiters.
    Expression(&'a [u8]),
    /// A template-name expression requested by an include tag.
    Include {
        /// Expression resolving to the requested template name.
        expression: &'a [u8],
        /// Whether an absent template should produce no output.
        ignore_missing: bool,
    },
    /// A non-built-in block directive resolved against declarative tag schemas.
    Tag(&'a [u8]),
    /// The parser reached the end of this source.
    End,
}

/// A branch boundary found while skipping an inactive conditional body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) enum ConditionalBoundary<'a> {
    /// An unconditional else body begins after this cursor.
    Else(usize),
    /// An else-if condition and the cursor after its directive.
    ElseIf(&'a [u8], usize),
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
    if cursor >= source.len() {
        return Ok((TemplateItem::End, source.len()));
    }
    let Some((open, delimiter)) = find_next_tag(source, cursor) else {
        return Ok((TemplateItem::Text(&source[cursor..]), source.len()));
    };
    if open > cursor {
        let mut text_end = open;
        if source.get(open + 2) == Some(&b'-') {
            while text_end > cursor && source[text_end - 1].is_ascii_whitespace() {
                text_end -= 1;
            }
        } else if options.lstrip_blocks && delimiter == Delimiter::Block {
            let line_start = source[..open]
                .iter()
                .rposition(|byte| *byte == b'\n')
                .map_or(0, |index| index + 1);
            if line_start >= cursor && source[line_start..open].iter().all(u8::is_ascii_whitespace)
            {
                text_end = line_start;
            }
        }
        return Ok((TemplateItem::Text(&source[cursor..text_end]), open));
    }

    let left_trim = source.get(open + 2) == Some(&b'-');
    let content_start = open + 2 + usize::from(left_trim);
    match delimiter {
        Delimiter::Expression => {
            let close = find_pair(&source[content_start..], b'}', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedInterpolation)?;
            let right_trim = close > content_start && source[close - 1] == b'-';
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
            let right_trim = close > content_start && source[close - 1] == b'-';
            let content_end = close - usize::from(right_trim);
            let next_cursor = following_cursor(source, close + 2, right_trim, options.trim_blocks);
            let directive = trim_ascii_whitespace(&source[content_start..content_end]);
            if matches!(directive, b"raw" | b"verbatim") {
                let end_name = if directive == b"raw" {
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
            if directive == b"include" {
                Err(RenderError::InvalidInclude)
            } else if let Some(include) = directive
                .strip_prefix(b"include")
                .filter(|remainder| remainder.first().is_some_and(u8::is_ascii_whitespace))
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
            let right_trim = close > content_start && source[close - 1] == b'-';
            Ok((
                TemplateItem::Text(b""),
                following_cursor(source, close + 2, right_trim, false),
            ))
        }
    }
}

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
            } else if directive_keyword(directive, b"for").is_some() {
                loop_depth = loop_depth
                    .checked_add(1)
                    .ok_or(RenderError::OutputTooLarge)?;
            } else if directive == b"endfor" && loop_depth != 0 {
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
            if directive_keyword(directive, b"for").is_some() {
                loop_depth = loop_depth
                    .checked_add(1)
                    .ok_or(RenderError::OutputTooLarge)?;
            } else if directive == b"endfor" {
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
) -> Result<usize, RenderError> {
    let mut depth = 0usize;
    loop {
        let (item, next_cursor) = next_item_with_options(source, cursor, options)?;
        if let TemplateItem::Tag(directive) = item {
            if directive_keyword(directive, b"block").is_some() {
                depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
            } else if is_endblock(directive) {
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

/// Returns a non-empty directive remainder after an exact keyword and whitespace.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn directive_keyword<'a>(directive: &'a [u8], keyword: &[u8]) -> Option<&'a [u8]> {
    directive
        .strip_prefix(keyword)
        .filter(|remainder| remainder.first().is_some_and(u8::is_ascii_whitespace))
        .map(trim_ascii_whitespace)
        .filter(|remainder| !remainder.is_empty())
}

/// Parses and renders templates that do not require asynchronous host work.
pub fn render_template<'a>(
    source: &[u8],
    autoescape: bool,
    mut lookup: impl FnMut(&[u8]) -> Option<RenderedValue<'a>>,
    output: &mut [u8],
) -> Result<usize, RenderError> {
    let expected_length = measure_template(source, autoescape, &mut lookup)?;
    if output.len() < expected_length {
        return Err(RenderError::OutputBufferTooSmall);
    }

    let mut output_cursor = 0usize;
    visit_template(source, autoescape, &mut lookup, |segment| {
        let end = output_cursor
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        output[output_cursor..end].copy_from_slice(segment);
        output_cursor = end;
        Ok(())
    })?;
    Ok(output_cursor)
}

/// Computes the output size for templates that do not require host work.
pub fn measure_template<'a>(
    source: &[u8],
    autoescape: bool,
    mut lookup: impl FnMut(&[u8]) -> Option<RenderedValue<'a>>,
) -> Result<usize, RenderError> {
    let mut output_length = 0usize;
    visit_template(source, autoescape, &mut lookup, |segment| {
        output_length = output_length
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        Ok(())
    })?;
    Ok(output_length)
}

/// Emits an HTML-escaped value without allocating an intermediate string.
pub fn emit_escaped(
    value: &[u8],
    emit: &mut impl FnMut(&[u8]) -> Result<(), RenderError>,
) -> Result<(), RenderError> {
    let mut cursor = 0;
    for (index, byte) in value.iter().enumerate() {
        let replacement = match byte {
            b'&' => b"&amp;".as_slice(),
            b'"' => b"&quot;".as_slice(),
            b'\'' => b"&#39;".as_slice(),
            b'<' => b"&lt;".as_slice(),
            b'>' => b"&gt;".as_slice(),
            b'\\' => b"&#92;".as_slice(),
            _ => continue,
        };
        emit(&value[cursor..index])?;
        emit(replacement)?;
        cursor = index + 1;
    }
    emit(&value[cursor..])
}

fn visit_template<'a>(
    source: &[u8],
    autoescape: bool,
    lookup: &mut impl FnMut(&[u8]) -> Option<RenderedValue<'a>>,
    mut emit: impl FnMut(&[u8]) -> Result<(), RenderError>,
) -> Result<(), RenderError> {
    let mut cursor = 0;
    loop {
        let (item, next_cursor) = next_item(source, cursor)?;
        cursor = next_cursor;
        match item {
            TemplateItem::Text(text) => emit(text)?,
            TemplateItem::Expression(expression) => {
                if let Some(value) = lookup(expression) {
                    if autoescape && !value.safe {
                        emit_escaped(value.bytes, &mut emit)?;
                    } else {
                        emit(value.bytes)?;
                    }
                }
            }
            TemplateItem::Include { .. } => return Err(RenderError::UnsupportedTag),
            TemplateItem::Tag(_) => return Err(RenderError::UnsupportedTag),
            TemplateItem::End => return Ok(()),
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Delimiter {
    Expression,
    Block,
    Comment,
}

fn find_next_tag(source: &[u8], cursor: usize) -> Option<(usize, Delimiter)> {
    source[cursor..]
        .windows(2)
        .enumerate()
        .find_map(|(relative, window)| match window {
            b"{{" => Some((cursor + relative, Delimiter::Expression)),
            b"{%" => Some((cursor + relative, Delimiter::Block)),
            b"{#" => Some((cursor + relative, Delimiter::Comment)),
            _ => None,
        })
}

fn find_raw_end(
    source: &[u8],
    body_start: usize,
    end_name: &[u8],
    options: ParseOptions,
) -> Result<(usize, usize), RenderError> {
    let mut search_cursor = body_start;
    loop {
        let Some(relative) = source[search_cursor..]
            .windows(2)
            .position(|window| window == b"{%")
        else {
            return Err(RenderError::UnclosedRaw);
        };
        let open = search_cursor + relative;
        let left_trim = source.get(open + 2) == Some(&b'-');
        let content_start = open + 2 + usize::from(left_trim);
        let close = find_pair(&source[content_start..], b'%', b'}')
            .map(|relative| content_start + relative)
            .ok_or(RenderError::UnclosedRaw)?;
        let right_trim = close > content_start && source[close - 1] == b'-';
        let content_end = close - usize::from(right_trim);
        if trim_ascii_whitespace(&source[content_start..content_end]) == end_name {
            let mut body_end = open;
            if left_trim {
                while body_end > body_start && source[body_end - 1].is_ascii_whitespace() {
                    body_end -= 1;
                }
            } else if options.lstrip_blocks {
                let line_start = source[..open]
                    .iter()
                    .rposition(|byte| *byte == b'\n')
                    .map_or(0, |index| index + 1);
                if line_start >= body_start
                    && source[line_start..open].iter().all(u8::is_ascii_whitespace)
                {
                    body_end = line_start;
                }
            }
            return Ok((
                body_end,
                following_cursor(source, close + 2, right_trim, options.trim_blocks),
            ));
        }
        search_cursor = close + 2;
    }
}

fn following_cursor(
    source: &[u8],
    mut cursor: usize,
    explicit_trim: bool,
    trim_block: bool,
) -> usize {
    if explicit_trim {
        while source.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
    } else if trim_block {
        if source.get(cursor) == Some(&b'\n') {
            cursor += 1;
        } else if source.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        }
    }
    cursor
}

fn find_pair(bytes: &[u8], first: u8, second: u8) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| window[0] == first && window[1] == second)
}

fn parse_include(source: &[u8]) -> Result<(&[u8], bool), RenderError> {
    let source = trim_ascii_whitespace(source);
    if source.is_empty() {
        return Err(RenderError::InvalidInclude);
    }
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    let mut previous = None;
    let mut last = None;
    while let Some(byte) = source.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(RenderError::InvalidInclude)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            b'(' => parentheses += 1,
            b'[' => brackets += 1,
            b'{' => braces += 1,
            b')' => {
                parentheses = parentheses
                    .checked_sub(1)
                    .ok_or(RenderError::InvalidInclude)?;
            }
            b']' => {
                brackets = brackets.checked_sub(1).ok_or(RenderError::InvalidInclude)?;
            }
            b'}' => {
                braces = braces.checked_sub(1).ok_or(RenderError::InvalidInclude)?;
            }
            _ => {}
        }
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && (byte.is_ascii_alphabetic() || byte == b'_')
        {
            let start = cursor;
            cursor += 1;
            while source
                .get(cursor)
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            {
                cursor += 1;
            }
            previous = last;
            last = Some((start, cursor));
            continue;
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(RenderError::InvalidInclude);
    }
    let Some((ignore_start, ignore_end)) = previous else {
        return Ok((source, false));
    };
    let Some((missing_start, missing_end)) = last else {
        return Ok((source, false));
    };
    if &source[ignore_start..ignore_end] == b"ignore"
        && &source[missing_start..missing_end] == b"missing"
        && source[ignore_end..missing_start]
            .iter()
            .all(u8::is_ascii_whitespace)
        && missing_end == source.len()
    {
        let expression = trim_ascii_whitespace(&source[..ignore_start]);
        if expression.is_empty() {
            return Err(RenderError::InvalidInclude);
        }
        Ok((expression, true))
    } else {
        Ok((source, false))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_text_expressions_and_literal_includes() {
        let source = b"before {{ name }} {% include 'partial.njk' %} after";
        let mut cursor = 0;
        let expected = [
            TemplateItem::Text(b"before "),
            TemplateItem::Expression(b"name"),
            TemplateItem::Text(b" "),
            TemplateItem::Include {
                expression: b"'partial.njk'",
                ignore_missing: false,
            },
            TemplateItem::Text(b" after"),
            TemplateItem::End,
        ];
        for expected_item in expected {
            let (item, next_cursor) = next_item(source, cursor).unwrap();
            assert_eq!(item, expected_item);
            cursor = next_cursor;
        }

        assert_eq!(
            next_item(b"{% include target ignore missing %}", 0),
            Ok((
                TemplateItem::Include {
                    expression: b"target",
                    ignore_missing: true,
                },
                35,
            )),
        );
        assert_eq!(
            next_item(b"{% include 'ignore missing' %}", 0),
            Ok((
                TemplateItem::Include {
                    expression: b"'ignore missing'",
                    ignore_missing: false,
                },
                30,
            )),
        );
    }

    #[test]
    fn renders_static_text_and_interpolations() {
        let source = b"Hello {{ name }}! {{ missing }}";
        let mut output = vec![0; 64];
        let written = render_template(
            source,
            false,
            |name| {
                (name == b"name").then_some(RenderedValue {
                    bytes: b"Nunjitsu",
                    safe: false,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"Hello Nunjitsu! ");
    }

    #[test]
    fn rejects_invalid_tags_and_short_output_buffers() {
        let mut output = [0; 4];
        assert_eq!(
            render_template(b"{{ value", false, |_| None, &mut output),
            Err(RenderError::UnclosedInterpolation),
        );
        assert_eq!(
            render_template(b"{% include value %}", false, |_| None, &mut output),
            Err(RenderError::UnsupportedTag),
        );
        assert_eq!(
            render_template(b"{% include  %}", false, |_| None, &mut output),
            Err(RenderError::InvalidInclude),
        );
        assert_eq!(
            render_template(b"hello", false, |_| None, &mut output),
            Err(RenderError::OutputBufferTooSmall),
        );
        assert_eq!(
            render_template(b"{# unclosed", false, |_| None, &mut output),
            Err(RenderError::UnclosedComment),
        );
        assert_eq!(
            render_template(b"{% raw %}unclosed", false, |_| None, &mut output),
            Err(RenderError::UnclosedRaw),
        );
    }

    #[test]
    fn autoescapes_values_unless_they_are_safe() {
        let mut output = [0; 128];
        let source = b"<p>{{ value }}</p>";
        let written = render_template(
            source,
            true,
            |_| {
                Some(RenderedValue {
                    bytes: b"<&\"'>",
                    safe: false,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"<p>&lt;&amp;&quot;&#39;&gt;</p>");

        let written = render_template(
            source,
            true,
            |_| {
                Some(RenderedValue {
                    bytes: b"<strong>safe</strong>",
                    safe: true,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"<p><strong>safe</strong></p>");
    }

    #[test]
    fn finds_nested_conditional_branches() {
        let source = b"false {% if nested %}nested{% else %}other{% endif %}{% elif second %}second{% else %}last{% endif %}";
        assert_eq!(
            find_conditional_boundary(source, 0, true, ParseOptions::default()),
            Ok(ConditionalBoundary::ElseIf(b"second", 70)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, true, ParseOptions::default()),
            Ok(ConditionalBoundary::Else(86)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, false, ParseOptions::default()),
            Ok(ConditionalBoundary::EndIf(source.len())),
        );

        let loop_source =
            b"item{% if condition %}yes{% else %}no{% endif %}{% else %}empty{% endfor %}";
        assert_eq!(
            find_loop_boundaries(loop_source, 0, ParseOptions::default()),
            Ok(LoopBoundaries {
                else_cursor: Some(58),
                end_cursor: loop_source.len(),
            }),
        );

        let macro_source = b"body{% macro nested() %}nested{% endmacro %}tail{% endmacro %}after";
        assert_eq!(
            find_macro_end(macro_source, 0, ParseOptions::default()),
            Ok(62),
        );

        let block_source = b"body{% block nested %}nested{% endblock %}tail{% endblock %}after";
        assert_eq!(
            find_block_end(block_source, 0, ParseOptions::default()),
            Ok(60),
        );

        let call_source = b"body{% call wrap() %}nested{% endcall %}tail{% endcall %}after";
        assert_eq!(
            find_call_end(call_source, 0, ParseOptions::default()),
            Ok(57),
        );
        assert_eq!(
            contains_extends(
                b"before{% if enabled %}{% extends parent %}{% endif %}",
                ParseOptions::default(),
            ),
            Ok(true),
        );
        assert_eq!(
            contains_extends(
                b"{% raw %}{% extends hidden %}{% endraw %}",
                ParseOptions::default(),
            ),
            Ok(false),
        );
    }

    #[test]
    fn omits_comments_and_preserves_raw_template_syntax() {
        let source = b"before{# {{ hidden }} #}{% raw %}{{ visible syntax }}{% endraw %}after";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"before{{ visible syntax }}after");

        let source = b"hello \n{#- comment -#} \n world";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"helloworld");

        let source = b"test\n {% raw %}\n  foo\n {% endraw %}\n</div>";
        let options = ParseOptions {
            trim_blocks: true,
            lstrip_blocks: true,
        };
        let mut cursor = 0;
        let mut items = Vec::new();
        loop {
            let (item, next) = next_item_with_options(source, cursor, options).unwrap();
            cursor = next;
            items.push(item);
            if item == TemplateItem::End {
                break;
            }
        }
        assert_eq!(
            items,
            [
                TemplateItem::Text(b"test\n"),
                TemplateItem::Text(b"  foo\n"),
                TemplateItem::Text(b"</div>"),
                TemplateItem::End,
            ],
        );
    }
}
