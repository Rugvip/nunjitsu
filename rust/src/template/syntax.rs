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
    let start_name = end_name
        .strip_prefix(b"end")
        .ok_or(RenderError::UnclosedRaw)?;
    let mut depth = 0usize;
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
        let marker = source[content_start..]
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
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
        let right_trim = close > content_start && source[close - 1] == b'-';
        let content_end = close - usize::from(right_trim);
        let directive = trim_ascii_whitespace(&source[content_start..content_end]);
        if directive == start_name {
            depth = depth.checked_add(1).ok_or(RenderError::OutputTooLarge)?;
        } else if directive == end_name && depth != 0 {
            depth -= 1;
        } else if directive == end_name {
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

fn raw_marker_prefix(source: &[u8], cursor: usize, name: &[u8]) -> bool {
    source.get(cursor..cursor + name.len()) == Some(name)
        && source
            .get(cursor + name.len())
            .is_some_and(|byte| byte.is_ascii_whitespace() || matches!(byte, b'-' | b'%'))
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
