/**
 * How a trade-feed line is split between the dashboard's two panes. This is the same split the
 * old console interceptor used: order-ish lines go to the orders pane, everything else to the
 * system log. Shared by the socket.io layer and the machine-API log buffer so both agree.
 */
export const ORDER_KEYWORDS = Object.freeze([
    'Trade executed',
    '[Exec] Conditions met',
    'Sending order',
    'BUY',
    'SELL',
    'Order Placed',
]);

/** @returns {'order' | 'system'} */
export function channelOf(message) {
    return ORDER_KEYWORDS.some((kw) => message.includes(kw)) ? 'order' : 'system';
}
