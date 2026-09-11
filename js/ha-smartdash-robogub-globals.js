// Compatibility bridge for RoboGub extension.
// Core modules are declared with top-level const in classic scripts, so they
// are available as global lexical bindings but are not properties on window.
// The first RoboGub extension version referenced window.*; expose only the
// three dependencies it needs until the extension is folded into robots.js.
window.BeastCore = BeastCore;
window.BeastAuth = BeastAuth;
window.BeastHaSocket = BeastHaSocket;
