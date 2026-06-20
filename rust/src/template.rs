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

/// Parses and renders the supported template subset into `output`.
///
/// The lookup callback receives the trimmed bytes inside `{{` and `}}` and
/// returns the corresponding UTF-8 value when one exists. The function returns
/// the number of initialized output bytes.
pub fn render_template<'a>(
    source: &[u8],
    mut lookup: impl FnMut(&[u8]) -> Option<&'a [u8]>,
    output: &mut [u8],
) -> Result<usize, RenderError> {
    let expected_length = measure_template(source, &mut lookup)?;
    if output.len() < expected_length {
        return Err(RenderError::OutputBufferTooSmall);
    }

    let mut output_cursor = 0usize;
    visit_template(source, &mut lookup, |segment| {
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
    mut lookup: impl FnMut(&[u8]) -> Option<&'a [u8]>,
) -> Result<usize, RenderError> {
    let mut output_length = 0usize;
    visit_template(source, &mut lookup, |segment| {
        output_length = output_length
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        Ok(())
    })?;
    Ok(output_length)
}

fn visit_template<'a>(
    source: &[u8],
    lookup: &mut impl FnMut(&[u8]) -> Option<&'a [u8]>,
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
            emit(value)?;
        }
        cursor = close + 2;
    }
    emit(&source[cursor..])?;
    Ok(())
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
            |name| (name == b"name").then_some(b"Nunjitsu".as_slice()),
            &mut output,
        )
        .unwrap();

        assert_eq!(&output[..written], b"Hello Nunjitsu! ");
        assert_eq!(
            measure_template(source, |name| {
                (name == b"name").then_some(b"Nunjitsu".as_slice())
            }),
            Ok(written)
        );
    }

    #[test]
    fn rejects_unclosed_interpolations_and_short_output_buffers() {
        let mut output = [0; 4];

        assert_eq!(
            render_template(b"{{ value", |_| None, &mut output),
            Err(RenderError::UnclosedInterpolation),
        );
        assert_eq!(
            render_template(b"hello", |_| None, &mut output),
            Err(RenderError::OutputBufferTooSmall),
        );
    }
}
