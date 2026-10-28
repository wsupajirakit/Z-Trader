/**
 * The strategy modes StrategyController.run() knows about. Anything else would only
 * log "unknown mode" on every tick, so the socket API rejects it up front.
 */
export const STRATEGY_MODES = Object.freeze(['Hardcode', 'Conservative', 'Swing', 'Merge', 'Sonic', 'Scalper']);

/** cTrader symbol names such as XAUUSD, EURUSD, US500. */
export const SYMBOL_PATTERN = /^[A-Z0-9]{3,16}$/;
export const MAX_SYMBOLS = 10;

/**
 * Same normalisation the original loop applied ("sonic" -> "Sonic").
 * Returns null when the result is not a known mode.
 */
export function normalizeMode(input) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 32) return null;
    const mode = input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
    return STRATEGY_MODES.includes(mode) ? mode : null;
}

export function isValidSymbol(symbol) {
    return typeof symbol === 'string' && SYMBOL_PATTERN.test(symbol);
}
