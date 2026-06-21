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
    /// A Jinja-compatible slice over one copied lookup value.
    Slice {
        /// Lookup path evaluated before slicing.
        target: &'a [u8],
        /// Optional inclusive starting-index expression.
        start: Option<&'a [u8]>,
        /// Optional exclusive stopping-index expression.
        stop: Option<&'a [u8]>,
        /// Optional step expression.
        step: Option<&'a [u8]>,
    },
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

/// Reports whether a parenthesized expression contains a top-level tuple separator.
pub fn has_top_level_comma(expression: &[u8]) -> Result<bool, ExpressionError> {
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
        if byte == b'r'
            && expression.get(cursor + 1) == Some(&b'/')
            && (cursor == 0
                || expression[..cursor]
                    .last()
                    .is_some_and(|previous| previous.is_ascii_whitespace() || *previous == b','))
        {
            let (_, next) = parse_regex(expression, cursor)?;
            cursor = next;
            continue;
        }
        match byte {
            b'(' => parentheses += 1,
            b'[' => brackets += 1,
            b'{' => braces += 1,
            b')' => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            b']' => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            b'}' => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            b',' if parentheses == 0 && brackets == 0 && braces == 0 => return Ok(true),
            _ => {}
        }
        cursor += 1;
    }
    if quote.is_some() || parentheses != 0 || brackets != 0 || braces != 0 {
        return Err(ExpressionError);
    }
    Ok(false)
}

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

include!("base.rs");
include!("arguments.rs");
include!("directives.rs");
include!("atoms.rs");
include!("tests.rs");
