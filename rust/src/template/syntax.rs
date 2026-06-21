#[derive(Clone, Copy, Eq, PartialEq)]
enum Delimiter {
    Expression,
    Block,
    Comment,
}

pub(crate) trait SourceCodeUnit: Copy + Eq {
    fn from_ascii(byte: u8) -> Self;
    fn is_ascii_whitespace(self) -> bool;
    fn is_ascii_alphabetic(self) -> bool;
    fn is_ascii_alphanumeric(self) -> bool;
    #[cfg(target_arch = "wasm32")]
    fn slice_eq_utf8(source: &[Self], utf8: &[u8]) -> bool;
}

impl SourceCodeUnit for u8 {
    fn from_ascii(byte: u8) -> Self {
        byte
    }

    fn is_ascii_whitespace(self) -> bool {
        char::from(self).is_ascii_whitespace()
    }

    fn is_ascii_alphabetic(self) -> bool {
        char::from(self).is_ascii_alphabetic()
    }

    fn is_ascii_alphanumeric(self) -> bool {
        char::from(self).is_ascii_alphanumeric()
    }

    #[cfg(target_arch = "wasm32")]
    fn slice_eq_utf8(source: &[Self], utf8: &[u8]) -> bool {
        source == utf8
    }
}

impl SourceCodeUnit for u16 {
    fn from_ascii(byte: u8) -> Self {
        u16::from(byte)
    }

    fn is_ascii_whitespace(self) -> bool {
        char::from_u32(u32::from(self)).is_some_and(|unit| unit.is_ascii_whitespace())
    }

    fn is_ascii_alphabetic(self) -> bool {
        char::from_u32(u32::from(self)).is_some_and(|unit| unit.is_ascii_alphabetic())
    }

    fn is_ascii_alphanumeric(self) -> bool {
        char::from_u32(u32::from(self)).is_some_and(|unit| unit.is_ascii_alphanumeric())
    }

    #[cfg(target_arch = "wasm32")]
    fn slice_eq_utf8(source: &[Self], utf8: &[u8]) -> bool {
        let Ok(text) = core::str::from_utf8(utf8) else {
            return false;
        };
        let mut units = source.iter().copied();
        for character in text.chars() {
            let mut encoded = [0u16; 2];
            for expected in character.encode_utf16(&mut encoded).iter().copied() {
                if units.next() != Some(expected) {
                    return false;
                }
            }
        }
        units.next().is_none()
    }
}

fn ascii_eq<T: SourceCodeUnit>(source: &[T], ascii: &[u8]) -> bool {
    source.len() == ascii.len()
        && source
            .iter()
            .copied()
            .zip(ascii.iter().copied())
            .all(|(unit, byte)| unit == T::from_ascii(byte))
}

fn strip_ascii_prefix<'a, T: SourceCodeUnit>(
    source: &'a [T],
    ascii: &[u8],
) -> Option<&'a [T]> {
    source
        .get(..ascii.len())
        .filter(|prefix| ascii_eq(prefix, ascii))
        .map(|_| &source[ascii.len()..])
}

fn find_next_tag<T: SourceCodeUnit>(source: &[T], cursor: usize) -> Option<(usize, Delimiter)> {
    source[cursor..]
        .windows(2)
        .enumerate()
        .find_map(|(relative, window)| {
            if ascii_eq(window, b"{{") {
                Some((cursor + relative, Delimiter::Expression))
            } else if ascii_eq(window, b"{%") {
                Some((cursor + relative, Delimiter::Block))
            } else if ascii_eq(window, b"{#") {
                Some((cursor + relative, Delimiter::Comment))
            } else {
                None
            }
        })
}

fn find_raw_end<T: SourceCodeUnit>(
    source: &[T],
    body_start: usize,
    end_name: &[u8],
    options: ParseOptions,
) -> Result<(usize, usize), RenderError> {
    let mut search_cursor = body_start;
    let start_name = end_name
        .strip_prefix(b"end")
        .ok_or(RenderError::UnclosedRaw)?;
    let mut depth = 0usize;
    loop {
        let Some(relative) = source[search_cursor..]
            .windows(2)
            .position(|window| ascii_eq(window, b"{%"))
        else {
            return Err(RenderError::UnclosedRaw);
        };
        let open = search_cursor + relative;
        let left_trim = source.get(open + 2).copied() == Some(T::from_ascii(b'-'));
        let content_start = open + 2 + usize::from(left_trim);
        let marker = source[content_start..]
            .iter()
            .position(|unit| !unit.is_ascii_whitespace())
            .map(|relative| content_start + relative)
            .ok_or(RenderError::UnclosedRaw)?;
        if !raw_marker_prefix(source, marker, start_name)
            && !raw_marker_prefix(source, marker, end_name)
        {
            search_cursor = open + 2;
            continue;
        }
        let close = find_pair(&source[content_start..], b'%', b'}')
            .map(|relative| content_start + relative)
            .ok_or(RenderError::UnclosedRaw)?;
        let right_trim = close > content_start && source[close - 1] == T::from_ascii(b'-');
        let content_end = close - usize::from(right_trim);
        let directive = trim_ascii_whitespace(&source[content_start..content_end]);
        if ascii_eq(directive, start_name) {
            depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
        } else if ascii_eq(directive, end_name) && depth != 0 {
            depth -= 1;
        } else if ascii_eq(directive, end_name) {
            let mut body_end = open;
            if left_trim {
                while body_end > body_start && source[body_end - 1].is_ascii_whitespace() {
                    body_end -= 1;
                }
            } else if options.lstrip_blocks {
                let line_start = source[..open]
                    .iter()
                    .rposition(|unit| *unit == T::from_ascii(b'\n'))
                    .map_or(0, |index| index + 1);
                if line_start >= body_start
                    && source[line_start..open]
                        .iter()
                        .all(|unit| unit.is_ascii_whitespace())
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

fn raw_marker_prefix<T: SourceCodeUnit>(source: &[T], cursor: usize, name: &[u8]) -> bool {
    source
        .get(cursor..cursor + name.len())
        .is_some_and(|candidate| ascii_eq(candidate, name))
        && source
            .get(cursor + name.len())
            .copied()
            .is_some_and(|unit| {
                unit.is_ascii_whitespace()
                    || unit == T::from_ascii(b'-')
                    || unit == T::from_ascii(b'%')
            })
}

fn following_cursor<T: SourceCodeUnit>(
    source: &[T],
    mut cursor: usize,
    explicit_trim: bool,
    trim_block: bool,
) -> usize {
    if explicit_trim {
        while source
            .get(cursor)
            .is_some_and(|unit| unit.is_ascii_whitespace())
        {
            cursor += 1;
        }
    } else if trim_block {
        if source.get(cursor).copied() == Some(T::from_ascii(b'\n')) {
            cursor += 1;
        } else if source
            .get(cursor..cursor + 2)
            .is_some_and(|candidate| ascii_eq(candidate, b"\r\n"))
        {
            cursor += 2;
        }
    }
    cursor
}

fn find_pair<T: SourceCodeUnit>(bytes: &[T], first: u8, second: u8) -> Option<usize> {
    bytes
        .windows(2)
        .position(|window| {
            window[0] == T::from_ascii(first) && window[1] == T::from_ascii(second)
        })
}

fn parse_include<T: SourceCodeUnit>(source: &[T]) -> Result<(&[T], bool), RenderError> {
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
            if byte == T::from_ascii(b'\\') {
                cursor = cursor.checked_add(2).ok_or(RenderError::InvalidInclude)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if byte == T::from_ascii(b'\'') || byte == T::from_ascii(b'"') {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        match byte {
            byte if byte == T::from_ascii(b'(') => parentheses += 1,
            byte if byte == T::from_ascii(b'[') => brackets += 1,
            byte if byte == T::from_ascii(b'{') => braces += 1,
            byte if byte == T::from_ascii(b')') => {
                parentheses = parentheses
                    .checked_sub(1)
                    .ok_or(RenderError::InvalidInclude)?;
            }
            byte if byte == T::from_ascii(b']') => {
                brackets = brackets.checked_sub(1).ok_or(RenderError::InvalidInclude)?;
            }
            byte if byte == T::from_ascii(b'}') => {
                braces = braces.checked_sub(1).ok_or(RenderError::InvalidInclude)?;
            }
            _ => {}
        }
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && (byte.is_ascii_alphabetic() || byte == T::from_ascii(b'_'))
        {
            let start = cursor;
            cursor += 1;
            while source
                .get(cursor)
                .is_some_and(|unit| {
                    unit.is_ascii_alphanumeric() || *unit == T::from_ascii(b'_')
                })
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
    if ascii_eq(&source[ignore_start..ignore_end], b"ignore")
        && ascii_eq(&source[missing_start..missing_end], b"missing")
        && source[ignore_end..missing_start]
            .iter()
            .all(|unit| unit.is_ascii_whitespace())
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

fn trim_ascii_whitespace<T: SourceCodeUnit>(mut bytes: &[T]) -> &[T] {
    while bytes
        .first()
        .is_some_and(|unit| unit.is_ascii_whitespace())
    {
        bytes = &bytes[1..];
    }
    while bytes
        .last()
        .is_some_and(|unit| unit.is_ascii_whitespace())
    {
        bytes = &bytes[..bytes.len() - 1];
    }
    bytes
}
