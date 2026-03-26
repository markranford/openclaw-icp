/// OpenClaw ICP — On-chain HTML Email Template Engine
/// Simple {{variable}} substitution for email templates
import Text "mo:base/Text";
import Iter "mo:base/Iter";

module {

  /// Render a template by replacing {{key}} with values
  /// Example: render("Hello {{name}}", [("name", "Alice")]) → "Hello Alice"
  public func render(template : Text, variables : [(Text, Text)]) : Text {
    var result = template;
    for ((key, value) in variables.vals()) {
      let placeholder = "{{" # key # "}}";
      result := Text.replace(result, #text(placeholder), value);
    };
    result;
  };
}
