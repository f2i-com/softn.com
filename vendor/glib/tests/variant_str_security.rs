use glib::variant::ToVariant;

#[test]
fn string_array_iteration_preserves_values_in_both_directions() {
    let values = ["first", "", "こんにちは", "last"];
    let variant = values.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().collect::<Vec<_>>(), values);
    assert_eq!(
        variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
        values.into_iter().rev().collect::<Vec<_>>()
    );

    let mut iter = variant.array_iter_str().unwrap();
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.next_back(), Some("last"));
    assert_eq!(iter.next_back(), Some("こんにちは"));
    assert_eq!(iter.next(), Some(""));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
}
