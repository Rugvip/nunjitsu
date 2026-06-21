fn evaluate_sync_expression(state_offset: u32, expression: &[u16]) -> Result<u32, u32> {
    let (atom, mut cursor, negated) =
        parse_base(expression).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    let mut current = resolve_operand(state_offset, Operand { atom, negated })?;
    while let Some((operation, next_cursor)) =
        next_operation(expression, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        current = match operation {
            Operation::Compare { operator, operand } => {
                let right = resolve_operand(state_offset, operand)?;
                write_boolean(compare_values(current, operator, right)?)?
            }
            Operation::And(operand) => {
                if Value::at(current)?.truthy() {
                    resolve_operand(state_offset, operand)?
                } else {
                    current
                }
            }
            Operation::Or(operand) => {
                if Value::at(current)?.truthy() {
                    return Ok(current);
                }
                resolve_operand(state_offset, operand)?
            }
            Operation::Filter(call) => apply_builtin_filter(state_offset, call, current)?
                .ok_or(ERROR_INVALID_EXPRESSION)?,
            Operation::Test { call, negated } => {
                let result = apply_builtin_test(state_offset, call, current)?
                    .ok_or(ERROR_INVALID_EXPRESSION)?;
                write_boolean(if negated { !result } else { result })?
            }
        };
        cursor = next_cursor;
    }
    Ok(current)
}

fn evaluate_binary_expression(state_offset: u32, expression: &[u16]) -> Result<u32, u32> {
    let binary = split_binary_expression(expression)
        .map_err(|_| ERROR_INVALID_EXPRESSION)?
        .ok_or(ERROR_INVALID_EXPRESSION)?;
    let left = evaluate_sync_expression(state_offset, binary.left)?;
    let right = evaluate_sync_expression(state_offset, binary.right)?;
    apply_binary_operator(left, binary.operator, right)
}

fn apply_binary_operator(
    left_offset: u32,
    operator: BinaryOperator,
    right_offset: u32,
) -> Result<u32, u32> {
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    if operator == BinaryOperator::Concat
        || (operator == BinaryOperator::Add
            && (left.string_bytes().is_some() || right.string_bytes().is_some()))
    {
        return concatenate_values(left_offset, right_offset);
    }
    let left = left.as_number();
    let right = right.as_number();
    let result = match operator {
        BinaryOperator::Add => left + right,
        BinaryOperator::Subtract => left - right,
        BinaryOperator::Multiply => left * right,
        BinaryOperator::Divide => left / right,
        BinaryOperator::FloorDivide => libm::floor(left / right),
        BinaryOperator::Remainder => left % right,
        BinaryOperator::Power => libm::pow(left, right),
        BinaryOperator::Concat => return Err(ERROR_INVALID_EXPRESSION),
    };
    write_computed_number(result)
}

fn concatenate_values(left_offset: u32, right_offset: u32) -> Result<u32, u32> {
    let left = rendered_value(left_offset)?.bytes;
    let right = rendered_value(right_offset)?.bytes;
    let length = left
        .len()
        .checked_add(right.len())
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_STRING, length as u32)?;
    let output = mutable_record_at(offset, TAG_STRING)?;
    output[..left.len()].copy_from_slice(left);
    output[left.len()..].copy_from_slice(right);
    Ok(offset)
}
fn compare_values(left_offset: u32, operator: Comparison, right_offset: u32) -> Result<bool, u32> {
    let result = match operator {
        Comparison::Equal => values_equal(left_offset, right_offset, false)?,
        Comparison::StrictEqual => values_equal(left_offset, right_offset, true)?,
        Comparison::NotEqual => !values_equal(left_offset, right_offset, false)?,
        Comparison::StrictNotEqual => !values_equal(left_offset, right_offset, true)?,
        Comparison::Less => values_order(left_offset, right_offset)? == core::cmp::Ordering::Less,
        Comparison::LessOrEqual => {
            values_order(left_offset, right_offset)? != core::cmp::Ordering::Greater
        }
        Comparison::Greater => {
            values_order(left_offset, right_offset)? == core::cmp::Ordering::Greater
        }
        Comparison::GreaterOrEqual => {
            values_order(left_offset, right_offset)? != core::cmp::Ordering::Less
        }
        Comparison::In => value_contains(right_offset, left_offset)?,
        Comparison::NotIn => !value_contains(right_offset, left_offset)?,
    };
    Ok(result)
}

fn values_equal(left_offset: u32, right_offset: u32, strict: bool) -> Result<bool, u32> {
    if left_offset == right_offset {
        return Ok(true);
    }
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    let result = match (left, right) {
        (Value::Undefined, Value::Undefined) | (Value::Null, Value::Null) => true,
        (Value::Undefined, Value::Null) | (Value::Null, Value::Undefined) => !strict,
        (Value::Boolean(left), Value::Boolean(right)) => left == right,
        (Value::Number { numeric: left, .. }, Value::Number { numeric: right, .. }) => {
            left == right
        }
        (
            Value::String(left) | Value::SafeString(left),
            Value::String(right) | Value::SafeString(right),
        ) => left == right,
        (Value::Array(_), Value::Array(_)) | (Value::Record(_), Value::Record(_)) => false,
        (left, right) if !strict => left.as_number() == right.as_number(),
        _ => false,
    };
    Ok(result)
}

fn values_order(left_offset: u32, right_offset: u32) -> Result<core::cmp::Ordering, u32> {
    let left = Value::at(left_offset)?;
    let right = Value::at(right_offset)?;
    if let (Some(left), Some(right)) = (left.string_bytes(), right.string_bytes()) {
        return Ok(left.cmp(right));
    }
    left.as_number()
        .partial_cmp(&right.as_number())
        .ok_or(ERROR_INVALID_EXPRESSION)
}

fn value_contains(container_offset: u32, needle_offset: u32) -> Result<bool, u32> {
    let container = Value::at(container_offset)?;
    match container {
        Value::String(value) | Value::SafeString(value) => {
            let rendered = rendered_value(needle_offset)?.bytes;
            if rendered.is_empty() {
                return Ok(true);
            }
            Ok(value
                .windows(rendered.len())
                .any(|window| window == rendered))
        }
        Value::Array(array) => {
            for index in 0..array.count {
                let value_offset = read_u32(array.payload, 4 + index * 4)?;
                if values_equal(value_offset, needle_offset, false)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Value::Record(record) => {
            let key = rendered_value(needle_offset)?.bytes;
            Ok(record.get_offset(key).is_some())
        }
        _ => Err(ERROR_INVALID_EXPRESSION),
    }
}

fn resolve_atom(state_offset: u32, atom: Atom<'_>) -> Result<u32, u32> {
    match atom {
        Atom::Lookup(path) => {
            let context_offset = state_field(state_offset, STATE_CONTEXT)?;
            let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
            if let Some(offset) = context.lookup_offset(path) {
                return Ok(offset);
            }
            let simple_name = next_lookup_segment(path, 0)
                .map_err(|_| ERROR_INVALID_EXPRESSION)?
                .filter(|(_, cursor)| *cursor == path.len())
                .map(|(name, _)| name);
            if let Some(name) = simple_name
                && let Some(definition) = resolve_macro(state_offset, code_units_as_utf8(name)?)?
            {
                return Ok(definition);
            }
            allocate_record(TAG_UNDEFINED, 0)
        }
        Atom::Slice {
            target,
            start,
            stop,
            step,
        } => {
            let target = resolve_atom(state_offset, Atom::Lookup(target))?;
            slice_lookup_value(state_offset, target, start, stop, step)
        }
        Atom::String(value) => write_string_literal(value),
        Atom::Number(value) => write_number(value),
        Atom::Regex(value) => write_code_units_record(TAG_REGEX, value),
        Atom::Boolean(value) => write_boolean(value),
        Atom::Null => allocate_record(TAG_NULL, 0),
        Atom::Undefined => allocate_record(TAG_UNDEFINED, 0),
        Atom::Call(call) => {
            if resolve_capability(
                state_field(state_offset, STATE_GLOBALS)?,
                code_units_as_utf8(call.name)?,
            )?
            .is_some()
            {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            apply_builtin_call(state_offset, call)?.ok_or(ERROR_INVALID_EXPRESSION)
        }
        Atom::Group(expression) => {
            if has_top_level_comma(expression).map_err(|_| ERROR_INVALID_EXPRESSION)? {
                write_array_literal(state_offset, expression)
            } else {
                evaluate_sync_expression(state_offset, expression)
            }
        }
        Atom::Array(elements) => write_array_literal(state_offset, elements),
        Atom::Record(entries) => write_record_literal(state_offset, entries),
        Atom::Arithmetic(expression) => evaluate_binary_expression(state_offset, expression),
        Atom::InlineIf {
            body,
            condition,
            alternative,
        } => {
            let condition = evaluate_sync_expression(state_offset, condition)?;
            if Value::at(condition)?.truthy() {
                evaluate_sync_expression(state_offset, body)
            } else if let Some(alternative) = alternative {
                evaluate_sync_expression(state_offset, alternative)
            } else {
                allocate_record(TAG_UNDEFINED, 0)
            }
        }
    }
}

fn slice_lookup_value(
    state_offset: u32,
    value_offset: u32,
    start: Option<&[u16]>,
    stop: Option<&[u16]>,
    step: Option<&[u16]>,
) -> Result<u32, u32> {
    let source_offset = match Value::at(value_offset)? {
        Value::Array(_) => value_offset,
        Value::String(_) | Value::SafeString(_) => list_value(value_offset)?,
        Value::Undefined | Value::Null => allocate_value_array(0)?,
        _ => return Err(ERROR_INVALID_EXPRESSION),
    };
    let Value::Array(source) = Value::at(source_offset)? else {
        return Err(ERROR_INVALID_ARENA);
    };
    let length = source.count as f64;
    let step = slice_expression_number(state_offset, step)?.unwrap_or(1.0);
    if step == 0.0 || !step.is_finite() {
        return Err(ERROR_INVALID_EXPRESSION);
    }
    let mut start_value = slice_expression_number(state_offset, start)?.unwrap_or(if step < 0.0 {
        length - 1.0
    } else {
        0.0
    });
    let stop_value = slice_expression_number(state_offset, stop)?;
    let mut stop_value = stop_value.unwrap_or(if step < 0.0 { -1.0 } else { length });
    if stop.is_some() && stop_value < 0.0 {
        stop_value += length;
    }
    if start_value < 0.0 {
        start_value += length;
    }
    let mut count = 0usize;
    let mut index = start_value;
    while slice_index_in_bounds(index, stop_value, step, length) {
        charge_counter(state_offset, STATE_WORK_UNITS, STATE_LIMIT_WORK_UNITS, 1)?;
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        index += step;
    }
    let output = allocate_value_array(count)?;
    index = start_value;
    for output_index in 0..count {
        let value = if libm::trunc(index) == index && index >= 0.0 && index < length {
            read_u32(source.payload, 4 + index as usize * 4)?
        } else {
            allocate_record(TAG_UNDEFINED, 0)?
        };
        write_u32(
            mutable_record_at(output, TAG_ARRAY)?,
            4 + output_index * 4,
            value,
        )?;
        index += step;
    }
    Ok(output)
}

fn slice_expression_number(
    state_offset: u32,
    expression: Option<&[u16]>,
) -> Result<Option<f64>, u32> {
    let Some(expression) = expression else {
        return Ok(None);
    };
    let value = Value::at(evaluate_sync_expression(state_offset, expression)?)?.as_number();
    if value.is_finite() {
        Ok(Some(value))
    } else {
        Err(ERROR_INVALID_EXPRESSION)
    }
}

fn slice_index_in_bounds(index: f64, stop: f64, step: f64, length: f64) -> bool {
    if index < 0.0 || index > length {
        return false;
    }
    if step > 0.0 {
        index < stop
    } else {
        index > stop
    }
}

fn write_string_literal(value: &[u16]) -> Result<u32, u32> {
    let value = code_units_as_utf8(value)?;
    let text = core::str::from_utf8(value).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    let mut length = 0usize;
    string_literal_emit(text, &mut |segment| {
        length = length
            .checked_add(segment.len())
            .ok_or(ERROR_RESOURCE_LIMIT)?;
        Ok(())
    })?;
    let offset = allocate_record(
        TAG_STRING,
        u32::try_from(length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
    )?;
    let output = mutable_record_at(offset, TAG_STRING)?;
    let mut cursor = 0usize;
    string_literal_emit(text, &mut |segment| {
        write_coerced_bytes(output, &mut cursor, segment)
    })?;
    Ok(offset)
}

fn string_literal_emit(
    value: &str,
    emit: &mut impl FnMut(&[u8]) -> Result<(), u32>,
) -> Result<(), u32> {
    let mut characters = value.char_indices();
    while let Some((start, character)) = characters.next() {
        if character != '\\' {
            let end = start + character.len_utf8();
            emit(&value.as_bytes()[start..end])?;
            continue;
        }
        let (_, escaped) = characters.next().ok_or(ERROR_INVALID_EXPRESSION)?;
        match escaped {
            'n' => emit(b"\n")?,
            't' => emit(b"\t")?,
            'r' => emit(b"\r")?,
            _ => {
                let mut encoded = [0u8; 4];
                emit(escaped.encode_utf8(&mut encoded).as_bytes())?;
            }
        }
    }
    Ok(())
}

fn write_array_literal(state_offset: u32, elements: &[u16]) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some((_, next)) =
        next_argument(elements, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = next;
    }
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(4).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_ARRAY, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_ARRAY)?, 0, count as u32)?;
    cursor = 0;
    let mut index = 0usize;
    while let Some((atom, next)) =
        next_argument(elements, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let value_offset = resolve_atom(state_offset, atom)?;
        write_u32(
            mutable_record_at(offset, TAG_ARRAY)?,
            4 + index * 4,
            value_offset,
        )?;
        index += 1;
        cursor = next;
    }
    Ok(offset)
}

fn write_record_literal(state_offset: u32, entries: &[u16]) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some(entry) =
        next_record_entry(entries, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = entry.next_cursor;
    }
    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(8).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let offset = allocate_record(TAG_RECORD, payload_length)?;
    write_u32(mutable_record_at(offset, TAG_RECORD)?, 0, count as u32)?;
    cursor = 0;
    let mut index = 0usize;
    while let Some(entry) =
        next_record_entry(entries, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        let key_offset = write_code_units_record(TAG_STRING, entry.key)?;
        let value_offset = resolve_atom(state_offset, entry.value)?;
        let record = mutable_record_at(offset, TAG_RECORD)?;
        write_u32(record, 4 + index * 8, key_offset)?;
        write_u32(record, 8 + index * 8, value_offset)?;
        index += 1;
        cursor = entry.next_cursor;
    }
    Ok(offset)
}
