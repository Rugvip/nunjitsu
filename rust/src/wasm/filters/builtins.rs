fn apply_builtin_filter(
    state_offset: u32,
    call: Call<'_>,
    input_offset: u32,
) -> Result<Option<u32>, u32> {
    let input = Value::at(input_offset)?;
    let name = code_units_as_utf8(call.name)?;
    let output = match name {
        b"abs" => {
            require_argument_count(call, 0)?;
            let number = input.as_number();
            if number.is_nan() {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            write_computed_number(libm::fabs(number))?
        }
        b"batch" => {
            let count = argument_count(call)?;
            if !(1..=2).contains(&count) {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let size = numeric_usize(
                call_positional_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?,
            )?;
            batch_value(
                input_offset,
                size,
                call_positional_argument(state_offset, call, 1)?,
            )?
        }
        b"center" => {
            if argument_count(call)? > 1 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let width = if let Some(value) = call_argument(state_offset, call, 0)? {
                numeric_usize(value)?
            } else {
                80
            };
            center_value(input_offset, width)?
        }
        b"safe" => {
            require_argument_count(call, 0)?;
            let rendered = rendered_value(input_offset)?;
            write_bytes_record(TAG_SAFE_STRING, rendered.bytes)?
        }
        b"escape" | b"e" => {
            require_argument_count(call, 0)?;
            if matches!(input, Value::SafeString(_)) {
                input_offset
            } else {
                write_escaped_string(rendered_value(input_offset)?.bytes)?
            }
        }
        b"forceescape" => {
            require_argument_count(call, 0)?;
            write_escaped_string(rendered_value(input_offset)?.bytes)?
        }
        b"default" | b"d" => {
            let count = argument_count(call)?;
            if !(1..=2).contains(&count) {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let use_falsy = if count == 2 {
                Value::at(call_argument(state_offset, call, 1)?.ok_or(ERROR_INVALID_EXPRESSION)?)?
                    .truthy()
            } else {
                false
            };
            if matches!(input, Value::Undefined) || (use_falsy && !input.truthy()) {
                call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?
            } else {
                input_offset
            }
        }
        b"dictsort" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let case_sensitive = call_positional_argument(state_offset, call, 0)?
                .is_some_and(|value| Value::at(value).is_ok_and(Value::truthy));
            let by_value = call_positional_argument(state_offset, call, 1)?;
            let by_value = if let Some(value) = by_value {
                rendered_value(value)?.bytes == b"value"
            } else {
                false
            };
            dictsort_value(input_offset, case_sensitive, by_value)?
        }
        b"dump" => {
            if argument_count(call)? > 1 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            dump_value(
                input_offset,
                call_positional_argument(state_offset, call, 0)?,
            )?
        }
        b"float" => {
            if argument_count(call)? > 1 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let number = input.as_number();
            if number.is_nan() {
                call_argument(state_offset, call, 0)?.unwrap_or(write_computed_number(0.0)?)
            } else {
                write_computed_number(number)?
            }
        }
        b"groupby" => {
            require_argument_count(call, 1)?;
            let attribute =
                call_positional_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            groupby_value(input_offset, attribute)?
        }
        b"int" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let base = if let Some(value) = call_named_argument(state_offset, call, b"base")?
                .or(call_argument(state_offset, call, 1)?)
            {
                numeric_usize(value)?
            } else {
                10
            };
            if let Some(number) = parse_integer(input_offset, base)? {
                write_computed_number(number as f64)?
            } else {
                call_argument(state_offset, call, 0)?.unwrap_or(write_computed_number(0.0)?)
            }
        }
        b"indent" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let width = if let Some(value) = call_argument(state_offset, call, 0)? {
                numeric_usize(value)?
            } else {
                4
            };
            let first = call_argument(state_offset, call, 1)?
                .is_some_and(|value| Value::at(value).is_ok_and(Value::truthy));
            indent_value(input_offset, width, first)?
        }
        b"join" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            join_value(
                input_offset,
                call_argument(state_offset, call, 0)?,
                call_argument(state_offset, call, 1)?,
            )?
        }
        b"list" => {
            require_argument_count(call, 0)?;
            list_value(input_offset)?
        }
        b"nl2br" => {
            require_argument_count(call, 0)?;
            nl2br_value(input_offset)?
        }
        b"random" => {
            require_argument_count(call, 0)?;
            random_value(input_offset)?
        }
        b"reverse" => {
            require_argument_count(call, 0)?;
            reverse_value(input)?
        }
        b"reject" | b"select" => {
            select_or_reject_value(state_offset, input_offset, call, name == b"select")?
        }
        b"rejectattr" | b"selectattr" => {
            require_argument_count(call, 1)?;
            let attribute =
                call_positional_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            select_or_reject_attribute_value(input_offset, attribute, name == b"selectattr")?
        }
        b"upper" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, true, false)?
        }
        b"lower" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, false, false)?
        }
        b"capitalize" => {
            require_argument_count(call, 0)?;
            ascii_case_value(input_offset, false, true)?
        }
        b"title" => {
            require_argument_count(call, 0)?;
            title_value(input_offset)?
        }
        b"replace" => {
            let count = argument_count(call)?;
            if !(2..=3).contains(&count) {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let from = call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            let to = call_argument(state_offset, call, 1)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            let limit = if matches!(Value::at(from)?, Value::Regex(_)) {
                usize::MAX
            } else if count == 3 {
                let value =
                    call_argument(state_offset, call, 2)?.ok_or(ERROR_INVALID_EXPRESSION)?;
                let number = Value::at(value)?.as_number();
                if number == -1.0 || number == f64::INFINITY {
                    usize::MAX
                } else if !number.is_finite() || number <= 0.0 {
                    0
                } else {
                    libm::ceil(number).min(usize::MAX as f64) as usize
                }
            } else {
                usize::MAX
            };
            replace_value(input_offset, from, to, limit)?
        }
        b"round" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let precision = if let Some(value) = call_argument(state_offset, call, 0)? {
                numeric_usize(value)?
            } else {
                0
            };
            let method = call_argument(state_offset, call, 1)?;
            round_value(input_offset, precision, method)?
        }
        b"slice" => {
            let count = argument_count(call)?;
            if !(1..=2).contains(&count) {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let slices = numeric_usize(
                call_positional_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?,
            )?;
            slice_value(
                input_offset,
                slices,
                call_positional_argument(state_offset, call, 1)?,
            )?
        }
        b"sort" => {
            if argument_count(call)? > 3 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let reverse = call_positional_argument(state_offset, call, 0)?
                .is_some_and(|value| Value::at(value).is_ok_and(Value::truthy));
            let case_sensitive = call_positional_argument(state_offset, call, 1)?
                .is_some_and(|value| Value::at(value).is_ok_and(Value::truthy));
            let attribute = call_named_argument(state_offset, call, b"attribute")?
                .or(call_positional_argument(state_offset, call, 2)?);
            sort_value(input_offset, reverse, case_sensitive, attribute)?
        }
        b"string" => {
            require_argument_count(call, 0)?;
            let rendered = rendered_value(input_offset)?;
            write_bytes_record(
                if rendered.safe {
                    TAG_SAFE_STRING
                } else {
                    TAG_STRING
                },
                rendered.bytes,
            )?
        }
        b"striptags" => {
            if argument_count(call)? > 1 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let preserve_linebreaks = call_positional_argument(state_offset, call, 0)?
                .is_some_and(|value| Value::at(value).is_ok_and(Value::truthy));
            striptags_value(input_offset, preserve_linebreaks)?
        }
        b"sum" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let start = if let Some(value) = call_argument(state_offset, call, 1)? {
                Value::at(value)?.as_number()
            } else {
                0.0
            };
            sum_value(input_offset, call_argument(state_offset, call, 0)?, start)?
        }
        b"trim" => {
            require_argument_count(call, 0)?;
            let rendered = rendered_value(input_offset)?;
            write_bytes_record(
                if rendered.safe {
                    TAG_SAFE_STRING
                } else {
                    TAG_STRING
                },
                trim_ascii_whitespace(rendered.bytes),
            )?
        }
        b"truncate" => {
            if argument_count(call)? > 3 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            truncate_value(
                input_offset,
                call_positional_argument(state_offset, call, 0)?,
                call_positional_argument(state_offset, call, 1)?,
                call_positional_argument(state_offset, call, 2)?,
            )?
        }
        b"urlencode" => {
            require_argument_count(call, 0)?;
            urlencode_value(input_offset)?
        }
        b"urlize" => {
            if argument_count(call)? > 2 {
                return Err(ERROR_INVALID_EXPRESSION);
            }
            let length = if let Some(offset) = call_positional_argument(state_offset, call, 0)? {
                let number = Value::at(offset)?.as_number();
                if number.is_nan() {
                    usize::MAX
                } else if number <= 0.0 {
                    0
                } else {
                    libm::trunc(number).min(usize::MAX as f64) as usize
                }
            } else {
                usize::MAX
            };
            let nofollow = call_positional_argument(state_offset, call, 1)?
                .is_some_and(|offset| matches!(Value::at(offset), Ok(Value::Boolean(true))));
            urlize_value(input_offset, length, nofollow)?
        }
        b"wordcount" => {
            require_argument_count(call, 0)?;
            if matches!(input, Value::Undefined | Value::Null) {
                write_string_value(b"")?
            } else {
                let rendered = rendered_value(input_offset)?;
                let count = rendered
                    .bytes
                    .split(u8::is_ascii_whitespace)
                    .filter(|word| !word.is_empty())
                    .count();
                write_computed_number(count as f64)?
            }
        }
        b"length" => {
            require_argument_count(call, 0)?;
            let length = match input {
                Value::Undefined | Value::Null => 0,
                Value::String(value) | Value::SafeString(value) => core::str::from_utf8(value)
                    .map_err(|_| ERROR_INVALID_RECORD)?
                    .chars()
                    .count()
                    as u32,
                Value::Array(array) => array.count as u32,
                Value::Record(record) => record.count as u32,
                _ => 0,
            };
            write_u32_number(length)?
        }
        b"first" => {
            require_argument_count(call, 0)?;
            edge_value(input, false)?
        }
        b"last" => {
            require_argument_count(call, 0)?;
            edge_value(input, true)?
        }
        _ => return Ok(None),
    };
    Ok(Some(output))
}

fn apply_builtin_test(
    state_offset: u32,
    call: Call<'_>,
    input_offset: u32,
) -> Result<Option<bool>, u32> {
    let input = Value::at(input_offset)?;
    let name = code_units_as_utf8(call.name)?;
    let result = match name {
        b"defined" => {
            require_argument_count(call, 0)?;
            !matches!(input, Value::Undefined)
        }
        b"undefined" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Undefined)
        }
        b"none" | b"null" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Null)
        }
        b"truthy" => {
            require_argument_count(call, 0)?;
            input.truthy()
        }
        b"falsy" => {
            require_argument_count(call, 0)?;
            !input.truthy()
        }
        b"boolean" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Boolean(_))
        }
        b"number" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Number { .. })
        }
        b"string" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::String(_) | Value::SafeString(_))
        }
        b"mapping" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Record(_))
        }
        b"iterable" => {
            require_argument_count(call, 0)?;
            matches!(
                input,
                Value::Array(_) | Value::String(_) | Value::SafeString(_)
            )
        }
        b"escaped" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::SafeString(_))
        }
        b"callable" => {
            require_argument_count(call, 0)?;
            matches!(input, Value::Macro)
        }
        b"even" | b"odd" => {
            require_argument_count(call, 0)?;
            let number = input.as_number();
            if name == b"even" {
                number.is_finite() && number % 2.0 == 0.0
            } else {
                number.is_finite() && number % 2.0 == 1.0
            }
        }
        b"divisibleby" => {
            require_argument_count(call, 1)?;
            let divisor =
                Value::at(call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?)?
                    .as_number();
            divisor != 0.0 && input.as_number() % divisor == 0.0
        }
        b"sameas" => {
            require_argument_count(call, 1)?;
            values_equal(
                input_offset,
                call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?,
                true,
            )?
        }
        b"eq" | b"equalto" | b"ne" => {
            require_argument_count(call, 1)?;
            let right = call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            let equal = values_equal(input_offset, right, true)?;
            if name == b"ne" { !equal } else { equal }
        }
        b"lt" | b"lessthan" | b"le" | b"lteq" | b"gt" | b"greaterthan" | b"ge" | b"gteq" => {
            require_argument_count(call, 1)?;
            let right = call_argument(state_offset, call, 0)?.ok_or(ERROR_INVALID_EXPRESSION)?;
            let operator = match name {
                b"lt" | b"lessthan" => Comparison::Less,
                b"le" | b"lteq" => Comparison::LessOrEqual,
                b"gt" | b"greaterthan" => Comparison::Greater,
                _ => Comparison::GreaterOrEqual,
            };
            compare_values(input_offset, operator, right)?
        }
        b"lower" | b"upper" => {
            require_argument_count(call, 0)?;
            let Some(value) = input.string_bytes() else {
                return Ok(Some(false));
            };
            if name == b"lower" {
                !value.iter().any(u8::is_ascii_uppercase)
            } else {
                !value.iter().any(u8::is_ascii_lowercase)
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(result))
}

fn argument_count(call: Call<'_>) -> Result<usize, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    while let Some(argument) =
        next_macro_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        cursor = argument.next_cursor;
    }
    Ok(count)
}

fn require_argument_count(call: Call<'_>, expected: usize) -> Result<(), u32> {
    if argument_count(call)? == expected {
        Ok(())
    } else {
        Err(ERROR_INVALID_EXPRESSION)
    }
}

fn call_argument(state_offset: u32, call: Call<'_>, requested: usize) -> Result<Option<u32>, u32> {
    let mut index = 0usize;
    let mut cursor = 0usize;
    while let Some(argument) =
        next_macro_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if index == requested {
            return resolve_atom(state_offset, argument.value).map(Some);
        }
        index += 1;
        cursor = argument.next_cursor;
    }
    Ok(None)
}

fn call_named_argument(
    state_offset: u32,
    call: Call<'_>,
    requested: &[u8],
) -> Result<Option<u32>, u32> {
    let mut cursor = 0usize;
    while let Some(argument) =
        next_macro_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if argument.name.is_some_and(|name| ascii_eq(name, requested)) {
            return resolve_atom(state_offset, argument.value).map(Some);
        }
        cursor = argument.next_cursor;
    }
    Ok(None)
}

fn call_positional_argument(
    state_offset: u32,
    call: Call<'_>,
    requested: usize,
) -> Result<Option<u32>, u32> {
    let mut cursor = 0usize;
    let mut index = 0usize;
    while let Some(argument) =
        next_macro_argument(call.arguments, cursor).map_err(|_| ERROR_INVALID_EXPRESSION)?
    {
        if argument.name.is_none() {
            if index == requested {
                return resolve_atom(state_offset, argument.value).map(Some);
            }
            index += 1;
        }
        cursor = argument.next_cursor;
    }
    Ok(None)
}

fn write_escaped_string(value: &[u8]) -> Result<u32, u32> {
    let mut byte_length = 0usize;
    let mut code_unit_length = 0usize;
    emit_escaped(value, &mut |segment| {
        byte_length = byte_length
            .checked_add(segment.len())
            .ok_or(RenderError::OutputTooLarge)?;
        code_unit_length = code_unit_length
            .checked_add(
                core::str::from_utf8(segment)
                    .map_err(|_| RenderError::OutputTooLarge)?
                    .encode_utf16()
                    .count(),
            )
            .ok_or(RenderError::OutputTooLarge)?;
        Ok(())
    })
    .map_err(render_error_code)?;
    let code_unit_length = u32::try_from(code_unit_length).map_err(|_| ERROR_RESOURCE_LIMIT)?;
    let (value_start, output) = allocate_value_code_units(code_unit_length)?;
    let mut cursor = 0usize;
    emit_escaped(value, &mut |segment| {
        let segment = core::str::from_utf8(segment).map_err(|_| RenderError::OutputTooLarge)?;
        let segment_length = segment.encode_utf16().count();
        let end = cursor
            .checked_add(segment_length)
            .ok_or(RenderError::OutputTooLarge)?;
        for (destination, code_unit) in output[cursor..end]
            .iter_mut()
            .zip(segment.encode_utf16())
        {
            *destination = code_unit;
        }
        cursor = end;
        Ok(())
    })
    .map_err(render_error_code)?;
    write_materialized_code_unit_value(
        value_start,
        code_unit_length,
        u32::try_from(byte_length).map_err(|_| ERROR_RESOURCE_LIMIT)?,
        true,
    )
}
