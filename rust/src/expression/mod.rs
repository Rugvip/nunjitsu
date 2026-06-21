/// One host-call syntax node with raw argument source.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Call<'a> {
    /// Template-visible capability name.
    pub name: &'a [u16],
    /// Comma-separated argument source without parentheses.
    pub arguments: &'a [u16],
}

/// One directly resolvable expression atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Atom<'a> {
    /// A dotted lookup into the copied render context.
    Lookup(&'a [u16]),
    /// A Jinja-compatible slice over one copied lookup value.
    Slice {
        /// Lookup path evaluated before slicing.
        target: &'a [u16],
        /// Optional inclusive starting-index expression.
        start: Option<&'a [u16]>,
        /// Optional exclusive stopping-index expression.
        stop: Option<&'a [u16]>,
        /// Optional step expression.
        step: Option<&'a [u16]>,
    },
    /// A UTF-8 string literal without its quotes.
    String(&'a [u16]),
    /// A decimal numeric literal retained in source form.
    Number(&'a [u16]),
    /// A Nunjucks regular-expression literal retained in rendered `/.../flags` form.
    Regex(&'a [u16]),
    /// A boolean literal.
    Boolean(bool),
    /// The null/none literal.
    Null,
    /// The undefined literal.
    Undefined,
    /// A callable global expression.
    Call(Call<'a>),
    /// A parenthesized expression evaluated as one operand.
    Group(&'a [u16]),
    /// An array literal's comma-separated element source.
    Array(&'a [u16]),
    /// An object literal's comma-separated entry source.
    Record(&'a [u16]),
    /// An arithmetic or concatenation expression evaluated with precedence.
    Arithmetic(&'a [u16]),
    /// A lazy inline conditional expression.
    InlineIf {
        /// Expression evaluated when the condition is truthy.
        body: &'a [u16],
        /// Expression whose truthiness selects the branch.
        condition: &'a [u16],
        /// Optional expression evaluated when the condition is falsey.
        alternative: Option<&'a [u16]>,
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
    pub left: &'a [u16],
    /// Selected lowest-precedence operator.
    pub operator: BinaryOperator,
    /// Source to the right of the selected operator.
    pub right: &'a [u16],
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
pub fn has_top_level_comma(expression: &[u16]) -> Result<bool, ExpressionError> {
    let mut cursor = 0usize;
    let mut quote = None;
    let mut parentheses = 0usize;
    let mut brackets = 0usize;
    let mut braces = 0usize;
    while let Some(byte) = expression.get(cursor).copied() {
        if let Some(active_quote) = quote {
            if byte == CU_BACKSLASH {
                cursor = cursor.checked_add(2).ok_or(ExpressionError)?;
                continue;
            }
            if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, CU_APOSTROPHE | CU_QUOTE) {
            quote = Some(byte);
            cursor += 1;
            continue;
        }
        if byte == CU_R
            && expression.get(cursor + 1) == Some(&CU_SLASH)
            && (cursor == 0
                || expression[..cursor].last().is_some_and(|previous| {
                    is_ascii_whitespace(*previous) || *previous == CU_COMMA
                }))
        {
            let (_, next) = parse_regex(expression, cursor)?;
            cursor = next;
            continue;
        }
        match byte {
            CU_OPEN_PAREN => parentheses += 1,
            CU_OPEN_BRACKET => brackets += 1,
            CU_OPEN_BRACE => braces += 1,
            CU_CLOSE_PAREN => parentheses = parentheses.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACKET => brackets = brackets.checked_sub(1).ok_or(ExpressionError)?,
            CU_CLOSE_BRACE => braces = braces.checked_sub(1).ok_or(ExpressionError)?,
            CU_COMMA if parentheses == 0 && brackets == 0 && braces == 0 => return Ok(true),
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
    pub bindings: &'a [u16],
    /// Iterable expression after the `in` keyword.
    pub iterable: &'a [u16],
}

/// One parsed object-literal entry and the cursor of the following entry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RecordEntry<'a> {
    /// UTF-8 key without quotes.
    pub key: &'a [u16],
    /// Parsed entry value.
    pub value: Atom<'a>,
    /// Cursor after this entry and its comma.
    pub next_cursor: usize,
}

/// Parsed target names and optional value expression for an assignment directive.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SetClause<'a> {
    /// Comma-separated ordered assignment identifiers.
    pub targets: &'a [u16],
    /// Complete expression after `=`, or `None` for a capture block.
    pub expression: Option<&'a [u16]>,
}

/// One macro definition parameter and optional default atom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MacroParameter<'a> {
    /// Template-visible parameter name.
    pub name: &'a [u16],
    /// Default value evaluated when the call does not supply this parameter.
    pub default: Option<Atom<'a>>,
    /// Cursor of the following parameter.
    pub next_cursor: usize,
}

/// One positional or named macro call argument.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MacroArgument<'a> {
    /// Explicit target parameter for a keyword argument.
    pub name: Option<&'a [u16]>,
    /// Argument value atom evaluated in caller scope.
    pub value: Atom<'a>,
    /// Cursor of the following argument.
    pub next_cursor: usize,
}

/// One call-block clause with optional caller parameters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CallBlock<'a> {
    /// Comma-separated names bound when the macro invokes `caller`.
    pub bindings: &'a [u16],
    /// Macro invoked with the captured caller body.
    pub call: Call<'a>,
}

/// One `{% import expression as name %}` clause.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImportClause<'a> {
    /// Template-name expression resolved through configured loaders.
    pub template: &'a [u16],
    /// Local namespace binding populated by the import.
    pub alias: &'a [u16],
    /// Whether the imported template receives the caller context.
    pub with_context: bool,
}

/// One `{% from expression import names %}` clause.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FromImportClause<'a> {
    /// Template-name expression resolved through configured loaders.
    pub template: &'a [u16],
    /// Comma-separated imported names and aliases.
    pub bindings: &'a [u16],
    /// Whether the imported template receives the caller context.
    pub with_context: bool,
}

/// One imported name and its local alias.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImportBinding<'a> {
    /// Exported template name.
    pub name: &'a [u16],
    /// Local name, equal to `name` when no alias is present.
    pub alias: &'a [u16],
    /// Cursor of the following binding.
    pub next_cursor: usize,
}

include!("base.rs");
include!("arguments.rs");
include!("directives.rs");
include!("atoms.rs");
const CU_APOSTROPHE: u16 = 0x27;
const CU_QUOTE: u16 = 0x22;
const CU_BACKSLASH: u16 = b'\\' as u16;
const CU_OPEN_PAREN: u16 = 0x28;
const CU_CLOSE_PAREN: u16 = 0x29;
const CU_OPEN_BRACKET: u16 = 0x5b;
const CU_CLOSE_BRACKET: u16 = 0x5d;
const CU_OPEN_BRACE: u16 = 0x7b;
const CU_CLOSE_BRACE: u16 = 0x7d;
const CU_COMMA: u16 = 0x2c;
const CU_COLON: u16 = 0x3a;
const CU_DOT: u16 = 0x2e;
const CU_PLUS: u16 = 0x2b;
const CU_MINUS: u16 = 0x2d;
const CU_STAR: u16 = 0x2a;
const CU_SLASH: u16 = 0x2f;
const CU_PERCENT: u16 = 0x25;
const CU_TILDE: u16 = 0x7e;
const CU_PIPE: u16 = 0x7c;
const CU_EQUALS: u16 = 0x3d;
const CU_BANG: u16 = 0x21;
const CU_LESS: u16 = 0x3c;
const CU_GREATER: u16 = 0x3e;
const CU_UNDERSCORE: u16 = 0x5f;
const CU_R: u16 = 0x72;
const CU_G: u16 = 0x67;
const CU_I: u16 = 0x69;
const CU_M: u16 = 0x6d;
const CU_Y: u16 = 0x79;

fn is_ascii_whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|character| character.is_ascii_whitespace())
}

fn is_ascii_alphabetic(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|character| character.is_ascii_alphabetic())
}

fn is_ascii_digit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(|character| character.is_ascii_digit())
}

pub(crate) fn ascii_eq(units: &[u16], ascii: &[u8]) -> bool {
    units.len() == ascii.len()
        && units
            .iter()
            .copied()
            .zip(ascii.iter().copied())
            .all(|(unit, byte)| unit == u16::from(byte))
}

pub(crate) fn starts_with_ascii(units: &[u16], ascii: &[u8]) -> bool {
    units
        .get(..ascii.len())
        .is_some_and(|prefix| ascii_eq(prefix, ascii))
}

include!("tests.rs");
