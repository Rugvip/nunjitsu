fn start_expression(state_offset: u32, expression: &[u8], action: u32) -> Result<Option<u32>, u32> {
    let expression_offset = write_bytes_record(TAG_STRING, expression)?;
    let (base, cursor, negated) = parse_base(expression).map_err(|_| ERROR_INVALID_EXPRESSION)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, cursor as u32)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, 0)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, action)?;

    if let Atom::Call(call) = base {
        let context_offset = state_field(state_offset, STATE_CONTEXT)?;
        let context = Context::new(record_at(context_offset, TAG_RECORD)?, state_offset)?;
        if let Some(definition_offset) = context.lookup_offset(call.name)
            && matches!(Value::at(definition_offset)?, Value::Macro)
        {
            start_macro_call(state_offset, definition_offset, call, negated, 0)?;
            return Ok(None);
        }
        if let Some(definition_offset) = resolve_macro(state_offset, call.name)? {
            start_macro_call(state_offset, definition_offset, call, negated, 0)?;
            return Ok(None);
        }
        let registered =
            resolve_capability(state_field(state_offset, STATE_GLOBALS)?, call.name)?.is_some();
        if !registered && let Some(mut value_offset) = apply_builtin_call(state_offset, call)? {
            if negated {
                value_offset = write_boolean(!Value::at(value_offset)?.truthy())?;
            }
            set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
            return continue_expression(state_offset);
        }
        return issue_capability(
            state_offset,
            CAPABILITY_GLOBAL,
            call,
            None,
            cursor,
            if negated {
                NEGATE_TRUTHINESS
            } else {
                NEGATE_NONE
            },
        )
        .map(Some);
    }
    let mut value_offset = resolve_atom(state_offset, base)?;
    if negated {
        value_offset = write_boolean(!Value::at(value_offset)?.truthy())?;
    }
    set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
    continue_expression(state_offset)
}

fn handle_tag(state_offset: u32, directive: &[u8]) -> Result<Option<u32>, u32> {
    if let Some(source) = directive_keyword(directive, b"from") {
        let clause = parse_from_import_clause(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let bindings = write_bytes_record(TAG_STRING, clause.bindings)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, 0)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, bindings)?;
        set_state_field(
            state_offset,
            STATE_IMPORT_WITH_CONTEXT,
            u32::from(clause.with_context),
        )?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_IMPORT)?;
        return start_expression(state_offset, clause.template, EXPRESSION_IMPORT);
    }
    if let Some(source) = directive_keyword(directive, b"import") {
        let clause = parse_import_clause(source).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let alias = write_bytes_record(TAG_STRING, clause.alias)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_ALIAS, alias)?;
        set_state_field(state_offset, STATE_PENDING_IMPORT_BINDINGS, 0)?;
        set_state_field(
            state_offset,
            STATE_IMPORT_WITH_CONTEXT,
            u32::from(clause.with_context),
        )?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_IMPORT)?;
        return start_expression(state_offset, clause.template, EXPRESSION_IMPORT);
    }
    if let Some(expression) = directive_keyword(directive, b"extends") {
        discard_extends_output(state_offset)?;
        prepare_extending_template(state_offset)?;
        set_state_field(state_offset, STATE_PENDING_LOAD_KIND, LOAD_EXTENDS)?;
        return start_expression(state_offset, expression, EXPRESSION_EXTENDS);
    }
    if let Some(name) = directive_keyword(directive, b"block") {
        start_block(state_offset, name)?;
        return Ok(None);
    }
    if is_endblock(directive) {
        return Ok(None);
    }
    if let Some(clause) = directive_keyword(directive, b"call").or_else(|| {
        directive
            .strip_prefix(b"call")
            .filter(|remainder| remainder.first() == Some(&b'('))
    }) {
        start_call_block(state_offset, clause)?;
        return Ok(None);
    }
    if directive == b"endcall" {
        return finish_macro_call(state_offset);
    }
    if let Some(signature) = directive_keyword(directive, b"macro") {
        define_macro(state_offset, signature)?;
        return Ok(None);
    }
    if directive == b"endmacro" {
        return finish_macro_call(state_offset);
    }
    if let Some(condition) = directive_keyword(directive, b"if") {
        return start_expression(state_offset, condition, EXPRESSION_IF);
    }
    if let Some(expression) = directive_keyword(directive, b"switch") {
        return start_expression(state_offset, expression, EXPRESSION_SWITCH);
    }
    if let Some(clause) = directive_keyword(directive, b"for")
        .or_else(|| directive_keyword(directive, b"asyncEach"))
        .or_else(|| directive_keyword(directive, b"asyncAll"))
    {
        start_for(state_offset, clause)?;
        return Ok(None);
    }
    if let Some(clause) = directive_keyword(directive, b"set") {
        let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
        let bindings = write_bindings(clause.targets)?;
        if let Some(expression) = clause.expression {
            set_state_field(state_offset, STATE_PENDING_SET_BINDINGS, bindings)?;
            return start_expression(state_offset, expression, EXPRESSION_SET);
        }
        begin_capture(state_offset, bindings)?;
        return Ok(None);
    }
    if let Some(filter) = directive_keyword(directive, b"filter") {
        start_filter_block(state_offset, filter)?;
        return Ok(None);
    }
    if directive == b"endfilter" {
        return finish_filter_block(state_offset);
    }
    if directive == b"endset" {
        finish_capture(state_offset)?;
        return Ok(None);
    }
    if matches!(directive, b"endfor" | b"endeach" | b"endall") {
        advance_for(state_offset)?;
        return Ok(None);
    }
    if directive == b"else"
        || directive_keyword(directive, b"elif").is_some()
        || directive_keyword(directive, b"elseif").is_some()
    {
        if directive == b"else" && is_current_loop_else(state_offset)? {
            advance_for(state_offset)?;
        } else {
            skip_active_conditional(state_offset)?;
        }
        return Ok(None);
    }
    if directive == b"endif" {
        return Ok(None);
    }
    if directive_keyword(directive, b"case").is_some() || directive == b"default" {
        skip_active_switch(state_offset)?;
        return Ok(None);
    }
    if directive == b"endswitch" {
        return Ok(None);
    }
    start_tag(state_offset, directive)
}

fn start_filter_block(state_offset: u32, filter: &[u8]) -> Result<(), u32> {
    if filter.is_empty() {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let expression_length = 2u32
        .checked_add(filter.len() as u32)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let expression_offset = allocate_record(TAG_STRING, expression_length)?;
    let expression = mutable_record_at(expression_offset, TAG_STRING)?;
    expression[..2].copy_from_slice(b"| ");
    expression[2..].copy_from_slice(filter);

    let block_offset = allocate_record(TAG_FILTER_BLOCK, FILTER_BLOCK_LENGTH)?;
    let block = mutable_record_at(block_offset, TAG_FILTER_BLOCK)?;
    write_u32(
        block,
        FILTER_BLOCK_PARENT,
        state_field(state_offset, STATE_CURRENT_FILTER_BLOCK)?,
    )?;
    write_u32(
        block,
        FILTER_BLOCK_FRAME,
        state_field(state_offset, STATE_CURRENT_FRAME)?,
    )?;
    write_u32(block, FILTER_BLOCK_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_CURRENT_FILTER_BLOCK, block_offset)?;
    begin_capture(state_offset, 0)
}

fn finish_filter_block(state_offset: u32) -> Result<Option<u32>, u32> {
    let block_offset = state_field(state_offset, STATE_CURRENT_FILTER_BLOCK)?;
    if block_offset == 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let block = record_at(block_offset, TAG_FILTER_BLOCK)?;
    if block.len() != FILTER_BLOCK_LENGTH as usize
        || read_u32(block, FILTER_BLOCK_FRAME)? != state_field(state_offset, STATE_CURRENT_FRAME)?
    {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let expression_offset = read_u32(block, FILTER_BLOCK_EXPRESSION)?;
    let parent = read_u32(block, FILTER_BLOCK_PARENT)?;
    let value_offset = finish_output_capture(state_offset, TAG_SAFE_STRING)?;
    set_state_field(state_offset, STATE_CURRENT_FILTER_BLOCK, parent)?;
    set_state_field(state_offset, STATE_PENDING_EXPRESSION, expression_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_CURSOR, 0)?;
    set_state_field(state_offset, STATE_CURRENT_VALUE, value_offset)?;
    set_state_field(state_offset, STATE_EXPRESSION_ACTION, EXPRESSION_OUTPUT)?;
    continue_expression(state_offset)
}

fn prepare_extending_template(state_offset: u32) -> Result<(), u32> {
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    if read_u32(frame, FRAME_END_CURSOR)? != 0 {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let source_length = source_at(source_offset)?.len();
    let mut cursor = 0usize;
    let mut block_depth = 0usize;
    loop {
        let source = source_at(source_offset)?;
        let (item, next_cursor) =
            next_item_utf16(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let directive = code_units_as_utf8(directive)?;
                if let Some(name) = directive_keyword(directive, b"block") {
                    register_block_definition(
                        state_offset,
                        name,
                        frame_offset,
                        source_offset,
                        next_cursor as u32,
                    )?;
                    block_depth = block_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) {
                    block_depth = block_depth.saturating_sub(1);
                } else if let Some(signature) = directive_keyword(directive, b"macro") {
                    let end_cursor = if block_depth == 0 {
                        register_macro_definition(
                            state_offset,
                            signature,
                            frame_offset,
                            source_offset,
                            frame_canonical_name(frame_offset)?,
                            next_cursor as u32,
                        )? as usize
                    } else {
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?
                    };
                    cursor = end_cursor;
                    continue;
                } else if block_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if let Some(expression) = clause.expression {
                        let bindings = write_bindings(clause.targets)?;
                        let value = evaluate_sync_expression(state_offset, expression)?;
                        assign_bindings(state_offset, bindings, value)?;
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    set_frame_field(frame_offset, FRAME_CURSOR, source_length as u32)
}

fn write_import_namespace(
    state_offset: u32,
    source_offset: u32,
    canonical_offset: u32,
    owner_frame: u32,
) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut cursor = 0usize;
    let mut nested_depth = 0usize;
    loop {
        let source = source_at(source_offset)?;
        let (item, next_cursor) =
            next_item_utf16(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let directive = code_units_as_utf8(directive)?;
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if directive_keyword(directive, b"macro").is_some() {
                    let end_cursor =
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?;
                    if nested_depth == 0 {
                        count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                    }
                    cursor = end_cursor;
                    continue;
                } else if nested_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if clause.expression.is_some() {
                        let mut binding_cursor = 0usize;
                        while let Some((name, next)) = next_binding(clause.targets, binding_cursor)
                            .map_err(|_| ERROR_UNSUPPORTED_TAG)?
                        {
                            if !name.starts_with(b"_") {
                                count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                            }
                            binding_cursor = next;
                        }
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }

    let payload_length = 4u32
        .checked_add((count as u32).checked_mul(8).ok_or(ERROR_RESOURCE_LIMIT)?)
        .ok_or(ERROR_RESOURCE_LIMIT)?;
    let namespace = allocate_record(TAG_RECORD, payload_length)?;
    write_u32(mutable_record_at(namespace, TAG_RECORD)?, 0, count as u32)?;
    let outer_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;
    let with_context = state_field(state_offset, STATE_IMPORT_WITH_CONTEXT)? == 1;
    let mut caller_scope = outer_scope;
    let mut imported_scope = if with_context { outer_scope } else { 0 };
    cursor = 0;
    nested_depth = 0;
    let mut index = 0usize;
    loop {
        let source = source_at(source_offset)?;
        let (item, next_cursor) =
            next_item_utf16(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let directive = code_units_as_utf8(directive)?;
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if directive_keyword(directive, b"macro").is_some() {
                    cursor = find_macro_end(source, next_cursor, parse_options(state_offset)?)
                        .map_err(render_error_code)?;
                    continue;
                } else if nested_depth == 0
                    && let Some(clause) = directive_keyword(directive, b"set")
                {
                    let clause = parse_set_clause(clause).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
                    if let Some(expression) = clause.expression {
                        set_state_field(state_offset, STATE_CURRENT_SCOPE, imported_scope)?;
                        let value = evaluate_sync_expression(state_offset, expression);
                        set_state_field(state_offset, STATE_CURRENT_SCOPE, caller_scope)?;
                        let value = value?;
                        let mut binding_cursor = 0usize;
                        while let Some((name, next)) = next_binding(clause.targets, binding_cursor)
                            .map_err(|_| ERROR_UNSUPPORTED_TAG)?
                        {
                            if !name.starts_with(b"_") {
                                let name_offset = write_bytes_record(TAG_STRING, name)?;
                                if with_context {
                                    set_state_field(
                                        state_offset,
                                        STATE_CURRENT_SCOPE,
                                        caller_scope,
                                    )?;
                                    assign_scope(state_offset, name_offset, value)?;
                                    caller_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;
                                    imported_scope = caller_scope;
                                } else {
                                    let scope = allocate_record(TAG_SCOPE, SCOPE_LENGTH)?;
                                    let scope_record = mutable_record_at(scope, TAG_SCOPE)?;
                                    write_u32(scope_record, SCOPE_PARENT, imported_scope)?;
                                    write_u32(scope_record, SCOPE_NAME, name_offset)?;
                                    write_u32(scope_record, SCOPE_VALUE, value)?;
                                    imported_scope = scope;
                                }
                                let record = mutable_record_at(namespace, TAG_RECORD)?;
                                write_u32(record, 4 + index * 8, name_offset)?;
                                write_u32(record, 8 + index * 8, value)?;
                                index += 1;
                            }
                            binding_cursor = next;
                        }
                    }
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    set_state_field(state_offset, STATE_CURRENT_SCOPE, caller_scope)?;

    cursor = 0;
    nested_depth = 0;
    loop {
        let source = source_at(source_offset)?;
        let (item, next_cursor) =
            next_item_utf16(source, cursor, parse_options(state_offset)?)
                .map_err(render_error_code)?;
        match item {
            TemplateItem::Tag(directive) => {
                let directive = code_units_as_utf8(directive)?;
                if directive_keyword(directive, b"block").is_some()
                    || directive_keyword(directive, b"for").is_some()
                    || directive_keyword(directive, b"if").is_some()
                {
                    nested_depth = nested_depth.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
                } else if is_endblock(directive) || matches!(directive, b"endfor" | b"endif") {
                    nested_depth = nested_depth.saturating_sub(1);
                } else if let Some(signature) = directive_keyword(directive, b"macro") {
                    let end_cursor =
                        find_macro_end(source, next_cursor, parse_options(state_offset)?)
                            .map_err(render_error_code)?;
                    if nested_depth == 0 {
                        let definition = write_imported_macro_definition(
                            signature,
                            owner_frame,
                            source_offset,
                            canonical_offset,
                            next_cursor as u32,
                            imported_scope,
                        )?;
                        let name = macro_definition_field(definition, MACRO_DEFINITION_NAME)?;
                        let record = mutable_record_at(namespace, TAG_RECORD)?;
                        write_u32(record, 4 + index * 8, name)?;
                        write_u32(record, 8 + index * 8, definition)?;
                        index += 1;
                    }
                    cursor = end_cursor;
                    continue;
                }
            }
            TemplateItem::End => break,
            _ => {}
        }
        cursor = next_cursor;
    }
    Ok(namespace)
}

fn assign_import_bindings(
    state_offset: u32,
    bindings_offset: u32,
    namespace_offset: u32,
) -> Result<(), u32> {
    let bindings = record_at(bindings_offset, TAG_STRING)?;
    let namespace = Record::new(record_at(namespace_offset, TAG_RECORD)?)?;
    let mut cursor = 0usize;
    while let Some(binding) =
        next_import_binding(bindings, cursor).map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        let value = namespace
            .get_offset(binding.name)
            .ok_or(ERROR_INVALID_EXPRESSION)?;
        let alias = write_bytes_record(TAG_STRING, binding.alias)?;
        assign_scope(state_offset, alias, value)?;
        cursor = binding.next_cursor;
    }
    Ok(())
}

fn write_imported_macro_definition(
    signature: &[u8],
    owner_frame: u32,
    source_offset: u32,
    canonical_offset: u32,
    body_cursor: u32,
    scope: u32,
) -> Result<u32, u32> {
    let macro_signature = parse_tag_call(signature).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    let mut parameter_cursor = 0usize;
    while let Some(parameter) = next_macro_parameter(macro_signature.arguments, parameter_cursor)
        .map_err(|_| ERROR_UNSUPPORTED_TAG)?
    {
        parameter_cursor = parameter.next_cursor;
    }
    let name = write_bytes_record(TAG_STRING, macro_signature.name)?;
    let parameters = write_bytes_record(TAG_STRING, macro_signature.arguments)?;
    let definition_offset = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_MACRO_DEFINITION)?;
    write_u32(definition, MACRO_DEFINITION_PARENT, 0)?;
    write_u32(definition, MACRO_DEFINITION_NAME, name)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters)?;
    write_u32(definition, MACRO_DEFINITION_SCOPE, scope)?;
    write_u32(definition, MACRO_DEFINITION_FRAME, owner_frame)?;
    write_u32(
        definition,
        MACRO_DEFINITION_CANONICAL_NAME,
        canonical_offset,
    )?;
    Ok(definition_offset)
}

fn register_block_definition(
    state_offset: u32,
    name: &[u8],
    frame_offset: u32,
    source_offset: u32,
    body_cursor: u32,
) -> Result<u32, u32> {
    let block = parse_tag_call(name).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    if !block.arguments.is_empty() {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let end_cursor = find_block_end_utf8(
        source_at(source_offset)?,
        body_cursor as usize,
        parse_options(state_offset)?,
        block.name,
    )
    .map_err(render_error_code)? as u32;
    let mut existing_definition = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    while existing_definition != 0 {
        if block_definition_field(existing_definition, BLOCK_DEFINITION_FRAME)? == frame_offset
            && record_at(
                block_definition_field(existing_definition, BLOCK_DEFINITION_NAME)?,
                TAG_STRING,
            )? == block.name
        {
            return Err(ERROR_UNSUPPORTED_TAG);
        }
        existing_definition = block_definition_field(existing_definition, BLOCK_DEFINITION_PARENT)?;
    }
    let name_offset = write_bytes_record(TAG_STRING, block.name)?;
    let definition_offset = allocate_record(TAG_BLOCK_DEFINITION, BLOCK_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_BLOCK_DEFINITION)?;
    write_u32(definition, BLOCK_DEFINITION_PARENT, 0)?;
    write_u32(definition, BLOCK_DEFINITION_NAME, name_offset)?;
    write_u32(definition, BLOCK_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, BLOCK_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, BLOCK_DEFINITION_END_CURSOR, end_cursor)?;
    write_u32(
        definition,
        BLOCK_DEFINITION_SCOPE,
        state_field(state_offset, STATE_CURRENT_SCOPE)?,
    )?;
    write_u32(definition, BLOCK_DEFINITION_FRAME, frame_offset)?;
    let first_definition = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    if first_definition == 0 {
        set_state_field(
            state_offset,
            STATE_CURRENT_BLOCK_DEFINITION,
            definition_offset,
        )?;
    } else {
        let mut last_definition = first_definition;
        loop {
            let next = block_definition_field(last_definition, BLOCK_DEFINITION_PARENT)?;
            if next == 0 {
                break;
            }
            last_definition = next;
        }
        write_u32(
            mutable_record_at(last_definition, TAG_BLOCK_DEFINITION)?,
            BLOCK_DEFINITION_PARENT,
            definition_offset,
        )?;
    }
    Ok(end_cursor)
}

fn resolve_block(state_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let mut definition_offset = state_field(state_offset, STATE_CURRENT_BLOCK_DEFINITION)?;
    while definition_offset != 0 {
        let definition = record_at(definition_offset, TAG_BLOCK_DEFINITION)?;
        if definition.len() != BLOCK_DEFINITION_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        if record_at(read_u32(definition, BLOCK_DEFINITION_NAME)?, TAG_STRING)? == name {
            return Ok(Some(definition_offset));
        }
        definition_offset = read_u32(definition, BLOCK_DEFINITION_PARENT)?;
    }
    Ok(None)
}

fn write_super_definition(
    source_offset: u32,
    body_cursor: u32,
    end_cursor: u32,
    scope: u32,
    owner_frame: u32,
    next_super: u32,
) -> Result<u32, u32> {
    let name = write_bytes_record(TAG_STRING, b"super")?;
    let parameters = write_bytes_record(TAG_STRING, b"")?;
    let definition_offset = allocate_record(TAG_MACRO_DEFINITION, MACRO_DEFINITION_LENGTH)?;
    let definition = mutable_record_at(definition_offset, TAG_MACRO_DEFINITION)?;
    write_u32(definition, MACRO_DEFINITION_PARENT, 0)?;
    write_u32(definition, MACRO_DEFINITION_NAME, name)?;
    write_u32(definition, MACRO_DEFINITION_SOURCE, source_offset)?;
    write_u32(definition, MACRO_DEFINITION_BODY_CURSOR, body_cursor)?;
    write_u32(definition, MACRO_DEFINITION_PARAMETERS, parameters)?;
    write_u32(definition, MACRO_DEFINITION_SCOPE, scope)?;
    write_u32(definition, MACRO_DEFINITION_FRAME, owner_frame)?;
    write_u32(definition, MACRO_DEFINITION_SUPER, next_super)?;
    write_u32(definition, MACRO_DEFINITION_END_CURSOR, end_cursor)?;
    write_u32(
        definition,
        MACRO_DEFINITION_CANONICAL_NAME,
        frame_canonical_name(owner_frame)?,
    )?;
    Ok(definition_offset)
}

fn write_super_chain(
    definition_offset: u32,
    name: &[u8],
    fallback: u32,
    scope: u32,
) -> Result<u32, u32> {
    let mut count = 0usize;
    let mut candidate = block_definition_field(definition_offset, BLOCK_DEFINITION_PARENT)?;
    while candidate != 0 {
        if record_at(
            block_definition_field(candidate, BLOCK_DEFINITION_NAME)?,
            TAG_STRING,
        )? == name
        {
            count = count.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
        }
        candidate = block_definition_field(candidate, BLOCK_DEFINITION_PARENT)?;
    }

    let mut chain = fallback;
    for requested in (0..count).rev() {
        candidate = block_definition_field(definition_offset, BLOCK_DEFINITION_PARENT)?;
        let mut index = 0usize;
        let selected = loop {
            if candidate == 0 {
                return Err(ERROR_INVALID_ARENA);
            }
            if record_at(
                block_definition_field(candidate, BLOCK_DEFINITION_NAME)?,
                TAG_STRING,
            )? == name
            {
                if index == requested {
                    break candidate;
                }
                index = index.checked_add(1).ok_or(ERROR_RESOURCE_LIMIT)?;
            }
            candidate = block_definition_field(candidate, BLOCK_DEFINITION_PARENT)?;
        };
        chain = write_super_definition(
            block_definition_field(selected, BLOCK_DEFINITION_SOURCE)?,
            block_definition_field(selected, BLOCK_DEFINITION_BODY_CURSOR)?,
            block_definition_field(selected, BLOCK_DEFINITION_END_CURSOR)?,
            scope,
            block_definition_field(selected, BLOCK_DEFINITION_FRAME)?,
            chain,
        )?;
    }
    Ok(chain)
}

fn start_block(state_offset: u32, name: &[u8]) -> Result<(), u32> {
    let block = parse_tag_call(name).map_err(|_| ERROR_UNSUPPORTED_TAG)?;
    if !block.arguments.is_empty() {
        return Err(ERROR_UNSUPPORTED_TAG);
    }
    let frame_offset = state_field(state_offset, STATE_CURRENT_FRAME)?;
    let frame = record_at(frame_offset, TAG_FRAME)?;
    let source_offset = read_u32(frame, FRAME_SOURCE)?;
    let body_cursor = read_u32(frame, FRAME_CURSOR)?;
    let canonical_offset = frame_canonical_name(frame_offset)?;
    let end_cursor = find_block_end_utf8(
        source_at(source_offset)?,
        body_cursor as usize,
        parse_options(state_offset)?,
        block.name,
    )
    .map_err(render_error_code)? as u32;
    set_frame_field(frame_offset, FRAME_CURSOR, end_cursor)?;
    let current_scope = state_field(state_offset, STATE_CURRENT_SCOPE)?;

    let definition_offset = resolve_block(state_offset, block.name)?;
    let is_override = if let Some(definition_offset) = definition_offset {
        block_definition_field(definition_offset, BLOCK_DEFINITION_SOURCE)? != source_offset
    } else {
        false
    };
    if !is_override {
        let block_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
        write_frame(
            block_frame,
            frame_offset,
            source_offset,
            body_cursor,
            canonical_offset,
            current_scope,
            end_cursor,
        )?;
        set_state_field(state_offset, STATE_CURRENT_FRAME, block_frame)?;
        set_state_field(state_offset, STATE_TRANSIENT_BASE, legacy_arena_cursor())?;
        return Ok(());
    }
    let definition_offset = definition_offset.ok_or(ERROR_INVALID_ARENA)?;
    let override_source = block_definition_field(definition_offset, BLOCK_DEFINITION_SOURCE)?;
    let override_canonical = frame_canonical_name(block_definition_field(
        definition_offset,
        BLOCK_DEFINITION_FRAME,
    )?)?;
    let base_super = write_super_definition(
        source_offset,
        body_cursor,
        end_cursor,
        current_scope,
        frame_offset,
        0,
    )?;
    let super_definition =
        write_super_chain(definition_offset, block.name, base_super, current_scope)?;

    let block_frame = allocate_record(TAG_FRAME, FRAME_LENGTH)?;
    write_frame(
        block_frame,
        frame_offset,
        override_source,
        block_definition_field(definition_offset, BLOCK_DEFINITION_BODY_CURSOR)?,
        override_canonical,
        current_scope,
        block_definition_field(definition_offset, BLOCK_DEFINITION_END_CURSOR)?,
    )?;
    set_state_field(state_offset, STATE_CURRENT_FRAME, block_frame)?;
    set_state_field(state_offset, STATE_TRANSIENT_BASE, legacy_arena_cursor())?;
    let super_name = write_bytes_record(TAG_STRING, b"super")?;
    assign_scope(state_offset, super_name, super_definition)
}
