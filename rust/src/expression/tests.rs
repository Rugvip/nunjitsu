#[cfg(test)]
mod tests {
    use super::*;

    fn units(value: &str) -> Vec<u16> {
        value.encode_utf16().collect()
    }

    #[test]
    fn parses_globals_filters_tests_and_arguments() {
        let expression = units(r#"hello("World", user.name) | suffix("!") is not empty"#);
        let (base, cursor, negated) = parse_base(&expression).unwrap();
        assert!(!negated);
        let Atom::Call(call) = base else {
            panic!("expected call");
        };
        assert_eq!(call.name, units("hello"));
        assert_eq!(call.arguments, units(r#""World", user.name"#));

        let (first, cursor) = next_operation(&expression, cursor).unwrap().unwrap();
        let Operation::Filter(filter) = first else {
            panic!("expected filter");
        };
        assert_eq!(filter.name, units("suffix"));
        assert_eq!(filter.arguments, units(r#""!""#));

        let (second, cursor) = next_operation(&expression, cursor).unwrap().unwrap();
        let Operation::Test { call: test, negated } = second else {
            panic!("expected test");
        };
        assert_eq!(test.name, units("empty"));
        assert!(test.arguments.is_empty());
        assert!(negated);
        assert_eq!(next_operation(&expression, cursor), Ok(None));

        let (first, cursor) = next_argument(call.arguments, 0).unwrap().unwrap();
        let (second, cursor) = next_argument(call.arguments, cursor).unwrap().unwrap();
        assert_eq!(first, Atom::String(&units("World")));
        assert_eq!(second, Atom::Lookup(&units("user.name")));
        assert_eq!(next_argument(call.arguments, cursor), Ok(None));
    }

    #[test]
    fn parses_directives_bindings_and_lookup_segments() {
        let tag = units(r#" badge("new", user.name) "#);
        let call = parse_tag_call(&tag).unwrap();
        assert_eq!(call.name, units("badge"));
        assert_eq!(call.arguments, units(r#""new", user.name"#));

        let call_block = units(r#"(item, index) list(["a", "b"])"#);
        let clause = parse_call_block(&call_block).unwrap();
        assert_eq!(clause.bindings, units("item, index"));
        assert_eq!(clause.call.name, units("list"));
        assert_eq!(clause.call.arguments, units(r#"["a", "b"]"#));

        let import = units(r#" "import.njk" as imp with context "#);
        let clause = parse_import_clause(&import).unwrap();
        assert_eq!(clause.template, units(r#""import.njk""#));
        assert_eq!(clause.alias, units("imp"));
        assert!(clause.with_context);

        let from_import = units(r#" "import.njk" import foo as baz, bar without context "#);
        let clause = parse_from_import_clause(&from_import).unwrap();
        assert_eq!(clause.template, units(r#""import.njk""#));
        assert_eq!(clause.bindings, units("foo as baz, bar"));
        assert!(!clause.with_context);
        let first = next_import_binding(clause.bindings, 0).unwrap().unwrap();
        let second = next_import_binding(clause.bindings, first.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!((first.name, first.alias), (&units("foo")[..], &units("baz")[..]));
        assert_eq!((second.name, second.alias), (&units("bar")[..], &units("bar")[..]));
        assert_eq!(next_import_binding(clause.bindings, second.next_cursor), Ok(None));

        let for_source = units("key, value in entries");
        let for_clause = parse_for_clause(&for_source).unwrap();
        assert_eq!(for_clause.bindings, units("key, value"));
        assert_eq!(for_clause.iterable, units("entries"));
        let set_source = units("x, y = source");
        let set_clause = parse_set_clause(&set_source).unwrap();
        assert_eq!(set_clause.targets, units("x, y"));
        assert_eq!(set_clause.expression, Some(&units("source")[..]));

        let parameters = units(r#"x, y=2, z="value""#);
        let first = next_macro_parameter(&parameters, 0).unwrap().unwrap();
        let second = next_macro_parameter(&parameters, first.next_cursor)
            .unwrap()
            .unwrap();
        let third = next_macro_parameter(&parameters, second.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(first.name, units("x"));
        assert_eq!(second.default, Some(Atom::Number(&units("2"))));
        assert_eq!(third.default, Some(Atom::String(&units("value"))));
        let arguments = units("1, z=3");
        let first = next_macro_argument(&arguments, 0).unwrap().unwrap();
        let second = next_macro_argument(&arguments, first.next_cursor)
            .unwrap()
            .unwrap();
        assert_eq!(first.value, Atom::Number(&units("1")));
        assert_eq!(second.name, Some(&units("z")[..]));
        assert_eq!(second.value, Atom::Number(&units("3")));

        let path = units(r#"user["profile"].flags[0]"#);
        let mut cursor = 0;
        let mut segments = Vec::new();
        while let Some((segment, next)) = next_lookup_segment(&path, cursor).unwrap() {
            segments.push(segment);
            cursor = next;
        }
        assert_eq!(
            segments,
            [
                &units("user")[..],
                &units("profile")[..],
                &units("flags")[..],
                &units("0")[..],
            ],
        );
    }

    #[test]
    fn parses_boolean_arithmetic_and_literal_structures() {
        let expression = units(r#"(hungry or pizza) and not anchovies or food == "salad""#);
        let (base, cursor, negated) = parse_base(&expression).unwrap();
        assert_eq!(base, Atom::Group(&units("hungry or pizza")));
        assert!(!negated);
        let (and, cursor) = next_operation(&expression, cursor).unwrap().unwrap();
        let (or, cursor) = next_operation(&expression, cursor).unwrap().unwrap();
        let (comparison, cursor) = next_operation(&expression, cursor).unwrap().unwrap();
        assert_eq!(
            and,
            Operation::And(Operand {
                atom: Atom::Lookup(&units("anchovies")),
                negated: true,
            }),
        );
        assert_eq!(
            or,
            Operation::Or(Operand {
                atom: Atom::Lookup(&units("food")),
                negated: false,
            }),
        );
        assert_eq!(
            comparison,
            Operation::Compare {
                operator: Comparison::Equal,
                operand: Operand {
                    atom: Atom::String(&units("salad")),
                    negated: false,
                },
            },
        );
        assert_eq!(next_operation(&expression, cursor), Ok(None));

        let arithmetic = units("3 + 4 - 5 * 6 / 10");
        let split = split_binary_expression(&arithmetic).unwrap().unwrap();
        assert_eq!(split.left, units("3"));
        assert_eq!(split.operator, BinaryOperator::Add);
        assert_eq!(split.right, units("4 - 5 * 6 / 10"));

        let inline = units(r#""yes" if value is odd else "no""#);
        let (Atom::InlineIf { body, condition, alternative }, cursor, false) =
            parse_base(&inline).unwrap()
        else {
            panic!("expected inline conditional");
        };
        assert_eq!(body, units(r#""yes""#));
        assert_eq!(condition, units("value is odd"));
        assert_eq!(alternative, Some(&units(r#""no""#)[..]));
        assert_eq!(cursor, inline.len());

        let literal = units(r#"[1, "two", { three: 3 }]"#);
        let (Atom::Array(elements), cursor, false) = parse_base(&literal).unwrap() else {
            panic!("expected array");
        };
        assert_eq!(cursor, literal.len());
        let (_, cursor) = next_argument(elements, 0).unwrap().unwrap();
        let (_, cursor) = next_argument(elements, cursor).unwrap().unwrap();
        let (Atom::Record(entries), cursor) = next_argument(elements, cursor).unwrap().unwrap()
        else {
            panic!("expected record");
        };
        assert_eq!(next_argument(elements, cursor), Ok(None));
        let entry = next_record_entry(entries, 0).unwrap().unwrap();
        assert_eq!(entry.key, units("three"));
        assert_eq!(entry.value, Atom::Number(&units("3")));
        assert_eq!(entry.next_cursor, entries.len());
    }

    #[test]
    fn parses_utf16_whitespace_regexes_and_slice_bounds() {
        let padded = units("\u{a0}foo\u{a0}");
        assert_eq!(
            parse_base(&padded),
            Ok((Atom::Lookup(&units("foo")), padded.len(), false)),
        );
        let regex = units("r/x$/iv");
        assert_eq!(parse_base(&regex), Ok((Atom::Regex(&units("/x$/i")), 6, false)));
        assert_eq!(has_top_level_comma(&units(r#"[1, 2], "three,four""#)), Ok(true));
        assert_eq!(has_top_level_comma(&units(r#"[1, 2] | join(",")"#)), Ok(false));

        let expression = units("arr[n:n+3]");
        assert_eq!(
            parse_base(&expression),
            Ok((
                Atom::Slice {
                    target: &units("arr"),
                    start: Some(&units("n")),
                    stop: Some(&units("n+3")),
                    step: None,
                },
                expression.len(),
                false,
            )),
        );
        let reverse = units("values[::-1]");
        assert_eq!(
            parse_base(&reverse),
            Ok((
                Atom::Slice {
                    target: &units("values"),
                    start: None,
                    stop: None,
                    step: Some(&units("-1")),
                },
                reverse.len(),
                false,
            )),
        );
        assert!(parse_base(&units("values[1:2:3:4]")).is_err());
    }
}
