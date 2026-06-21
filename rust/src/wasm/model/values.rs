struct Context {
    root: Record,
    state_offset: u32,
}

impl Context {
    fn new(payload: &'static [u8], state_offset: u32) -> Result<Self, u32> {
        Ok(Self {
            root: Record::new(payload)?,
            state_offset,
        })
    }

    fn lookup_offset(&self, path: &[u16]) -> Option<u32> {
        let (first, mut cursor) = next_lookup_segment(path, 0).ok()??;
        if ascii_eq(first, b"loop") {
            let (metadata, next) = next_lookup_segment(path, cursor).ok()??;
            let mut offset = loop_metadata_offset(self.state_offset, code_units_as_utf8(metadata).ok()?)
                .ok()
                .flatten()?;
            cursor = next;
            while let Some((segment, next)) = next_lookup_segment(path, cursor).ok()? {
                offset = Value::at(offset)
                    .ok()?
                    .get_offset(code_units_as_utf8(segment).ok()?)?;
                cursor = next;
            }
            return Some(offset);
        }
        let first = code_units_as_utf8(first).ok()?;
        let mut offset = self
            .lookup_scope(first)
            .or_else(|| self.lookup_local(first))
            .or_else(|| self.root.get_offset(first))?;
        while let Some((segment, next)) = next_lookup_segment(path, cursor).ok()? {
            offset = Value::at(offset)
                .ok()?
                .get_offset(code_units_as_utf8(segment).ok()?)?;
            cursor = next;
        }
        Some(offset)
    }

    fn lookup_scope(&self, name: &[u8]) -> Option<u32> {
        let mut scope_offset = state_field(self.state_offset, STATE_CURRENT_SCOPE).ok()?;
        while scope_offset != 0 {
            let scope = record_at(scope_offset, TAG_SCOPE).ok()?;
            if scope.len() != SCOPE_LENGTH as usize {
                return None;
            }
            let name_offset = read_u32(scope, SCOPE_NAME).ok()?;
            if name_eq_bytes(name_offset, name).ok()? {
                return read_u32(scope, SCOPE_VALUE).ok();
            }
            scope_offset = read_u32(scope, SCOPE_PARENT).ok()?;
        }
        None
    }

    fn lookup_local(&self, name: &[u8]) -> Option<u32> {
        let mut loop_offset = state_field(self.state_offset, STATE_CURRENT_LOOP).ok()?;
        while loop_offset != 0 {
            let bindings =
                record_at(loop_field(loop_offset, LOOP_BINDINGS).ok()?, TAG_BINDINGS).ok()?;
            let count = collection_count(bindings, 4).ok()?;
            for index in 0..count {
                let name_offset = read_u32(bindings, 4 + index * 4).ok()?;
                if name_eq_bytes(name_offset, name).ok()? {
                    return loop_binding(loop_offset, index, count).ok();
                }
            }
            loop_offset = loop_field(loop_offset, LOOP_PARENT).ok()?;
        }
        None
    }
}
fn loop_metadata_offset(state_offset: u32, name: &[u8]) -> Result<Option<u32>, u32> {
    let loop_offset = state_field(state_offset, STATE_CURRENT_LOOP)?;
    if loop_offset == 0 {
        return Ok(None);
    }
    let index = loop_field(loop_offset, LOOP_INDEX)?;
    let length = loop_field(loop_offset, LOOP_LENGTH)?;
    let value = match name {
        b"index" => write_u32_number(index + 1)?,
        b"index0" => write_u32_number(index)?,
        b"revindex" => write_u32_number(length - index)?,
        b"revindex0" => write_u32_number(length - index - 1)?,
        b"first" => write_boolean(index == 0)?,
        b"last" => write_boolean(index + 1 == length)?,
        b"length" => write_u32_number(length)?,
        _ => return Ok(None),
    };
    Ok(Some(value))
}

fn loop_binding(loop_offset: u32, binding_index: usize, binding_count: usize) -> Result<u32, u32> {
    let iterable = Value::at(loop_field(loop_offset, LOOP_ITERABLE)?)?;
    let index = loop_field(loop_offset, LOOP_INDEX)? as usize;
    match iterable {
        Value::Array(array) => {
            let element_offset = read_u32(array.payload, 4 + index * 4)?;
            if binding_count == 1 {
                return Ok(element_offset);
            }
            let Value::Array(element) = Value::at(element_offset)? else {
                return allocate_record(TAG_UNDEFINED, 0);
            };
            if binding_index >= element.count {
                allocate_record(TAG_UNDEFINED, 0)
            } else {
                read_u32(element.payload, 4 + binding_index * 4)
            }
        }
        Value::Record(record) => {
            let entry = 4 + index * 8;
            if binding_index < 2 {
                read_u32(record.payload, entry + binding_index * 4)
            } else {
                allocate_record(TAG_UNDEFINED, 0)
            }
        }
        _ => allocate_record(TAG_UNDEFINED, 0),
    }
}

#[derive(Clone, Copy)]
struct Record {
    payload: &'static [u8],
    count: usize,
}

impl Record {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        let count = collection_count(payload, 8)?;
        Ok(Self { payload, count })
    }

    fn get_offset(&self, name: &[u8]) -> Option<u32> {
        for index in 0..self.count {
            let entry_offset = 4 + index * 8;
            let key_offset = read_u32(self.payload, entry_offset).ok()?;
            let value_offset = read_u32(self.payload, entry_offset + 4).ok()?;
            if name_eq_bytes(key_offset, name).ok()? {
                return Some(value_offset);
            }
        }
        None
    }
}

#[derive(Clone, Copy)]
struct Array {
    payload: &'static [u8],
    count: usize,
}

impl Array {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        let count = collection_count(payload, 4)?;
        Ok(Self { payload, count })
    }

    fn get_offset(&self, name: &[u8]) -> Option<u32> {
        let index = parse_index(name)?;
        if index >= self.count {
            return None;
        }
        let value_offset = read_u32(self.payload, 4 + index * 4).ok()?;
        Some(value_offset)
    }
}

#[derive(Clone, Copy)]
struct Cycler {
    payload: &'static [u8],
}

impl Cycler {
    fn new(payload: &'static [u8]) -> Result<Self, u32> {
        if payload.len() < CYCLER_FIXED_LENGTH as usize {
            return Err(ERROR_INVALID_RECORD);
        }
        let count = read_u32(payload, CYCLER_COUNT)? as usize;
        let expected = (CYCLER_FIXED_LENGTH as usize)
            .checked_add(count.checked_mul(4).ok_or(ERROR_INVALID_RECORD)?)
            .ok_or(ERROR_INVALID_RECORD)?;
        if payload.len() != expected {
            return Err(ERROR_INVALID_RECORD);
        }
        Ok(Self { payload })
    }

    fn get_offset(self, name: &[u8]) -> Option<u32> {
        if name == b"current" {
            read_u32(self.payload, CYCLER_CURRENT).ok()
        } else {
            None
        }
    }
}

#[derive(Clone, Copy)]
struct Joiner;

#[derive(Clone, Copy)]
enum Value {
    Undefined,
    Null,
    Boolean(bool),
    Number { numeric: f64 },
    String(&'static [u8]),
    SafeString(&'static [u8]),
    Regex(&'static [u8]),
    Array(Array),
    Record(Record),
    Cycler(Cycler),
    Joiner(Joiner),
    Macro,
}

impl Value {
    fn at(offset: u32) -> Result<Self, u32> {
        let (tag, payload) = raw_record_at(offset)?;
        match tag {
            TAG_UNDEFINED if payload.is_empty() => Ok(Self::Undefined),
            TAG_NULL if payload.is_empty() => Ok(Self::Null),
            TAG_BOOLEAN if payload.len() == 1 => match payload[0] {
                0 => Ok(Self::Boolean(false)),
                1 => Ok(Self::Boolean(true)),
                _ => Err(ERROR_INVALID_RECORD),
            },
            TAG_NUMBER if payload.len() == 8 => {
                let numeric =
                    f64::from_le_bytes(payload[..8].try_into().map_err(|_| ERROR_INVALID_RECORD)?);
                Ok(Self::Number { numeric })
            }
            TAG_STRING => Ok(Self::String(payload)),
            TAG_SAFE_STRING => Ok(Self::SafeString(payload)),
            TAG_STRING_VALUE => Ok(Self::String(code_units_as_utf8(value_code_units(payload)?)?)),
            TAG_SAFE_STRING_VALUE => {
                Ok(Self::SafeString(code_units_as_utf8(value_code_units(payload)?)?))
            }
            TAG_IDENTIFIER => Ok(Self::String(code_units_as_utf8(identifier_code_units(offset)?)?)),
            TAG_REGEX => Ok(Self::Regex(code_units_as_utf8(regex_code_units(offset)?)?)),
            TAG_ARRAY => Ok(Self::Array(Array::new(payload)?)),
            TAG_RECORD => Ok(Self::Record(Record::new(payload)?)),
            TAG_CYCLER => Ok(Self::Cycler(Cycler::new(payload)?)),
            TAG_JOINER if payload.len() == JOINER_LENGTH as usize => Ok(Self::Joiner(Joiner)),
            TAG_MACRO_DEFINITION if payload.len() == MACRO_DEFINITION_LENGTH as usize => {
                Ok(Self::Macro)
            }
            _ => Err(ERROR_INVALID_RECORD),
        }
    }

    fn get_offset(self, name: &[u8]) -> Option<u32> {
        match self {
            Self::Array(array) => array.get_offset(name),
            Self::Record(record) => record.get_offset(name),
            Self::Cycler(cycler) => cycler.get_offset(name),
            _ => None,
        }
    }

    fn rendered(self) -> Option<RenderedValue<'static>> {
        match self {
            Self::Undefined | Self::Null => Some(RenderedValue {
                bytes: b"",
                safe: false,
            }),
            Self::Boolean(false) => Some(RenderedValue {
                bytes: b"false",
                safe: false,
            }),
            Self::Boolean(true) => Some(RenderedValue {
                bytes: b"true",
                safe: false,
            }),
            Self::Number { .. } => None,
            Self::String(value) => Some(RenderedValue {
                bytes: value,
                safe: false,
            }),
            Self::SafeString(value) => Some(RenderedValue {
                bytes: value,
                safe: true,
            }),
            Self::Regex(value) => Some(RenderedValue {
                bytes: value,
                safe: false,
            }),
            Self::Cycler(_) => Some(RenderedValue {
                bytes: b"[object Object]",
                safe: false,
            }),
            Self::Joiner(_) | Self::Array(_) | Self::Record(_) | Self::Macro => {
                Some(RenderedValue {
                    bytes: b"",
                    safe: false,
                })
            }
        }
    }

    fn truthy(self) -> bool {
        match self {
            Self::Undefined | Self::Null | Self::Boolean(false) => false,
            Self::Boolean(true)
            | Self::Regex(_)
            | Self::Array(_)
            | Self::Record(_)
            | Self::Cycler(_)
            | Self::Joiner(_)
            | Self::Macro => true,
            Self::Number { numeric, .. } => numeric != 0.0 && !numeric.is_nan(),
            Self::String(value) | Self::SafeString(value) => !value.is_empty(),
        }
    }

    fn string_bytes(self) -> Option<&'static [u8]> {
        match self {
            Self::String(value) | Self::SafeString(value) => Some(value),
            _ => None,
        }
    }

    fn as_number(self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Boolean(false) => 0.0,
            Self::Boolean(true) => 1.0,
            Self::Number { numeric, .. } => numeric,
            Self::String(value) | Self::SafeString(value) => {
                let value = trim_ascii_whitespace(value);
                if value.is_empty() {
                    0.0
                } else {
                    core::str::from_utf8(value)
                        .ok()
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(f64::NAN)
                }
            }
            Self::Undefined
            | Self::Regex(_)
            | Self::Array(_)
            | Self::Record(_)
            | Self::Cycler(_)
            | Self::Joiner(_)
            | Self::Macro => f64::NAN,
        }
    }
}
