/// One host-call syntax node with raw argument source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Call<'a> {
    /// Template-visible capability name.
    pub name: &'a [u8],
    /// Comma-separated argument source without parentheses.
    pub arguments: &'a [u8],
}

/// One directly resolvable expression atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Atom<'a> {
    /// A dotted lookup into the copied render context.
    Lookup(&'a [u8]),
    /// A UTF-8 string literal without its quotes.
    String(&'a [u8]),
    /// A decimal numeric literal retained in source form.
    Number(&'a [u8]),
    /// A Nunjucks regular-expression literal retained in rendered `/.../flags` form.
    Regex(&'a [u8]),
    /// A boolean literal.
    Boolean(bool),
    /// The null/none literal.
    Null,
    /// The undefined literal.
    Undefined,
    /// A callable global expression.
    Call(Call<'a>),
    /// A parenthesized expression evaluated as one operand.
    Group(&'a [u8]),
    /// An array literal's comma-separated element source.
    Array(&'a [u8]),
    /// An object literal's comma-separated entry source.
    Record(&'a [u8]),
    /// An arithmetic or concatenation expression evaluated with precedence.
    Arithmetic(&'a [u8]),
    /// A lazy inline conditional expression.
    InlineIf {
        /// Expression evaluated when the condition is truthy.
        body: &'a [u8],
        /// Expression whose truthiness selects the branch.
        condition: &'a [u8],
        /// Optional expression evaluated when the condition is falsey.
        alternative: Option<&'a [u8]>,
    },
}

/// One binary arithmetic or string-concatenation operator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOperator {
    Concat,
    Add,
    Subtract,
    Multiply,
    Divide,
    FloorDivide,
    Remainder,
    Power,
}

/// One lowest-precedence binary split of an expression.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BinaryExpression<'a> {
    /// Source to the left of the selected operator.
    pub left: &'a [u8],
    /// Selected lowest-precedence operator.
    pub operator: BinaryOperator,
    /// Source to the right of the selected operator.
    pub right: &'a [u8],
}

/// One atom with an optional unary `not` operator.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Operand<'a> {
    /// Directly resolvable operand value.
    pub atom: Atom<'a>,
    /// Whether truthiness is inverted before applying the next operation.
    pub negated: bool,
}

/// Supported comparison operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Comparison {
    Equal,
    StrictEqual,
    NotEqual,
    StrictNotEqual,
    Less,
    LessOrEqual,
    Greater,
    GreaterOrEqual,
    In,
    NotIn,
}

/// One operation following an expression's base atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation<'a> {
    /// A `| filter(...)` operation.
    Filter(Call<'a>),
    /// An `is [not] test(...)` operation.
    Test { call: Call<'a>, negated: bool },
    /// A comparison against one following operand.
    Compare {
        operator: Comparison,
        operand: Operand<'a>,
    },
    /// A short-circuiting boolean `and` operation.
    And(Operand<'a>),
    /// A short-circuiting boolean `or` operation.
    Or(Operand<'a>),
}

/// A malformed or currently unsupported expression shape.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExpressionError;

/// Parsed variable binding and iterable expression for a `for` directive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForClause<'a> {
    /// Comma-separated ordered binding identifiers.
    pub bindings: &'a [u8],
    /// Iterable expression after the `in` keyword.
    pub iterable: &'a [u8],
}

/// One parsed object-literal entry and the cursor of the following entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordEntry<'a> {
    /// UTF-8 key without quotes.
    pub key: &'a [u8],
    /// Parsed entry value.
    pub value: Atom<'a>,
    /// Cursor after this entry and its comma.
    pub next_cursor: usize,
}

/// Parsed target names and optional value expression for an assignment directive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SetClause<'a> {
    /// Comma-separated ordered assignment identifiers.
    pub targets: &'a [u8],
    /// Complete expression after `=`, or `None` for a capture block.
    pub expression: Option<&'a [u8]>,
}

/// One macro definition parameter and optional default atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MacroParameter<'a> {
    /// Template-visible parameter name.
    pub name: &'a [u8],
    /// Default value evaluated when the call does not supply this parameter.
    pub default: Option<Atom<'a>>,
    /// Cursor of the following parameter.
    pub next_cursor: usize,
}

/// One positional or named macro call argument.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MacroArgument<'a> {
    /// Explicit target parameter for a keyword argument.
    pub name: Option<&'a [u8]>,
    /// Argument value atom evaluated in caller scope.
    pub value: Atom<'a>,
    /// Cursor of the following argument.
    pub next_cursor: usize,
}

/// One call-block clause with optional caller parameters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CallBlock<'a> {
    /// Comma-separated names bound when the macro invokes `caller`.
    pub bindings: &'a [u8],
    /// Macro invoked with the captured caller body.
    pub call: Call<'a>,
}

/// One `{% import expression as name %}` clause.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImportClause<'a> {
    /// Template-name expression resolved through configured loaders.
    pub template: &'a [u8],
    /// Local namespace binding populated by the import.
    pub alias: &'a [u8],
    /// Whether the imported template receives the caller context.
    pub with_context: bool,
}

/// One `{% from expression import names %}` clause.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FromImportClause<'a> {
    /// Template-name expression resolved through configured loaders.
    pub template: &'a [u8],
    /// Comma-separated imported names and aliases.
    pub bindings: &'a [u8],
    /// Whether the imported template receives the caller context.
    pub with_context: bool,
}

/// One imported name and its local alias.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImportBinding<'a> {
    /// Exported template name.
    pub name: &'a [u8],
    /// Local name, equal to `name` when no alias is present.
    pub alias: &'a [u8],
    /// Cursor of the following binding.
    pub next_cursor: usize,
}

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

/// Parses one comma-separated call argument from a raw call argument slice.
pub fn next_argument(
    arguments: &[u8],
    cursor: usize,
) -> Result<Option<(Atom<'_>, usize)>, ExpressionError> {
    let cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(None);
    }
    let (atom, mut cursor) = parse_atom(arguments, cursor)?;
    cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(Some((atom, cursor)));
    }
    if arguments[cursor] != b',' {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(arguments, cursor + 1);
    if cursor == arguments.len() {
        return Err(ExpressionError);
    }
    Ok(Some((atom, cursor)))
}

/// Parses one macro definition parameter from a comma-separated signature.
pub fn next_macro_parameter(
    parameters: &[u8],
    cursor: usize,
) -> Result<Option<MacroParameter<'_>>, ExpressionError> {
    let cursor = skip_whitespace(parameters, cursor);
    if cursor == parameters.len() {
        return Ok(None);
    }
    let start = cursor;
    let mut cursor = parse_identifier(parameters, cursor)?;
    let name = &parameters[start..cursor];
    cursor = skip_whitespace(parameters, cursor);
    let default =
        if parameters.get(cursor) == Some(&b'=') && parameters.get(cursor + 1) != Some(&b'=') {
            cursor = skip_whitespace(parameters, cursor + 1);
            let (default, next) = parse_atom(parameters, cursor)?;
            cursor = skip_whitespace(parameters, next);
            Some(default)
        } else {
            None
        };
    let next_cursor = next_list_cursor(parameters, cursor)?;
    Ok(Some(MacroParameter {
        name,
        default,
        next_cursor,
    }))
}

/// Parses one positional or keyword macro call argument.
pub fn next_macro_argument(
    arguments: &[u8],
    cursor: usize,
) -> Result<Option<MacroArgument<'_>>, ExpressionError> {
    let cursor = skip_whitespace(arguments, cursor);
    if cursor == arguments.len() {
        return Ok(None);
    }
    let mut value_cursor = cursor;
    let name = if arguments
        .get(cursor)
        .copied()
        .is_some_and(is_identifier_start)
    {
        let end = parse_identifier(arguments, cursor)?;
        let following = skip_whitespace(arguments, end);
        if arguments.get(following) == Some(&b'=') && arguments.get(following + 1) != Some(&b'=') {
            value_cursor = skip_whitespace(arguments, following + 1);
            Some(&arguments[cursor..end])
        } else {
            None
        }
    } else {
        None
    };
    let (value, cursor) = parse_atom(arguments, value_cursor)?;
    let cursor = skip_whitespace(arguments, cursor);
    let next_cursor = next_list_cursor(arguments, cursor)?;
    Ok(Some(MacroArgument {
        name,
        value,
        next_cursor,
    }))
}

fn next_list_cursor(bytes: &[u8], cursor: usize) -> Result<usize, ExpressionError> {
    if cursor == bytes.len() {
        return Ok(cursor);
    }
    if bytes.get(cursor) != Some(&b',') {
        return Err(ExpressionError);
    }
    let cursor = skip_whitespace(bytes, cursor + 1);
    if cursor == bytes.len() {
        return Err(ExpressionError);
    }
    Ok(cursor)
}

/// Parses one object-literal entry from a comma-separated entry slice.
pub fn next_record_entry(
    entries: &[u8],
    cursor: usize,
) -> Result<Option<RecordEntry<'_>>, ExpressionError> {
    let mut cursor = skip_whitespace(entries, cursor);
    if cursor == entries.len() {
        return Ok(None);
    }
    let (key, next) = if matches!(entries.get(cursor), Some(b'\'' | b'"')) {
        let quote = entries[cursor];
        let start = cursor + 1;
        let mut end = start;
        while entries.get(end).is_some_and(|byte| *byte != quote) {
            if entries[end] == b'\\' {
                return Err(ExpressionError);
            }
            end += 1;
        }
        if entries.get(end) != Some(&quote) {
            return Err(ExpressionError);
        }
        (&entries[start..end], end + 1)
    } else {
        let start = cursor;
        let end = parse_identifier(entries, cursor)?;
        (&entries[start..end], end)
    };
    cursor = skip_whitespace(entries, next);
    if entries.get(cursor) != Some(&b':') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(entries, cursor + 1);
    let (value, mut cursor) = parse_atom(entries, cursor)?;
    cursor = skip_whitespace(entries, cursor);
    if cursor == entries.len() {
        return Ok(Some(RecordEntry {
            key,
            value,
            next_cursor: cursor,
        }));
    }
    if entries.get(cursor) != Some(&b',') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(entries, cursor + 1);
    if cursor == entries.len() {
        return Err(ExpressionError);
    }
    Ok(Some(RecordEntry {
        key,
        value,
        next_cursor: cursor,
    }))
}

/// Parses a complete custom-tag directive using parenthesized or legacy arguments.
pub fn parse_tag_call(directive: &[u8]) -> Result<Call<'_>, ExpressionError> {
    let cursor = skip_whitespace(directive, 0);
    let name_start = cursor;
    let name_end = parse_identifier(directive, cursor)?;
    let name = &directive[name_start..name_end];
    let cursor = skip_whitespace(directive, name_end);
    if directive.get(cursor) == Some(&b'(') {
        let (arguments, cursor) = parse_parenthesized(directive, cursor)?;
        if skip_whitespace(directive, cursor) != directive.len() {
            return Err(ExpressionError);
        }
        return Ok(Call { name, arguments });
    }
    Ok(Call {
        name,
        arguments: trim_whitespace(&directive[cursor..]),
    })
}

/// Returns the leading identifier of a custom-tag directive.
#[cfg(target_arch = "wasm32")]
pub fn parse_tag_name(directive: &[u8]) -> Result<&[u8], ExpressionError> {
    let start = skip_whitespace(directive, 0);
    let end = parse_identifier(directive, start)?;
    Ok(&directive[start..end])
}

/// Parses `(optional, bindings) macro(arguments)` call-block syntax.
pub fn parse_call_block(source: &[u8]) -> Result<CallBlock<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let bindings = if source.get(cursor) == Some(&b'(') {
        let (bindings, next) = parse_parenthesized(source, cursor)?;
        let mut binding_cursor = 0usize;
        while let Some((_, next)) = next_binding(bindings, binding_cursor)? {
            binding_cursor = next;
        }
        cursor = skip_whitespace(source, next);
        bindings
    } else {
        b""
    };
    let (call, cursor) = parse_named_call(source, cursor)?;
    if skip_whitespace(source, cursor) != source.len() {
        return Err(ExpressionError);
    }
    Ok(CallBlock { bindings, call })
}

/// Parses `template-expression as namespace [with|without context]`.
pub fn parse_import_clause(source: &[u8]) -> Result<ImportClause<'_>, ExpressionError> {
    let start = skip_whitespace(source, 0);
    let (_, expression_end) = parse_atom(source, start)?;
    let template = trim_whitespace(&source[start..expression_end]);
    let mut cursor = skip_whitespace(source, expression_end);
    if !has_keyword(source, cursor, b"as") {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(source, cursor + 2);
    let alias_start = cursor;
    cursor = parse_identifier(source, cursor)?;
    let alias = &source[alias_start..cursor];
    cursor = skip_whitespace(source, cursor);
    let with_context = if cursor == source.len() {
        false
    } else if has_keyword(source, cursor, b"with") {
        cursor = skip_whitespace(source, cursor + 4);
        if !has_keyword(source, cursor, b"context") {
            return Err(ExpressionError);
        }
        cursor = skip_whitespace(source, cursor + 7);
        true
    } else if has_keyword(source, cursor, b"without") {
        cursor = skip_whitespace(source, cursor + 7);
        if !has_keyword(source, cursor, b"context") {
            return Err(ExpressionError);
        }
        cursor = skip_whitespace(source, cursor + 7);
        false
    } else {
        return Err(ExpressionError);
    };
    if cursor != source.len() {
        return Err(ExpressionError);
    }
    Ok(ImportClause {
        template,
        alias,
        with_context,
    })
}

/// Parses `template-expression import names [with|without context]`.
pub fn parse_from_import_clause(source: &[u8]) -> Result<FromImportClause<'_>, ExpressionError> {
    let start = skip_whitespace(source, 0);
    let (_, expression_end) = parse_atom(source, start)?;
    let template = trim_whitespace(&source[start..expression_end]);
    let mut cursor = skip_whitespace(source, expression_end);
    if !has_keyword(source, cursor, b"import") {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(source, cursor + 6);
    let bindings_start = cursor;
    let first = next_import_binding(source, cursor)?.ok_or(ExpressionError)?;
    let mut bindings_end = first.next_cursor;
    cursor = skip_whitespace(source, first.next_cursor);
    while cursor != source.len()
        && !has_keyword(source, cursor, b"with")
        && !has_keyword(source, cursor, b"without")
    {
        let binding = next_import_binding(source, cursor)?.ok_or(ExpressionError)?;
        bindings_end = binding.next_cursor;
        cursor = skip_whitespace(source, binding.next_cursor);
    }
    if cursor == source.len() {
        return Ok(FromImportClause {
            template,
            bindings: trim_whitespace(&source[bindings_start..bindings_end]),
            with_context: false,
        });
    }
    let with_context = has_keyword(source, cursor, b"with");
    cursor = skip_whitespace(source, cursor + if with_context { 4 } else { 7 });
    if !has_keyword(source, cursor, b"context") {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(source, cursor + 7);
    if cursor != source.len() {
        return Err(ExpressionError);
    }
    Ok(FromImportClause {
        template,
        bindings: trim_whitespace(&source[bindings_start..bindings_end]),
        with_context,
    })
}

/// Parses one `name [as alias]` entry from an import binding list.
pub fn next_import_binding(
    bindings: &[u8],
    cursor: usize,
) -> Result<Option<ImportBinding<'_>>, ExpressionError> {
    let cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(None);
    }
    let name_start = cursor;
    let mut cursor = parse_identifier(bindings, cursor)?;
    let name = &bindings[name_start..cursor];
    cursor = skip_whitespace(bindings, cursor);
    let alias = if has_keyword(bindings, cursor, b"as") {
        cursor = skip_whitespace(bindings, cursor + 2);
        let alias_start = cursor;
        cursor = parse_identifier(bindings, cursor)?;
        &bindings[alias_start..cursor]
    } else {
        name
    };
    cursor = skip_whitespace(bindings, cursor);
    let next_cursor = if cursor == bindings.len()
        || has_keyword(bindings, cursor, b"with")
        || has_keyword(bindings, cursor, b"without")
    {
        cursor
    } else {
        if bindings.get(cursor) != Some(&b',') {
            return Err(ExpressionError);
        }
        let next = skip_whitespace(bindings, cursor + 1);
        if next == bindings.len() {
            return Err(ExpressionError);
        }
        next
    };
    Ok(Some(ImportBinding {
        name,
        alias,
        next_cursor,
    }))
}

/// Parses one identifier from a validated comma-separated binding list.
pub fn next_binding(
    bindings: &[u8],
    cursor: usize,
) -> Result<Option<(&[u8], usize)>, ExpressionError> {
    let cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(None);
    }
    let start = cursor;
    let mut cursor = parse_identifier(bindings, cursor)?;
    let name = &bindings[start..cursor];
    cursor = skip_whitespace(bindings, cursor);
    if cursor == bindings.len() {
        return Ok(Some((name, cursor)));
    }
    if bindings.get(cursor) != Some(&b',') {
        return Err(ExpressionError);
    }
    cursor = skip_whitespace(bindings, cursor + 1);
    if cursor == bindings.len() {
        return Err(ExpressionError);
    }
    Ok(Some((name, cursor)))
}

/// Parses `name [ , name ... ] in expression` without evaluating the iterable.
pub fn parse_for_clause(source: &[u8]) -> Result<ForClause<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let bindings_start = cursor;
    loop {
        cursor = parse_identifier(source, cursor)?;
        cursor = skip_whitespace(source, cursor);
        if source.get(cursor) != Some(&b',') {
            break;
        }
        cursor = skip_whitespace(source, cursor + 1);
    }
    let bindings = trim_whitespace(&source[bindings_start..cursor]);
    if !has_keyword(source, cursor, b"in") {
        return Err(ExpressionError);
    }
    let iterable = &source[skip_whitespace(source, cursor + 2)..];
    if iterable.is_empty() {
        return Err(ExpressionError);
    }
    Ok(ForClause { bindings, iterable })
}

/// Parses `name [ , name ... ] [ = expression ]` for assignment or capture.
pub fn parse_set_clause(source: &[u8]) -> Result<SetClause<'_>, ExpressionError> {
    let mut cursor = skip_whitespace(source, 0);
    let targets_start = cursor;
    loop {
        cursor = parse_identifier(source, cursor)?;
        cursor = skip_whitespace(source, cursor);
        if source.get(cursor) != Some(&b',') {
            break;
        }
        cursor = skip_whitespace(source, cursor + 1);
    }
    let targets = trim_whitespace(&source[targets_start..cursor]);
    if cursor == source.len() {
        return Ok(SetClause {
            targets,
            expression: None,
        });
    }
    if source.get(cursor) != Some(&b'=') || source.get(cursor + 1) == Some(&b'=') {
        return Err(ExpressionError);
    }
    let expression = trim_whitespace(&source[cursor + 1..]);
    if expression.is_empty() {
        return Err(ExpressionError);
    }
    Ok(SetClause {
        targets,
        expression: Some(expression),
    })
}

fn parse_atom(bytes: &[u8], cursor: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let byte = *bytes.get(cursor).ok_or(ExpressionError)?;
    if byte == b'r' && bytes.get(cursor + 1) == Some(&b'/') {
        return parse_regex(bytes, cursor);
    }
    if byte == b'(' {
        let (expression, cursor) = parse_parenthesized(bytes, cursor)?;
        return Ok((Atom::Group(expression), cursor));
    }
    if byte == b'[' {
        let (elements, cursor) = parse_delimited(bytes, cursor, b'[', b']')?;
        return Ok((Atom::Array(elements), cursor));
    }
    if byte == b'{' {
        let (entries, cursor) = parse_delimited(bytes, cursor, b'{', b'}')?;
        return Ok((Atom::Record(entries), cursor));
    }
    if matches!(byte, b'\'' | b'"') {
        return parse_string(bytes, cursor, byte);
    }
    if byte.is_ascii_digit()
        || ((byte == b'-' || byte == b'+') && bytes.get(cursor + 1).is_some_and(u8::is_ascii_digit))
    {
        return parse_number(bytes, cursor);
    }
    if !is_identifier_start(byte) {
        return Err(ExpressionError);
    }

    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while matches!(bytes.get(cursor), Some(b'.' | b'[')) {
        let Some((_, next)) = next_lookup_segment(&bytes[start..], cursor - start)? else {
            return Err(ExpressionError);
        };
        cursor = start + next;
    }
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&b'(') {
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        return Ok((Atom::Call(Call { name, arguments }), end));
    }
    let atom = match name {
        b"true" => Atom::Boolean(true),
        b"false" => Atom::Boolean(false),
        b"none" | b"null" => Atom::Null,
        b"undefined" => Atom::Undefined,
        _ => Atom::Lookup(name),
    };
    Ok((atom, cursor))
}

fn parse_regex(bytes: &[u8], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start + 2;
    loop {
        match bytes.get(cursor).copied() {
            Some(b'\\') => {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
            }
            Some(b'/') => {
                cursor += 1;
                while bytes.get(cursor).is_some_and(u8::is_ascii_alphabetic) {
                    cursor += 1;
                }
                return Ok((Atom::Regex(&bytes[start + 1..cursor]), cursor));
            }
            Some(_) => cursor += 1,
            None => return Err(ExpressionError),
        }
    }
}

fn parse_operand(bytes: &[u8], cursor: usize) -> Result<(Operand<'_>, usize), ExpressionError> {
    let mut cursor = skip_whitespace(bytes, cursor);
    let negated = has_keyword(bytes, cursor, b"not");
    if negated {
        cursor = skip_whitespace(bytes, cursor + 3);
    }
    let end = arithmetic_operand_end(bytes, cursor)?;
    let arithmetic = trim_whitespace(&bytes[cursor..end]);
    let is_regex = bytes.get(cursor) == Some(&b'r') && bytes.get(cursor + 1) == Some(&b'/');
    let (atom, cursor) = if !is_regex && split_binary_expression(arithmetic)?.is_some() {
        (Atom::Arithmetic(arithmetic), end)
    } else {
        parse_atom(bytes, cursor)?
    };
    Ok((Operand { atom, negated }, skip_whitespace(bytes, cursor)))
}

fn arithmetic_operand_end(bytes: &[u8], start: usize) -> Result<usize, ExpressionError> {
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = bytes.get(cursor).copied() {
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
        if parentheses == 0
            && brackets == 0
            && braces == 0
            && (matches!(byte, b'=' | b'!' | b'<' | b'>')
                || keyword_boundary(bytes, start, cursor, b"is")
                || keyword_boundary(bytes, start, cursor, b"in")
                || keyword_boundary(bytes, start, cursor, b"and")
                || keyword_boundary(bytes, start, cursor, b"or")
                || keyword_boundary(bytes, start, cursor, b"not"))
        {
            return Ok(cursor);
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(ExpressionError);
    }
    Ok(bytes.len())
}

fn keyword_boundary(bytes: &[u8], start: usize, cursor: usize, keyword: &[u8]) -> bool {
    (cursor == start || bytes[cursor - 1].is_ascii_whitespace())
        && bytes.get(cursor..cursor + keyword.len()) == Some(keyword)
        && bytes
            .get(cursor + keyword.len())
            .is_some_and(u8::is_ascii_whitespace)
}

fn is_unary_sign(bytes: &[u8], cursor: usize) -> bool {
    let Some(previous) = bytes[..cursor]
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| bytes[index])
    else {
        return true;
    };
    matches!(
        previous,
        b'~' | b'+'
            | b'-'
            | b'*'
            | b'/'
            | b'%'
            | b'('
            | b'['
            | b'{'
            | b','
            | b':'
            | b'='
            | b'!'
            | b'<'
            | b'>'
    )
}

fn trim_whitespace(bytes: &[u8]) -> &[u8] {
    let start = skip_whitespace(bytes, 0);
    let mut end = bytes.len();
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    &bytes[start..end]
}

fn parse_named_call(bytes: &[u8], cursor: usize) -> Result<(Call<'_>, usize), ExpressionError> {
    let start = cursor;
    let mut cursor = parse_identifier(bytes, cursor)?;
    while bytes.get(cursor) == Some(&b'.') {
        cursor = parse_identifier(bytes, cursor + 1)?;
    }
    let name = &bytes[start..cursor];
    let following = skip_whitespace(bytes, cursor);
    if bytes.get(following) == Some(&b'(') {
        let (arguments, end) = parse_parenthesized(bytes, following)?;
        Ok((Call { name, arguments }, end))
    } else {
        Ok((
            Call {
                name,
                arguments: b"",
            },
            cursor,
        ))
    }
}

fn parse_string(
    bytes: &[u8],
    cursor: usize,
    quote: u8,
) -> Result<(Atom<'_>, usize), ExpressionError> {
    let start = cursor + 1;
    let mut cursor = start;
    while let Some(byte) = bytes.get(cursor) {
        if *byte == quote {
            return Ok((Atom::String(&bytes[start..cursor]), cursor + 1));
        }
        if *byte == b'\\' {
            return Err(ExpressionError);
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_number(bytes: &[u8], start: usize) -> Result<(Atom<'_>, usize), ExpressionError> {
    let mut cursor = start;
    if matches!(bytes.get(cursor), Some(b'-' | b'+')) {
        cursor += 1;
    }
    let integer_start = cursor;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        cursor += 1;
    }
    if cursor == integer_start {
        return Err(ExpressionError);
    }
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        if cursor == fraction_start {
            return Err(ExpressionError);
        }
    }
    Ok((Atom::Number(&bytes[start..cursor]), cursor))
}

fn parse_parenthesized(bytes: &[u8], open: usize) -> Result<(&[u8], usize), ExpressionError> {
    parse_delimited(bytes, open, b'(', b')')
}

fn parse_delimited(
    bytes: &[u8],
    open: usize,
    expected_open: u8,
    expected_close: u8,
) -> Result<(&[u8], usize), ExpressionError> {
    if bytes.get(open) != Some(&expected_open) {
        return Err(ExpressionError);
    }
    let start = open + 1;
    let mut cursor = start;
    let mut quote = None;
    let mut parentheses = usize::from(expected_open == b'(');
    let mut brackets = usize::from(expected_open == b'[');
    let mut braces = usize::from(expected_open == b'{');
    while let Some(byte) = bytes.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == b'\\' {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
        } else if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'(' {
            parentheses += 1;
        } else if byte == b'[' {
            brackets += 1;
        } else if byte == b'{' {
            braces += 1;
        } else if byte == b')' {
            parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == b']' {
            brackets = brackets.checked_sub(1).ok_or(ExpressionError)?;
        } else if byte == b'}' {
            braces = braces.checked_sub(1).ok_or(ExpressionError)?;
        }
        if byte == expected_close && parentheses == 0 && brackets == 0 && braces == 0 {
            return Ok((&bytes[start..cursor], cursor + 1));
        }
        cursor += 1;
    }
    Err(ExpressionError)
}

fn parse_identifier(bytes: &[u8], cursor: usize) -> Result<usize, ExpressionError> {
    if !bytes.get(cursor).copied().is_some_and(is_identifier_start) {
        return Err(ExpressionError);
    }
    let mut cursor = cursor + 1;
    while bytes
        .get(cursor)
        .copied()
        .is_some_and(is_identifier_continue)
    {
        cursor += 1;
    }
    Ok(cursor)
}

fn parse_path_segment(bytes: &[u8], cursor: usize) -> Result<usize, ExpressionError> {
    if bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
        let mut cursor = cursor + 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        Ok(cursor)
    } else {
        parse_identifier(bytes, cursor)
    }
}

fn has_keyword(bytes: &[u8], cursor: usize, keyword: &[u8]) -> bool {
    bytes.get(cursor..cursor + keyword.len()) == Some(keyword)
        && bytes
            .get(cursor + keyword.len())
            .is_none_or(|byte| byte.is_ascii_whitespace())
}

fn skip_whitespace(bytes: &[u8], mut cursor: usize) -> usize {
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    cursor
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_globals_filters_tests_and_arguments() {
        let expression = br#"hello("World", user.name) | suffix("!") is not empty"#;
        let (base, cursor, negated) = parse_base(expression).unwrap();
        assert!(!negated);
        assert_eq!(
            base,
            Atom::Call(Call {
                name: b"hello",
                arguments: br#""World", user.name"#,
            }),
        );
        let (first, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            first,
            Operation::Filter(Call {
                name: b"suffix",
                arguments: br#""!""#,
            }),
        );
        let (second, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            second,
            Operation::Test {
                call: Call {
                    name: b"empty",
                    arguments: b"",
                },
                negated: true,
            },
        );
        assert_eq!(next_operation(expression, cursor), Ok(None));

        let Atom::Call(call) = base else {
            panic!("expected call");
        };
        let (first, cursor) = next_argument(call.arguments, 0).unwrap().unwrap();
        assert_eq!(first, Atom::String(b"World"));
        let (second, cursor) = next_argument(call.arguments, cursor).unwrap().unwrap();
        assert_eq!(second, Atom::Lookup(b"user.name"));
        assert_eq!(next_argument(call.arguments, cursor), Ok(None));
    }

    #[test]
    fn rejects_trailing_arguments_and_invalid_syntax() {
        let expression = b"value + 1";
        let (base, cursor, _) = parse_base(expression).unwrap();
        assert_eq!(base, Atom::Arithmetic(expression));
        assert_eq!(next_operation(expression, cursor), Ok(None));
        assert_eq!(next_argument(b"value,", 0), Err(ExpressionError));
        assert_eq!(parse_base(br#""escaped\"""#), Err(ExpressionError));
        assert_eq!(
            parse_tag_call(br#" badge("new", user.name) "#),
            Ok(Call {
                name: b"badge",
                arguments: br#""new", user.name"#,
            }),
        );
        assert_eq!(
            parse_tag_call(b"badge trailing"),
            Ok(Call {
                name: b"badge",
                arguments: b"trailing",
            }),
        );
        assert_eq!(
            parse_call_block(br#"(item, index) list(["a", "b"])"#),
            Ok(CallBlock {
                bindings: b"item, index",
                call: Call {
                    name: b"list",
                    arguments: br#"["a", "b"]"#,
                },
            }),
        );
        assert_eq!(
            parse_call_block(b"(item) wrap()"),
            Ok(CallBlock {
                bindings: b"item",
                call: Call {
                    name: b"wrap",
                    arguments: b"",
                },
            }),
        );
        assert_eq!(
            parse_call_block(b"(item,) list(values)"),
            Err(ExpressionError)
        );
        assert_eq!(
            parse_import_clause(br#" "import.njk" as imp with context "#),
            Ok(ImportClause {
                template: br#""import.njk""#,
                alias: b"imp",
                with_context: true,
            }),
        );
        assert_eq!(
            parse_from_import_clause(br#" "import.njk" import foo as baz, bar without context "#),
            Ok(FromImportClause {
                template: br#""import.njk""#,
                bindings: b"foo as baz, bar",
                with_context: false,
            }),
        );
        let bindings = b"foo as baz, bar";
        let first = next_import_binding(bindings, 0).unwrap().unwrap();
        assert_eq!(
            (first.name, first.alias),
            (b"foo".as_slice(), b"baz".as_slice())
        );
        let second = next_import_binding(bindings, first.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(
            (second.name, second.alias),
            (b"bar".as_slice(), b"bar".as_slice())
        );
        assert_eq!(next_import_binding(bindings, second.next_cursor), Ok(None));
        assert_eq!(
            parse_base(b"imp.wrap(\"span\")"),
            Ok((
                Atom::Call(Call {
                    name: b"imp.wrap",
                    arguments: b"\"span\"",
                }),
                16,
                false,
            )),
        );
        assert_eq!(next_macro_parameter(b"value=", 0), Err(ExpressionError));
        assert_eq!(next_macro_argument(b"value=", 0), Err(ExpressionError));
        assert_eq!(
            parse_base(br#"not user["profile"].flags[0]"#),
            Ok((Atom::Lookup(br#"user["profile"].flags[0]"#), 28, true)),
        );
        let path = br#"user["profile"].flags[0]"#;
        let mut cursor = 0;
        let mut segments = Vec::new();
        while let Some((segment, next)) = next_lookup_segment(path, cursor).unwrap() {
            segments.push(segment);
            cursor = next;
        }
        assert_eq!(
            segments,
            [
                b"user".as_slice(),
                b"profile".as_slice(),
                b"flags".as_slice(),
                b"0".as_slice(),
            ],
        );
    }

    #[test]
    fn parses_boolean_and_comparison_operations() {
        let expression = br#"(hungry or pizza) and not anchovies or food == "salad""#;
        let (base, cursor, negated) = parse_base(expression).unwrap();
        assert_eq!(base, Atom::Group(b"hungry or pizza"));
        assert!(!negated);
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::And(Operand {
                atom: Atom::Lookup(b"anchovies"),
                negated: true,
            }),
        );
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::Or(Operand {
                atom: Atom::Lookup(b"food"),
                negated: false,
            }),
        );
        let (operation, cursor) = next_operation(expression, cursor).unwrap().unwrap();
        assert_eq!(
            operation,
            Operation::Compare {
                operator: Comparison::Equal,
                operand: Operand {
                    atom: Atom::String(b"salad"),
                    negated: false,
                },
            },
        );
        assert_eq!(next_operation(expression, cursor), Ok(None));
        assert_eq!(
            parse_for_clause(b" key, value in items | entries "),
            Ok(ForClause {
                bindings: b"key, value",
                iterable: b"items | entries ",
            }),
        );
        let clause = parse_for_clause(b" a, b, c, d in values ").unwrap();
        assert_eq!(clause.bindings, b"a, b, c, d");
        let (first, cursor) = next_binding(clause.bindings, 0).unwrap().unwrap();
        let (second, cursor) = next_binding(clause.bindings, cursor).unwrap().unwrap();
        let (third, cursor) = next_binding(clause.bindings, cursor).unwrap().unwrap();
        let (fourth, cursor) = next_binding(clause.bindings, cursor).unwrap().unwrap();
        assert_eq!([first, second, third, fourth], [b"a", b"b", b"c", b"d"]);
        assert_eq!(next_binding(clause.bindings, cursor), Ok(None));
        assert_eq!(
            parse_set_clause(b" value = source | default('fallback') "),
            Ok(SetClause {
                targets: b"value",
                expression: Some(b"source | default('fallback')"),
            }),
        );
        assert_eq!(
            parse_set_clause(b" x, y, z "),
            Ok(SetClause {
                targets: b"x, y, z",
                expression: None,
            }),
        );

        let parameters = br#"x, y=2, z="value""#;
        let first = next_macro_parameter(parameters, 0).unwrap().unwrap();
        assert_eq!(first.name, b"x");
        assert_eq!(first.default, None);
        let second = next_macro_parameter(parameters, first.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(second.name, b"y");
        assert_eq!(second.default, Some(Atom::Number(b"2")));
        let third = next_macro_parameter(parameters, second.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(third.name, b"z");
        assert_eq!(third.default, Some(Atom::String(b"value")));
        assert_eq!(
            next_macro_parameter(parameters, third.next_cursor),
            Ok(None),
        );

        let arguments = b"1, z=3";
        let first = next_macro_argument(arguments, 0).unwrap().unwrap();
        assert_eq!(first.name, None);
        assert_eq!(first.value, Atom::Number(b"1"));
        let second = next_macro_argument(arguments, first.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(second.name, Some(b"z".as_slice()));
        assert_eq!(second.value, Atom::Number(b"3"));
        assert_eq!(next_macro_argument(arguments, second.next_cursor), Ok(None));

        let expression = b"3 + 4 - 5 * 6 / 10";
        assert_eq!(
            parse_base(expression),
            Ok((Atom::Arithmetic(expression), expression.len(), false)),
        );
        assert_eq!(
            split_binary_expression(expression),
            Ok(Some(BinaryExpression {
                left: b"3",
                operator: BinaryOperator::Add,
                right: b"4 - 5 * 6 / 10",
            })),
        );
        assert_eq!(
            split_binary_expression(b"1 + 2 + 3"),
            Ok(Some(BinaryExpression {
                left: b"1 + 2",
                operator: BinaryOperator::Add,
                right: b"3",
            })),
        );
        assert_eq!(
            split_binary_expression(br#"(1 + 2) ~ "x~y""#),
            Ok(Some(BinaryExpression {
                left: b"(1 + 2)",
                operator: BinaryOperator::Concat,
                right: br#""x~y""#,
            })),
        );
        let comparison = b"3 + 4 == 7";
        let (base, cursor, _) = parse_base(comparison).unwrap();
        assert_eq!(base, Atom::Arithmetic(b"3 + 4"));
        assert_eq!(
            next_operation(comparison, cursor),
            Ok(Some((
                Operation::Compare {
                    operator: Comparison::Equal,
                    operand: Operand {
                        atom: Atom::Number(b"7"),
                        negated: false,
                    },
                },
                comparison.len(),
            ))),
        );
        assert_eq!(
            parse_base(br#""yes" if value is odd else "no""#),
            Ok((
                Atom::InlineIf {
                    body: br#""yes""#,
                    condition: b"value is odd",
                    alternative: Some(br#""no""#),
                },
                31,
                false,
            )),
        );
        assert_eq!(
            parse_base(br#""if else" if enabled"#),
            Ok((
                Atom::InlineIf {
                    body: br#""if else""#,
                    condition: b"enabled",
                    alternative: None,
                },
                20,
                false,
            )),
        );

        let (array, cursor, _) = parse_base(br#"[1, "two", { three: 3 }]"#).unwrap();
        assert_eq!(array, Atom::Array(br#"1, "two", { three: 3 }"#),);
        assert_eq!(cursor, 24);
        let Atom::Array(elements) = array else {
            panic!("expected array");
        };
        let (_, cursor) = next_argument(elements, 0).unwrap().unwrap();
        let (_, cursor) = next_argument(elements, cursor).unwrap().unwrap();
        let (record, cursor) = next_argument(elements, cursor).unwrap().unwrap();
        assert_eq!(next_argument(elements, cursor), Ok(None));
        let Atom::Record(entries) = record else {
            panic!("expected record");
        };
        assert_eq!(
            next_record_entry(entries, 0),
            Ok(Some(RecordEntry {
                key: b"three",
                value: Atom::Number(b"3"),
                next_cursor: entries.len(),
            })),
        );
    }
}
