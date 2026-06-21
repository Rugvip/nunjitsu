#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_text_expressions_and_literal_includes() {
        let source = b"before {{ name }} {% include 'partial.njk' %} after";
        let mut cursor = 0;
        let expected = [
            TemplateItem::Text(b"before "),
            TemplateItem::Expression(b"name"),
            TemplateItem::Text(b" "),
            TemplateItem::Include {
                expression: b"'partial.njk'",
                ignore_missing: false,
            },
            TemplateItem::Text(b" after"),
            TemplateItem::End,
        ];
        for expected_item in expected {
            let (item, next_cursor) = next_item(source, cursor).unwrap();
            assert_eq!(item, expected_item);
            cursor = next_cursor;
        }

        assert_eq!(
            next_item(b"{% include target ignore missing %}", 0),
            Ok((
                TemplateItem::Include {
                    expression: b"target",
                    ignore_missing: true,
                },
                35,
            )),
        );
        assert_eq!(
            next_item(b"{% include 'ignore missing' %}", 0),
            Ok((
                TemplateItem::Include {
                    expression: b"'ignore missing'",
                    ignore_missing: false,
                },
                30,
            )),
        );
    }

    #[test]
    fn renders_static_text_and_interpolations() {
        let source = b"Hello {{ name }}! {{ missing }}";
        let mut output = vec![0; 64];
        let written = render_template(
            source,
            false,
            |name| {
                (name == b"name").then_some(RenderedValue {
                    bytes: b"Nunjitsu",
                    safe: false,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"Hello Nunjitsu! ");
    }

    #[test]
    fn rejects_invalid_tags_and_short_output_buffers() {
        let mut output = [0; 4];
        assert_eq!(
            render_template(b"{{ value", false, |_| None, &mut output),
            Err(RenderError::UnclosedInterpolation),
        );
        assert_eq!(
            render_template(b"{% include value %}", false, |_| None, &mut output),
            Err(RenderError::UnsupportedTag),
        );
        assert_eq!(
            render_template(b"{% include  %}", false, |_| None, &mut output),
            Err(RenderError::InvalidInclude),
        );
        assert_eq!(
            render_template(b"hello", false, |_| None, &mut output),
            Err(RenderError::OutputBufferTooSmall),
        );
        assert_eq!(
            render_template(b"{# unclosed", false, |_| None, &mut output),
            Err(RenderError::UnclosedComment),
        );
        assert_eq!(
            render_template(b"{% raw %}unclosed", false, |_| None, &mut output),
            Err(RenderError::UnclosedRaw),
        );
    }

    #[test]
    fn autoescapes_values_unless_they_are_safe() {
        let mut output = [0; 128];
        let source = b"<p>{{ value }}</p>";
        let written = render_template(
            source,
            true,
            |_| {
                Some(RenderedValue {
                    bytes: b"<&\"'>",
                    safe: false,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"<p>&lt;&amp;&quot;&#39;&gt;</p>");

        let written = render_template(
            source,
            true,
            |_| {
                Some(RenderedValue {
                    bytes: b"<strong>safe</strong>",
                    safe: true,
                })
            },
            &mut output,
        )
        .unwrap();
        assert_eq!(&output[..written], b"<p><strong>safe</strong></p>");
    }

    #[test]
    fn finds_nested_conditional_branches() {
        let source = b"false {% if nested %}nested{% else %}other{% endif %}{% elif second %}second{% else %}last{% endif %}";
        assert_eq!(
            find_conditional_boundary(source, 0, true, ParseOptions::default()),
            Ok(ConditionalBoundary::ElseIf(b"second", 70)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, true, ParseOptions::default()),
            Ok(ConditionalBoundary::Else(86)),
        );
        assert_eq!(
            find_conditional_boundary(source, 70, false, ParseOptions::default()),
            Ok(ConditionalBoundary::EndIf(source.len())),
        );

        let loop_source =
            b"item{% if condition %}yes{% else %}no{% endif %}{% else %}empty{% endfor %}";
        assert_eq!(
            find_loop_boundaries(loop_source, 0, ParseOptions::default()),
            Ok(LoopBoundaries {
                else_cursor: Some(58),
                end_cursor: loop_source.len(),
            }),
        );

        let macro_source = b"body{% macro nested() %}nested{% endmacro %}tail{% endmacro %}after";
        assert_eq!(
            find_macro_end(macro_source, 0, ParseOptions::default()),
            Ok(62),
        );

        let block_source = b"body{% block nested %}nested{% endblock %}tail{% endblock %}after";
        assert_eq!(
            find_block_end(block_source, 0, ParseOptions::default(), b"outer"),
            Ok(60),
        );
        assert_eq!(
            find_block_end(
                b"body{% block nested %}nested{% endblock wrong %}{% endblock outer %}",
                0,
                ParseOptions::default(),
                b"outer",
            ),
            Err(RenderError::UnsupportedTag),
        );

        let call_source = b"body{% call wrap() %}nested{% endcall %}tail{% endcall %}after";
        assert_eq!(
            find_call_end(call_source, 0, ParseOptions::default()),
            Ok(57),
        );
        assert_eq!(
            contains_extends(
                b"before{% if enabled %}{% extends parent %}{% endif %}",
                ParseOptions::default(),
            ),
            Ok(true),
        );
        assert_eq!(
            contains_extends(
                b"{% raw %}{% extends hidden %}{% endraw %}",
                ParseOptions::default(),
            ),
            Ok(false),
        );
    }

    #[test]
    fn omits_comments_and_preserves_raw_template_syntax() {
        let source = b"before{# {{ hidden }} #}{% raw %}{{ visible syntax }}{% endraw %}after";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"before{{ visible syntax }}after");

        let source = b"{% raw %}{% if broken }literal{% endraw %}";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"{% if broken }literal");

        let source = b"{% raw %}{% raw %}nested{% endraw %}{% endraw %}";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"{% raw %}nested{% endraw %}");

        let source = b"hello \n{#- comment -#} \n world";
        let mut output = vec![0; source.len()];
        let written = render_template(source, false, |_| None, &mut output).unwrap();
        assert_eq!(&output[..written], b"helloworld");

        let source = b"test\n {% raw %}\n  foo\n {% endraw %}\n</div>";
        let options = ParseOptions {
            trim_blocks: true,
            lstrip_blocks: true,
        };
        let mut cursor = 0;
        let mut items = Vec::new();
        loop {
            let (item, next) = next_item_with_options(source, cursor, options).unwrap();
            cursor = next;
            items.push(item);
            if item == TemplateItem::End {
                break;
            }
        }
        assert_eq!(
            items,
            [
                TemplateItem::Text(b"test\n"),
                TemplateItem::Text(b"  foo\n"),
                TemplateItem::Text(b"</div>"),
                TemplateItem::End,
            ],
        );
    }
}
#[test]
fn parses_utf16_source_with_code_unit_cursors() {
    let source: Vec<u16> = "A😀{{ value }}終".encode_utf16().collect();
    let (text, cursor) = next_item_utf16(&source, 0, ParseOptions::default()).unwrap();
    assert_eq!(text, TemplateItem::Text(&source[..3]));
    assert_eq!(cursor, 3);

    let (expression, cursor) = next_item_utf16(&source, cursor, ParseOptions::default()).unwrap();
    let expected: Vec<u16> = "value".encode_utf16().collect();
    assert_eq!(expression, TemplateItem::Expression(expected.as_slice()));
    assert_eq!(cursor, 14);

    let (text, cursor) = next_item_utf16(&source, cursor, ParseOptions::default()).unwrap();
    assert_eq!(text, TemplateItem::Text(&source[14..]));
    assert_eq!(cursor, source.len());
}
