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
