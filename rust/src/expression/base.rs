/// Parses the base atom, its unary negation, and the following operation cursor.
pub fn parse_base(expression: &[u8]) -> Result<(Atom<'_>, usize, bool), ExpressionError> {
    if let Some(atom) = parse_inline_if(expression)? {
        return Ok((atom, expression.len(), false));
    }
    let (operand, cursor) = parse_operand(expression, 0)?;
    Ok((operand.atom, cursor, operand.negated))
}

fn parse_inline_if(expression: &[u8]) -> Result<Option<Atom<'_>>, ExpressionError> {
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    let mut if_position = None;
    let mut else_position = None;
    while let Some(byte) = expression.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
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
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            _ => {}
        }
        if parentheses == 0 && brackets == 0 && braces == 0 {
            if if_position.is_none() && keyword_boundary(expression, 0, cursor, b"if") {
                if_position = Some(cursor);
                cursor += 2;
                continue;
            }
            if if_position.is_some()
                && else_position.is_none()
                && keyword_boundary(expression, 0, cursor, b"else")
            {
                else_position = Some(cursor);
                cursor += 4;
                continue;
            }
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(ExpressionError);
    }
    let Some(if_position) = if_position else {
        return Ok(None);
    };
    let body = trim_whitespace(&expression[..if_position]);
    let condition_end = else_position.unwrap_or(expression.len());
    let condition = trim_whitespace(&expression[if_position + 2..condition_end]);
    let alternative = else_position
        .map(|position| trim_whitespace(&expression[position + 4..]))
        .filter(|alternative| !alternative.is_empty());
    if body.is_empty() || condition.is_empty() || (else_position.is_some() && alternative.is_none())
    {
        return Err(ExpressionError);
    }
    Ok(Some(Atom::InlineIf {
        body,
        condition,
        alternative,
    }))
}

/// Splits an arithmetic expression at its lowest-precedence, rightmost operator.
pub fn split_binary_expression(
    expression: &[u8],
) -> Result<Option<BinaryExpression<'_>>, ExpressionError> {
    let mut positions = [None; 8];
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = expression.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
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
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            _ => {}
        }
        if parentheses != 0 || brackets != 0 || braces != 0 {
            cursor += 1;
            continue;
        }
        match byte {
            b'~' => positions[BinaryOperator::Concat as usize] = Some(cursor),
            b'+' if !is_unary_sign(expression, cursor) => {
                positions[BinaryOperator::Add as usize] = Some(cursor);
            }
            b'-' if !is_unary_sign(expression, cursor) => {
                positions[BinaryOperator::Subtract as usize] = Some(cursor);
            }
            b'*' if expression.get(cursor + 1) == Some(&b'*') => {
                positions[BinaryOperator::Power as usize] = Some(cursor);
                cursor += 1;
            }
            b'*' => positions[BinaryOperator::Multiply as usize] = Some(cursor),
            b'/' if expression.get(cursor + 1) == Some(&b'/') => {
                positions[BinaryOperator::FloorDivide as usize] = Some(cursor);
                cursor += 1;
            }
            b'/' => positions[BinaryOperator::Divide as usize] = Some(cursor),
            b'%' => positions[BinaryOperator::Remainder as usize] = Some(cursor),
            _ => {}
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(ExpressionError);
    }
    for operator in [
        BinaryOperator::Concat,
        BinaryOperator::Add,
        BinaryOperator::Subtract,
        BinaryOperator::Multiply,
        BinaryOperator::Divide,
        BinaryOperator::FloorDivide,
        BinaryOperator::Remainder,
        BinaryOperator::Power,
    ] {
        if let Some(position) = positions[operator as usize] {
            let width = usize::from(matches!(
                operator,
                BinaryOperator::FloorDivide | BinaryOperator::Power
            )) + 1;
            let left = trim_whitespace(&expression[..position]);
            let right = trim_whitespace(&expression[position + width..]);
            if left.is_empty() || right.is_empty() {
                return Err(ExpressionError);
            }
            return Ok(Some(BinaryExpression {
                left,
                operator,
                right,
            }));
        }
    }
    Ok(None)
}

/// Returns each validated dotted or bracketed lookup segment in order.
pub fn next_lookup_segment(
    path: &[u8],
    cursor: usize,
) -> Result<Option<(&[u8], usize)>, ExpressionError> {
    if cursor == path.len() {
        return Ok(None);
    }
    let mut cursor = cursor;
    if cursor != 0 && path.get(cursor) == Some(&b'.') {
        cursor += 1;
    }
    if path.get(cursor) == Some(&b'[') {
        cursor = skip_whitespace(path, cursor + 1);
        let quote = path.get(cursor).copied();
        let (segment, next) = if matches!(quote, Some(b'\'' | b'"')) {
            let quote = quote.ok_or(ExpressionError)?;
            let start = cursor + 1;
            let mut end = start;
            while path.get(end).is_some_and(|byte| *byte != quote) {
                if path[end] == b'\\' {
                    return Err(ExpressionError);
                }
                end += 1;
            }
            if path.get(end) != Some(&quote) {
                return Err(ExpressionError);
            }
            (&path[start..end], end + 1)
        } else {
            let start = cursor;
            while path.get(cursor).is_some_and(u8::is_ascii_digit) {
                cursor += 1;
            }
            if cursor == start {
                return Err(ExpressionError);
            }
            (&path[start..cursor], cursor)
        };
        let next = skip_whitespace(path, next);
        if path.get(next) != Some(&b']') {
            return Err(ExpressionError);
        }
        return Ok(Some((segment, next + 1)));
    }
    let start = cursor;
    let end = parse_path_segment(path, cursor)?;
    Ok(Some((&path[start..end], end)))
}

/// Parses the next filter or test operation from a previously returned cursor.
pub fn next_operation(
    expression: &[u8],
    cursor: usize,
) -> Result<Option<(Operation<'_>, usize)>, ExpressionError> {
    let mut cursor = skip_whitespace(expression, cursor);
    if cursor == expression.len() {
        return Ok(None);
    }
    if expression[cursor] == b'|' {
        cursor = skip_whitespace(expression, cursor + 1);
        let (call, cursor) = parse_named_call(expression, cursor)?;
        return Ok(Some((
            Operation::Filter(call),
            skip_whitespace(expression, cursor),
        )));
    }
    if has_keyword(expression, cursor, b"is") {
        cursor = skip_whitespace(expression, cursor + 2);
        let negated = has_keyword(expression, cursor, b"not");
        if negated {
            cursor = skip_whitespace(expression, cursor + 3);
        }
        let (call, cursor) = parse_named_call(expression, cursor)?;
        return Ok(Some((
            Operation::Test { call, negated },
            skip_whitespace(expression, cursor),
        )));
    }
    if has_keyword(expression, cursor, b"not") {
        let next = skip_whitespace(expression, cursor + 3);
        if has_keyword(expression, next, b"in") {
            let (operand, cursor) = parse_operand(expression, next + 2)?;
            return Ok(Some((
                Operation::Compare {
                    operator: Comparison::NotIn,
                    operand,
                },
                cursor,
            )));
        }
    }
    if has_keyword(expression, cursor, b"in") {
        let (operand, cursor) = parse_operand(expression, cursor + 2)?;
        return Ok(Some((
            Operation::Compare {
                operator: Comparison::In,
                operand,
            },
            cursor,
        )));
    }
    if has_keyword(expression, cursor, b"and") {
        let (operand, cursor) = parse_operand(expression, cursor + 3)?;
        return Ok(Some((Operation::And(operand), cursor)));
    }
    if has_keyword(expression, cursor, b"or") {
        let (operand, cursor) = parse_operand(expression, cursor + 2)?;
        return Ok(Some((Operation::Or(operand), cursor)));
    }
    for (symbol, operator) in [
        (b"!==".as_slice(), Comparison::StrictNotEqual),
        (b"===".as_slice(), Comparison::StrictEqual),
        (b"!=".as_slice(), Comparison::NotEqual),
        (b"==".as_slice(), Comparison::Equal),
        (b"<=".as_slice(), Comparison::LessOrEqual),
        (b">=".as_slice(), Comparison::GreaterOrEqual),
        (b"<".as_slice(), Comparison::Less),
        (b">".as_slice(), Comparison::Greater),
    ] {
        if expression.get(cursor..cursor + symbol.len()) == Some(symbol) {
            let (operand, cursor) = parse_operand(expression, cursor + symbol.len())?;
            return Ok(Some((Operation::Compare { operator, operand }, cursor)));
        }
    }
    Err(ExpressionError)
}
