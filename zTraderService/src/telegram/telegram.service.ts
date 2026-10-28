import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { errorMessage } from '../common/utils/errors';

@Injectable()
export class TelegramService {
    private readonly logger = new Logger(TelegramService.name);
    private readonly botToken: string;
    private readonly chatId: string;

    constructor(private configService: ConfigService) {
        this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
        this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || '';
    }

    async notifyOrderSuccess(details: string) {
        await this.sendMessage(`✅ Order Executed Successfully!\n${details}`);
    }

    async notifyTP_SL(details: string) {
        await this.sendMessage(`🎯 TP/SL Hit!\n${details}`);
    }

    async notifyError(message: string) {
        await this.sendMessage(`⚠️ ${message}`);
    }

    private async sendMessage(text: string) {
        if (!this.botToken || !this.chatId) {
            this.logger.warn('Telegram Bot Token or Chat ID not configured. Skipping notification.');
            return;
        }

        try {
            const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
            this.logger.log(`Sending Telegram message: ${text.replace(/\n/g, ' ')}`);
            await axios.post(url, {
                chat_id: this.chatId,
                text: text,
                parse_mode: 'HTML',
            });
            this.logger.debug('Telegram message sent successfully');
        } catch (error) {
            this.logger.error(
                'Failed to send Telegram notification',
                axios.isAxiosError(error) ? (error.response?.data ?? error.message) : errorMessage(error),
            );
        }
    }
}
