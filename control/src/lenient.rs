//! lenient.rs - Tolerant value coercion for config.yaml and WebUI request bodies.
//!
//! The stored YAML was written by older (Python) versions of the manager and is hand-editable,
//! and the WebUI sends form values that may be strings where numbers are meant ("30") or
//! empty strings for "unset". A strict serde model would reject such a config and take the
//! whole manager down, so typed fields are decoded through these helpers instead:
//!
//!   * `FromLenient` coerces a `serde_json::Value` into a target type, returning `None` for a
//!     value that has no sensible reading (null, "", "abc" for a number, ...).
//!   * `opt` is a `deserialize_with` for `Option<T>` fields (garbage -> `None`).
//!   * `lenient_or!` generates a `deserialize_with` for non-optional fields that falls back to a
//!     given default on garbage.
//!
//! Boolean strings follow the manager's historical rule (`_sip_bool`): "1/true/yes/on" are
//! true, any other string is false.
use serde::{Deserialize, Deserializer};
use serde_json::Value;

pub trait FromLenient: Sized {
    fn from_lenient(v: &Value) -> Option<Self>;
}

impl FromLenient for String {
    fn from_lenient(v: &Value) -> Option<Self> {
        match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }
}

impl FromLenient for i64 {
    fn from_lenient(v: &Value) -> Option<Self> {
        match v {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
            Value::String(s) => {
                let t = s.trim();
                t.parse::<i64>()
                    .ok()
                    .or_else(|| t.parse::<f64>().ok().map(|f| f as i64))
            }
            Value::Bool(b) => Some(*b as i64),
            _ => None,
        }
    }
}

impl FromLenient for u16 {
    fn from_lenient(v: &Value) -> Option<Self> {
        i64::from_lenient(v).and_then(|n| u16::try_from(n).ok())
    }
}

impl FromLenient for u32 {
    fn from_lenient(v: &Value) -> Option<Self> {
        i64::from_lenient(v).and_then(|n| u32::try_from(n).ok())
    }
}

impl FromLenient for f64 {
    fn from_lenient(v: &Value) -> Option<Self> {
        match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }
}

impl FromLenient for bool {
    fn from_lenient(v: &Value) -> Option<Self> {
        match v {
            Value::Bool(b) => Some(*b),
            Value::Number(n) => Some(n.as_f64().map(|f| f != 0.0).unwrap_or(false)),
            Value::String(s) => Some(matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )),
            _ => None,
        }
    }
}

/// `deserialize_with` for `Option<T>`: anything that doesn't coerce becomes `None`.
pub fn opt<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: FromLenient,
{
    let v = Value::deserialize(d)?;
    Ok(T::from_lenient(&v))
}

/// Coerce `v` or fall back to `default`.
pub fn or<T: FromLenient>(v: Option<&Value>, default: T) -> T {
    v.and_then(T::from_lenient).unwrap_or(default)
}

/// `lenient_or!(fn_name, Type, default_expr)` defines a `deserialize_with` function that
/// coerces leniently and falls back to `default_expr` on a value it can't read.
#[macro_export]
macro_rules! lenient_or {
    ($name:ident, $t:ty, $default:expr) => {
        fn $name<'de, D: serde::Deserializer<'de>>(d: D) -> Result<$t, D::Error> {
            let v = <serde_json::Value as serde::Deserialize>::deserialize(d)?;
            Ok(<$t as $crate::lenient::FromLenient>::from_lenient(&v).unwrap_or_else(|| $default))
        }
    };
}

/// Python-style truthiness, for the few places the old manager used `bool(x)` on raw values.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// `str(v)` for an optional JSON value ("" for null/missing).
pub fn string(v: Option<&Value>) -> String {
    v.and_then(String::from_lenient).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coercions() {
        assert_eq!(i64::from_lenient(&json!("30")), Some(30));
        assert_eq!(i64::from_lenient(&json!("")), None);
        assert_eq!(i64::from_lenient(&json!(2.9)), Some(2));
        assert_eq!(bool::from_lenient(&json!("on")), Some(true));
        assert_eq!(bool::from_lenient(&json!("nope")), Some(false));
        assert_eq!(bool::from_lenient(&json!(null)), None);
        assert_eq!(String::from_lenient(&json!(7)), Some("7".into()));
        assert_eq!(u16::from_lenient(&json!(70000)), None);
    }
}
