/**
 * @cad0p/pi-steering-hooks — AST-backed steering engine for pi.
 *
 * Scaffolded pi extension entry point. Real implementation arrives in
 * Phase 2 of the PoC. See ../README.md for the full plan.
 *
 * TODO(Phase 2):
 *   - Load rules via walk-up + merge + session_start handler.
 *   - Parse bash commands through `unbash-walker` and evaluate rules
 *     (pattern / requires / unless / cwdPattern) against the AST.
 *   - Detect inline `steering-override` comments and audit via pi hooks.
 *   - Emit typed events for write / edit tools alongside bash.
 */

// Intentionally exports a no-op default so `pi install @cad0p/pi-steering-hooks`
// can load the extension during the scaffold phase without crashing.
// Real ExtensionAPI wiring lands in Phase 2.
export default function register(): void {
	// no-op scaffold
}
