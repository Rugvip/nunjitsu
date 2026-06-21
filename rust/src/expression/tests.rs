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
        let escaped = br#""escaped\"""#;
        assert_eq!(
            parse_base(escaped),
            Ok((Atom::String(br#"escaped\""#), escaped.len(), false)),
        );
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
            parse_import_clause(br#" "import.html" | replace("html", "njk") as imp "#),
            Ok(ImportClause {
                template: br#""import.html" | replace("html", "njk")"#,
                alias: b"imp",
                with_context: false,
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
        assert_eq!(
            parse_from_import_clause(
                br#" "import.html" | replace("html", "njk") import foo as baz "#,
            ),
            Ok(FromImportClause {
                template: br#""import.html" | replace("html", "njk")"#,
                bindings: b"foo as baz",
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
        assert_eq!(next_import_binding(b"_private", 0), Err(ExpressionError));
        assert_eq!(
            parse_base("\u{a0}foo\u{a0}".as_bytes()),
            Ok((Atom::Lookup(b"foo"), 7, false)),
        );
        assert_eq!(has_top_level_comma(b"1, 2, 3"), Ok(true));
        assert_eq!(has_top_level_comma(br#"[1, 2], "three,four""#), Ok(true));
        assert_eq!(has_top_level_comma(br#"[1, 2] | join(",")"#), Ok(false));
        assert_eq!(
            parse_base(b"r/x$/iv"),
            Ok((Atom::Regex(b"/x$/i"), 6, false)),
        );
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

    #[test]
    fn parses_jinja_slice_bounds() {
        let expression = b"arr[n:n+3]";
        assert_eq!(
            parse_base(expression),
            Ok((
                Atom::Slice {
                    target: b"arr",
                    start: Some(b"n"),
                    stop: Some(b"n+3"),
                    step: None,
                },
                expression.len(),
                false,
            )),
        );
        let expression = b"values[::-1]";
        assert_eq!(
            parse_base(expression),
            Ok((
                Atom::Slice {
                    target: b"values",
                    start: None,
                    stop: None,
                    step: Some(b"-1"),
                },
                expression.len(),
                false,
            )),
        );
        assert!(parse_base(b"values[1:2:3:4]").is_err());
    }
}
