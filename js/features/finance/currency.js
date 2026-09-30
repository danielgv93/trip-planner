import { store } from "../../core/store.js";

export const CURRENCIES = [
    ["EUR", "Euro"], ["USD", "Dólar estadounidense"], ["GBP", "Libra esterlina"],
    ["JPY", "Yen japonés"], ["CHF", "Franco suizo"], ["CAD", "Dólar canadiense"],
    ["AUD", "Dólar australiano"], ["CNY", "Yuan chino"], ["KRW", "Won surcoreano"],
    ["MXN", "Peso mexicano"], ["BRL", "Real brasileño"], ["INR", "Rupia india"],
    ["THB", "Baht tailandés"], ["TRY", "Lira turca"], ["SEK", "Corona sueca"],
    ["NOK", "Corona noruega"], ["DKK", "Corona danesa"], ["PLN", "Zloty polaco"],
    ["CZK", "Corona checa"], ["HUF", "Forinto húngaro"], ["NZD", "Dólar neozelandés"],
    ["SGD", "Dólar de Singapur"], ["HKD", "Dólar de Hong Kong"], ["ZAR", "Rand sudafricano"],
];

export function formatMoney(amount, currency) {
    if (!Number.isFinite(amount)) return "—";
    try {
        return new Intl.NumberFormat("es-ES", {
            style: "currency", currency,
            minimumFractionDigits: ["JPY", "KRW"].includes(currency) ? 0 : 2,
            maximumFractionDigits: ["JPY", "KRW"].includes(currency) ? 0 : 2,
        }).format(amount);
    } catch {
        return `${amount.toLocaleString("es-ES", { maximumFractionDigits: 2 })} ${currency}`;
    }
}

export const foreignAmount = (amount) => formatMoney(amount, store.foreignCurrency);
export const localAmount = (amount) => store.exchangeRate
    ? formatMoney(amount * store.exchangeRate, store.localCurrency)
    : "Conversión no disponible";

// Updating derived conversion data must not enqueue a trip mutation.
export async function refreshExchangeRate() {
    const { foreignCurrency, localCurrency } = store;
    if (foreignCurrency === localCurrency) {
        store.exchangeRate = 1;
        store.exchangeRateDate = new Date().toISOString().slice(0, 10);
        return true;
    }
    try {
        const response = await fetch(`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(foreignCurrency)}&to=${encodeURIComponent(localCurrency)}`);
        if (!response.ok) throw new Error();
        const data = await response.json(), rate = Number(data?.rates?.[localCurrency]);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error();
        if (store.foreignCurrency !== foreignCurrency || store.localCurrency !== localCurrency) return false;
        store.exchangeRate = rate;
        store.exchangeRateDate = data.date || new Date().toISOString().slice(0, 10);
        return true;
    } catch {
        return false;
    }
}
