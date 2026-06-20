/// A failure detected while parsing or rendering a template.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    /// An interpolation was opened but not closed.
    UnclosedInterpolation,
    /// A block tag was opened but not closed.
    UnclosedBlockTag,
    /// A block tag is not implemented by the current evaluator.
    UnsupportedTag,
    /// An include tag did not contain one quoted literal name.
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

/// One parser event consumed by the streaming evaluator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TemplateItem<'a> {
    /// Literal template source copied directly to output.
    Text(&'a [u8]),
    /// A context expression between interpolation delimiters.
    Expression(&'a [u8]),
    /// A literal template name requested by an include tag.
    Include(&'a [u8]),
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
    if cursor >= source.len() {
        return Ok((TemplateItem::End, source.len()));
    }
    let Some((open, delimiter)) = find_next_tag(source, cursor) else {
        return Ok((TemplateItem::Text(&source[cursor..]), source.len()));
    };
    if open > cursor {
        return Ok((TemplateItem::Text(&source[cursor..open]), open));
    }

    let content_start = open + 2;
    match delimiter {
        Delimiter::Expression => {
            let close = find_pair(&source[content_start..], b'}', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedInterpolation)?;
            Ok((
                TemplateItem::Expression(trim_ascii_whitespace(&source[content_start..close])),
                close + 2,
            ))
        }
        Delimiter::Block => {
            let close = find_pair(&source[content_start..], b'%', b'}')
                .map(|relative| content_start + relative)
                .ok_or(RenderError::UnclosedBlockTag)?;
            let directive = trim_ascii_whitespace(&source[content_start..close]);
            if let Some(include) = directive
                .strip_prefix(b"include")
                .filter(|remainder| remainder.first().is_some_and(u8::is_ascii_whitespace))
            {
                let name = parse_quoted_literal(trim_ascii_whitespace(include))?;
                Ok((TemplateItem::Include(name), close + 2))
            } else {
                Ok((TemplateItem::Tag(directive), close + 2))
            }
        }
    }
}

/// Finds the next branch at the current conditional nesting depth.
#[cfg(any(target_arch = "wasm32", test))]
pub(crate) fn find_conditional_boundary(
    source: &[u8],
    mut cursor: usize,
    include_else: bool,
) -> Result<ConditionalBoundary<'_>, RenderError> {
    let mut depth = 0usize;
    let mut loop_depth = 0usize;
    loop {
        let (item, next_cursor) = next_item(source, cursor)?;
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
) -> Result<LoopBoundaries, RenderError> {
    let mut loop_depth = 0usize;
    let mut conditional_depth = 0usize;
    let mut else_cursor = None;
    loop {
        let (item, next_cursor) = next_item(source, cursor)?;
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
            TemplateItem::Include(_) => return Err(RenderError::UnsupportedTag),
            TemplateItem::Tag(_) => return Err(RenderError::UnsupportedTag),
            TemplateItem::End => return Ok(()),
        }
    }
}

#[derive(Clone, Copy)]
enum Delimiter {
    Expression,
    Block,
}

fn find_next_tag(source: &[u8], cursor: usize) -> Option<(usize, Delimiter)> {
    source[cursor..]
        .windows(2)
        .enumerate()
        .find_map(|(relative, window)| match window {
            b"{{" => Some((cursor + relative, Delimiter::Expression)),
            b"{%" => Some((cursor + relative, Delimiter::Block)),
            _ => None,
        })
}

fn find_pair(bytes: &[u8], first: u8, second: u8) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| window[0] == first && window[1] == second)
}

fn parse_quoted_literal(bytes: &[u8]) -> Result<&[u8], RenderError> {
    if bytes.len() < 2 {
        return Err(RenderError::InvalidInclude);
    }
    let quote = bytes[0];
    if !matches!(quote, b'\'' | b'"') || bytes[bytes.len() - 1] != quote {
        return Err(RenderError::InvalidInclude);
    }
    let value = &bytes[1..bytes.len() - 1];
    if value.is_empty() || value.contains(&quote) {
        return Err(RenderError::InvalidInclude);
    }
    Ok(value)
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
            TemplateItem::Include(b"partial.njk"),
            TemplateItem::Text(b" after"),
            TemplateItem::End,
        ];
        for expected_item in expected {
            let (item, next_cursor) = next_item(source, cursor).unwrap();
            assert_eq!(item, expected_item);
            cursor = next_cursor;
        }
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
            Err(RenderError::InvalidInclude),
        );
        assert_eq!(
            render_template(b"hello", false, |_| None, &mut output),
            Err(RenderError::OutputBufferTooSmall),
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
            find_conditional_boundary(source, 0, true),
            Ok(ConditionalBoundary::ElseIf(b"second", 70)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, true),
            Ok(ConditionalBoundary::Else(86)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, false),
            Ok(ConditionalBoundary::EndIf(source.len())),
        );

        let loop_source =
            b"item{% if condition %}yes{% else %}no{% endif %}{% else %}empty{% endfor %}";
        assert_eq!(
            find_loop_boundaries(loop_source, 0),
            Ok(LoopBoundaries {
                else_cursor: Some(58),
                end_cursor: loop_source.len(),
            }),
        );
    }
}
