import Parser from 'rss-parser';
import { tradeLog } from '../logging/logger.js';

export class NewsService {
    constructor({ parser = new Parser() } = {}) {
        this.parser = parser;
        this.rssUrl = 'https://finance.yahoo.com/news/rssindex';
        this.highImpactKeywords = ['USD', 'FED', 'CPI', 'PAYROLL', 'JOBS', 'INTEREST RATE', 'FOMC'];
    }

    async fetchNews() {
        try {
            const feed = await this.parser.parseURL(this.rssUrl);
            return feed.items;
        } catch (error) {
            tradeLog.error('Error fetching news:', error.message);
            return [];
        }
    }

    async getHighImpactUSDNews() {
        const items = await this.fetchNews();
        // Since Yahoo RSS doesn't have a "red box" tag like ForexFactory,
        // we'll look for USD in the title/desc and key economic keywords.
        return items.filter((item) => {
            const content = (item.title + ' ' + item.contentSnippet).toUpperCase();
            return this.highImpactKeywords.some((keyword) => content.includes(keyword));
        });
    }

    async checkNewsFilter() {
        const news = await this.getHighImpactUSDNews();
        const now = new Date();
        const bufferMinutes = 30;

        for (const item of news) {
            const newsDate = new Date(item.pubDate);
            const diffMinutes = Math.abs((now - newsDate) / (1000 * 60));

            if (diffMinutes <= bufferMinutes) {
                tradeLog.info(`News Guard: High impact news detected: ${item.title} (Published: ${item.pubDate})`);
                return true; // Trading restricted
            }
        }
        return false; // Trading allowed
    }
}
