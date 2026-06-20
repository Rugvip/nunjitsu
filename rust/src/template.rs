/// A failure detected while parsing or rendering a template.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    /// An interpolation was opened but not closed.
    UnclosedInterpolation,
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

/// Parses and renders the supported template subset into `output`.
///
/// The lookup callback receives the trimmed bytes inside `{{` and `}}` and
/// returns the corresponding UTF-8 value when one exists. The function returns
/// the number of initialized output bytes.
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

/// Computes the output size for the supported template subset.
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

fn visit_template<'a>(
    source: &[u8],
    autoescape: bool,
    lookup: &mut impl FnMut(&[u8]) -> Option<RenderedValue<'a>>,
    mut emit: impl FnMut(&[u8]) -> Result<(), RenderError>,
) -> Result<(), RenderError> {
    let mut cursor = 0;
    while let Some(open_relative) = find_pair(&source[cursor..], b'{', b'{') {
        let open = cursor + open_relative;
        emit(&source[cursor..open])?;

        let expression_start = open + 2;
        let Some(close_relative) = find_pair(&source[expression_start..], b'}', b'}') else {
            return Err(RenderError::UnclosedInterpolation);
        };
        let close = expression_start + close_relative;
        let name = trim_ascii_whitespace(&source[expression_start..close]);
        if let Some(value) = lookup(name) {
            if autoescape && !value.safe {
                emit_escaped(value.bytes, &mut emit)?;
            } else {
                emit(value.bytes)?;
            }
        }
        cursor = close + 2;
    }
    emit(&source[cursor..])?;
    Ok(())
}

fn emit_escaped(
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

fn find_pair(bytes: &[u8], first: u8, second: u8) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| window[0] == first && window[1] == second)
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
        assert_eq!(
            measure_template(source, false, |name| {
                (name == b"name").then_some(RenderedValue {
                    bytes: b"Nunjitsu",
                    safe: false,
                })
            }),
            Ok(written)
        );
    }

    #[test]
    fn rejects_unclosed_interpolations_and_short_output_buffers() {
        let mut output = [0; 4];

        assert_eq!(
            render_template(b"{{ value", false, |_| None, &mut output),
            Err(RenderError::UnclosedInterpolation),
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
}
