import { BollingerBands, EMA, RSI } from 'technicalindicators';

export class IndicatorService {
    calculateRSI(values, period = 14) {
        return RSI.calculate({ values, period });
    }

    calculateEMA(values, period) {
        return EMA.calculate({ values, period });
    }

    calculateBollingerBands(values, period = 20, stdDev = 2) {
        return BollingerBands.calculate({ values, period, stdDev });
    }

    // Helper to get crossing points
    checkEMACross(shortEMA, longEMA) {
        if (shortEMA.length < 2 || longEMA.length < 2) return null;

        const prevShort = shortEMA[shortEMA.length - 2];
        const currShort = shortEMA[shortEMA.length - 1];
        const prevLong = longEMA[longEMA.length - 2];
        const currLong = longEMA[longEMA.length - 1];

        if (prevShort <= prevLong && currShort > currLong) return 'GOLDEN_CROSS'; // Buy
        if (prevShort >= prevLong && currShort < currLong) return 'DEATH_CROSS'; // Sell

        return null;
    }
}
