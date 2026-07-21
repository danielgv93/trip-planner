import { store, save } from "../../core/store.js?v=26";

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

export async function refreshExchangeRate() {
    if (store.foreignCurrency === store.localCurrency) {
        store.exchangeRate = 1;
        store.exchangeRateDate = new Date().toISOString().slice(0, 10);
        save();
        return true;
    }
    try {
        const response = await fetch(`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(store.foreignCurrency)}&to=${encodeURIComponent(store.localCurrency)}`);
        if (!response.ok) throw new Error();
        const data = await response.json(), rate = Number(data?.rates?.[store.localCurrency]);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error();
        store.exchangeRate = rate;
        store.exchangeRateDate = data.date || new Date().toISOString().slice(0, 10);
        save();
        return true;
    } catch {
        return false;
    }
}
